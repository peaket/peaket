// A1-H4/A2-10 회귀: 상품 정산에서 주문 배송비를 품목마다 더하지 않고 주문에 한 번만 더한다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { productSettlementItem, productSettlementItems, type MerchOrderItemRecord, type MerchOrderRecord } from '../src/modules/shop/index.js';

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

const item = (seatLabel: string, status: MerchOrderItemRecord['status'] = 'DELIVERED'): MerchOrderItemRecord => ({
  itemId: randomUUID(),
  orderId: ORDER,
  promoterId: order.promoterId,
  eventId: order.eventId,
  productId: randomUUID(),
  productName: '응원봉',
  quantity: 1,
  unitAmount: 10_000,
  commissionRateBp: 1000,
  status,
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

describe('A1-H4/A2-10 상품 정산 배송비', () => {
  test('세 품목 10,000원×3 + 배송 3,000원은 33,000원이고 배송비는 한 행에만 붙는다', () => {
    const rows = productSettlementItems([item('A-1'), item('A-2'), item('A-3')], order);
    expect(rows).toHaveLength(3);
    expect(rows.reduce((s, r) => s + r.grossAmount, 0)).toBe(33_000);
    expect(rows.filter((r) => r.grossAmount === 13_000)).toHaveLength(1);
    expect(rows.filter((r) => r.grossAmount === 10_000)).toHaveLength(2);
  });

  test('단품 계산 함수의 기본값은 배송비를 더하지 않는다(주문 단위 함수가 한 번만 더한다)', () => {
    expect(productSettlementItem(item('A-1'), order)!.grossAmount).toBe(10_000);
    expect(productSettlementItems([item('A-1')], order)[0]!.grossAmount).toBe(13_000);
  });

  test('배송비가 0원이면 어느 행에도 더하지 않는다', () => {
    const rows = productSettlementItems([item('A-1'), item('A-2')], { ...order, shippingFee: 0 });
    expect(rows.map((r) => r.grossAmount)).toEqual([10_000, 10_000]);
  });

  test('정산 대상이 아닌 품목이 앞에 있어도 배송비는 정산 대상 첫 품목에 한 번만 붙는다', () => {
    const rows = productSettlementItems([item('A-1', 'CANCELLED'), item('A-2'), item('A-3')], order);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.grossAmount)).toEqual([13_000, 10_000]);
    expect(rows.reduce((s, r) => s + r.grossAmount, 0)).toBe(23_000);
  });
});
