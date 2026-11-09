// 결제하지 않은 주문의 만료 판정(OrderExpiry.check·사건 고리, ADR-0107 결정 1·2·6, docs/features/payment.md §2 '결제하지 않은 주문 만료의 첫 구현', BUILD_ORDER PRF-172 설계 1·2, 시험 P-T41).
// 저장소·inventory 다리·지표·로거는 시험 안의 대역이다. 대역 저장소의 expireIfDue는 운영처럼 '입력으로 받은 세션·홀드와 저장소가 다시 본 상태·결제 시도'로 결과를 정한다.
// 기다림은 약속 바퀴를 돌리는 settle로 푼다(고정 sleep 없음). 지표 어댑터 PromOrderExpirySignals와 세션 다리 InventoryOrderExpiry.sessionEnded도 여기서 본다
// (홀드 남음 holdRemains는 실제 Valkey가 있어야 뜻이 있어 test-int/order-expiry.int.test.ts가 본다).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { type FakeClock, fakeClock, PlatformMetrics, type Registry } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  InventoryOrderExpiry,
  ORDER_EXPIRY_ACTOR,
  ORDER_EXPIRY_CONCURRENCY,
  ORDER_EXPIRY_QUEUE_LIMIT,
  ORDER_EXPIRY_TRIGGERS,
  OrderExpiry,
  type OrderExpiryDeps,
  type OrderExpiryInput,
  type OrderExpiryOrder,
  type OrderExpiryOutcome,
  type OrderExpiryStage,
  type OrderExpiryTrigger,
  type OrderHoldQuery,
  OrderSeatStoreUnavailable,
  type OrderStatus,
  PromOrderExpirySignals,
} from '../src/modules/booking/index.js';
import { SeatStoreUnavailable } from '../src/modules/inventory/index.js';

const EVENT = '0190f3a1-7c2e-7a00-8000-0000000000e1';
const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
const SESSION = 'jti-order-expiry-1';
const NOW = Date.parse('2026-11-09T03:00:00.000Z');

const orderId = (n: number): string => `0190f3a1-7c2e-7a00-8000-${String(n).padStart(12, '0')}`;
const holdId = (n: number): string => `0190f3a1-7c2e-7b00-8000-${String(n).padStart(12, '0')}`;

/** 주문 칸(구현이 칸을 더해도 형 검사가 되게 단언으로 맞춘다) */
const anOrder = (n: number, o: { status?: OrderStatus; session?: string } = {}): OrderExpiryOrder =>
  ({ orderId: orderId(n), accountId: ACCOUNT, eventId: EVENT, purchaseSessionId: o.session ?? SESSION, holdId: holdId(n), status: o.status ?? 'CREATED' }) as OrderExpiryOrder;

/** 지금 쌓인 약속 작업을 한 바퀴 돌린다(시간을 기다리지 않는다) */
const flush = () => new Promise<void>((r) => setImmediate(r));
/** 조건이 설 때까지 쌓인 작업을 한 바퀴씩 돌린다(400바퀴까지) */
async function settle(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await flush();
}
const rounds = async (n = 20): Promise<void> => {
  for (let i = 0; i < n; i++) await flush();
};

/** 미뤄 둔 약속 */
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

/** 이름이 있는 오류(글에는 로그에 나가면 안 되는 값을 싣는다) */
const named = (name: string, message: string) => Object.assign(new Error(message), { name });
const SECRET_TEXT = `connection lost s:{event:${EVENT}}:stream ${ACCOUNT}`;

