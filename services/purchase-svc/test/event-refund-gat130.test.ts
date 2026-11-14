// 회차 취소 일괄 환불 GAT-130 잔여(자동 정지·연기 신청 창·백그라운드 실행기·팬 알림) 단위 시험.
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundAttemptStore, MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { OutboxEventRefundFanNotifier } from '../src/modules/refund/adapters/outbox-event-refund-fan-notifier.js';
import { CancelTicketEventRefund } from '../src/modules/refund/application/cancel-ticket-event-refund.js';
import type { CancelTicket } from '../src/modules/refund/application/cancel-ticket.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { EventRefundAlert, EventRefundCanceller, EventRefundFailureNotice, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';
import { compensationAmount, eventRefundCancellationId, progressOf, type EventRefundAttempt, type EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';

const NOW = Date.parse('2026-11-15T01:00:00.000Z');
const DAY = 86_400_000;
const REQUEST = '0193a000-0000-7000-8000-000000000001';
const EVENT = '0193a000-0000-7000-8000-000000000002';
const T1 = '0193a000-0000-7000-8000-000000000011';
const T2 = '0193a000-0000-7000-8000-000000000012';

const target = (ticketId: string, over: Partial<EventRefundTarget> = {}): EventRefundTarget => ({
  orderId: `order-${ticketId}`,
  ticketId,
  seatId: `seat-${ticketId}`,
  payerAccountId: '0193a000-0000-7000-8000-000000000007',
  ticketPrice: 10_000,
  bookedAtMs: NOW - DAY,
  saleEndsAtMs: NOW + 7 * DAY,
  pg: 'TOSS',
  ...over,
});

const fixture = (o: { targets?: EventRefundTarget[]; outcomes?: Array<'REFUNDED' | 'REFUND_PENDING' | 'FAILED'>; attempts?: MemoryEventRefundAttemptStore; alert?: EventRefundAlert; fan?: boolean } = {}) => {
  let now = NOW;
  const store = new MemoryEventRefundStore();
  const attempts = o.attempts ?? new MemoryEventRefundAttemptStore();
  const calls: Parameters<EventRefundCanceller['cancel']>[] = [];
  const notices: Parameters<EventRefundFailureNotice['open']>[0][] = [];
  const raises: Parameters<EventRefundAlert['raise']>[0][] = [];
  let i = 0;
  const outcomes = o.outcomes ?? [];
  const canceller: EventRefundCanceller = {
    cancel: async (t, q) => {
      calls.push([t, q]);
      const status = outcomes[i++] ?? 'REFUNDED';
      return status === 'FAILED' ? { status, error: 'REJECTED' } : { status };
    },
  };
  const targets: EventRefundTargets = { list: async () => o.targets ?? [target(T1)] };
  const service = new EventRefundService({
    store,
    targets,
    canceller,
    attempts,
    ...(o.fan === false ? {} : { fanNotifier: new OutboxEventRefundFanNotifier() }),
    notice: { open: async (q) => void notices.push(q) },
    alert: o.alert ?? { raise: async (q) => void raises.push(q) },
    nowMs: () => now,
    deadlineMs: () => now + 5_000,
    concurrency: 2,
  });
  return { store, attempts, service, calls, notices, raises, setNow: (ms: number) => (now = ms) };
};

const seed = (attempts: MemoryEventRefundAttemptStore, rows: Array<Partial<EventRefundAttempt> & { outcome: EventRefundAttempt['outcome']; amount?: number; atMs?: number }>) => {
  for (const r of rows) {
    attempts.attempts.push({ requestId: REQUEST, ticketId: T1, pg: 'TOSS', amount: r.amount ?? 10_000, outcome: r.outcome, atMs: r.atMs ?? NOW - 1_000 });
  }
};

const start = (service: EventRefundService, over: Record<string, unknown> = {}) =>
  service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', ...over });

describe('GAT-130 자동 정지', () => {
  test('R-T9_1분_창_실패율_5퍼센트면_그_결제사_몫을_멈추고_경보를_남긴다', async () => {
    const attempts = new MemoryEventRefundAttemptStore();
    seed(attempts, [...Array.from({ length: 19 }, () => ({ outcome: 'SUCCESS' as const })), { outcome: 'FAILURE' as const }]);
    const f = fixture({ attempts });
    const r = await start(f.service);
    expect(f.calls).toHaveLength(0);
    expect(r.status).toBe('PAUSED');
    expect(r.progress.perPg[0]).toMatchObject({ pg: 'TOSS', state: 'PAUSED', pauseReason: 'AUTO_FAILURE_RATE' });
    expect(f.raises[0]).toMatchObject({ severity: 'SEV2', reason: 'AUTO_FAILURE_RATE', pg: 'TOSS' });
    expect(f.raises[0]!.detail).toMatchObject({ failureRateBp: 500 });
  });

  test('R-T9_연속_실패_20건이면_멈춘다', async () => {
    const attempts = new MemoryEventRefundAttemptStore();
    seed(attempts, Array.from({ length: 20 }, () => ({ outcome: 'FAILURE' as const, atMs: NOW - 120_000 })));
    const f = fixture({ attempts });
    const r = await start(f.service);
    expect(f.calls).toHaveLength(0);
    expect(r.progress.perPg[0]).toMatchObject({ state: 'PAUSED', pauseReason: 'AUTO_CONSECUTIVE_FAILURES' });
  });

  test('R-T9_1분_창_실패_금액_500만원이면_멈춘다', async () => {
    const attempts = new MemoryEventRefundAttemptStore();
    seed(attempts, [...Array.from({ length: 99 }, () => ({ outcome: 'SUCCESS' as const })), { outcome: 'FAILURE' as const, amount: 6_000_000 }]);
    const f = fixture({ attempts });
    const r = await start(f.service);
    expect(f.calls).toHaveLength(0);
    expect(r.progress.perPg[0]).toMatchObject({ state: 'PAUSED', pauseReason: 'AUTO_FAILED_AMOUNT' });
  });

  test('R-T22 ④_업무_거절률_5퍼센트면_작업_전체를_멈춘다', async () => {
    const attempts = new MemoryEventRefundAttemptStore();
    seed(attempts, [...Array.from({ length: 94 }, () => ({ outcome: 'SUCCESS' as const })), ...Array.from({ length: 6 }, () => ({ outcome: 'REJECT' as const }))]);
    const f = fixture({ attempts, targets: [target(T1), target(T2, { pg: 'PORTONE' })] });
    const r = await start(f.service);
    expect(f.calls).toHaveLength(0);
    expect(r.status).toBe('PAUSED');
    expect(r.progress.perPg.map((p) => [p.pg, p.pauseReason])).toEqual([
      ['PORTONE', 'AUTO_REJECT_RATE'],
      ['TOSS', 'AUTO_REJECT_RATE'],
    ]);
  });

  test('R-T22 ②_자동_정지_뒤_수동_재개는_남은_호출을_다시_시도한다', async () => {
    const attempts = new MemoryEventRefundAttemptStore();
    seed(attempts, [...Array.from({ length: 19 }, () => ({ outcome: 'SUCCESS' as const })), { outcome: 'FAILURE' as const }]);
    const f = fixture({ attempts, outcomes: ['REFUNDED'] });
    await start(f.service);
    attempts.attempts.length = 0;
    const resumed = await f.service.resume({ requestId: REQUEST, pg: 'TOSS', reason: '결제사 정상 확인' });
    expect(f.calls).toHaveLength(1);
    expect(resumed.status).toBe('COMPLETED');
  });

  test('R-T22 ①_작업_전체를_수동으로_멈추면_새_호출을_보내지_않는다', async () => {
    const f = fixture({ outcomes: ['REFUND_PENDING', 'REFUND_PENDING'] });
    await start(f.service);
    const calls = f.calls.length;
    const paused = await f.service.pause({ requestId: REQUEST, reason: '작업 전체 정지' });
    expect(paused.status).toBe('PAUSED');
    expect(paused.progress.perPg[0]).toMatchObject({ state: 'PAUSED', pauseReason: 'MANUAL' });
    expect(await f.service.runDue()).toMatchObject({ processed: 0 });
    expect(f.calls).toHaveLength(calls);
  });

  test('R-T22 ⑤_재개_뒤에도_자동_정지_기준이_남아_있으면_바로_다시_멈춘다', async () => {
    const attempts = new MemoryEventRefundAttemptStore();
    seed(attempts, [...Array.from({ length: 19 }, () => ({ outcome: 'SUCCESS' as const })), { outcome: 'FAILURE' as const }]);
    const f = fixture({ attempts });
    await start(f.service);
    const resumed = await f.service.resume({ requestId: REQUEST, pg: 'TOSS', reason: '일단 재개' });
    expect(resumed.status).toBe('PAUSED');
    expect(f.calls).toHaveLength(0);
  });
});

describe('GAT-130 연기 신청 창', () => {
  test('GAT130_연기는_신청한_티켓만_환급하고_창이_닫히면_미신청을_NOT_APPLIED로_끝낸다', async () => {
    const f = fixture({ targets: [target(T1), target(T2)] });
    const r = await start(f.service, { kind: 'POSTPONE', postponedToMs: NOW + 7 * DAY, refundWindowClosesAtMs: NOW + 3 * DAY });
    expect(r.status).toBe('REFUND_WINDOW');
    expect(r.progress.perPg[0]).toMatchObject({ state: 'REFUND_WINDOW', notApplied: 0 });
    expect(f.calls).toHaveLength(0);
    const applied = await f.service.apply({ requestId: REQUEST, ticketId: T1 });
    expect(applied.progress).toMatchObject({ total: 2, done: 1, notApplied: 0 });
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]![1].reason).toBe('EVENT_POSTPONED');
    const closed = await f.service.closeWindow({ requestId: REQUEST, closedBy: 'commander-1', reason: '신청 기한 종료' });
    expect(closed.status).toBe('COMPLETED');
    expect(closed.progress).toMatchObject({ total: 2, done: 1, notApplied: 1 });
    expect(closed.progress.perPg[0]).toMatchObject({ notApplied: 1 });
    await expect(f.service.apply({ requestId: REQUEST, ticketId: T2 })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('GAT130_신청_창이_지나면_백그라운드_실행기가_닫고_신청_건은_이어서_환급한다', async () => {
    const f = fixture({ targets: [target(T1), target(T2)] });
    await start(f.service, { kind: 'POSTPONE', postponedToMs: NOW + 7 * DAY, refundWindowClosesAtMs: NOW + 3 * DAY });
    await f.service.apply({ requestId: REQUEST, ticketId: T1 });
    f.setNow(NOW + 4 * DAY);
    const tick = await f.service.runDue();
    expect(tick).toMatchObject({ closedWindows: 1 });
    const after = await f.service.get(REQUEST);
    expect(after.status).toBe('COMPLETED');
    expect(after.progress).toMatchObject({ total: 2, done: 1, notApplied: 1 });
  });

  test('GAT130_같은_요청_ID로_종류를_바꾸면_409다', async () => {
    const f = fixture();
    await start(f.service);
    await expect(start(f.service, { kind: 'POSTPONE', postponedToMs: NOW + DAY })).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});

describe('GAT-130 백그라운드 실행기·팬 알림', () => {
  test('GAT130_결과_모름은_다음_재시도_시각_전에는_실행기가_건드리지_않는다', async () => {
    const f = fixture({ outcomes: ['REFUND_PENDING', 'REFUNDED'] });
    const r = await start(f.service);
    expect(r.status).toBe('RUNNING');
    expect(r.progress).toMatchObject({ total: 1, done: 0 });
    expect(await f.service.runDue()).toMatchObject({ processed: 0 });
    f.setNow(NOW + 61_000);
    expect(await f.service.runDue()).toMatchObject({ processed: 1 });
    expect((await f.service.get(REQUEST)).status).toBe('COMPLETED');
  });

  test('GAT130_팬_알림은_Outbox에_확정·환급_완료를_남긴다', async () => {
    const f = fixture();
    await start(f.service);
    const types = f.store.outbox.map((m) => (JSON.parse(Buffer.from(m.payload).toString('utf8')) as { type: string }).type);
    expect(types).toEqual(['EVENT_CANCELLATION_CONFIRMED', 'REFUNDED']);
    const refunded = JSON.parse(Buffer.from(f.store.outbox[1]!.payload).toString('utf8')) as { refundAmount: number; eventKey: string };
    expect(refunded.refundAmount).toBe(10_000);
    expect(refunded.eventKey).toBeTruthy();
  });

  test('GAT130_환급_실패는_CS_알림과_팬_실패_알림을_함께_남긴다', async () => {
    const f = fixture({ outcomes: ['FAILED'] });
    await start(f.service);
    expect(f.notices).toHaveLength(1);
    const types = f.store.outbox.map((m) => (JSON.parse(Buffer.from(m.payload).toString('utf8')) as { type: string }).type);
    expect(types).toContain('REFUND_FAILED');
  });

  test('GAT130_연기_확정_알림은_바뀐_일시와_신청_창_닫힘을_싣는다', async () => {
    const f = fixture({ targets: [target(T1)] });
    await start(f.service, { kind: 'POSTPONE', postponedToMs: NOW + 7 * DAY, refundWindowClosesAtMs: NOW + 3 * DAY });
    const msg = JSON.parse(Buffer.from(f.store.outbox[0]!.payload).toString('utf8')) as { type: string; postponedTo: string; refundWindowClosesAt: string };
    expect(msg.type).toBe('EVENT_POSTPONED');
    expect(msg.postponedTo).toBe(new Date(NOW + 7 * DAY).toISOString());
    expect(msg.refundWindowClosesAt).toBe(new Date(NOW + 3 * DAY).toISOString());
  });

  test('GAT130_같은_요청_티켓의_취소_ID는_재시도에도_같고_티켓마다_다르다', () => {
    expect(eventRefundCancellationId(REQUEST, T1)).toBe(eventRefundCancellationId(REQUEST, T1));
    expect(eventRefundCancellationId(REQUEST, T1)).not.toBe(eventRefundCancellationId(REQUEST, T2));
  });

  test('GAT130_배상금은_10퍼센트_올림이고_불가항력은_0이다', () => {
    expect(compensationAmount(33_333, 'ORGANIZER')).toBe(3_334);
    expect(compensationAmount(33_333, 'CONTENT_CHANGE')).toBe(3_334);
    expect(compensationAmount(33_333, 'FORCE_MAJEURE')).toBe(0);
  });

  test('GAT130_진행률은_NOT_APPLIED를_결제사_몫과_전체에_센다', () => {
    const p = progressOf([
      { requestId: REQUEST, orderId: 'o1', ticketId: T1, cancellationId: 'c1', pg: 'TOSS', status: 'REFUNDED', attempts: 0 },
      { requestId: REQUEST, orderId: 'o2', ticketId: T2, cancellationId: 'c2', pg: 'TOSS', status: 'NOT_APPLIED', attempts: 0 },
    ]);
    expect(p).toMatchObject({ total: 2, done: 1, notApplied: 1, perPg: [{ pg: 'TOSS', done: 1, notApplied: 1 }] });
  });

  test('GAT130_신청과_창_닫기는_먼저_온_쪽만_남긴다', async () => {
    const f = fixture({ targets: [target(T1), target(T2)] });
    await start(f.service, { kind: 'POSTPONE', postponedToMs: NOW + 7 * DAY, refundWindowClosesAtMs: NOW + 3 * DAY });
    expect(await f.store.markApplied(REQUEST, T1, NOW)).toBe(true);
    expect(await f.store.markApplied(REQUEST, T1, NOW + 1)).toBe(false);
    await f.service.closeWindow({ requestId: REQUEST, closedBy: 'commander-1', reason: '기한 종료' });
    expect(await f.store.markApplied(REQUEST, T2, NOW + 2)).toBe(false);
    expect(await f.store.markNotApplied(REQUEST, T2)).toBe(false);
    expect((await f.store.items(REQUEST)).find((x) => x.ticketId === T1)).toMatchObject({ appliedAtMs: NOW });
    expect((await f.store.items(REQUEST)).find((x) => x.ticketId === T2)).toMatchObject({ status: 'NOT_APPLIED' });
  });

  test('GAT130_연기_취소_실행기는_EVENT_POSTPONED_사유를_그대로_넘긴다', async () => {
    let seen: Parameters<CancelTicket['execute']>[0] | undefined;
    const adapter = new CancelTicketEventRefund({
      execute: async (i: Parameters<CancelTicket['execute']>[0]) => {
        seen = i;
        return { status: 'ACCEPTED', cancellationId: i.cancellationId, refundAmount: 10_000, refundAfterEntryClose: false };
      },
    } as unknown as CancelTicket);
    const r = await adapter.cancel(target(T1), { requestId: REQUEST, cancellationId: '0193a000-0000-7000-8000-000000000099', reason: 'EVENT_POSTPONED', nowMs: NOW, deadlineMs: NOW + 1 });
    expect(r.status).toBe('REFUNDED');
    expect(seen?.reason).toBe('EVENT_POSTPONED');
  });
});
