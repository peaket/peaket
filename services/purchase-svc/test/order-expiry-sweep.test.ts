// 주문 만료 안전망 반복(OrderExpirySweep, ADR-0107 결정 2, docs/features/payment.md §2 '결제하지 않은 주문 만료의 첫 구현', docs/data.md §5.1 '주문 만료 안전망', BUILD_ORDER PRF-172 설계 3, 시험 P-T41 ④).
// 저장소·만료 판정·리더 확인·지표·로그는 시험 안의 대역이고, 시각은 가짜 시계, 쉬기는 deps.sleep을 바꿔 끼워 손으로 푼다(고정 sleep 없음).
import 'reflect-metadata';
import { fakeClock, type LeaderLoop } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  ORDER_EXPIRY_ATTEMPT_TTL_MS,
  ORDER_EXPIRY_BATCH,
  ORDER_EXPIRY_LOOKBACK_MS,
  ORDER_EXPIRY_SWEEP_AGE_MS,
  ORDER_EXPIRY_SWEEP_INTERVAL_MS,
  orderExpiryStaleTask,
  type OrderExpiredAttempt,
  type OrderExpiryOrder,
  type OrderExpiryOutcome,
  type OrderExpiryRange,
  type OrderExpiryStaleReport,
  OrderExpirySweep,
  type OrderExpirySweepDeps,
  type OrderExpiryTrigger,
} from '../src/modules/booking/index.js';

const NOW = Date.parse('2026-11-09T03:00:00.000Z');
const EVENT = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
const orderId = (n: number): string => `0190f3a1-7c2e-7a00-8000-${String(n).padStart(12, '0')}`;
const attempt = (n: number): OrderExpiredAttempt => ({ attemptId: `0190f3a1-7c2e-7c00-8000-${String(n).padStart(12, '0')}`, orderId: orderId(n) });
/** 주문 칸(구현이 칸을 더해도 형 검사가 되게 단언으로 맞춘다) */
const anOrder = (n: number): OrderExpiryOrder =>
  ({ orderId: orderId(n), accountId: ACCOUNT, eventId: EVENT, purchaseSessionId: `jti-${n}`, holdId: `0190f3a1-7c2e-7b00-8000-${String(n).padStart(12, '0')}`, status: 'CREATED' }) as OrderExpiryOrder;
const ordersFrom = (first: number, count: number): OrderExpiryOrder[] => Array.from({ length: count }, (_, i) => anOrder(first + i));
const attemptsFrom = (first: number, count: number): OrderExpiredAttempt[] => Array.from({ length: count }, (_, i) => attempt(first + i));

const EXPIRED: OrderExpiryOutcome = { status: 'EXPIRED', transition: 'T5', seq: 2 };
const SECRET_TEXT = `connection lost s:{event:${EVENT}}:stream ${ACCOUNT}`;
const named = (name: string, message: string) => Object.assign(new Error(message), { name });

