// 회차 취소 전용 표 취소기와 갈래(BAT-420 GAT-110 E, R-T24, docs/features/transfer-refund.md §5 '대상 선택과 보류 취소 전환', ADR-0280 결정 3).
// 견적을 부르지 않고(공제 0, 권면 전액), 좌석 되돌리기 포트가 아예 없으며, 보류 취소(REQUESTED)는 그 행을 조건부로 이어 쓴다.
// 대역만 쓰는 단위 시험이다. 실제 ticket-svc·DB로 여섯 가지 표를 도는 것은 test-int/event-cancel-r-t24.int.test.ts다. 시험 담당이 구현 전에 썼다(ADR-0270).
import { describe, expect, test } from 'vitest';
import {
  EventRefundCancellerRouter,
  EventTicketCanceller,
  WeekendBusinessCalendar,
  type CancellationRecord,
  type CancellationWriteOutcome,
  type EventRefundCanceller,
  type EventRefundTarget,
  type PaymentCancelOutcome,
} from '../src/modules/refund/index.js';

const NOW = Date.parse('2026-11-16T10:00:00+09:00');
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const REQUEST = '0194c000-0000-7000-8000-000000000001';
const ORDER = '0194c000-0000-7000-8000-000000000002';
const TICKET = '0194c000-0000-7000-8000-000000000003';
const CANCEL_ID = '0194c000-0000-7000-8000-000000000004';
const PENDING_ID = '0194c000-0000-7000-8000-000000000005';

/** 공연 시작 시각으로 대상 표를 만든다(판매 종료 = 공연 시작 − 24시간) */
const targetOf = (startsAtMs: number, over: Partial<EventRefundTarget> = {}): EventRefundTarget => ({
  orderId: ORDER,
  ticketId: TICKET,
  seatId: '0194c000-0000-7000-8000-000000000006',
  payerAccountId: '0194c000-0000-7000-8000-000000000007',
  ticketPrice: 33_333,
  bookedAtMs: NOW - 20 * DAY,
  saleEndsAtMs: startsAtMs - DAY,
  pg: 'TOSS',
  ...over,
});
const q = (cancellationId = CANCEL_ID) => ({ requestId: REQUEST, cancellationId, reason: 'EVENT_CANCELLED' as const, nowMs: NOW, deadlineMs: 5_000 });

function fixture(o: {
  ticket?: 'CANCELED' | 'ALREADY_ENDED' | 'throw';
  convert?: 'CONVERTED' | 'NOT_REQUESTED';
  existing?: CancellationRecord;
  write?: CancellationWriteOutcome;
  payment?: PaymentCancelOutcome;
} = {}) {
  const log: string[] = [];
  const ticketCalls: Record<string, unknown>[] = [];
  const conversions: Record<string, unknown>[] = [];
  const creates: Record<string, unknown>[] = [];
  const pays: Record<string, unknown>[] = [];
  const statuses: Record<string, unknown>[] = [];
  const canceller = new EventTicketCanceller({
    tickets: {
      eventCancel: async (x) => {
        log.push('ticket');
        ticketCalls.push({ ...x });
        if ((o.ticket ?? 'CANCELED') === 'throw') throw new Error('ticket-svc 14 UNAVAILABLE');
        return x.targets.map((t) => ({ ticketId: t.ticketId, result: (o.ticket ?? 'CANCELED') as 'CANCELED' | 'ALREADY_ENDED', orderId: ORDER, holderAccountId: '0194c000-0000-7000-8000-000000000008', transferWithdrawn: false }));
      },
    },
    conversions: {
      convert: async (x) => {
        log.push('convert');
        conversions.push({ ...x });
        return o.convert ?? 'CONVERTED';
      },
    },
    orders: {
      findByTicket: async () => {
        throw new Error('회차 취소 표 취소기는 견적용 주문 조회를 쓰지 않는다');
      },
      findCancellation: async () => o.existing,
    },
    writes: {
      create: async (x: Record<string, unknown>) => {
        log.push('create');
        creates.push({ ...x });
        return o.write ?? { status: 'CREATED' };
      },
      updateStatus: async (x: Record<string, unknown>) => {
        log.push('status');
        statuses.push({ ...x });
      },
    } as never,
    payments: {
      cancel: async (x) => {
        log.push('pay');
        pays.push({ ...x });
        return o.payment ?? 'CANCELLED';
      },
    },
    calendar: new WeekendBusinessCalendar(),
  });
  return { canceller, log, ticketCalls, conversions, creates, pays, statuses };
}

