// 주문 생성(BUILD_ORDER PRF-161) booking 어댑터·조립의 작은 단위 시험: 좌석맵 판의 판매 설정(SeatMapSaleConfigs), 구매 세션 다리(InventoryOrderSessions,
// setPaying 연결), 대체 판정 지표(PromOrderSignals.identityFallback), 보안·설정 로그(LoggerOrderLog), 모듈 조립의 동의 문안 판 검사(BookingModule.register).
// 결제 접수(PRF-162)의 보안 로그(LoggerOrderLog.attemptMismatch)와 회차 슬롯 읽기 다리(InventorySeatSlots)도 여기서 본다.
// 쓰임새·받는 층은 create-order.test.ts·orders-http.test.ts, 실제 저장소로 도는 것은 test-int(order-*.int.test.ts)가 본다.
import 'reflect-metadata';
import { type Database, fakeClock, PlatformMetrics, type Registry, type TransactionOptions } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  BookingModule,
  DrizzleOrderAccepts,
  DrizzleOrderStore,
  DrizzleOrderWrites,
  FALLBACK_REASONS,
  type FallbackReason,
  InventoryOrderSessions,
  InventorySeatSlots,
  LoggerOrderLog,
  OrderSeatStoreUnavailable,
  OrdersController,
  PromOrderSignals,
  SeatMapSaleConfigs,
  type SeatSlotRead,
} from '../src/modules/booking/index.js';
import { MemoryPurchaseSessionStore, MemorySeatMap, SeatStoreUnavailable, SESSION_IDLE_MS, StoredPurchaseSessions } from '../src/modules/inventory/index.js';
import { AcceptFakes } from './accept-cases.js';
import { CONSENT_VERSION, OrderFakes } from './order-cases.js';
import { newJti, openInput } from './purchase-session-cases.js';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
const EVENT = 'ev-order-adapters';

describe('SeatMapSaleConfigs(좌석맵 판의 판매 설정)', () => {
  test('FR011_판의 saleEndsAtMs·tierPrices를 그대로 준다', async () => {
    const m = new MemorySeatMap();
    m.put({ eventId: EVENT, layoutVersion: 'v1', seatCount: 4, perAccountLimit: 4, saleEndsAtMs: NOW + 1, tierPrices: { R: 1_000, S: 0 } }, []);
    expect(await new SeatMapSaleConfigs(m).get(EVENT)).toEqual({ saleEndsAtMs: NOW + 1, tierPrices: { R: 1_000, S: 0 } });
  });

  test('FR011_판 파일에 tierPrices가 없으면 빈 가격 표(모든 등급의 가격이 없다)이고, 그 표는 고칠 수 없다', async () => {
    const m = new MemorySeatMap();
    m.put({ eventId: EVENT, layoutVersion: 'v1', seatCount: 4, perAccountLimit: 4, saleEndsAtMs: NOW }, []);
    const c = await new SeatMapSaleConfigs(m).get(EVENT);
    expect(c?.saleEndsAtMs).toBe(NOW);
    expect(Object.keys(c!.tierPrices)).toEqual([]);
    expect(Object.isFrozen(c!.tierPrices)).toBe(true);
    // 프로토타입이 없어 toString 같은 이름도 가격이 아니다
    expect(Object.hasOwn(c!.tierPrices, 'toString')).toBe(false);
  });

  test('NFR015_그 회차의 판이 없거나 판을 읽다 던지면 undefined다(던지지 않는다, 쓰임새가 503)', async () => {
    expect(await new SeatMapSaleConfigs(new MemorySeatMap()).get('ev-none')).toBeUndefined();
    const broken = new SeatMapSaleConfigs({ config: async () => Promise.reject(new Error('read failed')) });
    await expect(broken.get(EVENT)).resolves.toBeUndefined();
  });
});

