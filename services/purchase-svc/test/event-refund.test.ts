// 회차 취소 일괄 환불 첫 몫(BAT-425 GAT-120·GAT-130) 단위 시험.
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import { compensationAmount, eventRefundCancellationId, progressOf, type EventRefundTarget } from '../src/modules/refund/domain/event-refund.js';
import type { EventRefundCanceller, EventRefundFailureNotice, EventRefundStartInput, EventRefundTargets } from '../src/modules/refund/domain/event-refund-ports.js';
import { EventTicketCanceller, MemoryEventRefundAttemptStore, WeekendBusinessCalendar, eventRefundPreviewOf } from '../src/modules/refund/index.js';

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
    // BAT-420(2026-11-16, 시험 담당): 정본(transfer-refund §5 '판정·미리보기·확정의 차례')이 주문 단위로 바뀌었다.
    // 이 대역의 두 표는 같은 주문(ORDER)이라 대상 주문 1, 배상은 주문의 표 권면 합 43,333원의 10% 올림 4,334원 한 번이다.
    const f = fixture();
    const p = await f.service.preview({ eventId: EVENT, fault: 'ORGANIZER' });
    expect(p).toMatchObject({ targetOrders: 1, refundTotal: 43_333, compensationTargets: 1, compensationTotal: 4_334 });
    expect([...p.perPg].sort((a, b) => a.pg.localeCompare(b.pg))).toEqual([
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
    // 두 표는 같은 주문(ORDER)이다. 앞 표가 결과 모름이면 그 주문의 나머지는 이번 실행에서 미룬다(리뷰 B4, docs/data.md §5 '같은 주문', docs/features/payment.md §4.1 '한 번에 하나씩')
    const f = fixture(['REFUND_PENDING', 'REFUNDED', 'REFUNDED']);
    const a = await start(f.service);
    expect(a.progress).toMatchObject({ total: 2, done: 0 });
    expect(a.status).toBe('RUNNING');
    expect(f.calls.map(([t]) => t.ticketId)).toEqual([TICKET]);
    const b = await f.service.resume({ requestId: REQUEST });
    expect(b.progress).toMatchObject({ total: 2, done: 2 });
    expect(b.status).toBe('COMPLETED');
    // 재개는 앞 표를 같은 멱등키로 먼저 다시 하고, 끝난 뒤에 같은 주문의 둘째 표를 한다
    expect(f.calls.map(([t]) => t.ticketId)).toEqual([TICKET, TICKET, TICKET2]);
    expect(f.calls[1]![1].cancellationId).toBe(eventRefundCancellationId(REQUEST, TICKET));
    expect(f.calls[1]![1].cancellationId).toBe(f.calls[0]![1].cancellationId);
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

  test('B1-04_같은_회차에_진행_중_요청이_있으면_새_요청은_CONFLICT다', async () => {
    const f = fixture();
    const first = await start(f.service, { kind: 'POSTPONE', postponedToMs: NOW + 7 * 86_400_000, refundWindowClosesAtMs: NOW + 3 * 86_400_000 });
    expect(first.status).toBe('REFUND_WINDOW');
    await expect(start(f.service, { requestId: randomUUID() })).rejects.toMatchObject({ code: 'CONFLICT' });
    expect(f.store.requests.size).toBe(1);
  });
});