describe('회차 취소 전용 표 취소기 [BAT-420 GAT-110 E]', () => {
  test('R-T24 공연 시작 뒤에 확정해도 견적 없이 공제 0·권면 33,333원 전액으로 취소 행을 쓰고 결제사로 환급한다', async () => {
    const f = fixture();
    const r = await f.canceller.cancel(targetOf(NOW - HOUR), q());
    expect(r).toEqual({ status: 'REFUNDED' });
    expect(f.log).toEqual(['ticket', 'create', 'pay', 'status']);
    expect(f.ticketCalls).toHaveLength(1);
    expect(f.ticketCalls[0]).toMatchObject({ cancellationRequestId: REQUEST, targets: [{ ticketId: TICKET, cancellationId: CANCEL_ID }] });
    expect(f.creates).toEqual([
      expect.objectContaining({
        cancellationId: CANCEL_ID,
        orderId: ORDER,
        ticketId: TICKET,
        reason: 'EVENT_CANCELLED',
        daysBefore: 0,
        within24h: false,
        deductionBp: 0,
        deductionAmount: 0,
        refundAmount: 33_333,
        status: 'REFUND_PENDING',
        eventCancellationRequestId: REQUEST,
        actor: 'system:event-cancellation',
      }),
    ]);
    expect(f.creates[0]).not.toHaveProperty('refundDueAtMs');
    expect(f.pays).toEqual([expect.objectContaining({ cancellationId: CANCEL_ID, orderId: ORDER, amount: 33_333, reason: 'EVENT_CANCELLED' })]);
    expect(f.statuses).toEqual([expect.objectContaining({ cancellationId: CANCEL_ID, status: 'REFUNDED' })]);
  });

  test('R-T24 공연 3일 전 확정은 남은 달력일 3을 적고 여전히 공제 0이다(KST 달력일)', async () => {
    const f = fixture();
    await f.canceller.cancel(targetOf(Date.parse('2026-11-19T19:00:00+09:00')), q());
    expect(f.creates[0]).toMatchObject({ daysBefore: 3, within24h: false, deductionBp: 0, deductionAmount: 0, refundAmount: 33_333 });
  });

  test('GAT-110 E1 보류 취소가 아직 REQUESTED면 그 행을 전환해 그 행 ID로 권면 전액을 환급하고 표 취소·새 행 쓰기는 하지 않는다', async () => {
    const f = fixture({ convert: 'CONVERTED' });
    const r = await f.canceller.cancel(targetOf(NOW - HOUR, { pendingCancellationId: PENDING_ID }), q(PENDING_ID));
    expect(r).toEqual({ status: 'REFUNDED' });
    expect(f.conversions).toEqual([{ cancellationId: PENDING_ID, eventCancellationRequestId: REQUEST, refundAmount: 33_333, nowMs: NOW }]);
    expect(f.ticketCalls).toEqual([]);
    expect(f.creates).toEqual([]);
    expect(f.pays).toEqual([expect.objectContaining({ cancellationId: PENDING_ID, amount: 33_333, reason: 'EVENT_CANCELLED' })]);
  });

  test('GAT-110 E1 그사이 환급 실행기가 보류 취소를 집었으면(NOT_REQUESTED) FAILED cancellation-in-progress이고 결제사·표·행을 건드리지 않는다', async () => {
    const f = fixture({ convert: 'NOT_REQUESTED' });
    const r = await f.canceller.cancel(targetOf(NOW - HOUR, { pendingCancellationId: PENDING_ID }), q(PENDING_ID));
    expect(r).toEqual({ status: 'FAILED', error: 'cancellation-in-progress' });
    expect(f.log).toEqual(['convert']);
  });

  test('GAT-110 E2 티켓 단계가 실패하면 결제사로 보내지 않은 실패(NOT_SENT ticket-unavailable)다', async () => {
    const f = fixture({ ticket: 'throw' });
    expect(await f.canceller.cancel(targetOf(NOW + 3 * DAY), q())).toEqual({ status: 'NOT_SENT', error: 'ticket-unavailable' });
    expect(f.log).toEqual(['ticket']);
  });

  test('GAT-110 E2 이미 끝난 표는 그 취소 ID의 행이 없으면 FAILED ticket-already-ended, 있으면 그 행으로 결제사를 다시 부른다', async () => {
    const none = fixture({ ticket: 'ALREADY_ENDED' });
    expect(await none.canceller.cancel(targetOf(NOW + 3 * DAY), q())).toEqual({ status: 'FAILED', error: 'ticket-already-ended' });
    expect(none.pays).toEqual([]);
    expect(none.creates).toEqual([]);

    const existing: CancellationRecord = { cancellationId: CANCEL_ID, orderId: ORDER, ticketId: TICKET, refundAmount: 33_333, state: 'REFUND_PENDING', refundAttempts: 1 };
    const again = fixture({ ticket: 'ALREADY_ENDED', existing });
    expect(await again.canceller.cancel(targetOf(NOW + 3 * DAY), q())).toEqual({ status: 'REFUNDED' });
    expect(again.pays).toEqual([expect.objectContaining({ cancellationId: CANCEL_ID, amount: 33_333, reason: 'EVENT_CANCELLED' })]);
  });

  test('GAT-110 E2 취소 행이 겹치면 FAILED cancellation-conflict이고, 다시 부르기(REPLAYED)는 끝났으면 결제사를 부르지 않고 남았으면 다시 부른다', async () => {
    const conflict = fixture({ write: { status: 'CONFLICT' } });
    expect(await conflict.canceller.cancel(targetOf(NOW + 3 * DAY), q())).toEqual({ status: 'FAILED', error: 'cancellation-conflict' });
    expect(conflict.pays).toEqual([]);

    const done = fixture({ write: { status: 'REPLAYED', cancellationId: CANCEL_ID, refundAmount: 33_333, state: 'REFUNDED', refundAfterEntryClose: false, refundAttempts: 0 } });
    expect(await done.canceller.cancel(targetOf(NOW + 3 * DAY), q())).toEqual({ status: 'REFUNDED' });
    expect(done.pays).toEqual([]);

    const left = fixture({ write: { status: 'REPLAYED', cancellationId: CANCEL_ID, refundAmount: 33_333, state: 'REFUND_PENDING', refundAfterEntryClose: false, refundAttempts: 1 } });
    expect(await left.canceller.cancel(targetOf(NOW + 3 * DAY), q())).toEqual({ status: 'REFUNDED' });
    expect(left.pays).toHaveLength(1);
  });

  test('GAT-110 E2 결제사 업무 거절은 FAILED REJECTED이고 모름·대기는 REFUND_PENDING이며 환급 상태를 쓰지 않는다', async () => {
    const rejected = fixture({ payment: 'REJECTED' });
    expect(await rejected.canceller.cancel(targetOf(NOW + 3 * DAY), q())).toEqual({ status: 'FAILED', error: 'REJECTED' });
    expect(rejected.statuses).toEqual([]);
    for (const payment of ['UNKNOWN', 'PENDING'] as const) {
      const f = fixture({ payment });
      expect((await f.canceller.cancel(targetOf(NOW + 3 * DAY), q())).status, payment).toBe('REFUND_PENDING');
      expect(f.statuses).toEqual([]);
    }
  });
});

