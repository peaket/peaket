// W9-fix1 환급 실행기 후속(GAT-110 N3·N8·P3) 단위 재현 시험. 시험 담당 w9f1-test가 구현 전에 썼다(계획 docs/review/plans/W9-fix1.md §3).
// N3 잡기 늘리기: 표가 여럿인 느린 주문은 표를 보내기 직전 남은 잡기 기한이 40초 [가정]보다 짧으면 살아 있는 잡기만 지금 + 60초 [가정]로 늘리고, 0행이면 보내지 않는다.
// N8 멈춤 합치기: 결제사 몫의 멈춤은 요청 행을 잠근 DB 값에 더하고 빼서만 쓴다. 실행 끝은 새 자동 정지만 더하고, 빼기는 재개뿐이다.
// P3 그 밖 실패(업무 거절 목록 밖, 시도 상한 전)의 FAILED도 팬 REFUND_FAILED 알림을 같은 끝내기 쓰기에 남긴다.
// 정본: docs/features/transfer-refund.md §5 '잡기 늘리기'·'멈춤 표시는 합쳐 쓴다'·'주인', docs/data.md event_refund_item.claimed_until·§5.
// 단언 값은 정본 값(60,000·40,000·30,000ms, 사유 이름)을 적고 코드 상수를 가져오지 않는다. 실제 SQL의 잡기·잠금은 test-int가 본다.
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundAttemptStore, MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { OutboxEventRefundFanNotifier } from '../src/modules/refund/adapters/outbox-event-refund-fan-notifier.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { CsCaseOutbox, EventRefundCanceller, EventRefundClaims, EventRefundServiceDeps } from '../src/modules/refund/domain/event-refund-ports.js';
import {
  eventRefundCancellationId,
  mergePauses,
  progressOf,
  type EventCancellationRequest,
  type EventRefundItem,
  type EventRefundTarget,
  type RefundPauseReason,
  type RefundPgProvider,
} from '../src/modules/refund/domain/event-refund.js';