/** 대역 조립 하나. state는 트랜잭션 안에서 다시 보는 값(활성 결제 시도)과 inventory가 답할 값이다 */
function world(o: { logger?: boolean; concurrency?: number; queueLimit?: number } = {}) {
  const orders = new Map<string, OrderExpiryOrder>();
  const clock = fakeClock({ now: NOW });
  const state = { sessionEnded: true, holdRemains: false, activeAttempt: false };
  /** expireIfDue가 다시 본 지금 상태(먼저 읽은 상태와 달라진 경합을 끼운다) */
  const lockedStatus = new Map<string, OrderStatus>();
  const log: string[] = [];
  const calls = {
    order: [] as string[],
    openOrdersOfSession: [] as string[],
    openOrdersOfHolds: [] as string[][],
    expireIfDue: [] as OrderExpiryInput[],
    sessionEnded: [] as string[],
    holdRemains: [] as OrderHoldQuery[],
  };
  const fail: { openOrdersOfSession?: unknown; openOrdersOfHolds?: unknown; expireIfDue?: Map<string, unknown>; sessionEnded?: unknown; holdRemains?: unknown } = {};
  const wait: { openOrdersOfSession?: () => Promise<void>; expireIfDue?: (id: string) => Promise<void> } = {};
  const expired: OrderExpiryTrigger[] = [];
  const failures: string[] = [];
  const stale: number[] = [];
  const warns: { obj: Record<string, unknown>; msg: string }[] = [];
  const running = { now: 0, max: 0 };

  const store: OrderExpiryDeps['store'] = {
    order: async (id) => {
      calls.order.push(id);
      log.push('order');
      return orders.get(id);
    },
    openOrdersOfSession: async (sid) => {
      calls.openOrdersOfSession.push(sid);
      await wait.openOrdersOfSession?.();
      if (fail.openOrdersOfSession !== undefined) throw fail.openOrdersOfSession;
      return [...orders.values()].filter((x) => x.purchaseSessionId === sid && (x.status === 'CREATED' || x.status === 'AUTHENTICATED'));
    },
    openOrdersOfHolds: async (hids) => {
      calls.openOrdersOfHolds.push([...hids]);
      if (fail.openOrdersOfHolds !== undefined) throw fail.openOrdersOfHolds;
      const wanted = new Set(hids);
      return [...orders.values()].filter((v) => wanted.has(v.holdId) && (v.status === 'CREATED' || v.status === 'AUTHENTICATED'));
    },
    expireIfDue: async (i): Promise<OrderExpiryOutcome> => {
      calls.expireIfDue.push({ ...i });
      log.push('expireIfDue');
      running.now += 1;
      running.max = Math.max(running.max, running.now);
      try {
        await wait.expireIfDue?.(i.orderId);
      } finally {
        running.now -= 1;
      }
      const x = fail.expireIfDue?.get(i.orderId);
      if (x !== undefined) throw x;
      const status = lockedStatus.get(i.orderId) ?? orders.get(i.orderId)?.status;
      if (status === undefined) return { status: 'NOT_OPEN' };
      if (status !== 'CREATED' && status !== 'AUTHENTICATED') return { status: 'NOT_OPEN', current: status };
      if (!i.sessionEnded) return { status: 'NOT_YET', reason: 'SESSION' };
      if (i.holdRemains) return { status: 'NOT_YET', reason: 'HOLD' };
      if (state.activeAttempt) return { status: 'NOT_YET', reason: 'ATTEMPT' };
      return { status: 'EXPIRED', transition: status === 'CREATED' ? 'T5' : 'T6', seq: 2 };
    },
  };
  const inventory: OrderExpiryDeps['inventory'] = {
    sessionEnded: async (sid) => {
      calls.sessionEnded.push(sid);
      log.push('sessionEnded');
      if (fail.sessionEnded !== undefined) throw fail.sessionEnded;
      return state.sessionEnded;
    },
    holdRemains: async (q) => {
      calls.holdRemains.push({ ...q });
      log.push('holdRemains');
      if (fail.holdRemains !== undefined) throw fail.holdRemains;
      return state.holdRemains;
    },
  };
  const signals: OrderExpiryDeps['signals'] = {
    expired: (t) => void expired.push(t),
    failure: (s) => void failures.push(s),
    openStale: (n) => void stale.push(n),
  };
  const logger = { warn: (obj: object, msg: string) => void warns.push({ obj: obj as Record<string, unknown>, msg }) };
  const expiry = new OrderExpiry({
    store,
    inventory,
    signals,
    clock,
    ...(o.logger === false ? {} : { logger }),
    ...(o.concurrency === undefined ? {} : { concurrency: o.concurrency }),
    ...(o.queueLimit === undefined ? {} : { queueLimit: o.queueLimit }),
  });
  const add = (...xs: OrderExpiryOrder[]) => {
    for (const x of xs) orders.set(x.orderId, x);
  };
  const warnText = () => warns.map((w) => `${JSON.stringify(w.obj)} ${w.msg}`).join('\n');
  /** 세션 종료 고리 값(형이 달라져도 검사되게 변수로 넘긴다) */
  const ended = (session = SESSION) => {
    const e = { eventId: EVENT, purchaseSessionId: session };
    expiry.onSessionEnded(e);
  };
  return { orders, clock, state, lockedStatus, log, calls, fail, wait, expired, failures, stale, warns, running, store, inventory, signals, expiry, add, warnText, ended };
}