describe('일괄 환불 표 취소의 갈래 [BAT-420 GAT-110 E8]', () => {
  test('GAT-110 E8 회차 취소(EVENT_CANCELLED)는 전용 취소기로, 연기(EVENT_POSTPONED)는 예매 취소 Saga 쪽으로 보내고 답을 그대로 준다', async () => {
    const calls: string[] = [];
    const side = (name: string, status: 'REFUNDED' | 'REFUND_PENDING'): EventRefundCanceller => ({
      cancel: async (t, x) => {
        calls.push(`${name}:${t.ticketId}:${x.reason}`);
        return { status };
      },
    });
    const router = new EventRefundCancellerRouter({ cancel: side('cancel', 'REFUNDED'), postpone: side('postpone', 'REFUND_PENDING') });
    const target = targetOf(NOW + 3 * DAY);
    expect(await router.cancel(target, { ...q(), reason: 'EVENT_POSTPONED' })).toEqual({ status: 'REFUND_PENDING' });
    expect(calls).toEqual([`postpone:${TICKET}:EVENT_POSTPONED`]);
    expect(await router.cancel(target, q())).toEqual({ status: 'REFUNDED' });
    expect(calls).toEqual([`postpone:${TICKET}:EVENT_POSTPONED`, `cancel:${TICKET}:EVENT_CANCELLED`]);
  });
});