/** 지금 쌓인 약속 작업을 한 바퀴 돌린다(시간을 기다리지 않는다) */
const flush = () => new Promise<void>((r) => setImmediate(r));
async function settle(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await flush();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

/** 대역 조립 하나. pages는 부를 때마다 앞에서 하나씩 꺼내 주는 묶음이다(다 쓰면 빈 묶음) */
function world() {
  const clock = fakeClock({ now: NOW });
  const state = { leader: true };
  const pages = { attempts: [] as OrderExpiredAttempt[][], orders: [] as OrderExpiryOrder[][], stale: [] as OrderExpiryOrder[][] };
  /** 주문마다 check의 결과(없으면 EXPIRED) 또는 던질 오류 */
  const outcomes = new Map<string, OrderExpiryOutcome | Error>();
  const fail: { attempts?: unknown; orders?: unknown; staleBatch?: unknown; leader?: () => unknown } = {};
  const wait: { check?: (id: string) => Promise<void>; staleBatch?: () => Promise<void> } = {};
  const calls = {
    leader: 0,
    attempts: [] as OrderExpiryRange[],
    orders: [] as (OrderExpiryRange & { afterId?: string })[],
    staleBatch: [] as (OrderExpiryRange & { afterId?: string })[],
    check: [] as [string, OrderExpiryTrigger][],
  };
  const expired: OrderExpiryTrigger[] = [];
  const failures: string[] = [];
  const stale: number[] = [];
  const warns: { obj: Record<string, unknown>; msg: string }[] = [];
  /** 손으로 푸는 쉬기. signal이 끊으면 바로 풀린다(던지지 않는다) */
  const sleeps: { ms: number; signal: AbortSignal; done: boolean; release: () => void }[] = [];
  const sleep = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      const s = {
        ms,
        signal,
        done: false,
        release: () => {
          if (s.done) return;
          s.done = true;
          resolve();
        },
      };
      sleeps.push(s);
      if (signal?.aborted) s.release();
      else signal?.addEventListener('abort', () => s.release(), { once: true });
    });
  const deps: OrderExpirySweepDeps = {
    store: {
      expireReadyAttempts: async (r) => {
        calls.attempts.push({ ...r });
        if (fail.attempts !== undefined) throw fail.attempts;
        return pages.attempts.shift() ?? [];
      },
      openOrderBatch: async (r) => {
        calls.orders.push({ ...r });
        if (fail.orders !== undefined) throw fail.orders;
        return pages.orders.shift() ?? [];
      },
    },
    expiry: {
      check: async (id, trigger) => {
        calls.check.push([id, trigger]);
        await wait.check?.(id);
        const r = outcomes.get(id) ?? EXPIRED;
        if (r instanceof Error) throw r;
        return r;
      },
    },
    leader: {
      isLeader: () => {
        calls.leader += 1;
        const x = fail.leader?.();
        if (x !== undefined) throw x;
        return state.leader;
      },
    },
    clock,
    signals: {
      expired: (t) => void expired.push(t),
      failure: (s) => void failures.push(s),
      openStale: (n) => void stale.push(n),
    },
    logger: { warn: (obj, msg) => void warns.push({ obj: obj as Record<string, unknown>, msg }) },
    sleep,
  };
  const sweep = (over: Partial<OrderExpirySweepDeps> = {}) => new OrderExpirySweep({ ...deps, ...over });
  const pendingSleeps = () => sleeps.filter((s) => !s.done);
  const warnText = () => warns.map((w) => `${JSON.stringify(w.obj)} ${w.msg}`).join('\n');
  /** 하루 넘은 주문 정비 일(대역 저장소·판정·지표) */
  const staleTask = (over: { batchSize?: number } = {}) =>
    orderExpiryStaleTask({
      store: {
        staleOrderBatch: async (r) => {
          calls.staleBatch.push({ ...r });
          await wait.staleBatch?.();
          if (fail.staleBatch !== undefined) throw fail.staleBatch;
          return pages.stale.shift() ?? [];
        },
      },
      expiry: deps.expiry,
      clock,
      signals: deps.signals,
      logger: deps.logger!,
      ...over,
    });
  return { clock, state, pages, outcomes, fail, wait, calls, expired, failures, stale, warns, sleeps, deps, sweep, staleTask, pendingSleeps, warnText };
}

/** start 뒤 조건이 설 때까지 돌린다. 그사이 걸린 쉬기는 하나씩 풀어 준다(첫 틱 전에 쉬는 구현도 받는다) */
async function runUntil(w: ReturnType<typeof world>, ok: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !ok(); i++) {
    await settle(() => ok() || w.pendingSleeps().length > 0);
    if (ok()) return;
    w.pendingSleeps()[0]?.release();
  }
}