describe('OrderExpiry.check: 세 조건과 만료', () => {
  test.each([
    ['CREATED', 'T5'],
    ['AUTHENTICATED', 'T6'],
  ] as const)('PT41_ADR0107_%s 주문의 세 조건이 모두 끝나면 %s로 EXPIRED이고 expireIfDue에 읽은 값과 행위자를 넘긴다 [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.3]', async (status, transition) => {
    const w = world();
    w.add(anOrder(1, { status }));
    await expect(w.expiry.check(orderId(1), 'sweep')).resolves.toMatchObject({ status: 'EXPIRED', transition });
    expect(w.calls.expireIfDue).toEqual([{ orderId: orderId(1), sessionEnded: true, holdRemains: false, actor: ORDER_EXPIRY_ACTOR }]);
    expect(w.calls.sessionEnded).toEqual([SESSION]);
    expect(w.calls.holdRemains).toEqual([expect.objectContaining({ eventId: EVENT, purchaseSessionId: SESSION, accountId: ACCOUNT, holdId: holdId(1) })]);
    expect(w.expired).toEqual(['sweep']);
    expect(w.failures).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('ADR0107_세션·홀드는 트랜잭션(expireIfDue)을 열기 전에 읽고 트랜잭션 뒤에는 읽지 않는다(DB 잠금을 쥔 채 좌석 Redis를 부르지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const w = world();
    w.add(anOrder(1));
    await w.expiry.check(orderId(1), 'session');
    const at = (x: string) => w.log.indexOf(x);
    expect(at('order')).toBe(0);
    expect(at('sessionEnded')).toBeGreaterThan(at('order'));
    expect(at('holdRemains')).toBeGreaterThan(at('order'));
    expect(at('expireIfDue')).toBeGreaterThan(at('sessionEnded'));
    expect(at('expireIfDue')).toBeGreaterThan(at('holdRemains'));
    expect(w.log.at(-1)).toBe('expireIfDue');
    expect(w.log.filter((x) => x === 'expireIfDue')).toHaveLength(1);
  });

  test.each(ORDER_EXPIRY_TRIGGERS)('PT41_ADR0107_까닭 %s로 부른 check가 만료로 끝나면 지표 expired는 그 까닭으로 한 번이다', async (trigger) => {
    const w = world();
    w.add(anOrder(1));
    await w.expiry.check(orderId(1), trigger);
    expect(w.expired).toEqual([trigger]);
  });

  test('PT41_ADR0107_주문이 없으면 NOT_OPEN(current 없음)이고 inventory도 트랜잭션도 부르지 않으며 지표도 없다', async () => {
    const w = world();
    expect(await w.expiry.check(orderId(9), 'hold')).toEqual({ status: 'NOT_OPEN' });
    expect(w.calls.sessionEnded).toEqual([]);
    expect(w.calls.holdRemains).toEqual([]);
    expect(w.calls.expireIfDue).toEqual([]);
    expect(w.expired).toEqual([]);
    expect(w.failures).toEqual([]);
  });

  test.each(['ACCEPTED', 'EXPIRED', 'CONFIRMED'] as const)('PT41_ADR0107_이미 %s인 주문은 NOT_OPEN과 지금 상태이고 inventory도 트랜잭션도 부르지 않는다 [ASVS v5.0.0-2.3.1]', async (status) => {
    const w = world();
    w.add(anOrder(1, { status }));
    expect(await w.expiry.check(orderId(1), 'sweep')).toEqual({ status: 'NOT_OPEN', current: status });
    expect(w.calls.sessionEnded).toEqual([]);
    expect(w.calls.holdRemains).toEqual([]);
    expect(w.calls.expireIfDue).toEqual([]);
    expect(w.expired).toEqual([]);
  });

  test('PT41_ADR0107_구매 세션이 아직이면 NOT_YET SESSION이고 만료하지 않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.state.sessionEnded = false;
    w.add(anOrder(1));
    expect(await w.expiry.check(orderId(1), 'hold')).toEqual({ status: 'NOT_YET', reason: 'SESSION' });
    expect(w.expired).toEqual([]);
    expect(w.failures).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('PT41_ADR0107_세션은 끝났어도 홀드가 남으면 NOT_YET HOLD이고 만료하지 않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.state.holdRemains = true;
    w.add(anOrder(1));
    expect(await w.expiry.check(orderId(1), 'session')).toEqual({ status: 'NOT_YET', reason: 'HOLD' });
    expect(w.expired).toEqual([]);
  });

  test.each([
    ['구매 세션이 아직', { sessionEnded: false, holdRemains: false }, 'SESSION'],
    ['세션은 끝났어도 홀드가 남음', { sessionEnded: true, holdRemains: true }, 'HOLD'],
    ['세션도 홀드도 아직(세션을 먼저 말한다)', { sessionEnded: false, holdRemains: true }, 'SESSION'],
  ] as const)('PT41_ADR0107_리뷰 고침 L3: %s이면 트랜잭션(expireIfDue)을 열지 않고 NOT_YET %s다(살아 있는 주문마다 쓰기 연결을 쥐지 않는다) [ASVS v5.0.0-2.3.1]', async (_label, s, reason) => {
    const w = world();
    Object.assign(w.state, s);
    w.add(anOrder(1));
    expect(await w.expiry.check(orderId(1), 'session')).toEqual({ status: 'NOT_YET', reason });
    expect(w.calls.expireIfDue).toEqual([]);
    expect(w.expired).toEqual([]);
    expect(w.failures).toEqual([]);
  });

  test('PT41_ADR0107_세션이 끝나고 홀드가 풀렸어도 트랜잭션에서 활성 결제 시도가 보이면 NOT_YET ATTEMPT이고 만료하지 않는다(결제창을 닫고 떠난 주문은 시도 만료까지 기다린다) [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.state.activeAttempt = true;
    w.add(anOrder(1));
    expect(await w.expiry.check(orderId(1), 'hold')).toEqual({ status: 'NOT_YET', reason: 'ATTEMPT' });
    expect(w.expired).toEqual([]);
  });

  test('PT41_ADR0107_만료 직전 결제 접수: 잠금 전 읽기에는 CREATED였어도 잠그고 다시 본 상태가 ACCEPTED면 NOT_OPEN(current)이고 지표는 없다(접수가 먼저면 만료하지 않는다) [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-2.3.3]', async () => {
    const w = world();
    w.add(anOrder(1));
    w.lockedStatus.set(orderId(1), 'ACCEPTED');
    expect(await w.expiry.check(orderId(1), 'attempt')).toEqual({ status: 'NOT_OPEN', current: 'ACCEPTED' });
    expect(w.expired).toEqual([]);
    expect(w.failures).toEqual([]);
  });

  test.each(['sessionEnded', 'holdRemains'] as const)('ADR0107_inventory.%s가 던지면 그 오류를 그대로 던지고(끝났다·풀렸다로 보지 않는다) 트랜잭션을 열지 않으며 failure(check)가 한 번이다 [ASVS v5.0.0-16.5.2]', async (which) => {
    const w = world();
    w.add(anOrder(1));
    const err = new OrderSeatStoreUnavailable(new Error('down'));
    w.fail[which] = err;
    await expect(w.expiry.check(orderId(1), 'sweep')).rejects.toBe(err);
    expect(w.calls.expireIfDue).toEqual([]);
    expect(w.expired).toEqual([]);
    expect(w.failures).toEqual(['check']);
  });

  test('ADR0107_트랜잭션이 던지면 그 오류를 그대로 던지고 만료 지표는 오르지 않는다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    w.add(anOrder(1));
    const err = named('DatabaseError', 'deadlock');
    w.fail.expireIfDue = new Map([[orderId(1), err]]);
    await expect(w.expiry.check(orderId(1), 'sweep')).rejects.toBe(err);
    expect(w.expired).toEqual([]);
  });
});