describe('InventoryOrderSessions(구매 세션 다리)', () => {
  const VIEW = { sessionId: 'jti-1', accountId: '0190f3a1-7c2e-7a00-8000-0000000000a1', eventId: EVENT, journeyId: '0190f3a1-7c2e-7d00-8000-0000000000d1' };

  test('FR011_get은 구매 세션 읽기의 답을 그대로 주고, 없으면 undefined다', async () => {
    const s = new InventoryOrderSessions({ sessions: { get: async (id) => (id === 'jti-1' ? VIEW : undefined) }, store: { setPaying: async () => true } });
    expect(await s.get('jti-1')).toEqual(VIEW);
    expect(await s.get('jti-2')).toBeUndefined();
  });

  test('POL009_markPaying은 setPaying(jti, true, 마감)을 부르고 그 답(세션 있음 참·없음 거짓)을 돌려준다', async () => {
    const calls: unknown[][] = [];
    let answer = true;
    const s = new InventoryOrderSessions({
      sessions: { get: async () => undefined },
      store: {
        setPaying: async (...a) => {
          calls.push(a);
          return answer;
        },
      },
    });
    expect(await s.markPaying('jti-1', { deadlineMs: 40 })).toBe(true);
    answer = false;
    expect(await s.markPaying('jti-2')).toBe(false);
    expect(calls).toEqual([
      ['jti-1', true, { deadlineMs: 40 }],
      ['jti-2', true, undefined],
    ]);
  });

  test('NFR015_inventory의 좌석 Redis 장애(SeatStoreUnavailable)는 OrderSeatStoreUnavailable로 바꿔 던지고(원인은 cause), 그 밖의 오류는 그대로 던진다', async () => {
    const down = new SeatStoreUnavailable(new Error('ECONNRESET'));
    const bug = new Error('구매 세션 상태의 칸이 모자란다');
    const failing = (e: unknown) =>
      new InventoryOrderSessions({ sessions: { get: async () => Promise.reject(e) }, store: { setPaying: async () => Promise.reject(e) } });
    for (const call of [(s: InventoryOrderSessions) => s.get('jti-1'), (s: InventoryOrderSessions) => s.markPaying('jti-1')]) {
      const err = await call(failing(down)).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(OrderSeatStoreUnavailable);
      expect((err as Error).cause).toBe(down);
      await expect(call(failing(bug))).rejects.toBe(bug);
    }
  });

  test('POL009_실제 구매 세션 저장소에 이으면 markPaying 뒤 유휴 시한이 지나도 정리 점검이 세션을 끝내지 않는다(Paying), 표시하지 않은 세션은 끝난다', async () => {
    const clock = fakeClock({ now: NOW });
    const store = new MemoryPurchaseSessionStore(clock);
    const sessions = new StoredPurchaseSessions({ store, ecdh: { sharedSecret: () => Buffer.alloc(32) }, clock });
    const bridge = new InventoryOrderSessions({ sessions, store });
    const paying = newJti();
    const idle = newJti();
    await store.open(openInput(clock, paying));
    await store.open(openInput(clock, idle));
    expect(await bridge.get(paying)).toMatchObject({ sessionId: paying, eventId: openInput(clock, paying).eventId });
    expect(await bridge.markPaying(paying)).toBe(true);
    expect(await bridge.markPaying(newJti())).toBe(false);
    clock.advance(SESSION_IDLE_MS + 1);
    expect((await store.sweep(paying)).kind).toBe('LIVE');
    expect(await store.sweep(idle)).toMatchObject({ kind: 'ENDED', reason: 'IDLE' });
  });
});