describe('OrderExpirySweep.tick: 리더', () => {
  test('ADR0107_리더가 아니면 저장소·판정 어느 것도 부르지 않고 { skipped: not_leader }다', async () => {
    const w = world();
    w.state.leader = false;
    w.pages.attempts.push([attempt(1)]);
    w.pages.orders.push([anOrder(2)]);
    await expect(w.sweep().tick()).resolves.toEqual({ skipped: 'not_leader' });
    expect(w.calls.leader).toBeGreaterThanOrEqual(1);
    expect(w.calls.attempts).toEqual([]);
    expect(w.calls.orders).toEqual([]);
    expect(w.calls.check).toEqual([]);
  });

  test('ADR0107_리뷰 고침 L2: 리더가 아닌 틱은 게이지 purchase_order_open_stale을 0으로 둔다(전 리더 파드가 옛 값을 내지 않게. 게이지는 파드 사이 최댓값으로 본다)', async () => {
    const w = world();
    w.state.leader = false;
    await w.sweep().tick();
    expect(w.stale).toEqual([0]);
    expect(w.warns).toEqual([]);
  });
});

describe('OrderExpirySweep.tick: READY 결제 시도 만료', () => {
  test('PT41_ADR0107_만든 지 하루 안이고 40분 [가정] 지난 READY 시도를 500건까지 바꾸라고 부르고, 바뀐 시도의 주문마다 까닭 attempt로 본다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.pages.attempts.push([attempt(1), attempt(2)]);
    const r = await w.sweep().tick();
    expect(w.calls.attempts).toEqual([{ createdFromMs: NOW - ORDER_EXPIRY_LOOKBACK_MS, createdBeforeMs: NOW - ORDER_EXPIRY_ATTEMPT_TTL_MS, limit: ORDER_EXPIRY_BATCH }]);
    expect(w.calls.check).toEqual([
      [orderId(1), 'attempt'],
      [orderId(2), 'attempt'],
    ]);
    expect(r).toMatchObject({ attemptsExpired: 2, checked: 2, expired: 2, failed: 0 });
  });

  test('ADR0107_바꾼 시도가 없으면 판정을 부르지 않는다', async () => {
    const w = world();
    expect(await w.sweep().tick()).toMatchObject({ attemptsExpired: 0, checked: 0, expired: 0, failed: 0 });
    expect(w.calls.check).toEqual([]);
  });

  test('ADR0107_한 묶음이 꽉 차면(500건) 다음 묶음을 이어 부르고, 꽉 차지 않은 묶음에서 멈춘다', async () => {
    const w = world();
    w.pages.attempts.push(attemptsFrom(1, ORDER_EXPIRY_BATCH), attemptsFrom(1001, 3));
    const r = await w.sweep().tick();
    expect(w.calls.attempts).toHaveLength(2);
    expect(r).toMatchObject({ attemptsExpired: ORDER_EXPIRY_BATCH + 3 });
    expect(w.calls.check.filter(([, t]) => t === 'attempt')).toHaveLength(ORDER_EXPIRY_BATCH + 3);
  });

  test('PT41_ADR0107_시도 만료 단계가 실패해도 주문 안전망은 돈다. 실패는 경고 한 줄과 failure(attempt)이고 오류 글은 없다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    w.fail.attempts = named('DatabaseError', SECRET_TEXT);
    w.pages.orders.push([anOrder(1)]);
    const r = await w.sweep().tick();
    expect(w.failures).toEqual(['attempt']);
    expect(w.warns).toHaveLength(1);
    expect(w.warnText()).toContain('DatabaseError');
    expect(w.warnText()).not.toContain('connection lost');
    expect(w.warnText()).not.toContain(ACCOUNT);
    expect(w.calls.check).toEqual([[orderId(1), 'sweep']]);
    expect(r).toMatchObject({ attemptsExpired: 0, checked: 1, expired: 1, failed: 1 });
  });

  test('ADR0107_시도의 주문 판정 하나가 던져도 다음 주문을 본다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    w.pages.attempts.push([attempt(1), attempt(2)]);
    w.outcomes.set(orderId(1), named('OrderSeatStoreUnavailable', SECRET_TEXT));
    const r = await w.sweep().tick();
    expect(w.calls.check.map(([id]) => id)).toEqual([orderId(1), orderId(2)]);
    expect(r).toMatchObject({ attemptsExpired: 2, checked: 2, expired: 1, failed: 1 });
    expect(w.warnText()).not.toContain('connection lost');
  });
});

