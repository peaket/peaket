// F-07-2 주문 내역의 순수 규칙(domain/order-history.ts) 단위 시험.
// 정본: openapi GET /v1/orders·GET /v1/orders/{orderId}(OrderSummary·OrderDetail), docs/design/d5 §5.29, docs/frontend.md §5.29.
// 계획: docs/review/plans/F-07-2.md. 판정 항목 J-T30 ①②(주문 내역 목록·상세).
import { describe, expect, test } from 'vitest';
import {
  BOOKING_NUMBER_PATTERN,
  HISTORY_LIMIT_DEFAULT,
  HISTORY_LIMIT_MAX,
  bookingNumberOf,
  decodeOrderHistoryCursor,
  encodeOrderHistoryCursor,
  historyIssueDelayed,
  historyVisible,
  orderHistoryDetailOf,
  orderHistoryPageOf,
  orderHistorySummaryOf,
  tiersOf,
  type OrderHistoryOrder,
} from '../src/modules/booking/index.js';

// UUIDv7 시각이 2026-10-14T03:00:00Z(12:00 KST)인 주문 ID
const ORDER_A = '01a1385a-3b80-7000-8000-000000000001';
const ORDER_B = '01a13d80-9780-7000-8000-000000000002';

const orderOf = (over: Partial<OrderHistoryOrder> = {}): OrderHistoryOrder => ({
  orderId: ORDER_A,
  accountId: 'acc-1',
  eventId: 'evt-1',
  status: 'CONFIRMED',
  amount: 132_000,
  createdAt: new Date('2026-10-14T03:00:00.000Z'),
  failureReason: null,
  items: [
    { lineNo: 1, seatId: 'seat-1', tierId: 'R', unitPrice: 66_000, ticketId: 'tkt-1' },
    { lineNo: 2, seatId: 'seat-2', tierId: 'R', unitPrice: 66_000, ticketId: 'tkt-2' },
  ],
  cancellations: [],
  ...over,
});

