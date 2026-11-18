// shop 주문·정산 원천 메모리 저장소(단위 시험·개발).
import type { MerchOrderStore } from '../domain/merch-ports.js';
import type { AttendeeRecord, MerchOrderItemRecord, MerchOrderRecord, ProductSettlementItem } from '../domain/merch.js';
import { productSettlementItems } from '../domain/merch.js';

export class MemoryMerchOrderStore implements MerchOrderStore {
  readonly orders = new Map<string, MerchOrderRecord>();
  readonly items = new Map<string, MerchOrderItemRecord>();

  async insertOrder(order: MerchOrderRecord, items: readonly MerchOrderItemRecord[]): Promise<void> {
    this.orders.set(order.orderId, { ...order });
    for (const item of items) this.items.set(item.itemId, { ...item });
  }

  #attendeeRows(promoterId: string, eventId: string): AttendeeRecord[] {
    const byOrder = new Map<string, AttendeeRecord>();
    for (const item of this.items.values()) {
      if (item.promoterId !== promoterId || item.eventId !== eventId) continue;
      const order = this.orders.get(item.orderId);
      if (!order || order.status !== 'PAID') continue;
      if (item.status === 'CANCELLED' || item.status === 'REFUNDED') continue;
      const current = byOrder.get(order.orderId);
      if (current) {
        current.quantity += item.quantity;
        if (item.seatLabel) current.seatLabel = current.seatLabel ? `${current.seatLabel}, ${item.seatLabel}` : item.seatLabel;
      } else {
        byOrder.set(order.orderId, { orderId: order.orderId, eventId, buyerName: order.buyerName ?? '', buyerPhone: order.buyerPhone ?? '', seatLabel: item.seatLabel, quantity: item.quantity });
      }
    }
    return [...byOrder.values()].sort((a, b) => a.orderId.localeCompare(b.orderId));
  }

  async listAttendees(promoterId: string, eventId: string, limit: number, cursor?: string): Promise<{ items: AttendeeRecord[]; nextCursor: string | null }> {
    const after = cursor ? Buffer.from(cursor, 'base64url').toString('utf8') : '';
    const rest = this.#attendeeRows(promoterId, eventId).filter((r) => after === '' || r.orderId > after);
    const items = rest.slice(0, limit);
    // 뒤에 주문이 더 있을 때만 다음 커서를 준다. 남은 것이 정확히 limit건이면 null이다(W7-audit A2-17, docs/api/guidelines.md §3)
    const nextCursor = rest.length > limit && items.length > 0 ? Buffer.from(items[items.length - 1]!.orderId).toString('base64url') : null;
    return { items, nextCursor };
  }

  async countAttendees(promoterId: string, eventId: string): Promise<{ bookings: number; tickets: number }> {
    const rows = this.#attendeeRows(promoterId, eventId);
    return { bookings: rows.length, tickets: rows.reduce((s, r) => s + r.quantity, 0) };
  }

  async listSettlementItems(from: string, to: string): Promise<ProductSettlementItem[]> {
    const byOrder = new Map<string, { order: MerchOrderRecord; items: MerchOrderItemRecord[] }>();
    for (const item of this.items.values()) {
      const order = this.orders.get(item.orderId);
      if (!order) continue;
      const group = byOrder.get(order.orderId) ?? { order, items: [] };
      group.items.push(item);
      byOrder.set(order.orderId, group);
    }
    const out: ProductSettlementItem[] = [];
    for (const { order, items } of byOrder.values()) {
      for (const row of productSettlementItems(items, order)) if (row.basisDate >= from && row.basisDate <= to) out.push(row);
    }
    return out.sort((a, b) => a.basisDate.localeCompare(b.basisDate) || a.itemId.localeCompare(b.itemId));
  }
}