/** 노출 글에서 이름이 name인 표본 줄 */
async function sampleLines(registry: Registry, name: string): Promise<string[]> {
  return (await registry.metrics()).split('\n').filter((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
}

describe('PromOrderSignals.identityFallback(purchase_identity_recheck_fallback_total{reason})', () => {
  const NAME = 'purchase_identity_recheck_fallback_total';

  test('PT35_ADR0055_붙이면 까닭 다섯 이름표가 0으로 보이고, 대체 판정마다 그 까닭만 1 오른다(이름표는 reason 하나뿐)', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromOrderSignals().register(metrics.registry);
    expect((await sampleLines(metrics.registry, NAME)).sort()).toEqual(FALLBACK_REASONS.map((r) => `${NAME}{reason="${r}"} 0`).sort());
    prom.identityFallback('deadline');
    prom.identityFallback('deadline');
    prom.identityFallback('circuit_open');
    const lines = await sampleLines(metrics.registry, NAME);
    expect(lines).toContain(`${NAME}{reason="deadline"} 2`);
    expect(lines).toContain(`${NAME}{reason="circuit_open"} 1`);
    expect(lines).toContain(`${NAME}{reason="internal"} 0`);
    expect(lines).toHaveLength(5);
    const text = await metrics.registry.metrics();
    expect(text).toContain(`# TYPE ${NAME} counter`);
  });

  test('PT35_모르는 까닭이 와도 이름표 값이 늘지 않는다(internal로 센다). 붙이기 전에도 던지지 않는다', async () => {
    const loose = new PromOrderSignals();
    expect(() => loose.identityFallback('unavailable')).not.toThrow();
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromOrderSignals().register(metrics.registry);
    prom.identityFallback('acct-0190f3a1' as FallbackReason);
    const lines = await sampleLines(metrics.registry, NAME);
    expect(lines).toHaveLength(5);
    expect(lines).toContain(`${NAME}{reason="internal"} 1`);
    expect(lines.join('\n')).not.toContain('acct-');
  });
});

describe('M3 PromOrderSignals.payingMarkFailed(purchase_order_paying_mark_failed_total)', () => {
  const NAME = 'purchase_order_paying_mark_failed_total';

  test('POL009_이름표 없는 카운터이고 붙이면 0으로 보이며, 부를 때마다 1 오른다. 붙이기 전에도 던지지 않는다', async () => {
    expect(() => new PromOrderSignals().payingMarkFailed()).not.toThrow();
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromOrderSignals().register(metrics.registry);
    expect(await sampleLines(metrics.registry, NAME)).toEqual([`${NAME} 0`]);
    prom.payingMarkFailed();
    prom.payingMarkFailed();
    expect(await sampleLines(metrics.registry, NAME)).toEqual([`${NAME} 2`]);
    expect(await metrics.registry.metrics()).toContain(`# TYPE ${NAME} counter`);
  });
});

describe('LoggerOrderLog(보안·설정 로그)', () => {
  function recorder() {
    const lines: { level: 'warn' | 'error'; obj: Record<string, unknown>; msg: string }[] = [];
    const logger = {
      warn: (obj: object, msg: string) => void lines.push({ level: 'warn', obj: obj as Record<string, unknown>, msg }),
      error: (obj: object, msg: string) => void lines.push({ level: 'error', obj: obj as Record<string, unknown>, msg }),
    };
    return { lines, log: new LoggerOrderLog(logger as never) };
  }
  const ACCOUNT = '0190f3a1-7c2e-7a00-8000-0000000000a1';
  const KEY = '3f0b8c1e-2d4a-4b6c-9e8f-1a2b3c4d5e6f';

  test('PT35_ADR0055_대체 판정은 warn 한 줄(kind security, 계정·까닭·통과·멱등 키)이다', () => {
    const { lines, log } = recorder();
    log.identityFallback({ accountId: ACCOUNT, reason: 'deadline', passed: true, idempotencyKey: KEY });
    log.identityFallback({ accountId: ACCOUNT, reason: 'circuit_open', passed: false, idempotencyKey: KEY });
    expect(lines.map((l) => [l.level, l.obj])).toEqual([
      ['warn', { kind: 'security', event: 'identity_recheck_fallback', accountId: ACCOUNT, reason: 'deadline', passed: true, idempotencyKey: KEY }],
      ['warn', { kind: 'security', event: 'identity_recheck_fallback', accountId: ACCOUNT, reason: 'circuit_open', passed: false, idempotencyKey: KEY }],
    ]);
  });

  test('FR011_설정 오류는 error 한 줄(kind config): 가격 없는 등급은 회차·등급, 재확인 설정 오류는 까닭과 SEV2', () => {
    const { lines, log } = recorder();
    log.configError({ what: 'tier_price_missing', eventId: EVENT, tierId: 'S' });
    log.configError({ what: 'identity_misconfigured', reason: 'permission_denied' });
    expect(lines.map((l) => [l.level, l.obj])).toEqual([
      ['error', { kind: 'config', what: 'tier_price_missing', eventId: EVENT, tierId: 'S' }],
      ['error', { kind: 'config', what: 'identity_misconfigured', reason: 'permission_denied', severity: 'SEV2' }],
    ]);
  });

  test('PT52_정한 칸만 싣는다: 넘긴 값에 번호·성명·pid가 섞여 와도 로그 줄에 나가지 않는다 [ASVS v5.0.0-16.2.5]', () => {
    const { lines, log } = recorder();
    const leaky = { buyerPhone: '010-1234-5678', phoneE164: '+821012345678', buyerName: '홍길동', pid: 'pid-secret' };
    log.identityFallback({ accountId: ACCOUNT, reason: 'unavailable', passed: true, idempotencyKey: KEY, ...leaky } as never);
    log.configError({ what: 'tier_price_missing', eventId: EVENT, tierId: 'R', ...leaky } as never);
    const text = JSON.stringify(lines);
    for (const v of ['1234-5678', '1012345678', '홍길동', 'pid-secret']) expect(text).not.toContain(v);
  });

  test('M3_POL009_Paying 표시 실패는 warn 한 줄이고 구매 세션 ID·주문 ID만 싣는다(넘긴 값에 다른 칸이 섞여도)', () => {
    const { lines, log } = recorder();
    const ORDER = '0190f3a1-7c2e-7f00-8000-0000000000f1';
    log.payingMarkFailed({ purchaseSessionId: 'jti-1', orderId: ORDER, buyerPhone: '010-1234-5678', accountId: ACCOUNT } as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.level).toBe('warn');
    expect(lines[0]!.obj).toEqual({ event: 'order_paying_mark_failed', purchaseSessionId: 'jti-1', orderId: ORDER });
  });

  test('로거가 던져도 삼킨다(부른 쪽을 막지 않는다)', () => {
    const boom = () => {
      throw new Error('log down');
    };
    const log = new LoggerOrderLog({ warn: boom, error: boom } as never);
    expect(() => log.identityFallback({ accountId: ACCOUNT, reason: 'deadline', passed: true, idempotencyKey: KEY })).not.toThrow();
    expect(() => log.configError({ what: 'identity_misconfigured', reason: 'invalid_argument' })).not.toThrow();
    expect(() => log.payingMarkFailed({ purchaseSessionId: 'jti-1', orderId: 'o-1' })).not.toThrow();
  });

  // ── 결제 접수의 보안 로그(AcceptLog.attemptMismatch, payment §4.2 18, BUILD_ORDER PRF-162) ──
  const ORDER = '0190f3a1-7c2e-7f00-8000-0000000000f2';

  // 금액 불일치(400)도 같은 줄이다(까닭 amount_mismatch, payment §2 '활성 결제 시도 대조', [ASVS v5.0.0-16.3.3], 2026-11-05 정본 바로잡음)
  const MISMATCH_REASONS = ['no_attempt', 'attempt_expired', 'pg_mismatch', 'payment_id_mismatch', 'amount_mismatch'] as const;

  test('PT28_PT7_결제 시도 대조 실패·금액 불일치는 warn 한 줄(kind security, event payment_attempt_mismatch, 계정·주문·까닭)이다 [ASVS v5.0.0-16.3.2] [ASVS v5.0.0-16.3.3]', () => {
    const { lines, log } = recorder();
    for (const reason of MISMATCH_REASONS) log.attemptMismatch({ accountId: ACCOUNT, orderId: ORDER, reason });
    expect(lines.map((l) => [l.level, l.obj])).toEqual(
      MISMATCH_REASONS.map((reason) => [
        'warn',
        { kind: 'security', event: 'payment_attempt_mismatch', accountId: ACCOUNT, orderId: ORDER, reason },
      ]),
    );
  });

  test('PT28_ADR0053_결제 참조·토큰·본문 값이 섞여 와도 로그 줄은 계정·주문·까닭 세 칸뿐이다 [ASVS v5.0.0-16.2.5]', () => {
    const { lines, log } = recorder();
    const leaky = { paymentKey: 'PAYKEYSECRET', paymentToken: 'PAYTOKENSECRET', txId: 'TXIDSECRET', paymentId: 'pay-x', amount: 123_456, pg: 'TOSS' };
    log.attemptMismatch({ accountId: ACCOUNT, orderId: ORDER, reason: 'pg_mismatch', ...leaky } as never);
    expect(lines).toHaveLength(1);
    expect(lines[0]!.obj).toEqual({ kind: 'security', event: 'payment_attempt_mismatch', accountId: ACCOUNT, orderId: ORDER, reason: 'pg_mismatch' });
    const text = JSON.stringify(lines);
    for (const v of ['PAYKEYSECRET', 'PAYTOKENSECRET', 'TXIDSECRET', '123456']) expect(text).not.toContain(v);
  });

  test('PT28_결제 시도 대조 실패 로그도 로거가 던지면 삼킨다', () => {
    const boom = () => {
      throw new Error('log down');
    };
    const log = new LoggerOrderLog({ warn: boom, error: boom } as never);
    expect(() => log.attemptMismatch({ accountId: ACCOUNT, orderId: ORDER, reason: 'no_attempt' })).not.toThrow();
  });
});

describe('InventorySeatSlots(회차 슬롯 읽기 다리, PRF-162)', () => {
  function source(answer: SeatSlotRead | Error) {
    const calls: { eventId: string; o: { deadlineMs?: number } | undefined }[] = [];
    return {
      calls,
      src: {
        read: async (eventId: string, o?: { deadlineMs?: number }) => {
          calls.push({ eventId, o });
          if (answer instanceof Error) throw answer;
          return answer;
        },
      },
    };
  }

  test.each<[SeatSlotRead]>([[{ status: 'OK', gen: 4 }], [{ status: 'NOT_READY' }], [{ status: 'PAUSED' }]])('FR011_inventory의 답(%o)을 그대로 돌려주고 회차·마감을 그대로 넘긴다', async (answer) => {
    const { calls, src } = source(answer);
    expect(await new InventorySeatSlots(src).read(EVENT, { deadlineMs: 40 })).toEqual(answer);
    expect(calls).toEqual([{ eventId: EVENT, o: { deadlineMs: 40 } }]);
  });

  test('NFR015_inventory의 좌석 Redis 장애(SeatStoreUnavailable)는 OrderSeatStoreUnavailable로 바꿔 던진다(원인은 cause에)', async () => {
    const down = new SeatStoreUnavailable(new Error('ECONNRESET'));
    const { src } = source(down);
    const err = await new InventorySeatSlots(src).read(EVENT).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OrderSeatStoreUnavailable);
    expect((err as Error).cause).toBe(down);
  });

  test('NFR015_이름으로 가른다: name이 SeatStoreUnavailable인 Error도 바꾼다(inventory를 가져오지 않는다)', async () => {
    const named = Object.assign(new Error('down'), { name: 'SeatStoreUnavailable' });
    const { src } = source(named);
    await expect(new InventorySeatSlots(src).read(EVENT)).rejects.toBeInstanceOf(OrderSeatStoreUnavailable);
  });

  test('그 밖의 오류(망가진 세대 키·WRONGTYPE·RangeError)는 같은 객체 그대로 던진다 [ASVS v5.0.0-16.5.3]', async () => {
    for (const e of [new Error('PEAKET_CORRUPT_KEY s:{event:x}:epoch'), new Error('WRONGTYPE Operation against a key'), new RangeError('eventId')]) {
      const { src } = source(e);
      const err = await new InventorySeatSlots(src).read(EVENT).catch((x: unknown) => x);
      expect(err).toBe(e);
    }
  });
});