const NOW = Date.parse('2026-11-21T09:00:00.000Z');
const DAY = 86_400_000;
const REQUEST = '0194d100-0000-7000-8000-000000000001';
const EVENT = '0194d100-0000-7000-8000-000000000002';
const uuid = (n: number) => `0194d100-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
const O1 = uuid(0x101);
const O2 = uuid(0x102);
const O3 = uuid(0x103);
const O4 = uuid(0x104);
const T1 = uuid(0x201);
const T2 = uuid(0x202);
const T3 = uuid(0x203);
const T4 = uuid(0x204);

const target = (orderId: string, ticketId: string, pg: RefundPgProvider = 'TOSS'): EventRefundTarget => ({
  orderId,
  ticketId,
  seatId: `seat-${ticketId}`,
  payerAccountId: '0194d100-0000-7000-8000-000000000007',
  ticketPrice: 10_000,
  bookedAtMs: NOW - DAY,
  saleEndsAtMs: NOW + 7 * DAY,
  pg,
});
const startInput = { eventId: EVENT, requestId: REQUEST, fault: 'ORGANIZER' as const, ruledBy: 'commander-1', confirmedBy: 'operator-2' };
const cid = (ticketId: string) => eventRefundCancellationId(REQUEST, ticketId);
const claimLost = (warns: readonly { o: object; msg: string }[]) => warns.filter((w) => JSON.stringify(w).includes('event-refund-item-claim-lost')).length;
/** 저장된 진행률의 멈춘 결제사와 사유(결제사 이름 차례) */
const pausedIn = (store: MemoryEventRefundStore): [RefundPgProvider, RefundPauseReason | undefined][] =>
  (store.requests.get(REQUEST)?.progress.perPg ?? [])
    .filter((p) => p.state === 'PAUSED')
    .map((p): [RefundPgProvider, RefundPauseReason | undefined] => [p.pg, p.pauseReason])
    .sort(([a], [b]) => a.localeCompare(b));

/**
 * 주문 단위 잡기 대역(메모리 저장소 위). 실제 DrizzleEventRefundClaims의 규칙을 따른다: 요청이 실행 중(RUNNING·REFUND_WINDOW)일 때만,
 * 멈춘 결제사가 아닌 처리할 항목(PENDING·UNKNOWN, 신청됨, 다음 시각 지남)이 있고 그 주문의 어떤 항목도 살아 있는 잡기(기한 > 지금)가 없으며
 * 재시도를 기다리는 결과 모름이 없는 주문만 잡는다(기한 = 지금 + 60초). 끝내기는 잡기 값이 같고 끝나지 않은 항목만 쓴다(기한은 보지 않는다).
 * 늘리기는 같은 잡기 값·기한 > 지금·PENDING·UNKNOWN인 행만 지금 + 60초로 쓴다. 잡기 차례는 저장소에 넣은 차례다(실제 SQL은 표 ID 차례)
 */
class ClaimsDouble implements EventRefundClaims {
  readonly marks = new Map<string, { token: string; until: number }>();
  readonly claimLog: { nowMs: number; items: number; token: string }[] = [];
  readonly extendLog: { token: string; nowMs: number; result: number | undefined }[] = [];
  readonly releaseLog: string[] = [];
  /** 참이면 늘리기가 0행으로 답한다(잡기를 잃은 경우) */
  extendLost = false;
  #seq = 0;
  constructor(private readonly store: MemoryEventRefundStore) {}

  async claimOrders(requestId: string, nowMs: number, limitOrders: number) {
    const claimToken = `claim-${++this.#seq}`;
    const claimedUntilMs = nowMs + 60_000;
    const all = await this.store.items(requestId);
    // 기다림 뒤에 요청을 읽고 고르기·표시를 한 번에 한다(실제 SQL의 요청 행 잠금처럼 한 줄로 선다)
    const request = this.store.requests.get(requestId);
    const paused = new Set((request?.progress.perPg ?? []).filter((p) => p.state === 'PAUSED').map((p) => p.pg));
    const due = (i: EventRefundItem) =>
      (i.status === 'PENDING' || i.status === 'UNKNOWN') && i.appliedAtMs !== undefined && (i.nextAttemptAtMs === undefined || i.nextAttemptAtMs <= nowMs) && !paused.has(i.pg);
    const live = (i: EventRefundItem) => (this.marks.get(`${requestId}/${i.ticketId}`)?.until ?? -Infinity) > nowMs;
    const orders: string[] = [];
    if (request && (request.status === 'RUNNING' || request.status === 'REFUND_WINDOW') && limitOrders > 0) {
      for (const i of all) {
        if (orders.length >= limitOrders) break;
        if (orders.includes(i.orderId) || !due(i)) continue;
        const sameOrder = all.filter((o) => o.orderId === i.orderId);
        if (sameOrder.some(live)) continue;
        if (sameOrder.some((w) => w.status === 'UNKNOWN' && w.nextAttemptAtMs !== undefined && w.nextAttemptAtMs > nowMs)) continue;
        orders.push(i.orderId);
      }
    }
    const items = all.filter((i) => orders.includes(i.orderId) && due(i));
    for (const i of items) this.marks.set(`${requestId}/${i.ticketId}`, { token: claimToken, until: claimedUntilMs });
    this.claimLog.push({ nowMs, items: items.length, token: claimToken });
    return { claimToken, items, claimedUntilMs };
  }

  async extend(requestId: string, claimToken: string, nowMs: number): Promise<number | undefined> {
    const rows = (await this.store.items(requestId)).filter((i) => {
      const m = this.marks.get(`${requestId}/${i.ticketId}`);
      return m?.token === claimToken && m.until > nowMs && (i.status === 'PENDING' || i.status === 'UNKNOWN');
    });
    const result = this.extendLost || rows.length === 0 ? undefined : nowMs + 60_000;
    if (result !== undefined) for (const i of rows) this.marks.set(`${requestId}/${i.ticketId}`, { token: claimToken, until: result });
    this.extendLog.push({ token: claimToken, nowMs, result });
    return result;
  }

  async finish(q: Parameters<EventRefundClaims['finish']>[0]): Promise<boolean> {
    const current = this.store.byRequest.get(q.requestId)?.get(q.ticketId);
    if (!current || this.marks.get(`${q.requestId}/${q.ticketId}`)?.token !== q.claimToken) return false;
    if (current.status !== 'PENDING' && current.status !== 'UNKNOWN') return false;
    const { lastError: _l, nextAttemptAtMs: _n, ...rest } = current;
    const next: EventRefundItem = {
      ...rest,
      status: q.status,
      attempts: q.attempts,
      ...(q.lastError !== undefined ? { lastError: q.lastError } : {}),
      ...(q.nextAttemptAtMs !== undefined ? { nextAttemptAtMs: q.nextAttemptAtMs } : {}),
    };
    return (
      (await this.store.updateItem(next, q.outbox ?? [], {
        ...(q.cancellationFailure ? { cancellationFailure: q.cancellationFailure } : {}),
        ...(q.deductionGap ? { deductionGap: q.deductionGap } : {}),
        ...(q.failureCase ? { failureCase: q.failureCase } : {}),
      })) !== false
    );
  }

  async release(requestId: string, claimToken: string): Promise<void> {
    this.releaseLog.push(claimToken);
    for (const [k, m] of this.marks) if (k.startsWith(`${requestId}/`) && m.token === claimToken) this.marks.delete(k);
  }
}