describe('OrderExpiry.onSessionEnded: 구매 세션 종료 고리', () => {
  test('PT41_ADR0107_그 세션의 열린 주문을 찾아 주문마다 까닭 session으로 본다(다른 세션의 주문·이미 닫힌 주문은 보지 않는다) [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.add(anOrder(1), anOrder(2, { status: 'AUTHENTICATED' }), anOrder(3, { status: 'ACCEPTED' }), anOrder(4, { session: 'jti-other' }));
    w.ended();
    await settle(() => w.expired.length === 2);
    await rounds();
    expect(w.calls.openOrdersOfSession).toEqual([SESSION]);
    expect(w.calls.expireIfDue.map((i) => i.orderId).sort()).toEqual([orderId(1), orderId(2)]);
    expect(w.expired).toEqual(['session', 'session']);
    expect(w.failures).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('PT41_ADR0107_열린 주문이 없으면 아무 판정도 부르지 않고 경고도 없다(주문을 만들지 않고 떠난 세션)', async () => {
    const w = world();
    w.ended();
    await settle(() => w.calls.openOrdersOfSession.length === 1);
    await rounds();
    expect(w.calls.expireIfDue).toEqual([]);
    expect(w.calls.order).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('PT41_ADR0107_아직 조건이 남은 주문(NOT_YET)은 경고도 실패 지표도 아니다', async () => {
    const w = world();
    w.state.holdRemains = true;
    w.add(anOrder(1));
    w.ended();
    await settle(() => w.calls.holdRemains.length === 1);
    await rounds();
    expect(w.expired).toEqual([]);
    expect(w.failures).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('ADR0107_고리는 호출자를 막지 않는다: 저장소가 끝나지 않아도 바로 돌아오고 값이 없다', async () => {
    const w = world();
    const gate = deferred();
    w.wait.openOrdersOfSession = () => gate.promise;
    w.add(anOrder(1));
    const e = { eventId: EVENT, purchaseSessionId: SESSION };
    expect(w.expiry.onSessionEnded(e)).toBeUndefined();
    await rounds(5);
    expect(w.calls.expireIfDue).toEqual([]);
    gate.resolve();
    await settle(() => w.expired.length === 1);
    expect(w.expired).toEqual(['session']);
  });

  test('ADR0107_주문 찾기가 실패하면 던지지 않고 경고 한 줄과 failure(hook)이다. 경고에 오류 이름만 있고 오류 글·구매 세션 ID는 없다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    w.fail.openOrdersOfSession = named('DatabaseError', SECRET_TEXT);
    expect(() => w.ended()).not.toThrow();
    await settle(() => w.failures.length >= 1);
    await rounds();
    expect(w.failures).toEqual(['hook']);
    expect(w.warns).toHaveLength(1);
    expect(w.warnText()).toContain('DatabaseError');
    expect(w.warnText()).not.toContain(ACCOUNT);
    expect(w.warnText()).not.toContain('connection lost');
    expect(w.warnText()).not.toContain('s:{');
    expect(w.warnText()).not.toContain(SESSION);
  });

  test('ADR0107_저장소가 곧바로 던져도(동기) 호출자에게 나가지 않고 경고 한 줄과 failure(hook)이다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    const expiry = new OrderExpiry({
      store: {
        ...w.store,
        openOrdersOfSession: () => {
          throw named('TypeError', SECRET_TEXT);
        },
      },
      inventory: w.inventory,
      signals: w.signals,
      clock: w.clock,
      logger: { warn: (obj, msg) => void w.warns.push({ obj: obj as Record<string, unknown>, msg }) },
    });
    const e = { eventId: EVENT, purchaseSessionId: SESSION };
    expect(() => expiry.onSessionEnded(e)).not.toThrow();
    await settle(() => w.failures.length >= 1);
    expect(w.failures).toEqual(['hook']);
    expect(w.warns).toHaveLength(1);
  });

  test('PT41_ADR0107_한 주문의 판정이 실패해도 다른 주문은 본다. 실패는 경고 한 줄과 failure(hook)이고 오류 글·계정 ID는 없다(안전망이 받친다) [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    w.add(anOrder(1), anOrder(2));
    w.fail.expireIfDue = new Map([[orderId(1), named('DatabaseError', SECRET_TEXT)]]);
    w.ended();
    await settle(() => w.expired.length === 1 && w.failures.includes('hook'));
    await rounds();
    expect(w.expired).toEqual(['session']);
    expect(w.failures.filter((s) => s === 'hook')).toHaveLength(1);
    expect(w.warns).toHaveLength(1);
    expect(w.warnText()).toContain('DatabaseError');
    expect(w.warnText()).not.toContain('connection lost');
    expect(w.warnText()).not.toContain(ACCOUNT);
  });

  test('ADR0107_좌석 Redis가 안 되어 판정이 던져도 고리는 던지지 않고 failure(hook)이 한 번이며 주문은 그대로다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    w.add(anOrder(1));
    w.fail.sessionEnded = new OrderSeatStoreUnavailable(new Error('down'));
    w.ended();
    await settle(() => w.failures.includes('hook'));
    await rounds();
    expect(w.failures.filter((s) => s === 'hook')).toHaveLength(1);
    expect(w.calls.expireIfDue).toEqual([]);
    expect(w.expired).toEqual([]);
    expect(w.warns).toHaveLength(1);
    expect(w.warnText()).toContain('OrderSeatStoreUnavailable');
  });

  test('ADR0107_로거를 달지 않은 조립도 실패를 던지지 않고 failure(hook)을 센다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world({ logger: false });
    w.fail.openOrdersOfSession = new Error('down');
    w.ended();
    await settle(() => w.failures.length >= 1);
    expect(w.failures).toEqual(['hook']);
  });

  test('ADR0107_리뷰 고침 L6: 고리 실패가 이어져도 경고는 파드마다 1분에 한 줄이고 지표 failure(hook)은 건마다다(장애 때 로그 수가 폭증하지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    w.fail.openOrdersOfSession = named('DatabaseError', SECRET_TEXT);
    for (let i = 0; i < 5; i++) w.ended(`jti-${i}`);
    await settle(() => w.failures.length === 5);
    await rounds();
    expect(w.failures).toEqual(['hook', 'hook', 'hook', 'hook', 'hook']);
    expect(w.warns).toHaveLength(1);

    w.clock.advance(59_999);
    w.ended('jti-59s');
    await settle(() => w.failures.length === 6);
    await rounds();
    expect(w.warns).toHaveLength(1);

    w.clock.advance(1);
    w.ended('jti-60s');
    await settle(() => w.failures.length === 7);
    await rounds();
    expect(w.warns).toHaveLength(2);
    expect(w.warnText()).not.toContain('connection lost');
  });
});