describe('주문 생성·결제 접수 트랜잭션의 선택값(리뷰 고침 L3·L4)', () => {
  /** transaction에 넘긴 선택값을 적고 바로 멈추는 Database 대역(DB에 가지 않는다) */
  function recordingDb() {
    const seen: (TransactionOptions | undefined)[] = [];
    const db = {
      db: undefined,
      pool: undefined,
      close: async () => {},
      transaction: async (_fn: unknown, o?: TransactionOptions) => {
        seen.push(o);
        throw new Error('stop');
      },
    } as unknown as Database;
    return { db, seen };
  }
  const clock = fakeClock({ now: Date.parse('2026-11-05T03:00:00.000Z') });
  const U = (n: number) => `0190f3a1-7c2e-7f00-8000-${String(n).padStart(12, '0')}`;
  const once = { accountRef: U(1), operation: 'ACCEPT_PAYMENT', key: '9a0b8c1e-2d4a-4b6c-9e8f-1a2b3c4d5e6f', requestHash: new Uint8Array(32) };
  const input = { orderId: U(2), attemptId: U(3), eventId: U(4), refs: { pg: 'TOSS', paymentKey: 'tgen_1' }, seatGen: 1, actor: `account:${U(1)}` } as const;
  /** 주문 생성은 트랜잭션 안(createOrder)에서 입력을 보므로, 트랜잭션을 열기 전에 멈추는 이 시험에는 빈 주문으로 충분하다 */
  const order = {} as never;

  test('FR011_결제 접수 트랜잭션은 늘 read committed이고, 남은 시간을 받으면 statementTimeoutMs로 건다', async () => {
    const { db, seen } = recordingDb();
    const accepts = new DrizzleOrderAccepts({ database: db, store: new DrizzleOrderStore({ clock }), clock });
    await expect(accepts.accept(once, input)).rejects.toThrow('stop');
    await expect(accepts.accept(once, input, {})).rejects.toThrow('stop');
    await expect(accepts.accept(once, input, { deadlineMs: 120 })).rejects.toThrow('stop');
    expect(seen).toEqual([{ isolationLevel: 'read committed' }, { isolationLevel: 'read committed' }, { isolationLevel: 'read committed', statementTimeoutMs: 120 }]);
  });

  test('FR011_주문 생성 트랜잭션도 늘 read committed이고, 남은 시간을 받으면 statementTimeoutMs로 건다', async () => {
    const { db, seen } = recordingDb();
    const writes = new DrizzleOrderWrites({ database: db, store: new DrizzleOrderStore({ clock }), clock });
    await expect(writes.create({ ...once, operation: 'CREATE_ORDER' }, order)).rejects.toThrow('stop');
    await expect(writes.create({ ...once, operation: 'CREATE_ORDER' }, order, { deadlineMs: 40 })).rejects.toThrow('stop');
    expect(seen).toEqual([{ isolationLevel: 'read committed' }, { isolationLevel: 'read committed', statementTimeoutMs: 40 }]);
  });

  test.each([[0], [-1], [1.5], [Number.NaN]])('FR011_남은 시간(deadlineMs) %s는 RangeError이고 트랜잭션을 열지 않는다', async (deadlineMs) => {
    const { db, seen } = recordingDb();
    const accepts = new DrizzleOrderAccepts({ database: db, store: new DrizzleOrderStore({ clock }), clock });
    await expect(accepts.accept(once, input, { deadlineMs })).rejects.toBeInstanceOf(RangeError);
    const writes = new DrizzleOrderWrites({ database: db, store: new DrizzleOrderStore({ clock }), clock });
    await expect(writes.create(once, order, { deadlineMs })).rejects.toBeInstanceOf(RangeError);
    expect(seen).toEqual([]);
  });
});