describe('F-07-2 주문 내역 순수 규칙', () => {
  test('ORD-HIST ① 표시 번호는 주문 ID에서 결정적으로 만든 13자리이고 주문마다 다르다', () => {
    const a = bookingNumberOf(ORDER_A);
    expect(a).toMatch(BOOKING_NUMBER_PATTERN);
    expect(a).toHaveLength(13);
    expect(bookingNumberOf(ORDER_A)).toBe(a);
    expect(bookingNumberOf(ORDER_B)).not.toBe(a);
    // UUIDv7 앞 48비트의 시각(2026-10-14 KST)이 앞 8자리에 온다 [가정]
    expect(a.slice(0, 8)).toBe('20261014');
  });

  test('ORD-HIST ① 결제를 접수하지 않아 만료된 EXPIRED만 목록에서 뺀다', () => {
    expect(historyVisible('EXPIRED')).toBe(false);
    for (const status of ['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'CONFIRMED', 'FAILED', 'COMPENSATED', 'PARTIALLY_REFUNDED', 'REFUNDED'] as const) {
      expect(historyVisible(status)).toBe(true);
    }
  });

  test('ORD-HIST ④ 커서는 createdAt과 주문 ID를 왕복하고, 깨진 커서는 undefined다', () => {
    const at = new Date('2026-10-14T03:00:00.000Z');
    const cursor = encodeOrderHistoryCursor(at, ORDER_A);
    expect(decodeOrderHistoryCursor(cursor)).toEqual({ createdAt: at, orderId: ORDER_A });
    for (const bad of ['', 'not-base64', Buffer.from('nope', 'utf8').toString('base64url'), Buffer.from('2026-10-14T03:00:00.000Z', 'utf8').toString('base64url')]) {
      expect(decodeOrderHistoryCursor(bad)).toBeUndefined();
    }
  });

  test('ORD-HIST ④ 다음 커서는 한 페이지를 가득 채웠을 때만 있고, 모자라면 없다', () => {
    const at = new Date('2026-10-14T03:00:00.000Z');
    const rows = [orderOf({ orderId: ORDER_A, createdAt: at }), orderOf({ orderId: ORDER_B, createdAt: new Date('2026-10-13T03:00:00.000Z') })];
    expect(orderHistoryPageOf(rows, { limit: 1, nowMs: at.getTime() }).nextCursor).toBe(encodeOrderHistoryCursor(rows[0]!.createdAt, ORDER_A));
    expect(orderHistoryPageOf(rows, { limit: 2, nowMs: at.getTime() }).nextCursor).toBeNull();
    expect(orderHistoryPageOf([], { limit: 2, nowMs: at.getTime() })).toEqual({ items: [], nextCursor: null });
  });

  test('ORD-HIST ⑤ 등급별 매수는 등급 이름으로 묶고, 이름이 없으면 등급 ID를 쓴다', () => {
    const rows = [
      { lineNo: 1, seatId: 'seat-1', tierId: 'R', unitPrice: 66_000, ticketId: null },
      { lineNo: 2, seatId: 'seat-2', tierId: 'R', unitPrice: 66_000, ticketId: null },
      { lineNo: 3, seatId: 'seat-3', tierId: 'S', unitPrice: 33_000, ticketId: null },
    ];
    expect(tiersOf(rows, { R: 'R석', S: 'S석' })).toEqual([
      { tierName: 'R석', quantity: 2 },
      { tierName: 'S석', quantity: 1 },
    ]);
    expect(tiersOf(rows)).toEqual([
      { tierName: 'R', quantity: 2 },
      { tierName: 'S', quantity: 1 },
    ]);
    // 정본의 20개 상한(openapi tiers maxItems 20)
    const many = Array.from({ length: 25 }, (_, i) => ({ lineNo: i + 1, seatId: `seat-${i}`, tierId: `T${i}`, unitPrice: 1_000, ticketId: null }));
    expect(tiersOf(many)).toHaveLength(20);
  });

  test('ORD-HIST ② 요약은 금액·상태·취소 이력을 싣고, 60초가 지난 APPROVED만 발권 지연이다', () => {
    const createdAt = new Date('2026-10-14T03:00:00.000Z');
    const summary = orderHistorySummaryOf(orderOf({ createdAt }), { nowMs: createdAt.getTime() + 59_999 });
    expect(summary.issueDelayed).toBe(false);
    expect(historyIssueDelayed('APPROVED', createdAt.getTime(), createdAt.getTime() + 60_000)).toBe(true);
    expect(historyIssueDelayed('CONFIRMED', createdAt.getTime(), createdAt.getTime() + 60_000)).toBe(false);
    expect(summary).toMatchObject({ orderId: ORDER_A, amount: 132_000, status: 'CONFIRMED', refundPending: false, virtualAccount: null });
    expect(summary.failureReason).toBeNull();
    const refunding = orderHistorySummaryOf(
      orderOf({
        cancellations: [
          { cancellationId: 'can-1', ticketId: 'tkt-1', requestedAt: new Date('2026-10-15T00:00:00.000Z'), deductionAmount: 6_600, refundAmount: 59_400, refundDueAt: null, status: 'REFUND_PENDING', refundAccountRequired: false },
        ],
      }),
      { nowMs: createdAt.getTime() },
    );
    expect(refunding.refundPending).toBe(true);
  });

  test('ORD-HIST ③ 상세는 좌석 이름·등급 이름을 판에서 붙이고, 없으면 좌석 ID·등급 ID로 떨어진다', () => {
    const base = orderOf();
    const withLabels = orderHistoryDetailOf(base, {
      nowMs: base.createdAt.getTime(),
      contextOf: () => ({
        title: 'LUMEN 콘서트 2026 서울',
        startsAtMs: Date.parse('2026-10-25T09:00:00.000Z'),
        entryOpensAtMs: Date.parse('2026-10-25T08:00:00.000Z'),
      }),
      seatLabels: [{ label: 'A구역 3열 12', tierName: 'R석' }, { label: 'A구역 3열 13', tierName: 'R석' }],
    });
    expect(withLabels).toMatchObject({ eventTitle: 'LUMEN 콘서트 2026 서울' });
    expect(withLabels.seats).toEqual([
      { seatLabel: 'A구역 3열 12', tierName: 'R석', unitPrice: 66_000, gateZone: null, ticketId: 'tkt-1' },
      { seatLabel: 'A구역 3열 13', tierName: 'R석', unitPrice: 66_000, gateZone: null, ticketId: 'tkt-2' },
    ]);
    const without = orderHistoryDetailOf(base, { nowMs: base.createdAt.getTime() });
    expect(without.seats[0]).toMatchObject({ seatLabel: 'seat-1', tierName: 'R', ticketId: 'tkt-1' });
    expect(without.entryOpensAt).toBeNull();
  });

  test('ORD-HIST ① 기본/최대 limit은 정본 값이다', () => {
    expect(HISTORY_LIMIT_DEFAULT).toBe(20);
    expect(HISTORY_LIMIT_MAX).toBe(100);
  });
});