describe('OrderExpiry.onHoldsExpired: 홀드 만료 고리', () => {
  test('PT41_ADR0107_리뷰 고침 M2: 고리 한 번에 저장소를 한 번만 부른다: holdId 2,000개(같은 값 포함)여도 openOrdersOfHolds 한 번이고, 찾은 열린 주문만 까닭 hold로 본다(닫힌 주문은 판정을 부르지 않는다) [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    const holdIds = Array.from({ length: 2_000 }, (_, i) => holdId(i));
    w.add(anOrder(1), anOrder(2, { status: 'AUTHENTICATED' }), anOrder(3, { status: 'ACCEPTED' }), anOrder(4, { status: 'EXPIRED' }));
    w.expiry.onHoldsExpired({ eventId: EVENT, holdIds: [...holdIds, holdId(1)] });
    await settle(() => w.expired.length === 2);
    await rounds();
    expect(w.calls.openOrdersOfHolds).toHaveLength(1);
    expect(w.calls.openOrdersOfHolds[0]).toEqual(holdIds);
    expect(w.calls.expireIfDue.map((i) => i.orderId).sort()).toEqual([orderId(1), orderId(2)]);
    expect(w.calls.order.sort()).toEqual([orderId(1), orderId(2)]);
    expect(w.expired).toEqual(['hold', 'hold']);
    expect(w.failures).toEqual([]);
  });

  test('PT41_ADR0107_리뷰 고침 M2: 주문을 만들지 않은 홀드는 찾는 주문이 없어 아무것도 하지 않고 경고도 실패 지표도 없다', async () => {
    const w = world();
    w.expiry.onHoldsExpired({ eventId: EVENT, holdIds: [holdId(7)] });
    await settle(() => w.calls.openOrdersOfHolds.length === 1);
    await rounds();
    expect(w.calls.expireIfDue).toEqual([]);
    expect(w.failures).toEqual([]);
    expect(w.warns).toEqual([]);
  });

  test('ADR0107_리뷰 고침 M2: 빈 목록이면 아무것도 부르지 않는다', async () => {
    const w = world();
    expect(w.expiry.onHoldsExpired({ eventId: EVENT, holdIds: [] })).toBeUndefined();
    await rounds();
    expect(w.calls.openOrdersOfHolds).toEqual([]);
  });

  test('ADR0107_리뷰 고침 M2: 주문 찾기가 실패해도 던지지 않고 경고 한 줄과 failure(hook) 한 번이다(안전망이 받친다) [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    w.add(anOrder(1), anOrder(2));
    w.fail.openOrdersOfHolds = named('DatabaseError', SECRET_TEXT);
    expect(() => w.expiry.onHoldsExpired({ eventId: EVENT, holdIds: [holdId(1), holdId(2)] })).not.toThrow();
    await settle(() => w.failures.length >= 1);
    await rounds();
    expect(w.expired).toEqual([]);
    expect(w.failures).toEqual(['hook']);
    expect(w.warns).toHaveLength(1);
    expect(w.warnText()).toContain('DatabaseError');
    expect(w.warnText()).not.toContain('connection lost');
  });
});