describe('BookingModule.register(동의 문안 판 검사)', () => {
  // 결제 접수 칸(accepts·slots, PRF-162)은 결제 접수 가짜로 채운다
  const deps = (consentVersion: unknown) => ({ ...new OrderFakes().ports(), ...new AcceptFakes().bookingPorts(), consentVersion: consentVersion as string });

  test('FR011_판 모양(1~32자의 영문·숫자·._-)이면 주문 컨트롤러 하나를 담은 모듈이고 내보내는 것이 없다', () => {
    for (const v of [CONSENT_VERSION, 'consent-2026.11_v1', 'v'.repeat(32), '1']) {
      const m = BookingModule.register(deps(v));
      expect(m.module).toBe(BookingModule);
      expect(m.controllers).toEqual([OrdersController]);
      expect(m.exports ?? []).toEqual([]);
    }
  });

  test('FR011_판 모양이 틀리면 던진다(시작 실패): 빈 글·빈칸·33자·다른 글자·글이 아님. 오류 글에 받은 값을 싣지 않는다', () => {
    for (const v of ['', ' v3', 'v3 ', 'v 3', 'v'.repeat(33), 'v3!', 'v3/1', '판3', undefined, 3]) {
      let err: unknown;
      try {
        BookingModule.register(deps(v));
      } catch (e) {
        err = e;
      }
      expect({ v, thrown: err instanceof Error }).toEqual({ v, thrown: true });
      expect((err as Error).message).toContain('PEAKET_ORDER_CONSENT_VERSION');
      if (typeof v === 'string' && v.length > 1) expect((err as Error).message).not.toContain(v);
    }
  });
});
