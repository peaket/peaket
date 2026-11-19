// 회차 취소 확정의 배상 행 만들기(BAT-425 R-T46 ①, FR-056, ADR-0046 결정 5, ADR-0317).
// 정본: docs/features/transfer-refund.md §6 '배상금 지급의 첫 구현', §11 R-T46 ①, docs/data.md compensation.
// - 주최 측 귀책(ORGANIZER)·공연 내용 변경(CONTENT_CHANGE)이면 대상 주문마다 한 행, 불가항력(FORCE_MAJEURE)은 0행.
// - 금액은 그 주문의 대상 표 권면 합의 10%를 원 미만 올림해 한 번만 계산한다(표마다 올림해 더하지 않는다).
// - 0원 주문은 행이 없다. 행은 ACCOUNT_PENDING 기본값·계좌/미수금 빈 칸으로 저장소가 쓴다(여기서는 도메인 행 모양을 본다).
import { describe, expect, test } from 'vitest';
import { compensationRowsOf } from '../src/modules/refund/domain/compensation.js';
import type { EventRefundFault, EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';

const NOW = Date.parse('2026-11-20T10:00:00.000Z');
const REQUEST = '0193b425-0000-7000-8000-000000000001';
const EVENT = '0193b425-0000-7000-8000-000000000002';
const ORDER_A = '0193b425-0000-7000-8000-0000000000a1';
const ORDER_B = '0193b425-0000-7000-8000-0000000000b1';
const ORDER_ZERO = '0193b425-0000-7000-8000-0000000000c1';
const ACCOUNT_A = '0193b425-0000-7000-8000-000000000011';
const ACCOUNT_B = '0193b425-0000-7000-8000-000000000012';

const target = (orderId: string, ticketId: string, ticketPrice: number, payerAccountId: string): EventRefundTarget => ({
  orderId,
  ticketId,
  seatId: `0193b425-0000-7000-8000-${ticketId.slice(-12)}`,
  payerAccountId,
  ticketPrice,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS',
});

/** 주문 A는 두 표 10,001+10,001=20,002(주문 단위 올림 2,001, 표마다면 2,002), 주문 B는 33,333(3,334), 주문 Z는 0원 */
const TARGETS: readonly EventRefundTarget[] = [
  target(ORDER_A, '0193b425-0000-7000-8000-0000000000d1', 10_001, ACCOUNT_A),
  target(ORDER_A, '0193b425-0000-7000-8000-0000000000d2', 10_001, ACCOUNT_A),
  target(ORDER_B, '0193b425-0000-7000-8000-0000000000d3', 33_333, ACCOUNT_B),
  target(ORDER_ZERO, '0193b425-0000-7000-8000-0000000000d4', 0, ACCOUNT_B),
];

function rowsOf(fault: EventRefundFault) {
  let n = 0;
  return compensationRowsOf({ requestId: REQUEST, eventId: EVENT, fault, targets: TARGETS, nowMs: NOW, idOf: () => `0193b425-0000-7000-8000-${String(++n).padStart(12, '0')}` });
}

describe('R-T46 ① 배상 행 만들기 [단위]', () => {
  test('R-T46 ①_주최_측_귀책이면_대상_주문마다_한_행이고_금액은_주문_단위_권면_합의_10퍼센트를_원_미만_올림한_값이다', () => {
    const rows = rowsOf('ORGANIZER');
    expect(rows.map((r) => ({ orderId: r.orderId, accountId: r.accountId, baseAmount: r.baseAmount, amount: r.amount }))).toEqual([
      { orderId: ORDER_A, accountId: ACCOUNT_A, baseAmount: 20_002, amount: 2_001 },
      { orderId: ORDER_B, accountId: ACCOUNT_B, baseAmount: 33_333, amount: 3_334 },
    ]);
    expect(new Set(rows.map((r) => r.id)).size).toBe(2);
    expect(rows.every((r) => r.eventCancellationRequestId === REQUEST && r.eventId === EVENT && r.createdAtMs === NOW && r.updatedAtMs === NOW)).toBe(true);
    // 도메인 행에는 상태·계좌·미수금이 없다. 저장소가 ACCOUNT_PENDING·빈 칸으로 쓴다(B13)
    for (const r of rows) {
      expect(r).not.toHaveProperty('status');
      expect(r).not.toHaveProperty('accountLast4');
      expect(r).not.toHaveProperty('receivableId');
      expect(r).not.toHaveProperty('transferId');
    }
  });

  test('R-T46 ①_공연_내용_변경도_같은_계산이고_표마다_올림해_더하지_않는다(20,002원은_2,001원이다)', () => {
    expect(rowsOf('CONTENT_CHANGE').map((r) => [r.orderId, r.amount])).toEqual([
      [ORDER_A, 2_001],
      [ORDER_B, 3_334],
    ]);
  });

  test('R-T46 ①_불가항력이면_대상이_있어도_행이_0이고_0원_주문은_어느_사유에도_행이_없다', () => {
    expect(rowsOf('FORCE_MAJEURE')).toEqual([]);
    for (const fault of ['ORGANIZER', 'CONTENT_CHANGE'] as const) {
      expect(rowsOf(fault).map((r) => r.orderId)).not.toContain(ORDER_ZERO);
    }
  });
});