describe('OrderExpiry 고리의 동시 상한과 멈춤', () => {
  /** expireIfDue를 하나씩 손으로 푸는 문 */
  function gated(w: ReturnType<typeof world>) {
    const gates: ReturnType<typeof deferred>[] = [];
    w.wait.expireIfDue = () => {
      const d = deferred();
      gates.push(d);
      return d.promise;
    };
    return gates;
  }

  test('ADR0107_파드마다 동시 4개 [가정]까지만 돈다: 세션 10개가 끝나도 판정은 4개만 돌고, 하나가 끝나면 다음이 들어와 모두 끝난다', async () => {
    const w = world();
    expect(ORDER_EXPIRY_CONCURRENCY).toBe(4);
    const gates = gated(w);
    for (let i = 1; i <= 10; i++) {
      w.add(anOrder(i, { session: `jti-${i}` }));
      w.ended(`jti-${i}`);
    }
    await settle(() => w.running.now === 4);
    await rounds();
    expect(w.running.now).toBe(4);
    expect(w.calls.expireIfDue).toHaveLength(4);
    gates[0]!.resolve();
    await settle(() => w.calls.expireIfDue.length === 5);
    await rounds();
    expect(w.calls.expireIfDue).toHaveLength(5);
    expect(w.running.now).toBe(4);
    for (let i = 0; i < 40 && w.expired.length < 10; i++) {
      for (const g of gates) g.resolve();
      await flush();
    }
    expect(w.expired).toHaveLength(10);
    expect(w.running.max).toBe(4);
  });

  test('ADR0107_한 사건에 홀드가 많아도 동시 수는 상한 안이다', async () => {
    const w = world();
    const gates = gated(w);
    const holdIds: string[] = [];
    for (let i = 1; i <= 10; i++) {
      w.add(anOrder(i));
      holdIds.push(holdId(i));
    }
    w.expiry.onHoldsExpired({ eventId: EVENT, holdIds });
    await settle(() => w.running.now >= 1);
    await rounds();
    expect(w.running.now).toBeLessThanOrEqual(4);
    for (let i = 0; i < 200 && w.expired.length < 10; i++) {
      for (const g of gates) g.resolve();
      await flush();
    }
    expect(w.expired).toHaveLength(10);
    expect(w.running.max).toBeLessThanOrEqual(4);
  });

  test('ADR0107_동시 수는 설정 concurrency로 바꾼다', async () => {
    const w = world({ concurrency: 2 });
    const gates = gated(w);
    for (let i = 1; i <= 5; i++) {
      w.add(anOrder(i, { session: `jti-${i}` }));
      w.ended(`jti-${i}`);
    }
    await settle(() => w.running.now === 2);
    await rounds();
    expect(w.running.now).toBe(2);
    for (let i = 0; i < 40 && w.expired.length < 5; i++) {
      for (const g of gates) g.resolve();
      await flush();
    }
    expect(w.expired).toHaveLength(5);
    expect(w.running.max).toBe(2);
  });

  test('ADR0107_stop은 돌던 일이 끝날 때까지 기다린다. 두 번 불러도 되고, 멈춘 뒤의 사건은 던지지 않고 받지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world();
    const gates = gated(w);
    w.add(anOrder(1), anOrder(2, { session: 'jti-after' }));
    w.ended();
    await settle(() => w.running.now === 1);
    let stopped = false;
    const p = w.expiry.stop().then(() => void (stopped = true));
    await rounds();
    expect(stopped).toBe(false);
    gates[0]!.resolve();
    await p;
    expect(stopped).toBe(true);
    expect(w.expired).toEqual(['session']);
    await w.expiry.stop();
    expect(() => w.ended('jti-after')).not.toThrow();
    await rounds();
    expect(w.calls.openOrdersOfSession).toEqual([SESSION]);
    expect(w.calls.expireIfDue).toHaveLength(1);
  });

  test('ADR0107_돌던 일이 없으면 stop은 바로 끝난다', async () => {
    const w = world();
    await expect(w.expiry.stop()).resolves.toBeUndefined();
  });

  test('변이 검토 PRF-172_대기 줄이 설정 상한에 닿으면 새 일을 버린다: 버린 건마다 failure(hook)이고 경고는 넘친 동안 한 줄이며 버린 세션은 찾지 않는다(안전망이 받친다) (ADR0107) [ASVS v5.0.0-16.5.2]', async () => {
    const w = world({ concurrency: 1, queueLimit: 2 });
    const gate = deferred();
    w.wait.openOrdersOfSession = () => gate.promise;
    // 1번은 돌고(줄에서 빠짐) 2·3번이 줄에 서고 4·5번은 넘친다
    for (let i = 1; i <= 5; i++) w.ended(`jti-${i}`);
    expect(w.failures).toEqual(['hook', 'hook']);
    expect(w.warns).toHaveLength(1);
    expect(w.warns[0]!.obj).toEqual({ queueLimit: 2 });
    gate.resolve();
    await settle(() => w.calls.openOrdersOfSession.length === 3);
    await rounds();
    expect(w.calls.openOrdersOfSession).toEqual(['jti-1', 'jti-2', 'jti-3']);
  });

  test('변이 검토 PRF-172_대기 줄의 기본 상한은 10,000건 [가정]이다: 동시 1개로 10,003건을 넣으면 하나가 돌고 10,000건이 서고 둘을 버린다 (ADR0107) [ASVS v5.0.0-16.5.2]', async () => {
    expect(ORDER_EXPIRY_QUEUE_LIMIT).toBe(10_000);
    const w = world({ concurrency: 1 });
    const gate = deferred();
    w.wait.openOrdersOfSession = () => gate.promise;
    for (let i = 0; i < 10_003; i++) w.ended(`jti-${i}`);
    expect(w.failures).toEqual(['hook', 'hook']);
    expect(w.warns).toHaveLength(1);
    gate.resolve();
    await w.expiry.stop();
  });

  test('ADR0107_리뷰 고침 M4: 대기 줄의 넘침 경고는 넘친 동안 한 줄이고, 줄이 상한의 절반까지 줄어야 다시 경고한다(절반 위에서 또 넘치면 늘지 않는다). 버림은 건마다 failure(hook)이다 [ASVS v5.0.0-16.5.2]', async () => {
    const w = world({ concurrency: 1, queueLimit: 4 });
    const gates: ReturnType<typeof deferred>[] = [];
    w.wait.openOrdersOfSession = () => {
      const d = deferred();
      gates.push(d);
      return d.promise;
    };
    const releaseOne = async () => {
      const running = gates.length;
      gates.at(-1)!.resolve();
      await settle(() => gates.length === running + 1);
    };
    // 첫 일은 줄을 떠나 돌고, 넷이 줄에 서고, 나머지 셋은 버린다
    for (let i = 0; i < 8; i++) w.ended(`jti-${i}`);
    await settle(() => gates.length === 1);
    expect(w.failures).toEqual(['hook', 'hook', 'hook']);
    expect(w.warns).toEqual([{ obj: { queueLimit: 4 }, msg: expect.any(String) as string }]);
    // 하나가 끝나면 줄은 3이다(상한의 절반 2보다 많다). 다시 넘쳐도 경고가 늘지 않는다
    await releaseOne();
    w.ended('jti-a');
    w.ended('jti-b');
    expect(w.failures).toHaveLength(4);
    expect(w.warns).toHaveLength(1);
    // 줄이 절반(2)까지 줄면 다음 넘침에 다시 경고한다
    await releaseOne();
    await releaseOne();
    for (let i = 0; i < 5; i++) w.ended(`jti-c${i}`);
    expect(w.warns).toHaveLength(2);
    expect(w.failures).toHaveLength(7);
    const stopped = w.expiry.stop();
    gates.at(-1)!.resolve();
    await stopped;
  });
});

