// R-T52 ①②③ 일괄 환불 실행기의 결제사별 토큰 버킷(F-07-8 계획 I-07, transfer-refund §5 '토큰 버킷의 값', §11 R-T52).
// ① 토스형 몫 표 900장(포트원형 10장)을 가짜 시계로 돌리면 토스 취소 호출의 시각 t초까지 누적이 300 + ⌊300 × t⌋를 넘지 않고, 포트원형은 토스를 기다리지 않는다.
//    기다림은 시도 기록(event_refund_attempt)·실패율·연속 실패에 들지 않는다.
// ② 보내기 직전에 잡기를 늘리고(남은 기한 40초 [가정] 아래일 때), 늘리기가 0행이면 그 표를 보내지 않는다. 토큰을 기다린 뒤에 본다.
// ③ 토큰을 기다리는 동안 그 몫이 수동 일시정지되면 멈춘 뒤 새 호출은 0이다.
// 실제 결제사·실제 시간은 쓰지 않는다: 취소기는 기록만 하는 대역이고, 버킷의 sleep 대역이 기다린 만큼 가짜 시계를 민다.
// 기준 트리: pg-token-bucket.ts와 EventRefundService의 buckets 의존이 없어 실패한다(계획 §7).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemoryEventRefundAttemptStore, MemoryEventRefundStore } from '../src/modules/refund/adapters/memory-event-refund-store.js';
import { EventRefundService } from '../src/modules/refund/application/event-refund-service.js';
import type { EventRefundCanceller, EventRefundClaims } from '../src/modules/refund/domain/event-refund-ports.js';
import type { EventRefundItem, EventRefundTarget, RefundPgProvider } from '../src/modules/refund/domain/event-refund.js';
import { PgTokenBuckets } from '../src/modules/refund/domain/pg-token-bucket.js';