/** 부를 때마다 센다(취소 ID별) */
const counter = () => {
  const calls = new Map<string, number>();
  return { calls, hit: (cancellationId: string) => calls.set(cancellationId, (calls.get(cancellationId) ?? 0) + 1), of: (ticketId: string) => calls.get(cid(ticketId)) ?? 0 };
};
type Deps = EventRefundServiceDeps;

describe('잡기 늘리기 [W9-fix1 GAT-110 N3, transfer-refund §5 잡기 늘리기]', () => {
  test('GAT-110 N3 표 셋이 각 25초 걸리는 주문은 보내기 전에 잡기를 늘려, 셋째 표를 보내는 도중 다른 실행이 그 주문을 다시 잡지 않는다', async () => {
    const clock = { now: NOW };
    const store = new MemoryEventRefundStore();
    const claims = new ClaimsDouble(store);
    const attempts = new MemoryEventRefundAttemptStore();
    const count = counter();
    const targets = [target(O1, T1), target(O1, T2), target(O1, T3)];
    const secondClaims: number[] = [];
    let overlapped = false;
    let second: EventRefundService | undefined;
    // 부를 때마다 시계를 25,000ms 민다. 셋째 표 호출 안에서 둘째 실행(리더의 runDue)을 한 번 돌린다
    const canceller: EventRefundCanceller = {
      cancel: async (t, q) => {
        clock.now += 25_000;
        count.hit(q.cancellationId);
        if (t.ticketId === T3 && !overlapped) {
          overlapped = true;
          await second!.runDue();
        }
        return { status: 'REFUNDED' };
      },
    };
    const base: Deps = { store, targets: { list: async () => targets }, canceller, attempts, nowMs: () => clock.now, deadlineMs: () => clock.now + 30_000 };
    const secondSide: EventRefundClaims = {
      claimOrders: async (...a) => {
        const r = await claims.claimOrders(...a);
        secondClaims.push(r.items.length);
        return r;
      },
      extend: (...a) => claims.extend(...a),
      finish: (q) => claims.finish(q),
      release: (...a) => claims.release(...a),
    };
    second = new EventRefundService({ ...base, claims: secondSide });
    await new EventRefundService({ ...base, claims }).start(startInput);
    // 장애 주입이 끼어들었는지 먼저: 셋째 표 호출 안에서 둘째 실행이 잡기를 시도했다
    expect(overlapped).toBe(true);
    expect(secondClaims.length).toBeGreaterThanOrEqual(1);
    expect(secondClaims.filter((n) => n > 0), '둘째 실행이 잡은 항목 수').toEqual([]);
    for (const t of [T1, T2, T3]) expect(count.of(t), t).toBe(1);
    // 늘리기: 잡은 때(0) 남은 60,000ms는 늘리지 않고, 둘째 표 앞(+25,000ms, 남은 35,000ms)·셋째 표 앞(+50,000ms, 남은 35,000ms)에 늘린다
    expect(claims.extendLog.map((e) => e.nowMs)).toEqual([NOW + 25_000, NOW + 50_000]);
    expect(claims.extendLog.map((e) => e.result)).toEqual([NOW + 85_000, NOW + 110_000]);
    expect(attempts.attempts.filter((a) => a.outcome === 'SUCCESS').map((a) => a.ticketId).sort()).toEqual([T1, T2, T3].sort());
    expect(attempts.attempts.filter((a) => a.outcome === 'UNKNOWN')).toEqual([]);
    for (const i of await store.items(REQUEST)) expect(i.status, i.ticketId).toBe('REFUNDED');
  });

  test('GAT-110 N3 늘리기 기준은 남은 기한 40,000ms 미만이다', async () => {
    for (const [firstTakesMs, extends_] of [
      [20_001, 1],
      [20_000, 0],
    ] as const) {
      const clock = { now: NOW };
      const store = new MemoryEventRefundStore();
      const claims = new ClaimsDouble(store);
      const count = counter();
      const canceller: EventRefundCanceller = {
        cancel: async (t, q) => {
          if (t.ticketId === T1) clock.now += firstTakesMs;
          count.hit(q.cancellationId);
          return { status: 'REFUNDED' };
        },
      };
      await new EventRefundService({
        store,
        targets: { list: async () => [target(O1, T1), target(O1, T2)] },
        canceller,
        claims,
        nowMs: () => clock.now,
        deadlineMs: () => clock.now + 30_000,
      }).start(startInput);
      // 첫 표가 20,001ms 걸리면 둘째 표 앞 남은 기한 39,999ms(늘림), 20,000ms면 40,000ms(늘리지 않음)
      expect(claims.extendLog.length, `첫 표 ${firstTakesMs}ms`).toBe(extends_);
      if (extends_ === 1) expect(claims.extendLog[0]!.nowMs).toBe(NOW + firstTakesMs);
      expect([count.of(T1), count.of(T2)], `첫 표 ${firstTakesMs}ms`).toEqual([1, 1]);
    }
  });

  test('GAT-110 N3 늘리기가 0행이면 그 표를 보내지 않고 그 주문의 나머지도 부르지 않는다', async () => {
    const clock = { now: NOW };
    const store = new MemoryEventRefundStore();
    const claims = new ClaimsDouble(store);
    const attempts = new MemoryEventRefundAttemptStore();
    const count = counter();
    const warns: { o: object; msg: string }[] = [];
    const canceller: EventRefundCanceller = {
      cancel: async (_t, q) => {
        clock.now += 25_000;
        count.hit(q.cancellationId);
        return { status: 'REFUNDED' };
      },
    };
    const service = new EventRefundService({
      store,
      targets: { list: async () => [target(O1, T1), target(O1, T2), target(O1, T3)] },
      canceller,
      attempts,
      claims,
      log: { warn: (o, msg) => void warns.push({ o, msg }) },
      nowMs: () => clock.now,
      deadlineMs: () => clock.now + 30_000,
    });
    claims.extendLost = true;
    await service.start(startInput);
    // 장애 주입이 끼어들었는지 먼저: 둘째 표 앞에서 늘리기를 불렀고 0행이었다
    expect(claims.extendLog.map((e) => [e.nowMs, e.result])).toEqual([[NOW + 25_000, undefined]]);
    expect([count.of(T1), count.of(T2), count.of(T3)]).toEqual([1, 0, 0]);
    expect(attempts.attempts.map((a) => [a.ticketId, a.outcome])).toEqual([[T1, 'SUCCESS']]);
    expect(claimLost(warns)).toBe(1);
    const byTicket = new Map((await store.items(REQUEST)).map((i) => [i.ticketId, i]));
    expect(byTicket.get(T1)?.status).toBe('REFUNDED');
    for (const t of [T2, T3]) expect(byTicket.get(t), t).toMatchObject({ status: 'PENDING', attempts: 0 });
    // 실행 끝의 잡기 풀기는 그대로 한 번
    expect(claims.releaseLog).toEqual([claims.claimLog[0]!.token]);
    // 잡기 기한(잡은 때 + 60,000ms) 뒤 다음 runDue는 남은 두 표를 한 번씩 부른다
    claims.extendLost = false;
    clock.now = NOW + 60_000;
    await service.runDue();
    expect([count.of(T1), count.of(T2), count.of(T3)]).toEqual([1, 1, 1]);
    for (const i of await store.items(REQUEST)) expect(i.status, i.ticketId).toBe('REFUNDED');
  });
});