describe('OrderExpirySweep.tick: 주문 안전망', () => {
  test('PT41_ADR0107_④ 만든 지 하루 안이고 90분 [가정] 지난 열린 주문을 500건씩 읽어 주문마다 까닭 sweep으로 본다(사건을 빠뜨려도 끝낸다) [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.pages.orders.push([anOrder(1), anOrder(2)]);
    const r = await w.sweep().tick();
    expect(w.calls.orders).toEqual([{ createdFromMs: NOW - ORDER_EXPIRY_LOOKBACK_MS, createdBeforeMs: NOW - ORDER_EXPIRY_SWEEP_AGE_MS, limit: ORDER_EXPIRY_BATCH }]);
    expect(w.calls.check).toEqual([
      [orderId(1), 'sweep'],
      [orderId(2), 'sweep'],
    ]);
    expect(r).toMatchObject({ checked: 2, expired: 2, failed: 0 });
  });

  test('ADR0107_꽉 찬 묶음 뒤에는 마지막 주문 ID를 afterId로 넘겨 이어 읽는다(NOT_YET으로 남는 주문이 있어 커서로 넘어간다). 범위와 상한은 그대로다', async () => {
    const w = world();
    const first = ordersFrom(1, ORDER_EXPIRY_BATCH);
    w.pages.orders.push(first, ordersFrom(1001, 3));
    w.outcomes.set(orderId(1), { status: 'NOT_YET', reason: 'ATTEMPT' });
    await w.sweep().tick();
    expect(w.calls.orders).toHaveLength(2);
    expect(w.calls.orders[0]!.afterId).toBeUndefined();
    expect(w.calls.orders[1]).toEqual({ createdFromMs: NOW - ORDER_EXPIRY_LOOKBACK_MS, createdBeforeMs: NOW - ORDER_EXPIRY_SWEEP_AGE_MS, limit: ORDER_EXPIRY_BATCH, afterId: first.at(-1)!.orderId });
    expect(w.calls.check).toHaveLength(ORDER_EXPIRY_BATCH + 3);
  });

  test('ADR0107_꽉 찼던 묶음 다음이 비면 거기서 멈춘다', async () => {
    const w = world();
    w.pages.orders.push(ordersFrom(1, ORDER_EXPIRY_BATCH));
    await w.sweep().tick();
    expect(w.calls.orders).toHaveLength(2);
  });

  test('ADR0107_꽉 차지 않은 묶음이면 더 읽지 않는다', async () => {
    const w = world();
    w.pages.orders.push(ordersFrom(1, ORDER_EXPIRY_BATCH - 1));
    await w.sweep().tick();
    expect(w.calls.orders).toHaveLength(1);
  });

  test('ADR0107_묶음 크기는 batchSize로 바꾸고 500을 넘으면 500이다', async () => {
    const small = world();
    small.pages.orders.push(ordersFrom(1, 2), ordersFrom(10, 1));
    await small.sweep({ batchSize: 2 }).tick();
    expect(small.calls.attempts[0]!.limit).toBe(2);
    expect(small.calls.orders.map((o) => o.limit)).toEqual([2, 2]);
    expect(small.calls.orders[1]!.afterId).toBe(orderId(2));

    const big = world();
    await big.sweep({ batchSize: 5_000 }).tick();
    expect(big.calls.attempts[0]!.limit).toBe(ORDER_EXPIRY_BATCH);
    expect(big.calls.orders[0]!.limit).toBe(ORDER_EXPIRY_BATCH);
  });

  test('PT41_ADR0107_보고의 expired는 만료로 끝낸 주문만 센다. 아직(NOT_YET)·닫힘(NOT_OPEN)은 checked에만 들어가고 실패가 아니다', async () => {
    const w = world();
    w.pages.orders.push([anOrder(1), anOrder(2), anOrder(3)]);
    w.outcomes.set(orderId(2), { status: 'NOT_YET', reason: 'HOLD' });
    w.outcomes.set(orderId(3), { status: 'NOT_OPEN', current: 'ACCEPTED' });
    expect(await w.sweep().tick()).toMatchObject({ attemptsExpired: 0, checked: 3, expired: 1, failed: 0 });
    expect(w.failures).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('ADR0107_만료 지표는 판정(check)이 올리므로 반복은 expired를 더 올리지 않는다(두 번 세지 않는다)', async () => {
    const w = world();
    w.pages.attempts.push([attempt(1)]);
    w.pages.orders.push([anOrder(2)]);
    await w.sweep().tick();
    expect(w.expired).toEqual([]);
  });

  test('PT41_ADR0107_한 주문의 판정이 던져도 다음 주문을 본다. 실패 수에 들어가고 경고에 오류 글은 없으며 틱은 던지지 않는다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    w.pages.orders.push([anOrder(1), anOrder(2), anOrder(3)]);
    w.outcomes.set(orderId(2), named('OrderSeatStoreUnavailable', SECRET_TEXT));
    const r = await w.sweep().tick();
    expect(w.calls.check.map(([id]) => id)).toEqual([orderId(1), orderId(2), orderId(3)]);
    expect(r).toMatchObject({ checked: 3, expired: 2, failed: 1 });
    expect(w.warns).toHaveLength(1);
    expect(w.warnText()).toContain('OrderSeatStoreUnavailable');
    expect(w.warnText()).not.toContain('connection lost');
    expect(w.warnText()).not.toContain(ACCOUNT);
  });

  test('ADR0107_묶음 읽기가 실패해도 던지지 않고 경고 한 줄과 failure(sweep)이다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    w.fail.orders = named('DatabaseError', SECRET_TEXT);
    const r = await w.sweep().tick();
    expect(w.failures).toEqual(['sweep']);
    expect(w.warns).toHaveLength(1);
    expect(r).toMatchObject({ failed: 1 });
  });

  test('ADR0107_멈춤 신호가 끊기면 남은 묶음을 읽지 않고 그때까지의 보고를 돌려준다', async () => {
    const w = world();
    const ac = new AbortController();
    w.pages.orders.push(ordersFrom(1, ORDER_EXPIRY_BATCH), ordersFrom(1001, 3));
    w.wait.check = async (id) => {
      if (id === orderId(1)) ac.abort();
    };
    const r = await w.sweep().tick(ac.signal);
    expect(w.calls.orders).toHaveLength(1);
    expect(r).toMatchObject({ failed: 0 });
    expect((r as { checked: number }).checked).toBeLessThanOrEqual(ORDER_EXPIRY_BATCH);
    expect((r as { checked: number }).checked).toBeGreaterThanOrEqual(1);
  });
});

