// F-06-3 구현 재리뷰 3 IR-03·31·11 재현 시험(시험 담당, 2026-11-26).
// approval-basis가 취소 ID를 주문 ID로 풀고, 주문의 모든 티켓 가운데 하나라도 입장 기록이 있으면
// entryRecorded를 참으로 답하는지 본다. 첫 티켓만 보면 둘째 티켓의 입장을 놓친다.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { ApprovalBasisOrders } from '../src/modules/booking/application/approval-basis.js';
import type { CancellationOrderView, CancellationRecord } from '../src/modules/refund/domain/cancellation.js';
import type { CancellationOrders } from '../src/modules/refund/domain/ports.js';

const ORDER = randomUUID();
const CANCELLATION = randomUUID();
const FIRST = randomUUID();
const SECOND = randomUUID();
const EVENT = randomUUID();
const NOW = Date.parse('2026-11-26T10:00:00+09:00');

const row = (ticketId: string, over: Partial<CancellationOrderView> = {}): CancellationOrderView =>
  ({
    orderId: ORDER,
    eventId: EVENT,
    ticketId,
    seatId: randomUUID(),
    payerAccountId: randomUUID(),
    ticketPrice: 11_000,
    bookedAtMs: NOW - 86_400_000,
    saleEndsAtMs: NOW + 86_400_000,
    eventStartsAtMs: NOW + 172_800_000,
    orderStatus: 'CONFIRMED',
    paidAtMs: NOW - 86_000_000,
    refundableAmount: 11_000,
    entryRecorded: false,
    issueGeneration: 3,
    ...over,
  }) as CancellationOrderView & { issueGeneration?: number };

// 실제 `DrizzleCancellationOrders.byOrder`는 그 취소 티켓의 남은 환급액을 0으로 깎는다(진행 중 취소가 금액을 덮는다).
// 취소 ID로 부를 때는 그 취소 행의 환급액(11,000)만 답해야 하고, 다른 티켓의 12,000을 더하면 안 된다.
const rows = [row(FIRST, { refundableAmount: 0 }), row(SECOND, { entryRecorded: true, refundableAmount: 12_000, ticketPrice: 12_000 })];
const records = new Map<string, CancellationRecord>([[CANCELLATION, { cancellationId: CANCELLATION, orderId: ORDER, ticketId: FIRST, refundAmount: 11_000, state: 'REQUESTED', refundAttempts: 0 }]]);

const orders = {
  async byOrder(orderId: string) {
    return orderId === ORDER ? rows : [];
  },
  async findCancellation(cancellationId: string) {
    return records.get(cancellationId);
  },
  async cancellationsOf() {
    return [...records.values()];
  },
} as unknown as CancellationOrders;

const basis = new ApprovalBasisOrders(orders);

describe('IR-03·31 주문의 모든 티켓 입장 기록', () => {
  test('IR-03 둘째 티켓만 들어갔어도 entryRecorded가 참이고 주문 기준 남은 금액은 다른 티켓만이다', async () => {
    const b = await basis.basis(ORDER);
    expect(b).toMatchObject({ orderId: ORDER, entryRecorded: true, refundableAmount: 12_000 });
    expect(b?.eventStartsAt).toBe(new Date(NOW + 172_800_000).toISOString());
  });

  test('IR-11 취소 ID로 부르면 그 취소의 환급액만 답하고 다른 티켓 금액을 더하지 않는다', async () => {
    const b = await basis.basis(CANCELLATION);
    expect(b).toMatchObject({ orderId: ORDER, entryRecorded: true, refundableAmount: 11_000 });
  });

  test('IR-31 발권 세대를 승인 근거에 싣는다', async () => {
    const b = await basis.basis(ORDER);
    expect((b as { issueGeneration?: number } | undefined)?.issueGeneration).toBe(3);
  });
});