const NOW = Date.parse('2026-11-23T01:00:00.000Z');
const DAY = 86_400_000;
const REQUEST = '0194f078-0000-7000-8000-000000000001';
const EVENT = '0194f078-0000-7000-8000-000000000002';
const id = (n: number) => `0194f078-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;

const target = (n: number, pg: RefundPgProvider, orderId = id(0x100000 + n)): EventRefundTarget => ({
  orderId,
  ticketId: id(0x200000 + n),
  seatId: `seat-${n}`,
  payerAccountId: id(7),
  ticketPrice: 47_500,
  bookedAtMs: NOW - DAY,
  saleEndsAtMs: NOW + 7 * DAY,
  pg,
});

function world(o: { targets: EventRefundTarget[]; rate?: number; burst?: number; concurrency?: number; claims?: (store: MemoryEventRefundStore) => EventRefundClaims; onSleep?: (n: number) => Promise<void> }) {
  // 버킷 시계는 0에서 시작하고(소수 ms의 부동소수 오차를 피한다) 실행기의 지금 = NOW + 버킷 시계다
  const clock = fakeClock({ now: 0, monotonic: 0 });
  const store = new MemoryEventRefundStore();
  const attempts = new MemoryEventRefundAttemptStore();
  const calls: { ticketId: string; pg: RefundPgProvider; atMs: number }[] = [];
  let sleepsN = 0;
  // 대역: 기다리기 시작한 시각 + ms까지 시계를 민다(이미 지났으면 그대로). onSleep(시험이 끼우는 일)이 끝난 뒤에 민다
  const sleep = async (ms: number): Promise<void> => {
    sleepsN += 1;
    const wake = clock.now() + ms;
    await o.onSleep?.(sleepsN);
    if (wake > clock.now()) clock.advance(wake - clock.now());
  };
  const buckets = new PgTokenBuckets({ ratePerSecond: o.rate ?? 300, burst: o.burst ?? 300, clock, sleep });
  const canceller: EventRefundCanceller = {
    cancel: async (t) => {
      calls.push({ ticketId: t.ticketId, pg: t.pg, atMs: clock.now() });
      return { status: 'REFUNDED' };
    },
  };
  const service = new EventRefundService({
    store,
    targets: { list: async () => o.targets },
    canceller,
    attempts,
    buckets,
    ...(o.claims ? { claims: o.claims(store) } : {}),
    nowMs: () => NOW + clock.now(),
    deadlineMs: () => NOW + clock.now() + 5_000,
    concurrency: o.concurrency ?? 8,
    firstBatch: 2_000,
    batchSize: 2_000,
  });
  const start = () => service.start({ eventId: EVENT, requestId: REQUEST, fault: 'FORCE_MAJEURE', ruledBy: 'commander-1', confirmedBy: 'operator-2' });
  return { clock, store, attempts, calls, service, start, sleeps: () => sleepsN };
}

describe('R-T52 ① 실행기의 결제사별 속도 한도', () => {
  test('R-T52 ① 토스 900장·포트원 10장: 토스 누적은 300 + ⌊300 × t⌋ 안이고(0초 300, 1초 600), 포트원 10건은 0초에 모두 나가며, 기다림은 시도 기록·자동 정지에 들지 않는다', async () => {
    // 포트원 표를 토스 표 사이(151번째부터)에 둔다: 버킷을 결제사 몫으로 나누지 않으면 0초의 토스 호출이 300보다 적어진다
    const toss = Array.from({ length: 900 }, (_, i) => target(i + 1, 'TOSS'));
    const portone = Array.from({ length: 10 }, (_, i) => target(1_000 + i, 'PORTONE'));
    const w = world({ targets: [...toss.slice(0, 150), ...portone, ...toss.slice(150)] });
    const started = await w.start();
    // 한 번의 실행에서 다 못 보낸 표는 다음 틱이 이어 간다
    for (let i = 0; i < 20 && w.calls.length < 910; i += 1) await w.service.runDue();
    const tossCalls = w.calls.filter((c) => c.pg === 'TOSS').map((c) => c.atMs).sort((a, b) => a - b);
    const portoneCalls = w.calls.filter((c) => c.pg === 'PORTONE').map((c) => c.atMs);
    expect(tossCalls).toHaveLength(900);
    expect(portoneCalls).toEqual(Array.from({ length: 10 }, () => 0));
    // 시각은 큰 기원 값 위의 소수 ms라 부동소수 오차만큼(1e-6건) 허용한다
    for (let k = 0; k < tossCalls.length; k += 1) expect(k + 1, `토스 ${k + 1}번째 t=${tossCalls[k]}ms`).toBeLessThanOrEqual(300 + Math.floor((300 * tossCalls[k]!) / 1000 + 1e-6));
    expect(tossCalls.filter((t) => t === 0)).toHaveLength(300);
    expect(tossCalls.filter((t) => t <= 3)).toHaveLength(300);
    expect(tossCalls.filter((t) => t <= 1000.01)).toHaveLength(600);
    // 같은 표를 두 번 보내지 않는다
    expect(new Set(w.calls.map((c) => c.ticketId)).size).toBe(910);
    // 기다림은 시도 기록에 들지 않는다: 시도 = 실제 호출 수, 모두 성공, 자동 정지 없음
    expect(w.attempts.attempts).toHaveLength(910);
    expect(w.attempts.attempts.every((a) => a.outcome === 'SUCCESS')).toBe(true);
    expect(started.progress.perPg.every((p) => p.state !== 'PAUSED')).toBe(true);
    expect((await w.service.get(REQUEST)).status).toBe('COMPLETED');
    expect(w.sleeps()).toBeGreaterThan(0);
  });
});

/** 주문 단위 잡기 대역(실제 DrizzleEventRefundClaims 규칙: 기한 = 지금 + 60초, 늘리기는 같은 잡기 값·기한 > 지금인 행만). 늘리기 결과를 시험이 정한다 */
class BucketClaims implements EventRefundClaims {
  readonly extendLog: { nowMs: number; result: number | undefined }[] = [];
  extendLost = false;
  readonly #marks = new Map<string, { token: string; until: number }>();
  #seq = 0;
  constructor(private readonly store: MemoryEventRefundStore) {}
  async claimOrders(requestId: string, nowMs: number, limitOrders: number) {
    const claimToken = `bucket-claim-${++this.#seq}`;
    const claimedUntilMs = nowMs + 60_000;
    const request = this.store.requests.get(requestId);
    const all = await this.store.items(requestId);
    const due = (i: EventRefundItem) => (i.status === 'PENDING' || i.status === 'UNKNOWN') && i.appliedAtMs !== undefined && (i.nextAttemptAtMs === undefined || i.nextAttemptAtMs <= nowMs);
    const live = (i: EventRefundItem) => (this.#marks.get(i.ticketId)?.until ?? -Infinity) > nowMs;
    const orders: string[] = [];
    if (request && (request.status === 'RUNNING' || request.status === 'REFUND_WINDOW')) {
      for (const i of all) {
        if (orders.length >= limitOrders) break;
        if (orders.includes(i.orderId) || !due(i) || all.filter((x) => x.orderId === i.orderId).some(live)) continue;
        orders.push(i.orderId);
      }
    }
    const items = all.filter((i) => orders.includes(i.orderId) && due(i));
    for (const i of items) this.#marks.set(i.ticketId, { token: claimToken, until: claimedUntilMs });
    return { claimToken, items, claimedUntilMs };
  }
  async extend(_requestId: string, claimToken: string, nowMs: number): Promise<number | undefined> {
    const alive = [...this.#marks.values()].some((m) => m.token === claimToken && m.until > nowMs);
    const result = this.extendLost || !alive ? undefined : nowMs + 60_000;
    if (result !== undefined) for (const [k, m] of this.#marks) if (m.token === claimToken) this.#marks.set(k, { token: claimToken, until: result });
    this.extendLog.push({ nowMs, result });
    return result;
  }
  async finish(q: Parameters<EventRefundClaims['finish']>[0]): Promise<boolean> {
    const current = this.store.byRequest.get(q.requestId)?.get(q.ticketId);
    if (!current || this.#marks.get(q.ticketId)?.token !== q.claimToken) return false;
    if (current.status !== 'PENDING' && current.status !== 'UNKNOWN') return false;
    const { lastError: _l, nextAttemptAtMs: _n, ...rest } = current;
    const next: EventRefundItem = { ...rest, status: q.status, attempts: q.attempts, ...(q.lastError !== undefined ? { lastError: q.lastError } : {}), ...(q.nextAttemptAtMs !== undefined ? { nextAttemptAtMs: q.nextAttemptAtMs } : {}) };
    return (await this.store.updateItem(next, q.outbox ?? [], {})) !== false;
  }
  async release(_requestId: string, claimToken: string): Promise<void> {
    for (const [k, m] of this.#marks) if (m.token === claimToken) this.#marks.delete(k);
  }
}

describe('R-T52 ② 토큰을 기다린 뒤의 잡기 늘리기', () => {
  // 한 주문에 토스 표 22장, 버킷 초당 1·최대 1: 표 k는 (k−1)초에 나간다. 잡기 기한 60초에서 남은 기한이 40초 아래로 내려가는 것은 21초째(22번째 표)다.
  // F-05: 20초째(남은 40초 = 기준)는 늘리지 않고 보내고, 21초째(남은 39초)는 늘린다. 늘리기가 0행이면 보내지 않는다
  test('R-T52 ② 기다림으로 남은 잡기 기한이 40초 아래가 되면 보내기 직전에 늘리고, 늘리기가 0행이면 그 표를 보내지 않으며 시도 기록도 없다', async () => {
    const order = id(0x9999);
    const targets = Array.from({ length: 22 }, (_, i) => target(i + 1, 'TOSS', order));
    let claims: BucketClaims | undefined;
    const w = world({
      targets,
      rate: 1,
      burst: 1,
      claims: (store) => {
        claims = new BucketClaims(store);
        claims.extendLost = true;
        return claims;
      },
    });
    await w.start();
    expect(w.calls.map((c) => c.atMs)).toEqual(Array.from({ length: 21 }, (_, i) => i * 1_000));
    expect(claims!.extendLog).toEqual([{ nowMs: NOW + 21_000, result: undefined }]);
    expect(w.attempts.attempts).toHaveLength(21);
    const items = await w.store.items(REQUEST);
    expect(items.filter((i) => i.status === 'REFUNDED')).toHaveLength(21);
    expect(items.filter((i) => i.status === 'PENDING')).toHaveLength(1);
  });

  test('R-T52 ② 늘리기가 되면 그 표를 보내고 이어 간다(22장 모두 21초 안에)', async () => {
    const order = id(0x9998);
    const targets = Array.from({ length: 22 }, (_, i) => target(100 + i, 'TOSS', order));
    let claims: BucketClaims | undefined;
    const w = world({ targets, rate: 1, burst: 1, claims: (store) => (claims = new BucketClaims(store)) });
    await w.start();
    expect(w.calls).toHaveLength(22);
    expect(w.calls.at(-1)!.atMs).toBe(21_000);
    expect(claims!.extendLog[0]).toEqual({ nowMs: NOW + 21_000, result: NOW + 81_000 });
  });
});

describe('R-T52 ③ 토큰을 기다리는 동안의 수동 일시정지', () => {
  test('R-T52 ③ 기다리는 중에 그 몫을 수동으로 멈추면 기다림 뒤에 다시 보아 새 호출이 0이다', async () => {
    const targets = Array.from({ length: 20 }, (_, i) => target(i + 1, 'TOSS'));
    let service: EventRefundService | undefined;
    let pausing: Promise<unknown> | undefined;
    // 작업자 하나(차례가 정해진다): 6번째 표가 토큰을 기다리는 동안 그 몫을 수동으로 멈추고, 멈춤이 저장된 뒤에야 시각이 흐른다
    const w = world({
      targets,
      rate: 1,
      burst: 5,
      concurrency: 1,
      onSleep: async () => {
        pausing ??= service!.pause({ requestId: REQUEST, pg: 'TOSS', reason: '결제사 공지 확인' });
        await pausing;
      },
    });
    service = w.service;
    await w.start();
    expect(pausing).toBeDefined();
    expect(w.calls).toHaveLength(5);
    const after = await w.service.get(REQUEST);
    expect(after.status).toBe('PAUSED');
    expect(after.progress.perPg.find((p) => p.pg === 'TOSS')).toMatchObject({ state: 'PAUSED', pauseReason: 'MANUAL' });
    w.clock.advance(60_000);
    await w.service.runDue();
    expect(w.calls).toHaveLength(5);
    expect(w.attempts.attempts).toHaveLength(5);
  });
});