describe('OrderExpirySweep.tick: 하루 넘은 열린 주문(정비 일의 몫)', () => {
  test('PT41_ADR0107_리뷰 고침 M3: 리더의 틱은 하루 넘은 주문을 세지 않고 게이지를 건드리지 않으며 경고도 없다(매일 정비 일 order-expiry-stale이 맡는다)', async () => {
    const w = world();
    const r = await w.sweep().tick();
    expect(w.stale).toEqual([]);
    expect(w.warns).toEqual([]);
    expect(r).not.toHaveProperty('staleOpen');
  });
});

describe('orderExpiryStaleTask(하루 넘은 열린 주문의 정비 일, docs/features/payment.md §2 안전망 ③)', () => {
  const DAY = 86_400_000;
  const report = (r: unknown) => r as OrderExpiryStaleReport;

  test('PT41_ADR0107_리뷰 고침 M3: 이름은 order-expiry-stale이고 정비 시간 창(when window)에서 하루 한 번 돈다', () => {
    const task = world().staleTask();
    expect(task.name).toBe('order-expiry-stale');
    expect(task.when).toBe('window');
  });

  test('PT41_ADR0107_리뷰 고침 M3: 만든 지 1~30일 [가정]인 열린 주문을 1,000건씩 읽어 주문마다 까닭 sweep으로 본다. 만료로 끝나면 게이지는 0이고 경고가 없다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.pages.stale.push([anOrder(1), anOrder(2)]);
    const r = await w.staleTask().run();
    expect(w.calls.staleBatch).toEqual([{ createdFromMs: NOW - 30 * DAY, createdBeforeMs: NOW - DAY, limit: 1_000 }]);
    expect(w.calls.check).toEqual([
      [orderId(1), 'sweep'],
      [orderId(2), 'sweep'],
    ]);
    expect(report(r)).toEqual({ checked: 2, expired: 2, stillOpen: 0, failed: 0 });
    expect(w.stale).toEqual([0]);
    expect(w.warns).toEqual([]);
  });

  test('PT41_ADR0107_리뷰 고침 M3: 꽉 찬 묶음 뒤에는 마지막 주문 ID를 afterId로 넘겨 이어 읽고(NOT_YET으로 남는 주문이 있어 커서로 간다), 꽉 차지 않은 묶음에서 멈춘다. batchSize로 바꾼다', async () => {
    const w = world();
    w.pages.stale.push(ordersFrom(1, 2), ordersFrom(10, 1));
    w.outcomes.set(orderId(1), { status: 'NOT_YET', reason: 'HOLD' });
    await w.staleTask({ batchSize: 2 }).run();
    expect(w.calls.staleBatch.map((c) => c.limit)).toEqual([2, 2]);
    expect(w.calls.staleBatch[0]!.afterId).toBeUndefined();
    expect(w.calls.staleBatch[1]!.afterId).toBe(orderId(2));
    expect(w.calls.check.map(([id]) => id)).toEqual([orderId(1), orderId(2), orderId(10)]);
  });

  test('PT41_ADR0107_리뷰 고침 M3: 끝에 그래도 열린 수를 게이지에 둔다: 아직(NOT_YET)과 판정 실패는 열린 수이고 만료·닫힘(NOT_OPEN)은 아니다. 한 주문의 실패는 다음을 막지 않고 경고는 끝에 한 줄이다(주문 ID·오류 글 없음) [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    w.pages.stale.push([anOrder(1), anOrder(2), anOrder(3), anOrder(4)]);
    w.outcomes.set(orderId(1), { status: 'NOT_YET', reason: 'HOLD' });
    w.outcomes.set(orderId(2), named('OrderSeatStoreUnavailable', SECRET_TEXT));
    w.outcomes.set(orderId(3), { status: 'NOT_OPEN', current: 'ACCEPTED' });
    const r = await w.staleTask().run();
    expect(w.calls.check.map(([id]) => id)).toEqual([orderId(1), orderId(2), orderId(3), orderId(4)]);
    expect(report(r)).toEqual({ checked: 4, expired: 1, stillOpen: 2, failed: 1 });
    expect(w.stale).toEqual([2]);
    expect(w.warns).toHaveLength(1);
    expect(w.warns[0]!.obj).toMatchObject({ stillOpen: 2, failed: 1 });
    expect(w.warnText()).not.toContain('connection lost');
    expect(w.warnText()).not.toContain(orderId(1));
  });

  test('PT41_ADR0107_리뷰 고침 M3: 멈춤 신호가 끊기면 다음 묶음을 읽지 않고 게이지·경고를 건드리지 않는다(일부만 본 수를 내지 않는다, 정비 실행기가 다시 돌린다) [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    const ac = new AbortController();
    w.pages.stale.push(ordersFrom(1, 1_000), ordersFrom(5_000, 1));
    w.outcomes.set(orderId(1), { status: 'NOT_YET', reason: 'HOLD' });
    w.wait.check = async (id) => {
      if (id === orderId(1_000)) ac.abort();
    };
    await w.staleTask().run(ac.signal);
    expect(w.calls.staleBatch).toHaveLength(1);
    expect(w.stale).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('PT41_ADR0107_리뷰 고침 M3: 묶음 읽기가 실패하면 던지고(정비 실행기가 실패로 세어 다음에 다시 한다) failure(sweep)이며 게이지는 지난 값 그대로다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    w.fail.staleBatch = named('DatabaseError', SECRET_TEXT);
    await expect(w.staleTask().run()).rejects.toThrow(SECRET_TEXT);
    expect(w.failures).toEqual(['sweep']);
    expect(w.stale).toEqual([]);
  });
});

