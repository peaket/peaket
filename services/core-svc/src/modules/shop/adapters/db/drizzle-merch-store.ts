// shop 주문·정산 원천 Drizzle 저장소. 내부 정산 원천은 core_app으로 읽는다.
import { eq } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { MerchOrderStore } from '../../domain/merch-ports.js';
import type { MerchItemStatus, MerchOrderItemRecord, MerchOrderRecord, MerchPg, MerchPgStore, ProductSettlementItem } from '../../domain/merch.js';
import { productSettlementItems } from '../../domain/merch.js';
import { merchOrder, merchOrderItem } from './schema.js';

const toOrder = (row: typeof merchOrder.$inferSelect): MerchOrderRecord => ({
  orderId: row.id,
  promoterId: row.promoterId,
  eventId: row.eventId,
  buyerName: row.buyerName,
  buyerPhone: row.buyerPhone,
  status: row.status as MerchOrderRecord['status'],
  pg: row.pg as MerchPg,
  pgStore: row.pgStore as MerchPgStore,
  shippingFee: row.shippingFee,
  purchaseConfirmedAt: row.purchaseConfirmedAt,
  orderedAt: row.orderedAt,
});

const toItem = (row: typeof merchOrderItem.$inferSelect): MerchOrderItemRecord => ({
  itemId: row.id,
  orderId: row.orderId,
  promoterId: row.promoterId,
  eventId: row.eventId,
  productId: row.productId,
  productName: row.productName,
  quantity: row.quantity,
  unitAmount: row.unitAmount,
  commissionRateBp: row.commissionRateBp,
  status: row.status as MerchItemStatus,
  fulfillment: row.fulfillment as MerchOrderItemRecord['fulfillment'],
  seatLabel: row.seatLabel,
  shippedAt: row.shippedAt,
  deliveredAt: row.deliveredAt,
  pickedUpAt: row.pickedUpAt,
  returnRequestedAt: row.returnRequestedAt,
  returnResolvedAt: row.returnResolvedAt,
  refundedAmount: row.refundedAmount,
  eventEndsAt: row.eventEndsAt,
  ticketLinked: row.ticketLinked,
});

export class DrizzleMerchOrderStore implements MerchOrderStore {
  // 예매자 명단 원천(listAttendees·countAttendees)은 여기 두지 않는다. 운영은 purchase-svc 내부 HTTP다(A2-03, W7-audit A2-17)
  constructor(private readonly appDb: Database) {}

  async listSettlementItems(from: string, to: string): Promise<ProductSettlementItem[]> {
    // 상품 정산서는 주 단위로 계산하므로 기준일 후보를 넓게 읽고 도메인 함수로 거른다.
    const rows = await this.appDb.transaction(async (tx) =>
      tx
        .select({
          item: merchOrderItem,
          order: merchOrder,
        })
        .from(merchOrderItem)
        .innerJoin(merchOrder, eq(merchOrder.id, merchOrderItem.orderId)),
    );
    const byOrder = new Map<string, { order: MerchOrderRecord; items: MerchOrderItemRecord[] }>();
    for (const { item: itemRow, order: orderRow } of rows) {
      const order = toOrder(orderRow);
      const group = byOrder.get(order.orderId) ?? { order, items: [] };
      group.items.push(toItem(itemRow));
      byOrder.set(order.orderId, group);
    }
    const out: ProductSettlementItem[] = [];
    for (const { order, items } of byOrder.values()) {
      for (const row of productSettlementItems(items, order)) if (row.basisDate >= from && row.basisDate <= to) out.push(row);
    }
    return out.sort((a, b) => a.basisDate.localeCompare(b.basisDate) || a.itemId.localeCompare(b.itemId));
  }

  async insertOrder(order: MerchOrderRecord, items: readonly MerchOrderItemRecord[]): Promise<void> {
    await this.appDb.transaction(async (tx) => {
      await tx.insert(merchOrder).values({
        id: order.orderId,
        promoterId: order.promoterId,
        eventId: order.eventId,
        buyerName: order.buyerName,
        buyerPhone: order.buyerPhone,
        status: order.status,
        pg: order.pg,
        pgStore: order.pgStore,
        shippingFee: order.shippingFee,
        purchaseConfirmedAt: order.purchaseConfirmedAt,
        orderedAt: order.orderedAt,
      });
      if (items.length > 0) {
        await tx.insert(merchOrderItem).values(
          items.map((i) => ({
            id: i.itemId,
            orderId: i.orderId,
            promoterId: i.promoterId,
            eventId: i.eventId,
            productId: i.productId,
            productName: i.productName,
            quantity: i.quantity,
            unitAmount: i.unitAmount,
            commissionRateBp: i.commissionRateBp,
            status: i.status,
            fulfillment: i.fulfillment,
            seatLabel: i.seatLabel,
            ticketLinked: i.ticketLinked,
            shippedAt: i.shippedAt,
            deliveredAt: i.deliveredAt,
            pickedUpAt: i.pickedUpAt,
            returnRequestedAt: i.returnRequestedAt,
            returnResolvedAt: i.returnResolvedAt,
            refundedAmount: i.refundedAmount,
            eventEndsAt: i.eventEndsAt,
          })),
        );
      }
    });
  }
}
