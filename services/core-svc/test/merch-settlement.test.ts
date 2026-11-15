// 상품 정산 배송비 시험(A1-H4/A2-10): 다품목 주문에서 배송비를 품목마다 더하지 않는다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { productSettlementItems, type MerchOrderItemRecord, type MerchOrderRecord } from '../src/modules/shop/index.js';

const ORDER = randomUUID();
const order: MerchOrderRecord = {
  orderId: ORDER,
  promoterId: randomUUID(),
  eventId: randomUUID(),
  buyerName: '김민수',
  buyerPhone: '010-1234-5678',
  status: 'PAID',
  pg: 'TOSS',
  pgStore: 'STANDARD',
  shippingFee: 3_000,
  purchaseConfirmedAt: null,
  orderedAt: new Date('2026-10-19T00:00:00Z'),
};
const item = (seatLabel: string): MerchOrderItemRecord => ({
  itemId: randomUUID(),
  orderId: ORDER,
  promoterId: order.promoterId,
  eventId: order.eventId,
  productId: randomUUID(),
  productName: '응원봉',
  quantity: 1,
  unitAmount: 10_000,
  commissionRateBp: 1000,
  status: 'DELIVERED',
  fulfillment: 'DELIVERY',
  seatLabel,
  shippedAt: new Date('2026-10-20T00:00:00Z'),
  deliveredAt: new Date('2026-10-22T00:00:00Z'),
  pickedUpAt: null,
  returnRequestedAt: null,
  returnResolvedAt: null,
  refundedAmount: 0,
  eventEndsAt: null,
  ticketLinked: false,
});

describe('상품 정산 배송비', () => {
  test('10,000원×2 + 배송 3,000원은 23,000원이고 배송비는 한 행에만 붙는다', () => {
    const rows = productSettlementItems([item('A-1'), item('A-2')], order);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((s, r) => s + r.grossAmount, 0)).toBe(23_000);
    expect(rows.filter((r) => r.grossAmount === 13_000)).toHaveLength(1);
    expect(rows.filter((r) => r.grossAmount === 10_000)).toHaveLength(1);
  });

  test('정산 대상이 아닌 첫 품목이 있으면 배송비는 정산 대상 첫 품목에 붙는다', () => {
    const rows = productSettlementItems([item('A-1'), { ...item('A-2'), status: 'CANCELLED' as const }], order);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.grossAmount).toBe(13_000);
  });
});