describe('OrderExpirySweep.start·stop', () => {
  test('ADR0107_리더 반복의 모양을 맞추고 이름은 order-expiry-sweep이다', () => {
    const w = world();
    const loop: LeaderLoop = w.sweep();
    expect(loop.name).toBe('order-expiry-sweep');
  });

  test('ADR0107_틱 사이에는 10분 [가정] 쉬고 deps.tickMs로 바꾼다. 쉬기는 멈춤 신호를 받는다', async () => {
    expect(ORDER_EXPIRY_SWEEP_INTERVAL_MS).toBe(600_000);
    const w = world();
    const r = w.sweep();
    r.start();
    await runUntil(w, () => w.calls.attempts.length >= 3);
    await r.stop();
    expect(w.calls.attempts.length).toBeGreaterThanOrEqual(3);
    expect(w.sleeps.slice(0, 2).map((s) => s.ms)).toEqual([ORDER_EXPIRY_SWEEP_INTERVAL_MS, ORDER_EXPIRY_SWEEP_INTERVAL_MS]);
    expect(w.sleeps.every((s) => s.signal instanceof AbortSignal)).toBe(true);

    const w2 = world();
    const r2 = w2.sweep({ tickMs: 50 });
    r2.start();
    await runUntil(w2, () => w2.calls.attempts.length >= 2);
    await r2.stop();
    expect(w2.sleeps[0]!.ms).toBe(50);
  });

  test('ADR0107_리뷰 고침 L1: 리더가 아니면 5초 [가정] 뒤 다시 본다(10분을 자지 않는다): 리더가 되면 5초 안에 틱이 돌고, 그 뒤로는 10분 [가정]마다 돈다', async () => {
    const w = world();
    w.state.leader = false;
    const r = w.sweep();
    r.start();
    await settle(() => w.pendingSleeps().length === 1);
    expect(w.calls.attempts).toEqual([]);
    expect(w.pendingSleeps()[0]!.ms).toBe(5_000);

    w.state.leader = true;
    w.pendingSleeps()[0]!.release();
    await settle(() => w.calls.attempts.length === 1 && w.pendingSleeps().length === 1);
    expect(w.calls.attempts).toHaveLength(1);
    expect(w.pendingSleeps()[0]!.ms).toBe(ORDER_EXPIRY_SWEEP_INTERVAL_MS);
    await r.stop();
  });

  test('ADR0107_리뷰 고침 L1: 시험이 틱 간격을 5초보다 줄이면 리더가 아닐 때도 그 간격이다', async () => {
    const w = world();
    w.state.leader = false;
    const r = w.sweep({ tickMs: 50 });
    r.start();
    await settle(() => w.pendingSleeps().length === 1);
    expect(w.pendingSleeps()[0]!.ms).toBe(50);
    await r.stop();
  });

  test('ADR0107_리더가 아닌 동안은 틱이 아무것도 하지 않고, 리더가 되면 돈다', async () => {
    const w = world();
    w.state.leader = false;
    const r = w.sweep();
    r.start();
    await runUntil(w, () => w.calls.leader >= 2);
    expect(w.calls.attempts).toEqual([]);
    w.state.leader = true;
    await runUntil(w, () => w.calls.attempts.length >= 1);
    await r.stop();
    expect(w.calls.attempts.length).toBeGreaterThanOrEqual(1);
  });

  test('ADR0107_stop은 돌던 틱이 끝날 때까지 기다리고 틱에 멈춤 신호를 보낸다. 그 뒤로 틱이 없다', async () => {
    const w = world();
    const gate = deferred();
    w.pages.orders.push(ordersFrom(1, ORDER_EXPIRY_BATCH), ordersFrom(1001, 1));
    w.wait.check = (id) => (id === orderId(1) ? gate.promise : Promise.resolve());
    const r = w.sweep();
    r.start();
    await runUntil(w, () => w.calls.check.length >= 1);
    let stopped = false;
    const p = r.stop().then(() => void (stopped = true));
    for (let i = 0; i < 20; i++) await flush();
    expect(stopped).toBe(false);
    gate.resolve();
    await p;
    expect(stopped).toBe(true);
    // 끊긴 틱은 남은 묶음을 읽지 않는다
    expect(w.calls.orders).toHaveLength(1);
    const ticks = w.calls.attempts.length;
    for (let i = 0; i < 20; i++) await flush();
    expect(w.calls.attempts.length).toBe(ticks);
  });

  test('ADR0107_stop은 쉬는 중이면 쉬기를 끊고 바로 끝난다', async () => {
    const w = world();
    const r = w.sweep();
    r.start();
    await runUntil(w, () => w.calls.attempts.length >= 1 && w.pendingSleeps().length >= 1);
    const ticks = w.calls.attempts.length;
    await r.stop();
    expect(w.sleeps.every((s) => s.done)).toBe(true);
    expect(w.sleeps.at(-1)!.signal.aborted).toBe(true);
    for (let i = 0; i < 20; i++) await flush();
    expect(w.calls.attempts.length).toBe(ticks);
  });

  test('ADR0107_start를 두 번 불러도 반복은 하나다. stop은 켜지 않았어도, 두 번 불러도 된다', async () => {
    const idle = world();
    const r0 = idle.sweep();
    await r0.stop();
    await r0.stop();
    expect(idle.calls.attempts).toEqual([]);

    const w = world();
    const gate = deferred();
    w.pages.attempts.push([attempt(1)]);
    w.wait.check = () => gate.promise;
    const r = w.sweep();
    r.start();
    r.start();
    await runUntil(w, () => w.calls.check.length >= 1);
    for (let i = 0; i < 5; i++) {
      for (const s of w.pendingSleeps()) s.release();
      await flush();
    }
    expect(w.calls.attempts).toHaveLength(1);
    gate.resolve();
    await r.stop();
    await r.stop();
  });

  test('ADR0107_반복은 예상 밖 오류에 끝나지 않는다: 틱이 던져도(리더 확인이 던짐) 쉬고 이어 돌아 다음 틱에 다시 본다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    let first = true;
    w.fail.leader = () => {
      if (!first) return undefined;
      first = false;
      return named('UnexpectedError', 'boom');
    };
    const r = w.sweep({ tickMs: 50 });
    r.start();
    await runUntil(w, () => w.calls.attempts.length >= 1);
    await r.stop();
    expect(w.calls.attempts.length).toBeGreaterThanOrEqual(1);
    expect(w.sleeps[0]!.ms).toBe(50);
  });
});