/** 노출 글에서 이름이 name인 표본 줄 */
async function sampleLines(registry: Registry, name: string): Promise<string[]> {
  return (await registry.metrics()).split('\n').filter((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
}

describe('PromOrderExpirySignals(지표 이름·이름표)', () => {
  const EXPIRED = 'purchase_order_expired_total';
  const FAILURES = 'purchase_order_expiry_failures_total';
  const STALE = 'purchase_order_open_stale';
  /** 정본의 stage 값. 구현이 ORDER_EXPIRY_STAGES를 고치기 전에도 형 검사가 되게 글로 두고 단언한다 */
  const STAGES: readonly string[] = ['hook', 'check', 'attempt', 'sweep'];
  const fresh = () => {
    const metrics = new PlatformMetrics('purchase-svc');
    return { metrics, prom: new PromOrderExpirySignals().register(metrics.registry) };
  };

  test('ADR0107_붙이면 trigger 넷·stage 넷의 이름표가 0으로 보이고 게이지도 0이며 register는 자신을 돌려준다', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromOrderExpirySignals();
    expect(prom.register(metrics.registry)).toBe(prom);
    expect((await sampleLines(metrics.registry, EXPIRED)).sort()).toEqual(['session', 'hold', 'attempt', 'sweep'].map((t) => `${EXPIRED}{trigger="${t}"} 0`).sort());
    expect((await sampleLines(metrics.registry, FAILURES)).sort()).toEqual(STAGES.map((s) => `${FAILURES}{stage="${s}"} 0`).sort());
    expect(await sampleLines(metrics.registry, STALE)).toEqual([`${STALE} 0`]);
    const text = await metrics.registry.metrics();
    expect(text).toContain(`# TYPE ${EXPIRED} counter`);
    expect(text).toContain(`# TYPE ${FAILURES} counter`);
    expect(text).toContain(`# TYPE ${STALE} gauge`);
  });

  test('PT41_ADR0107_expired(trigger)는 그 까닭만 1 올린다', async () => {
    const { metrics, prom } = fresh();
    prom.expired('sweep');
    prom.expired('sweep');
    prom.expired('hold');
    const lines = await sampleLines(metrics.registry, EXPIRED);
    expect(lines).toContain(`${EXPIRED}{trigger="sweep"} 2`);
    expect(lines).toContain(`${EXPIRED}{trigger="hold"} 1`);
    expect(lines).toContain(`${EXPIRED}{trigger="session"} 0`);
    expect(lines).toHaveLength(4);
  });

  test.each(STAGES)('ADR0107_failure(%s)는 그 단계만 1 올린다 [ASVS v5.0.0-16.5.2]', async (stage) => {
    const { metrics, prom } = fresh();
    prom.failure(stage as OrderExpiryStage);
    const lines = await sampleLines(metrics.registry, FAILURES);
    expect(lines).toContain(`${FAILURES}{stage="${stage}"} 1`);
    expect(lines).toHaveLength(4);
  });

  test('ADR0107_openStale(n)은 게이지를 n으로 둔다(올리는 것이 아니라 그 값으로)', async () => {
    const { metrics, prom } = fresh();
    prom.openStale(3);
    prom.openStale(1);
    expect(await sampleLines(metrics.registry, STALE)).toEqual([`${STALE} 1`]);
  });

  test('ADR0107_모르는 이름표 값은 버린다(이름표 수가 늘지 않고 값이 지표에 나가지 않는다). 붙이기 전에도 던지지 않는다', async () => {
    const loose = new PromOrderExpirySignals();
    expect(() => loose.expired('sweep')).not.toThrow();
    expect(() => loose.failure('check')).not.toThrow();
    expect(() => loose.openStale(1)).not.toThrow();
    const { metrics, prom } = fresh();
    expect(() => prom.expired('acct-0190f3a1' as OrderExpiryTrigger)).not.toThrow();
    expect(() => prom.failure('acct-0190f3a1' as OrderExpiryStage)).not.toThrow();
    const expired = await sampleLines(metrics.registry, EXPIRED);
    const failures = await sampleLines(metrics.registry, FAILURES);
    expect(expired).toHaveLength(4);
    expect(failures).toHaveLength(4);
    expect([...expired, ...failures].join('\n')).not.toContain('acct-');
    expect([...expired, ...failures].every((l) => l.endsWith(' 0'))).toBe(true);
  });
});

describe('InventoryOrderExpiry.sessionEnded(구매 세션 다리)', () => {
  const MAX_STAY = NOW + 60_000;
  const bridge = (read: (jti: string) => Promise<{ maxStayUntilMs: number } | undefined>, clock: FakeClock = fakeClock({ now: NOW })) =>
    // holds는 이 절에서 쓰지 않는다(홀드 남음은 test-int가 본다)
    new InventoryOrderExpiry({ sessions: { read }, holds: undefined as never, clock });

  test('PT41_ADR0107_세션 상태가 없으면 끝난 것이고 그 구매 세션 ID로 읽는다', async () => {
    const seen: string[] = [];
    const b = bridge(async (jti) => {
      seen.push(jti);
      return undefined;
    });
    expect(await b.sessionEnded(SESSION)).toBe(true);
    expect(seen).toEqual([SESSION]);
  });

  test('ADR0107_최대 체류 시각이 지나지 않았으면 안 끝났고, 지금이 최대 체류 시각 이상이면(같은 때 포함) 끝난 것이다', async () => {
    const clock = fakeClock({ now: MAX_STAY - 1 });
    const b = bridge(async () => ({ maxStayUntilMs: MAX_STAY }), clock);
    expect(await b.sessionEnded(SESSION)).toBe(false);
    clock.advance(1);
    expect(await b.sessionEnded(SESSION)).toBe(true);
    clock.advance(1);
    expect(await b.sessionEnded(SESSION)).toBe(true);
  });

  test('ADR0107_좌석 Redis 장애(SeatStoreUnavailable)는 OrderSeatStoreUnavailable로 던지고 끝났다고 보지 않는다. 그 밖의 오류는 그대로다 [ASVS v5.0.0-16.5.2]', async () => {
    const down = new SeatStoreUnavailable(new Error('down'));
    const err = await bridge(() => Promise.reject(down))
      .sessionEnded(SESSION)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderSeatStoreUnavailable);
    expect((err as Error).cause).toBe(down);
    const other = new Error('boom');
    await expect(bridge(() => Promise.reject(other)).sessionEnded(SESSION)).rejects.toBe(other);
  });
});