describe('멈춤 표시는 합쳐 쓴다 [W9-fix1 GAT-110 N8, transfer-refund §5]', () => {
  /** 처리하지 않고 요청·항목만 만드는 조립(첫 묶음 0) */
  const rig = (targets: EventRefundTarget[]) => {
    const store = new MemoryEventRefundStore();
    const claims = new ClaimsDouble(store);
    const count = counter();
    const canceller: EventRefundCanceller = { cancel: async (_t, q) => (count.hit(q.cancellationId), { status: 'REFUNDED' }) };
    const base: Deps = { store, targets: { list: async () => targets }, canceller, claims, nowMs: () => NOW, deadlineMs: () => NOW + 30_000 };
    const idle = new EventRefundService({ ...base, firstBatch: 0 });
    /** 저장된 요청의 멈춤을 바로 바꾼다(다른 실행이 커밋한 쓰기를 흉내 낸다) */
    const setPaused = (paused: { pg: RefundPgProvider; reason: RefundPauseReason }[], status?: EventCancellationRequest['status']) => {
      const current = store.requests.get(REQUEST)!;
      store.requests.set(REQUEST, { ...current, ...(status ? { status } : {}), progress: progressOf([...store.byRequest.get(REQUEST)!.values()], paused, false) });
    };
    /** 요청 쓰기(update·updateActive·updateLocked) 가운데 처음 오는 것 앞에 한 번 끼운다. 끼웠으면 injected가 참 */
    const beforeFirstRequestWrite = (inject: () => void) => {
      const state = { armed: true, injected: false };
      const once = () => {
        if (!state.armed) return;
        state.armed = false;
        inject();
        state.injected = true;
      };
      const update = store.update.bind(store);
      const updateActive = store.updateActive.bind(store);
      const updateLocked = store.updateLocked.bind(store);
      store.update = async (r) => (once(), update(r));
      store.updateActive = async (r) => (once(), updateActive(r));
      store.updateLocked = async (id, next) => (once(), updateLocked(id, next));
      return state;
    };
    return { store, claims, count, canceller, base, idle, setPaused, beforeFirstRequestWrite };
  };

  test('GAT-110 N8 겹친 두 실행이 서로 다른 결제사를 자동 정지하면 둘 다 남고, TOSS만 재개해도 PORTONE으로는 환불이 나가지 않는다', async () => {
    // O1은 PORTONE, O2는 TOSS. 두 결제사의 서킷이 열렸다
    const r = rig([target(O1, T1, 'PORTONE'), target(O2, T2, 'TOSS')]);
    await r.idle.start(startInput);
    const open = new Set<RefundPgProvider>(['TOSS', 'PORTONE']);
    const b = new EventRefundService({ ...r.base, circuitOpen: (pg) => open.has(pg), concurrency: 1 });
    const aAsked: RefundPgProvider[] = [];
    let aClaimCalls = 0;
    let afterB: [RefundPgProvider, RefundPauseReason | undefined][] | undefined;
    // A는 O1을 잡아 PORTONE 정지를 판정한 뒤 다음 잡기 호출에서 멈춘다. 그동안 B가 O2를 잡아 TOSS 정지로 끝까지 돌고 PAUSED{TOSS}를 쓴다
    const aClaims: EventRefundClaims = {
      claimOrders: async (...a) => {
        aClaimCalls++;
        if (aClaimCalls === 2 && aAsked.includes('PORTONE')) {
          await b.runDue();
          afterB = pausedIn(r.store);
        }
        return r.claims.claimOrders(...a);
      },
      extend: (...a) => r.claims.extend(...a),
      finish: (q) => r.claims.finish(q),
      release: (...a) => r.claims.release(...a),
    };
    const a = new EventRefundService({ ...r.base, claims: aClaims, circuitOpen: (pg) => (aAsked.push(pg), open.has(pg)), concurrency: 1 });
    await a.runDue();
    // 장애 주입이 끼어들었는지 먼저: B가 A의 끝 쓰기보다 먼저 TOSS만 멈춰 두었다
    expect(afterB).toEqual([['TOSS', 'AUTO_CIRCUIT_OPEN']]);
    expect(pausedIn(r.store)).toEqual([
      ['PORTONE', 'AUTO_CIRCUIT_OPEN'],
      ['TOSS', 'AUTO_CIRCUIT_OPEN'],
    ]);
    expect(r.store.requests.get(REQUEST)?.status).toBe('PAUSED');
    expect(r.count.calls.size).toBe(0);
    // 서킷이 닫힌 뒤 TOSS만 재개: PORTONE 몫(O1)은 사람이 재개하기 전에는 부르지 않는다
    open.clear();
    await new EventRefundService(r.base).resume({ requestId: REQUEST, pg: 'TOSS', reason: '결제사 정상 확인' });
    expect(r.count.of(T1)).toBe(0);
    expect(r.count.of(T2)).toBe(1);
    expect(pausedIn(r.store)).toEqual([['PORTONE', 'AUTO_CIRCUIT_OPEN']]);
  });

  test('GAT-110 N8 재개 전에 시작한 실행이 늦게 끝나도 사람이 푼 멈춤을 되살리지 않고, 그 실행이 새로 판정한 자동 정지만 더한다', async () => {
    for (const simulatorCircuit of [false, true]) {
      const label = simulatorCircuit ? '대조(SIMULATOR 서킷 열림)' : '본';
      // 잡기 차례 OP(PORTONE) → OS(SIMULATOR) → OT(TOSS)
      const r = rig([target(O1, T1, 'PORTONE'), target(O2, T2, 'SIMULATOR'), target(O3, T3, 'TOSS')]);
      await r.idle.start(startInput);
      r.setPaused(
        [
          { pg: 'TOSS', reason: 'AUTO_FAILURE_RATE' },
          { pg: 'PORTONE', reason: 'MANUAL' },
        ],
        'PAUSED',
      );
      let tossResumed: [RefundPgProvider, RefundPauseReason | undefined][] | undefined;
      // A(PORTONE 재개의 실행)가 OP를 보내는 도중 사람이 TOSS를 재개한다(그 재개는 쓰기만 하고 처리하지 않는다)
      const aCanceller: EventRefundCanceller = {
        cancel: async (t, q) => {
          if (t.ticketId === T1 && tossResumed === undefined) {
            await r.idle.resume({ requestId: REQUEST, pg: 'TOSS', reason: '결제사 정상 확인' });
            tossResumed = pausedIn(r.store);
          }
          return r.canceller.cancel(t, q);
        },
      };
      const a = new EventRefundService({ ...r.base, canceller: aCanceller, circuitOpen: (pg) => simulatorCircuit && pg === 'SIMULATOR', concurrency: 1 });
      await a.resume({ requestId: REQUEST, pg: 'PORTONE', reason: '수동 멈춤 해제' });
      // 장애 주입이 끼어들었는지 먼저: A가 끝나기 전에 TOSS 재개가 DB의 멈춤을 모두 뺐다
      expect(tossResumed, label).toEqual([]);
      expect(r.count.of(T1), label).toBe(1);
      expect(pausedIn(r.store), label).toEqual(simulatorCircuit ? [['SIMULATOR', 'AUTO_CIRCUIT_OPEN']] : []);
      if (!simulatorCircuit) expect(r.store.requests.get(REQUEST)?.status, label).not.toBe('PAUSED');
    }
  });

  test('GAT-110 N8 한꺼번에 재개는 재개가 읽은 멈춤만 빼고, 읽은 뒤 생긴 자동 정지는 남긴다', async () => {
    const r = rig([target(O1, T1, 'TOSS'), target(O2, T2, 'PORTONE')]);
    await r.idle.start(startInput);
    r.setPaused([{ pg: 'TOSS', reason: 'AUTO_FAILURE_RATE' }], 'PAUSED');
    // 재개의 첫 읽기 뒤·쓰기 전에 다른 실행이 PORTONE을 자동 정지한다(그 실행의 1분 창 실패율, 재개하는 쪽 서킷은 닫힘)
    const inj = r.beforeFirstRequestWrite(() =>
      r.setPaused([
        { pg: 'TOSS', reason: 'AUTO_FAILURE_RATE' },
        { pg: 'PORTONE', reason: 'AUTO_FAILURE_RATE' },
      ]),
    );
    await new EventRefundService(r.base).resume({ requestId: REQUEST, reason: '모두 재개' });
    expect(inj.injected).toBe(true);
    expect(pausedIn(r.store)).toEqual([['PORTONE', 'AUTO_FAILURE_RATE']]);
    expect(r.count.of(T2)).toBe(0);
    expect(r.count.of(T1)).toBe(1);
  });

  test('GAT-110 N8 신청 창 닫기·수동 멈춤은 그사이 적힌 자동 정지를 지우지 않는다', async () => {
    // ① 연기 요청의 신청 창 닫기(runDue): 닫을 창을 읽은 뒤·쓰기 전에 다른 실행이 PAUSED{TOSS}를 쓴다
    {
      const clock = { now: NOW };
      const r = rig([target(O1, T1, 'TOSS'), target(O2, T2, 'TOSS')]);
      const svc = new EventRefundService({ ...r.base, nowMs: () => clock.now, deadlineMs: () => clock.now + 30_000 });
      await svc.start({ ...startInput, kind: 'POSTPONE', postponedToMs: NOW + 7 * DAY, refundWindowClosesAtMs: NOW + 3 * DAY });
      expect(await r.store.markApplied(REQUEST, T1, NOW + 1_000)).toBe(true);
      clock.now = NOW + 3 * DAY;
      const inj = r.beforeFirstRequestWrite(() => r.setPaused([{ pg: 'TOSS', reason: 'AUTO_CIRCUIT_OPEN' }], 'PAUSED'));
      await svc.runDue();
      expect(inj.injected).toBe(true);
      expect(r.store.requests.get(REQUEST)?.status).toBe('PAUSED');
      expect(pausedIn(r.store)).toEqual([['TOSS', 'AUTO_CIRCUIT_OPEN']]);
      const byTicket = new Map((await r.store.items(REQUEST)).map((i) => [i.ticketId, i]));
      expect(byTicket.get(T2)?.status).toBe('NOT_APPLIED');
      // 멈춘 결제사로 신청 표를 보내지 않는다
      expect(r.count.of(T1)).toBe(0);
    }
    // ② PORTONE 수동 멈춤: 멈춤의 읽기 뒤·쓰기 전에 다른 실행이 TOSS를 자동 정지한다
    {
      const r = rig([target(O1, T1, 'TOSS'), target(O2, T2, 'PORTONE')]);
      await r.idle.start(startInput);
      const inj = r.beforeFirstRequestWrite(() => r.setPaused([{ pg: 'TOSS', reason: 'AUTO_CIRCUIT_OPEN' }], 'PAUSED'));
      await new EventRefundService(r.base).pause({ requestId: REQUEST, pg: 'PORTONE', reason: '결제사 점검' });
      expect(inj.injected).toBe(true);
      expect(pausedIn(r.store)).toEqual([
        ['PORTONE', 'MANUAL'],
        ['TOSS', 'AUTO_CIRCUIT_OPEN'],
      ]);
    }
  });

  test('GAT-110 N8 멈춤 합치기: 빼기 먼저·더하기 다음, 이미 멈춘 결제사는 DB 사유를 두고 MANUAL만 사유를 바꾼다', () => {
    type P = { pg: RefundPgProvider; reason: RefundPauseReason };
    const sorted = (ps: readonly P[]) => [...ps].sort((x, y) => x.pg.localeCompare(y.pg));
    const cases: { name: string; current: P[]; delta: Parameters<typeof mergePauses>[1]; want: P[] }[] = [
      { name: '자동 + 자동은 처음(DB) 사유', current: [{ pg: 'TOSS', reason: 'AUTO_FAILURE_RATE' }], delta: { add: [{ pg: 'TOSS', reason: 'AUTO_CIRCUIT_OPEN' }] }, want: [{ pg: 'TOSS', reason: 'AUTO_FAILURE_RATE' }] },
      { name: '자동 + MANUAL은 MANUAL', current: [{ pg: 'TOSS', reason: 'AUTO_CIRCUIT_OPEN' }], delta: { add: [{ pg: 'TOSS', reason: 'MANUAL' }] }, want: [{ pg: 'TOSS', reason: 'MANUAL' }] },
      { name: 'MANUAL + 자동은 MANUAL', current: [{ pg: 'TOSS', reason: 'MANUAL' }], delta: { add: [{ pg: 'TOSS', reason: 'AUTO_CIRCUIT_OPEN' }] }, want: [{ pg: 'TOSS', reason: 'MANUAL' }] },
      {
        name: '다른 결제사 더하기는 둘 다 남음',
        current: [{ pg: 'TOSS', reason: 'AUTO_CIRCUIT_OPEN' }],
        delta: { add: [{ pg: 'PORTONE', reason: 'AUTO_CONSECUTIVE_FAILURES' }] },
        want: [
          { pg: 'PORTONE', reason: 'AUTO_CONSECUTIVE_FAILURES' },
          { pg: 'TOSS', reason: 'AUTO_CIRCUIT_OPEN' },
        ],
      },
      {
        name: 'lift 밖 결제사는 남음',
        current: [
          { pg: 'TOSS', reason: 'AUTO_FAILURE_RATE' },
          { pg: 'PORTONE', reason: 'MANUAL' },
        ],
        delta: { lift: ['TOSS'] },
        want: [{ pg: 'PORTONE', reason: 'MANUAL' }],
      },
      { name: '멈추지 않은 결제사 빼기는 그대로', current: [{ pg: 'TOSS', reason: 'AUTO_FAILED_AMOUNT' }], delta: { lift: ['SIMULATOR'] }, want: [{ pg: 'TOSS', reason: 'AUTO_FAILED_AMOUNT' }] },
      { name: 'lift와 add가 같은 결제사면 add가 남음(빼기 먼저)', current: [{ pg: 'TOSS', reason: 'AUTO_FAILURE_RATE' }], delta: { lift: ['TOSS'], add: [{ pg: 'TOSS', reason: 'AUTO_CIRCUIT_OPEN' }] }, want: [{ pg: 'TOSS', reason: 'AUTO_CIRCUIT_OPEN' }] },
      { name: '빈 변화는 그대로', current: [{ pg: 'SIMULATOR', reason: 'AUTO_REJECT_RATE' }], delta: {}, want: [{ pg: 'SIMULATOR', reason: 'AUTO_REJECT_RATE' }] },
    ];
    for (const c of cases) expect(sorted(mergePauses(c.current, c.delta)), c.name).toEqual(sorted(c.want));
  });
});

