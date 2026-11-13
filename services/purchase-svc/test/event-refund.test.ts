// 회차 취소 일괄 환불 첫 몫(BAT-425 GAT-120·GAT-130) 단위 시험.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import { compensationAmount, eventRefundCancellationId, progressOf, type EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';
import type { EventRefundCanceller, EventRefundFailureNotice, EventRefundStartInput, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';

const NOW = Date.parse('2026-11-14T05:00:00.000Z');
const REQUEST = '0193a000-0000-7000-8000-000000000001';
const EVENT = '0193a000-0000-7000-8000-000000000002';
const ORDER = '0193a000-0000-7000-8000-000000000003';
const TICKET = '0193a000-0000-7000-8000-000000000004';
const TICKET2 = '0193a000-0000-7000-8000-000000000005';

const target = (over: Partial<EventRefundTarget> = {}) => ({
  orderId: ORDER,
  ticketId: TICKET,
  seatId: '0193a000-0000-7000-8000-000000000006',
  payerAccountId: '0193a000-0000-7000-8000-000000000007',
  ticketPrice: 33_333,
  bookedAtMs: NOW - 86_400_000,
  saleEndsAtMs: NOW + 7 * 86_400_000,
  pg: 'TOSS' as const,
  ...over,
});

const fixture = (outcomes: Array<'REFUNDED' | 'REFUND_PENDING' | 'FAILED'> = []) => {
  const store = new MemoryEventRefundStore();
  const originalCreate = store.create.bind(store);
  let createCalls = 0;
  store.create = async (request, items) => {
    createCalls++;
    return originalCreate(request, items);
  };
  const targets: EventRefundTargets = { list: async () => [target(), target({ ticketId: TICKET2, pg: 'PORTONE', ticketPrice: 10_000 })] };
  const calls: Parameters<EventRefundCanceller['cancel']>[] = [];
  const notice: Parameters<EventRefundFailureNotice['open']>[0][] = [];
  let i = 0;
  const canceller: EventRefundCanceller = {
    cancel: async (t, q) => {
      calls.push([t, q]);
      const status = outcomes[i++] ?? 'REFUNDED';
      return status === 'FAILED' ? { status, error: 'REJECTED' } : { status };
    },
  };
  const service = new EventRefundService({
    store,
    targets,
    canceller,
    notice: { open: async (q) => void notice.push(q) },
    nowMs: () => NOW,
    deadlineMs: () => NOW + 5_000,
    concurrency: 2,
  });
  return { store, service, calls, notice, createCalls: () => createCalls };
};

const start = (service: EventRefundService, over: Partial<EventRefundStartInput> = {}) =>
  service.start({ eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER', ruledBy: 'commander-1', confirmedBy: 'operator-2', fanNoticeReason: '공연 취소', ...over });

describe('회차 취소 일괄 환불', () => {
  test('GAT120_미리보기는_대상_환급액과_결제사별_건수·예상시간을_센다', async () => {
    const f = fixture();
    const p = await f.service.preview({ eventId: EVENT, fault: 'ORGANIZER' });
    expect(p).toMatchObject({ targetOrders: 2, refundTotal: 43_333, compensationTargets: 2, compensationTotal: 3_334 + 1_000 });
    expect(p.perPg).toEqual([
      { pg: 'PORTONE', orders: 1, estimatedSeconds: 1 },
      { pg: 'TOSS', orders: 1, estimatedSeconds: 1 },
    ]);
  });

  test('GAT120_판정자와_확정자가_같으면_409이고_아무것도_쓰지_않는다', async () => {
    const f = fixture();
    await expect(start(f.service, { confirmedBy: 'commander-1' })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.store.requests.size).toBe(0);
  });

  test('GAT120_시작은_대상마다_기존_취소_Saga를_EVENT_CANCELLED로_부르고_진행률을_남긴다', async () => {
    const f = fixture();
    const r = await start(f.service);
    expect(r.status).toBe('COMPLETED');
    expect(r.progress).toMatchObject({ total: 2, done: 2, failed: 0 });
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]![1]).toMatchObject({ requestId: REQUEST, reason: 'EVENT_CANCELLED', cancellationId: eventRefundCancellationId(REQUEST, TICKET) });
    expect(f.calls[0]![0]).toMatchObject({ ticketId: TICKET, payerAccountId: target().payerAccountId });
    expect((await f.store.items(REQUEST)).map((i) => i.cancellationId)).toEqual([eventRefundCancellationId(REQUEST, TICKET), eventRefundCancellationId(REQUEST, TICKET2)]);
  });

  test('GAT120_같은_요청을_다시_시작하면_처음_결과를_주고_다시_부르지_않는다', async () => {
    const f = fixture();
    const a = await start(f.service);
    const b = await start(f.service);
    expect(b.requestId).toBe(a.requestId);
    expect(b.progress).toEqual(a.progress);
    expect(f.calls).toHaveLength(2);
    expect(f.createCalls()).toBe(1);
  });

  test('GAT130_부분_실패는_실패_건으로_남기고_CS_알림_포트를_부른다', async () => {
    const f = fixture(['REFUNDED', 'FAILED']);
    const r = await start(f.service);
    expect(r.progress).toMatchObject({ total: 2, done: 1, failed: 1 });
    expect(f.notice).toHaveLength(1);
    expect(f.notice[0]).toMatchObject({ requestId: REQUEST, ticketId: TICKET2, lastError: 'REJECTED' });
  });

  test('GAT130_결과_모름은_재개에서_같은_멱등키로_다시_시도한다', async () => {
    const f = fixture(['REFUND_PENDING', 'REFUNDED', 'REFUNDED']);
    const a = await start(f.service);
    expect(a.progress).toMatchObject({ total: 2, done: 1 });
    expect(a.status).toBe('RUNNING');
    const b = await f.service.resume({ requestId: REQUEST });
    expect(b.progress).toMatchObject({ total: 2, done: 2 });
    expect(b.status).toBe('COMPLETED');
    expect(f.calls[2]![1].cancellationId).toBe(eventRefundCancellationId(REQUEST, TICKET));
  });

  test('GAT130_수동_일시정지와_재개는_결제사_몫_상태와_사유를_남긴다', async () => {
    const f = fixture(['REFUND_PENDING', 'REFUNDED', 'REFUNDED']);
    await start(f.service);
    const paused = await f.service.pause({ requestId: REQUEST, pg: 'TOSS', reason: '결제사 장애' });
    expect(paused.status).toBe('PAUSED');
    expect(paused.progress.perPg.find((p) => p.pg === 'TOSS')).toMatchObject({ state: 'PAUSED', pauseReason: 'MANUAL' });
    const resumed = await f.service.resume({ requestId: REQUEST, pg: 'TOSS' });
    expect(resumed.status).toBe('COMPLETED');
    expect(resumed.progress.perPg.find((p) => p.pg === 'TOSS')).toMatchObject({ state: 'COMPLETED', done: 1 });
  });

  test('GAT130_같은_요청_ID로_회차나_판정을_바꾸면_409다', async () => {
    const f = fixture();
    await start(f.service);
    await expect(start(f.service, { eventId: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(start(f.service, { fault: 'FORCE_MAJEURE' })).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  test('GAT130_요청_ID가_UUID가_아니면_조회도_400이다', async () => {
    const f = fixture();
    await expect(f.service.get('not-a-uuid')).rejects.toMatchObject({ code: 'INVALID' });
  });

  test('GAT130_불가항력은_배상하지_않고_같은_요청·티켓의_취소_ID는_같다', () => {
    expect(compensationAmount(33_333, 'FORCE_MAJEURE')).toBe(0);
    expect(compensationAmount(33_333, 'CONTENT_CHANGE')).toBe(3_334);
    expect(eventRefundCancellationId(REQUEST, TICKET)).toBe(eventRefundCancellationId(REQUEST, TICKET));
    expect(eventRefundCancellationId(REQUEST, TICKET)).not.toBe(eventRefundCancellationId(REQUEST, TICKET2));
  });

  test('GAT130_진행률은_결제사_몫마다_완료·실패·결과모름을_센다', () => {
    const p = progressOf([
      { requestId: REQUEST, orderId: ORDER, ticketId: TICKET, cancellationId: 'c1', pg: 'TOSS', status: 'REFUNDED', attempts: 0 },
      { requestId: REQUEST, orderId: ORDER, ticketId: TICKET2, cancellationId: 'c2', pg: 'TOSS', status: 'FAILED', attempts: 1, lastError: 'REJECTED' },
    ]);
    expect(p).toMatchObject({ total: 2, done: 1, failed: 1, perPg: [{ pg: 'TOSS', state: 'COMPLETED', done: 1, failed: 1, unknown: 0 }] });
  });
});