// ---- BAT-420(시험 담당, 구현 전에 씀): 주문 단위 미리보기(E6, R-T37 ①), 보류 취소 항목의 취소 ID(E1), 즉시 실패 까닭(E1·E2), 티켓 단계 실패(E7) ----
describe('회차 취소 일괄 환불 BAT-420 [GAT-110 E]', () => {
  const ORDER_A = '0194c100-0000-7000-8000-00000000000a';
  const ORDER_B = '0194c100-0000-7000-8000-00000000000b';
  const ORDER_C = '0194c100-0000-7000-8000-00000000000c';
  /** 정본 R-T37 ①의 회차: 표 둘인 주문 하나(TOSS)와 표 하나인 주문 둘(PORTONE), 권면 33,333원 */
  const rt37 = () => [
    target({ orderId: ORDER_A, ticketId: '0194c100-0000-7000-8000-0000000000a1', pg: 'TOSS' }),
    target({ orderId: ORDER_A, ticketId: '0194c100-0000-7000-8000-0000000000a2', pg: 'TOSS' }),
    target({ orderId: ORDER_B, ticketId: '0194c100-0000-7000-8000-0000000000b1', pg: 'PORTONE' }),
    target({ orderId: ORDER_C, ticketId: '0194c100-0000-7000-8000-0000000000c1', pg: 'PORTONE' }),
  ];
  const sortedPg = (p: { perPg: readonly { pg: string }[] }) => [...p.perPg].sort((a, b) => a.pg.localeCompare(b.pg));

  test('GAT-110 E6 R-T37 ① 미리보기는 주문 단위로 세고 배상은 주문마다 대상 표 권면 합에 한 번 올림한다', () => {
    const organizer = eventRefundPreviewOf(rt37(), 'ORGANIZER');
    expect(organizer).toMatchObject({ targetOrders: 3, refundTotal: 133_332, compensationTargets: 3, compensationTotal: 13_335 });
    expect(sortedPg(organizer)).toEqual([
      { pg: 'PORTONE', orders: 2, estimatedSeconds: 1 },
      { pg: 'TOSS', orders: 1, estimatedSeconds: 1 },
    ]);
    expect(eventRefundPreviewOf(rt37(), 'CONTENT_CHANGE')).toMatchObject({ compensationTargets: 3, compensationTotal: 13_335 });
    expect(eventRefundPreviewOf(rt37(), 'FORCE_MAJEURE')).toMatchObject({ targetOrders: 3, refundTotal: 133_332, compensationTargets: 0, compensationTotal: 0 });
    expect(eventRefundPreviewOf([], 'ORGANIZER')).toEqual({ targetOrders: 0, refundTotal: 0, compensationTargets: 0, compensationTotal: 0, perPg: [] });
  });

  test('GAT-110 E6 예상 시간은 그 결제사의 대상 표 수 ÷ 초당 300건 올림이다(300장 1초·301장 2초, 주문 수로 나누지 않는다)', () => {
    const tickets = (n: number) => Array.from({ length: n }, (_, i) => target({ orderId: ORDER_A, ticketId: `0194c200-0000-7000-8000-${String(i).padStart(12, '0')}`, pg: 'TOSS' }));
    expect(eventRefundPreviewOf(tickets(300), 'FORCE_MAJEURE').perPg).toEqual([{ pg: 'TOSS', orders: 1, estimatedSeconds: 1 }]);
    expect(eventRefundPreviewOf(tickets(301), 'FORCE_MAJEURE').perPg).toEqual([{ pg: 'TOSS', orders: 1, estimatedSeconds: 2 }]);
    expect(eventRefundPreviewOf(tickets(1), 'FORCE_MAJEURE').perPg).toEqual([{ pg: 'TOSS', orders: 1, estimatedSeconds: 1 }]);
  });

  test('GAT-110 E6 서비스의 미리보기와 시작이 저장한 합계가 같은 주문 단위 셈이다', async () => {
    const store = new MemoryEventRefundStore();
    const service = new EventRefundService({
      store,
      targets: { list: async () => rt37() },
      canceller: { cancel: async () => ({ status: 'REFUNDED' }) },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    expect(await service.preview({ eventId: EVENT, fault: 'ORGANIZER' })).toMatchObject({ targetOrders: 3, compensationTargets: 3, compensationTotal: 13_335 });
    const started = await start(service);
    expect(started).toMatchObject({ targetOrders: 3, refundTotal: 133_332, compensationTargets: 3, compensationTotal: 13_335 });
  });

  test('GAT-110 E1 보류 취소가 있는 표의 항목 취소 ID는 그 취소 행 ID이고 나머지는 요청·표로 정해진 값이다', async () => {
    const pendingId = '0194c100-0000-7000-8000-0000000000f1';
    const calls: string[] = [];
    const store = new MemoryEventRefundStore();
    const service = new EventRefundService({
      store,
      targets: { list: async () => [target({ pendingCancellationId: pendingId }), target({ ticketId: TICKET2, orderId: ORDER_B })] },
      canceller: { cancel: async (t, q) => (calls.push(`${t.ticketId}:${q.cancellationId}`), { status: 'REFUNDED' }) },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    await start(service);
    const items = new Map((await store.items(REQUEST)).map((i) => [i.ticketId, i.cancellationId]));
    expect(items.get(TICKET)).toBe(pendingId);
    expect(items.get(TICKET2)).toBe(eventRefundCancellationId(REQUEST, TICKET2));
    expect(calls.sort()).toEqual([`${TICKET}:${pendingId}`, `${TICKET2}:${eventRefundCancellationId(REQUEST, TICKET2)}`].sort());
  });

  // cancellation-in-progress(전환에서 진 항목)는 OPEN[45] 결정으로 일반 알림 대신 차액 건 하나만 연다(아래 GAT-110 D7)
  test.each(['ticket-already-ended', 'cancellation-conflict'])(
    'GAT-110 E1 즉시 실패 까닭 %s는 재시도 없이 FAILED로 끝내고 CS 일괄 환불 실패를 한 번 연다',
    async (error) => {
      const store = new MemoryEventRefundStore();
      const notices: Parameters<EventRefundFailureNotice['open']>[0][] = [];
      let calls = 0;
      const service = new EventRefundService({
        store,
        targets: { list: async () => [target()] },
        canceller: { cancel: async () => (calls++, { status: 'FAILED', error }) },
        notice: { open: async (q) => void notices.push(q) },
        nowMs: () => NOW,
        deadlineMs: () => NOW + 5_000,
      });
      await start(service);
      const [item] = await store.items(REQUEST);
      expect(item).toMatchObject({ status: 'FAILED', lastError: error });
      expect(item!.nextAttemptAtMs).toBeUndefined();
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ ticketId: TICKET, lastError: error });
      await service.runDue();
      expect(calls).toBe(1);
    },
  );

  test('GAT-110 E7 티켓 단계 실패(ticket-svc 무응답)는 결제사 호출로 세지 않아 20번 연속이어도 자동 정지가 없고 5회를 넘기면 FAILED다', async () => {
    let now = NOW;
    const store = new MemoryEventRefundStore();
    const attempts = new MemoryEventRefundAttemptStore();
    const alerts: string[] = [];
    const notices: string[] = [];
    let ticketCalls = 0;
    let payCalls = 0;
    const targets = Array.from({ length: 20 }, (_, i) =>
      target({ orderId: `0194c300-0000-7000-8000-${String(i).padStart(12, '0')}`, ticketId: `0194c301-0000-7000-8000-${String(i).padStart(12, '0')}`, pg: 'TOSS' }),
    );
    const canceller = new EventTicketCanceller({
      tickets: {
        eventCancel: async () => {
          ticketCalls++;
          throw new Error('ticket-svc 14 UNAVAILABLE');
        },
      },
      conversions: { convert: async () => 'CONVERTED' },
      orders: { findByTicket: async () => undefined, findCancellation: async () => undefined },
      writes: { create: async () => ({ status: 'CREATED' }) } as never,
      payments: { cancel: async () => (payCalls++, 'CANCELLED') },
      calendar: new WeekendBusinessCalendar(),
    });
    const service = new EventRefundService({
      store,
      targets: { list: async () => targets },
      canceller,
      attempts,
      alert: { raise: async (q) => void alerts.push(q.reason) },
      notice: { open: async (q) => void notices.push(q.ticketId) },
      nowMs: () => now,
      deadlineMs: () => now + 5_000,
      concurrency: 4,
    });
    const started = await start(service);
    expect(ticketCalls).toBe(20);
    expect(payCalls).toBe(0);
    expect(attempts.attempts).toEqual([]);
    expect(alerts).toEqual([]);
    expect(started.status).toBe('RUNNING');
    const items = await store.items(REQUEST);
    expect(items.every((i) => i.status === 'UNKNOWN' && i.attempts === 1 && i.nextAttemptAtMs === NOW + 60_000)).toBe(true);
    // 재시도 간격을 지나며 네 번 더(1분·5분·15분·1시간 뒤) 부르면 시도 5회로 FAILED다
    for (const wait of [60_000, 5 * 60_000, 15 * 60_000, 60 * 60_000]) {
      now += wait;
      await service.runDue();
    }
    expect(attempts.attempts).toEqual([]);
    expect(alerts).toEqual([]);
    const after = await store.items(REQUEST);
    expect(after.every((i) => i.status === 'FAILED' && i.attempts === 5)).toBe(true);
    expect(notices).toHaveLength(20);
  });
});

describe('회차 취소 확정 때 남는 공제 차액 CS 건 [BAT-420 몫 D, OPEN[45]]', () => {
  const ENTRY_OPENS = NOW - 3_600_000;
  const GAP = { cancellationId: '0194c600-0000-7000-8000-0000000000d1', orderId: '0194c600-0000-7000-8000-0000000000d2', ticketId: '0194c600-0000-7000-8000-0000000000d3', deductionAmount: 29_999 };
  type GapOpen = Parameters<NonNullable<ConstructorParameters<typeof EventRefundService>[0]['gapNotice']>['open']>[0];
  // 보충 2(af7bde64): 입장 시작 시각은 대상 표가 아니라 회차 판매 설정(configs)에서 읽는다. 대상 표에는 일부러 입장 시작을 싣지 않는다
  const gapFixture = (opts: { entryOpensAtMs?: number; rows?: () => readonly (typeof GAP)[]; targets?: readonly EventRefundTarget[] } = {}) => {
    const store = new MemoryEventRefundStore();
    const lists: [string, number][] = [];
    const gapOpens: GapOpen[] = [];
    const notices: Parameters<EventRefundFailureNotice['open']>[0][] = [];
    const warns: { o: object; msg: string }[] = [];
    const configCalls: string[] = [];
    let payCalls = 0;
    const entryOpensAtMs = 'entryOpensAtMs' in opts ? opts.entryOpensAtMs : ENTRY_OPENS;
    const service = new EventRefundService({
      store,
      targets: { list: async () => opts.targets ?? [target()] },
      canceller: { cancel: async () => (payCalls++, { status: 'REFUNDED' }) },
      notice: { open: async (q) => void notices.push(q) },
      gaps: { list: async (eventId, at) => (lists.push([eventId, at]), opts.rows ? opts.rows() : [GAP]) },
      gapNotice: { open: async (q) => void gapOpens.push(q) },
      configs: { config: async (eventId) => (configCalls.push(eventId), { saleEndsAtMs: NOW + 7 * 86_400_000, ...(entryOpensAtMs !== undefined ? { entryOpensAtMs } : {}) }) },
      log: { warn: (o, msg) => void warns.push({ o, msg }) },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    return { store, service, lists, gapOpens, notices, warns, configCalls, payCalls: () => payCalls };
  };

  test('R-T38 ④ 확정(CANCEL 시작)은 입장 시작 뒤 공제하고 나간 취소마다 차액 건을 한 번 열고 결제사를 더 부르지 않는다', async () => {
    const f = gapFixture();
    await start(f.service);
    expect(f.lists).toEqual([[EVENT, ENTRY_OPENS]]);
    expect(f.gapOpens).toEqual([{ cancellationId: GAP.cancellationId, orderId: GAP.orderId, deductionAmount: 29_999, requestId: REQUEST, nowMs: NOW }]);
    // 차액 건은 결제사 호출이 아니다: 대상 표 한 장의 환불만 있다
    expect(f.payCalls()).toBe(1);
    expect(f.notices).toEqual([]);
  });

  test('R-T38 ④ 같은 요청으로 다시 시작하면 차액 건을 다시 열지 않는다', async () => {
    const f = gapFixture();
    await start(f.service);
    await start(f.service);
    expect(f.gapOpens).toHaveLength(1);
  });

  test('R-T38 ④ 연기(POSTPONE)와 입장 시작이 없는 회차는 차액 건을 찾지 않는다', async () => {
    const postponed = gapFixture();
    await start(postponed.service, { kind: 'POSTPONE', postponedToMs: NOW + 7 * 86_400_000, refundWindowClosesAtMs: NOW + 3 * 86_400_000 });
    expect(postponed.lists).toEqual([]);
    expect(postponed.gapOpens).toEqual([]);
    const noEntry = gapFixture({ entryOpensAtMs: undefined });
    await start(noEntry.service);
    expect(noEntry.lists).toEqual([]);
    expect(noEntry.gapOpens).toEqual([]);
    // 대조: 입장 시작이 있으면 찾는다(위 두 줄이 뼈대의 예외로 지나가지 않게)
    const control = gapFixture();
    await start(control.service);
    expect(control.lists).toHaveLength(1);
  });

  test('R-T38 ④ 대상 표가 없어도(남은 표가 모두 이미 공제 환급됨) 판매 설정의 입장 시작으로 차액을 찾고, 설정에 입장 시작이 없으면 찾지 않고 경고 한 번이다(보충 2)', async () => {
    const empty = gapFixture({ targets: [] });
    await start(empty.service);
    expect(empty.configCalls).toContain(EVENT);
    expect(empty.lists).toEqual([[EVENT, ENTRY_OPENS]]);
    expect(empty.gapOpens).toEqual([{ cancellationId: GAP.cancellationId, orderId: GAP.orderId, deductionAmount: 29_999, requestId: REQUEST, nowMs: NOW }]);
    expect(empty.payCalls()).toBe(0);
    const noEntry = gapFixture({ targets: [], entryOpensAtMs: undefined });
    await start(noEntry.service);
    expect(noEntry.lists).toEqual([]);
    expect(noEntry.gapOpens).toEqual([]);
    expect(noEntry.warns).toHaveLength(1);
    expect(JSON.stringify(noEntry.warns[0])).toContain(EVENT);
    // 대상 표에 입장 시작이 실려 있어도 설정에 없으면 찾지 않는다(설정이 정본)
    const targetOnly = gapFixture({ targets: [target({ entryOpensAtMs: ENTRY_OPENS })], entryOpensAtMs: undefined });
    await start(targetOnly.service);
    expect(targetOnly.lists).toEqual([]);
  });

  test('GAT-110 D7 전환에서 진 항목(cancellation-in-progress)은 그 행 공제액으로 차액 건(그 취소 하나)만 열고 일반 일괄 환불 실패 알림은 열지 않는다', async () => {
    const pendingId = '0194c600-0000-7000-8000-0000000000e1';
    const store = new MemoryEventRefundStore();
    const gapOpens: GapOpen[] = [];
    const notices: Parameters<EventRefundFailureNotice['open']>[0][] = [];
    let claimed = false;
    let calls = 0;
    const service = new EventRefundService({
      store,
      targets: { list: async () => [target({ pendingCancellationId: pendingId })] },
      configs: { config: async () => ({ saleEndsAtMs: NOW + 7 * 86_400_000, entryOpensAtMs: ENTRY_OPENS }) },
      // 시작 도중 마감 뒤 환급 실행기가 그 보류 취소를 먼저 집었다(공제 29,999로 결제사에 보냄)
      canceller: { cancel: async () => (calls++, (claimed = true), { status: 'FAILED', error: 'cancellation-in-progress' }) },
      notice: { open: async (q) => void notices.push(q) },
      gaps: { list: async () => (claimed ? [{ cancellationId: pendingId, orderId: ORDER, ticketId: TICKET, deductionAmount: 29_999 }] : []) },
      gapNotice: { open: async (q) => void gapOpens.push(q) },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    await start(service);
    const [item] = await store.items(REQUEST);
    expect(item).toMatchObject({ status: 'FAILED', lastError: 'cancellation-in-progress' });
    expect(notices).toEqual([]);
    // CS 건 하나 = 그 취소 하나(eventKey가 취소 ID로 정해져 ops가 한 건으로 모은다). 확정 때 차액 찾기와 진 항목이 같은 행을 둘 다 볼 수 있어 호출 수는 1 이상을 받는다
    expect(gapOpens.length).toBeGreaterThanOrEqual(1);
    for (const g of gapOpens) expect(g).toEqual({ cancellationId: pendingId, orderId: ORDER, deductionAmount: 29_999, requestId: REQUEST, nowMs: NOW });
    // 즉시 실패라 다시 시도하지 않는다(E1과 같다)
    expect(item!.nextAttemptAtMs).toBeUndefined();
    const opened = gapOpens.length;
    await service.runDue();
    expect(calls).toBe(1);
    expect(gapOpens).toHaveLength(opened);
  });
});

// ---- BAT-420 리뷰 D5(시험 담당, 구현 전에 씀, 계획 §11 보충 3, transfer-refund §5 '확정 뒤 팬 취소') ----
describe('확정과 겹친 팬 공제 환급의 차액 건 [BAT-420 리뷰 D5]', () => {
  const FAN = '0194c700-0000-7000-8000-0000000000f1';
  type GapOpen = Parameters<NonNullable<ConstructorParameters<typeof EventRefundService>[0]['gapNotice']>['open']>[0];
  const overlap = async (error: 'ticket-already-ended' | 'cancellation-conflict', fan: { deductionAmount: number } | undefined) => {
    const store = new MemoryEventRefundStore();
    const gapOpens: GapOpen[] = [];
    const notices: Parameters<EventRefundFailureNotice['open']>[0][] = [];
    const asked: string[] = [];
    const service = new EventRefundService({
      store,
      targets: { list: async () => [target()] },
      // 확정 뒤 그 표를 처리하기 전에 팬 취소가 끼어들어 끝냈다(키 폐기·공제 환급)
      canceller: { cancel: async () => ({ status: 'FAILED', error }) },
      notice: { open: async (q) => void notices.push(q) },
      gaps: {
        list: async () => [],
        forTicket: async (ticketId) => (asked.push(ticketId), fan ? { cancellationId: FAN, orderId: ORDER, ticketId, deductionAmount: fan.deductionAmount } : undefined),
      },
      gapNotice: { open: async (q) => void gapOpens.push(q) },
      nowMs: () => NOW,
      deadlineMs: () => NOW + 5_000,
    });
    await start(service);
    return { store, gapOpens, notices, asked };
  };

  test.each(['ticket-already-ended', 'cancellation-conflict'] as const)(
    'GAT-110 R5 항목이 %s로 끝나고 그 표에 공제 3,333원인 진행 중 팬 취소(USER)가 있으면 일반 실패 대신 그 취소의 차액 건 하나다',
    async (error) => {
      const r = await overlap(error, { deductionAmount: 3_333 });
      expect(r.asked).toContain(TICKET);
      expect(r.notices).toEqual([]);
      expect(r.gapOpens.length).toBeGreaterThanOrEqual(1);
      for (const g of r.gapOpens) expect(g).toEqual({ cancellationId: FAN, orderId: ORDER, deductionAmount: 3_333, requestId: REQUEST, nowMs: NOW });
      const [item] = await r.store.items(REQUEST);
      expect(item).toMatchObject({ status: 'FAILED', lastError: error });
    },
  );

  test('GAT-110 R5 대조: 그 표의 팬 취소가 공제 0원이거나 없으면 차액 건 없이 지금처럼 일반 일괄 환불 실패 하나다(경계: 공제 > 0만)', async () => {
    for (const fan of [{ deductionAmount: 0 }, undefined]) {
      const r = await overlap('ticket-already-ended', fan);
      expect(r.gapOpens, JSON.stringify(fan)).toEqual([]);
      expect(r.notices, JSON.stringify(fan)).toHaveLength(1);
      expect(r.notices[0]).toMatchObject({ ticketId: TICKET, lastError: 'ticket-already-ended' });
    }
  });
});