describe('운영 조립(main.ts·relay-app.ts): 고리와 반복은 선택 인자·배열 원소라 빠뜨려도 형 오류가 없어 소스 글로 본다', () => {
  /** 주석을 뺀 소스(주석으로 막은 줄이 통과하지 않게). 줄바꿈은 LF로 맞춘다 */
  const source = (path: string): string =>
    readFileSync(new URL(path, import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

  test('변이 검토 PRF-172_운영 main.ts는 홀드 만료 고리와 세션 종료 고리(조립·나가기 경로 둘 다)를 판정기에 잇는다 (ADR0107) [ASVS v5.0.0-2.3.1]', () => {
    const main = source('../src/main.ts');
    const register = /AppModule\.register\(\{([\s\S]*?)\n {2}\}\),/.exec(main)?.[1];
    expect(register, 'main.ts에 AppModule.register({ … })가 있다').toBeDefined();
    expect(register).toMatch(/\bonHoldsExpired:\s*\((\w+)\)\s*=>\s*orderExpiry\?\.onHoldsExpired\(\1\)/);
    expect(/\badmission:\s*\{([\s\S]*?)\n {4}\},/.exec(register!)?.[1], 'admission 조립이 세션 종료 고리를 넘긴다').toMatch(/\bonSessionEnded\b/);
    expect(main).toMatch(/\bconst onSessionEnded = \(e[^)]*\)[^=]*=>\s*orderExpiry\?\.onSessionEnded\(e\)/);
    expect(main).toMatch(/new EndPurchaseSession\(\{[^}]*\bonEnded: onSessionEnded\b/);
  });

  test('변이 검토 PRF-172_운영 main.ts는 판정기를 전용 풀로 만들고, 고리를 부르는 것들이 멈춘 뒤에 멈추고 풀을 닫는다 (ADR0107) [ASVS v5.0.0-16.5.2]', () => {
    const main = source('../src/main.ts');
    expect(main).toMatch(/\bcreateDatabase\(orderExpiryDatabaseOptions\(databaseUrl\)\)/);
    expect(main).toMatch(/\borderExpiry = new OrderExpiry\(\{/);
    const closing = main.slice(main.indexOf('function shutdown'));
    const stopAt = closing.indexOf('orderExpiry?.stop()');
    expect(stopAt, 'shutdown이 판정기를 멈춘다').toBeGreaterThan(-1);
    expect(stopAt, '만료 반복을 멈춘 뒤다').toBeGreaterThan(closing.indexOf('sweeper.stop()'));
    expect(stopAt, '요청을 닫은 뒤다').toBeGreaterThan(closing.indexOf('service.close()'));
    expect(closing).toContain('orderExpiryDatabase?.close()');
  });

  test('변이 검토 PRF-172_릴레이 프로세스의 leaderLoops는 OrderExpirySweep을 돌려주고 서비스 역할 DB·리더 확인·좌석 Redis 다리를 잇는다 (ADR0107) [ASVS v5.0.0-16.5.2]', () => {
    const relay = source('../src/relay-app.ts');
    const loops = /leaderLoops: \(ctx\) => \{[\s\S]*?\n {6}return \[([\s\S]*?)\n {6}\];\n {4}\},/.exec(relay)?.[1];
    expect(loops, 'relay-app.ts에 leaderLoops의 배열이 있다').toBeDefined();
    const sweep = /new OrderExpirySweep\(\{([\s\S]*?)\n {8}\}\),/.exec(loops!)?.[1];
    expect(sweep, 'leaderLoops가 OrderExpirySweep을 돌려준다').toBeDefined();
    expect(sweep).toMatch(/\bstore: orderExpiryStore\b/);
    expect(sweep).toMatch(/\bexpiry: orderExpiry\b/);
    expect(sweep).toMatch(/\bleader: ctx\.leader\b/);
    expect(sweep).toMatch(/\bclock: ctx\.clock\b/);
    expect(relay).toMatch(/\borderExpiry = new OrderExpiry\(\{/);
    expect(relay).toMatch(/new InventoryOrderExpiry\(\{[^}]*\bholds: new RedisOrderHolds\(o\.redis, o\.seatMap\)/);
    expect(relay).toMatch(/\borderExpiryStore = new DrizzleOrderExpiry\(\{ database: o\.serviceDatabase\b/);
  });

  test('PT41_ADR0107_리뷰 고침 M3: 릴레이 프로세스의 maintenanceTasks에 하루 넘은 주문 정비 일(orderExpiryStaleTask)을 붙인다. 판정은 서비스 역할 저장소·판정기로 위임한다(정비 일은 leaderLoops 전에 만들어 넘긴다) [ASVS v5.0.0-16.5.2]', () => {
    const relay = source('../src/relay-app.ts');
    const tasks = /maintenanceTasks: \[([\s\S]*?)\n {4}\],/.exec(relay)?.[1];
    expect(tasks, 'relay-app.ts에 maintenanceTasks 배열이 있다').toBeDefined();
    expect(tasks).toMatch(/\borderExpiryStaleTask\(\{/);
    expect(tasks).toMatch(/\bstaleOrderBatch: \(\w+\) => bound\(\)\.orderExpiryStore\.staleOrderBatch\(/);
    expect(tasks).toMatch(/\bcheck: \(\w+, \w+\) => bound\(\)\.orderExpiry\.check\(/);
  });
});