describe('그 밖 실패의 팬 실패 알림 [W9-fix1 GAT-110 P3, transfer-refund §5 주인]', () => {
  /** 팬 알림 Outbox의 trade.orders REFUND_FAILED 가운데 그 표의 것(중복 제거 키 = sha256('event-refund-notice:{요청}:{표}:REFUND_FAILED') 앞 16바이트 UUID) */
  const noticeKey = (ticketId: string) => {
    const h = createHash('sha256').update(`event-refund-notice:${REQUEST}:${ticketId}:REFUND_FAILED`).digest('hex');
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
  };
  const fanFailures = (store: MemoryEventRefundStore, ticketId: string) =>
    store.outbox
      .map((m) => ({ topic: m.topic, key: m.key, payload: JSON.parse(Buffer.from(m.payload).toString('utf8')) as Record<string, unknown> }))
      .filter((m) => m.payload['type'] === 'REFUND_FAILED' && m.payload['eventKey'] === noticeKey(ticketId));
  const emptyOutbox: Pick<CsCaseOutbox, 'pendingGaps' | 'markGapOpened' | 'pendingItemFailures' | 'markItemFailureOpened'> = {
    pendingGaps: async () => [],
    markGapOpened: async () => undefined,
    pendingItemFailures: async () => [],
    markItemFailureOpened: async () => undefined,
  };

  test('GAT-110 P3 그 밖 실패(업무 거절 목록 밖, 시도 상한 전)로 끝난 항목도 팬 실패 알림 하나를 같은 쓰기에 남긴다', async () => {
    // 잡기를 꽂은 운영 조립과 잡기 없는 옛 조립 둘 다 본다
    for (const wiring of ['claims', 'store'] as const) {
      const store = new MemoryEventRefundStore();
      const attempts = new MemoryEventRefundAttemptStore();
      const opened: unknown[] = [];
      // T1 그 밖 실패(NOT_FOUND, 첫 시도), T2 결과 모름(재시도), T3 업무 거절(REJECTED, 꼴 견줌), T4 시도 상한(넷 시도 뒤 NOT_FOUND)
      const answers: Record<string, Awaited<ReturnType<EventRefundCanceller['cancel']>>> = {
        [T1]: { status: 'FAILED', error: 'NOT_FOUND' },
        [T2]: { status: 'REFUND_PENDING' },
        [T3]: { status: 'FAILED', error: 'REJECTED' },
        [T4]: { status: 'FAILED', error: 'NOT_FOUND' },
      };
      const base: Deps = {
        store,
        targets: { list: async () => [target(O1, T1), target(O2, T2), target(O3, T3), target(O4, T4)] },
        canceller: { cancel: async (t) => answers[t.ticketId]! },
        attempts,
        fanNotifier: new OutboxEventRefundFanNotifier(),
        notice: { open: async (q) => void opened.push(q) },
        csOutbox: emptyOutbox,
        ...(wiring === 'claims' ? { claims: new ClaimsDouble(store) } : {}),
        nowMs: () => NOW,
        deadlineMs: () => NOW + 30_000,
      };
      await new EventRefundService({ ...base, firstBatch: 0 }).start(startInput);
      const t4 = store.byRequest.get(REQUEST)!.get(T4)!;
      store.byRequest.get(REQUEST)!.set(T4, { ...t4, attempts: 4 });
      await new EventRefundService(base).runDue();
      const items = new Map((await store.items(REQUEST)).map((i) => [i.ticketId, i]));
      const t1 = items.get(T1)!;
      expect(t1, wiring).toMatchObject({ status: 'FAILED', attempts: 1, lastError: 'NOT_FOUND' });
      expect(t1.nextAttemptAtMs, wiring).toBeUndefined();
      const [notice, ...more] = fanFailures(store, T1);
      expect(more, wiring).toEqual([]);
      expect(notice, wiring).toBeDefined();
      expect(notice!.topic, wiring).toBe('trade.orders');
      expect(notice!.key, wiring).toBe(EVENT);
      expect(notice!.payload, wiring).toMatchObject({ type: 'REFUND_FAILED', orderId: O1, eventId: EVENT, eventKey: noticeKey(T1) });
      // 업무 거절 길의 알림과 같은 꼴(칸 이름이 같다)
      const rejected = fanFailures(store, T3);
      expect(rejected, wiring).toHaveLength(1);
      expect(Object.keys(notice!.payload).sort(), wiring).toEqual(Object.keys(rejected[0]!.payload).sort());
      expect(store.cancellationFailures.get(cid(T1)), wiring).toBe('NOT_FOUND');
      expect(store.failureCases.has(`${REQUEST}/${T1}`), wiring).toBe(true);
      expect(attempts.attempts.filter((a) => a.ticketId === T1).map((a) => a.outcome), wiring).toEqual(['FAILURE']);
      // 다시 열기 포트가 꽂혔으니 처리 중 CS 호출 0
      expect(opened, wiring).toEqual([]);
      // 대조: 결과 모름 재시도는 알림 0, 시도 상한 FAILED는 하나(둘이 아님)
      expect(items.get(T2)?.status, wiring).toBe('UNKNOWN');
      expect(fanFailures(store, T2), wiring).toEqual([]);
      expect(items.get(T4), wiring).toMatchObject({ status: 'FAILED', attempts: 5 });
      expect(fanFailures(store, T4), wiring).toHaveLength(1);
    }
  });
});
