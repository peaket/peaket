// 받는 층: 결제 시도 시작 POST /v1/orders/{orderId}/payments(openapi createOrderPayment, docs/features/payment.md §2 '결제 시도 시작의 첫 구현', BUILD_ORDER PRF-191).
// accept-http.test.ts와 같은 꼴: AppModule을 메모리 조립으로 띄워 fastify inject로 부른다. 쓰임새의 검사 차례는 start-payment.test.ts가 본다.
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createService, DEADLINE_HEADER, fakeClock, PlatformMetrics, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LoggerOrderLog, PromOrderSignals, START_PAYMENT_PROBLEMS, type StartPaymentRejection } from '../src/modules/booking/index.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import { AcceptFakes, ATTEMPT_ID, ORDER_ID, OTHER_PSID, PORTONE_PAYMENT_ID } from './accept-cases.js';
import { ACCOUNT, AMOUNT, CONSENT_VERSION, EVENT, IDEM_KEY, JOURNEY, LOGIN, NOW, OrderFakes, PID, PSID } from './order-cases.js';
import { BEHAVIOR, CUSTOMER_KEY, DEPOSIT_DUE_AT_MS, HOLD_EXPIRES_AT_MS, okCheckout, PORTONE_CHECKOUT, StartFakes, startOrder, TOSS_CHECKOUT } from './start-payment-cases.js';

const KEY = Buffer.alloc(32, 9);
const logLines: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    for (const l of String(c).split('\n')) if (l) logLines.push(l);
    cb();
  },
});
const clock = fakeClock({ now: NOW });
const orders = new OrderFakes(clock);
const accepts = new AcceptFakes();
const fx = new StartFakes();
const sessions = new MemoryPurchaseSessions();
sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: JOURNEY, loginSessionId: LOGIN, key: KEY });

let svc: Awaited<ReturnType<typeof createService>>;
beforeAll(async () => {
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      booking: { ...orders.ports(), sessions: fx.sessions, saleConfigs: fx.saleConfigs, ...accepts.bookingPorts(), slots: fx.slots, consentVersion: CONSENT_VERSION, clock, startPayment: fx.bookingPorts() },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  fx.reset();
  logLines.length = 0;
});

const pathOf = (orderId: string) => `/v1/orders/${orderId}/payments`;
let seq = 0;
interface PostOptions {
  orderId?: string;
  key?: string | null;
  mac?: string | null;
  scope?: string;
  pid?: string | null;
  headers?: Record<string, string>;
  app?: typeof svc;
}
function post(body: unknown, o: PostOptions = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  const url = pathOf(o.orderId ?? ORDER_ID);
  const n = ++seq;
  const headers: Record<string, string> = {
    'x-user-id': ACCOUNT,
    'x-session-id': LOGIN,
    'x-user-aud': 'fan',
    'x-user-scope': o.scope ?? 'ticket:buy',
    'content-type': 'application/json',
    'x-purchase-seq': String(n),
  };
  if (o.pid !== null) headers['x-user-pid'] = o.pid ?? PID;
  if (o.mac !== null) headers['x-purchase-mac'] = o.mac ?? purchaseMac(KEY, purchaseMacInput('POST', url, n, Buffer.from(payload, 'utf8')));
  if (o.key !== null) headers['idempotency-key'] = o.key ?? IDEM_KEY;
  Object.assign(headers, o.headers);
  return (o.app ?? svc).http.inject({ method: 'POST', url, headers, payload });
}
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;
const problem = (slug: string) => `${PROBLEM_TYPE_BASE}${slug}`;

describe('201 결제 시도', () => {
  test('FR011_토스 응답 칸은 계약 그대로이고 Cache-Control no-store다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-14.3.2] [ASVS v5.0.0-15.3.1]', async () => {
    const r = await post({});
    expect(r.statusCode).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    const { shape: _shape, ...toss } = TOSS_CHECKOUT;
    expect(json(r)).toEqual({
      attemptId: fx.lastPrepared().attemptId,
      pg: 'TOSS',
      switched: false,
      holdExpiresAt: new Date(HOLD_EXPIRES_AT_MS).toISOString(),
      allowedPayMethods: ['CARD', 'EASY_PAY', 'VIRTUAL_ACCOUNT'],
      depositDueAt: new Date(DEPOSIT_DUE_AT_MS).toISOString(),
      checkout: toss,
    });
  });

  test('PT28_포트원 응답은 PortoneCheckout 칸이고 paymentId는 pay-{주문 ID}다', async () => {
    fx.checkoutAnswers = [okCheckout({ pg: 'PORTONE', checkout: PORTONE_CHECKOUT })];
    const r = await post({ payMethod: 'CARD' });
    expect(r.statusCode).toBe(201);
    const { shape: _shape, ...portone } = PORTONE_CHECKOUT;
    expect(json(r)).toMatchObject({ pg: 'PORTONE', checkout: portone });
    expect((json(r).checkout as Record<string, unknown>).paymentId).toBe(PORTONE_PAYMENT_ID);
  });

  test('FR011_홀드 만료·입금 기한이 없으면 칸을 내지 않는다', async () => {
    fx.holdExpiry = undefined;
    fx.checkoutAnswers = [{ status: 'OK', pg: 'SIMULATOR', switched: false, checkout: TOSS_CHECKOUT, allowedPayMethods: ['CARD'] }];
    const r = await post({});
    expect(r.statusCode).toBe(201);
    expect(json(r)).not.toHaveProperty('holdExpiresAt');
    expect(json(r)).not.toHaveProperty('depositDueAt');
    expect(json(r).pg).toBe('SIMULATOR');
  });

  test('FR011_모르는 칸이 값에 섞여도 직렬화 스키마 밖이라 내보내지 않는다 [ASVS v5.0.0-15.3.1]', async () => {
    fx.checkoutAnswers = [okCheckout({ checkout: { ...TOSS_CHECKOUT, secretKey: 'test_sk_SECRET' } as never })];
    const r = await post({});
    expect(r.statusCode).toBe(201);
    expect(r.payload).not.toContain('test_sk_SECRET');
  });

  test('FR011_받는 층이 넘기는 값: 멱등 범위 계정 × START_PAYMENT × 소문자 키, 경로의 주문 ID 그대로, 토큰 pid, 본문', async () => {
    fx.committed = { status: 'NONE' };
    const r = await post({ behavior: BEHAVIOR }, { key: IDEM_KEY.toUpperCase() });
    expect(r.statusCode).toBe(201);
    const once = fx.started[0]!.once;
    expect({ accountRef: once.accountRef, operation: once.operation, key: once.key }).toEqual({ accountRef: ACCOUNT, operation: 'START_PAYMENT', key: IDEM_KEY });
    expect(once.requestHash).toHaveLength(32);
    await new Promise((res) => setImmediate(res));
    expect(fx.published[0]).toMatchObject({ pid: PID, features: BEHAVIOR });
  });

  test('PT45_재생도 201이고 같은 모양이다', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    const r = await post({});
    expect(r.statusCode).toBe(201);
    expect(json(r).attemptId).toBe(ATTEMPT_ID);
    expect(fx.started).toHaveLength(0);
  });

  test('PT45_리뷰 고침 M4: 재생에서 payment-svc가 수단을 거절하면 400이 아니라 503 pg-unavailable(Retry-After 2)이다', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.checkoutAnswers = [{ status: 'PAY_METHOD_INVALID' }];
    const r = await post({ payMethod: 'VIRTUAL_ACCOUNT' });
    expect(r.statusCode).toBe(503);
    expect(json(r).type).toBe(problem('pg-unavailable'));
    expect(r.headers['retry-after']).toBe('2');
  });

  test('ST29_리뷰 고침 L5: 재생인데 주문이 다른 구매 세션의 것이면 404 not-found다 [ASVS v5.0.0-8.2.2]', async () => {
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.order = startOrder({ purchaseSessionId: OTHER_PSID });
    const r = await post({});
    expect(r.statusCode).toBe(404);
    expect(json(r).type).toBe(problem('not-found'));
    expect(r.payload).not.toContain(CUSTOMER_KEY);
  });

  test('FR011_리뷰 고침 L7: 망가진 홀드 키는 500이 아니라 holdExpiresAt 칸만 빼고 201이다', async () => {
    fx.holdExpiry = new Error('PEAKET_CORRUPT_KEY 홀드 키 형이 틀림');
    const r = await post({});
    expect(r.statusCode).toBe(201);
    expect(json(r)).not.toHaveProperty('holdExpiresAt');
    expect(r.payload).not.toContain('PEAKET_CORRUPT_KEY');
  });

  test('FR011_남은 시간 머리 120이면 결제창 준비 데드라인이 120ms다', async () => {
    await post({}, { headers: { [DEADLINE_HEADER]: '120' } });
    expect(fx.lastPrepared().deadlineMs).toBe(120);
  });

  test('FR011_결제창 값·구매자 키·요약은 서비스 로그에 남지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    await post({ behavior: BEHAVIOR });
    expect(logLines.join('\n')).not.toContain(CUSTOMER_KEY);
  });
});

describe('입력 검사 400 [ASVS v5.0.0-2.2.1]', () => {
  test.each([
    ['허용 밖 칸', { amount: 1 }],
    ['허용 밖 수단', { payMethod: 'BITCOIN' }],
    ['수단이 글이 아님', { payMethod: 1 }],
    ['요약의 허용 밖 칸', { behavior: { ...BEHAVIOR, rawX: [1, 2] } }],
    ['요약 v가 1이 아님', { behavior: { ...BEHAVIOR, v: 2 } }],
    ['요약 구간이 음수', { behavior: { ...BEHAVIOR, windowMs: -1 } }],
    ['요약 구간이 1시간 초과', { behavior: { ...BEHAVIOR, windowMs: 3_600_001 } }],
  ])('PT28_%s는 400이고 쓰임새를 부르지 않는다 [ASVS v5.0.0-2.2.1]', async (_name, body) => {
    const r = await post(body);
    expect(r.statusCode).toBe(400);
    expect(fx.calls).toEqual([]);
  });

  test.each(['CARD', 'EASY_PAY', 'TRANSFER', 'VIRTUAL_ACCOUNT', 'MOBILE'])('PT26_허용 수단 %s는 받는다', async (payMethod) => {
    expect((await post({ payMethod })).statusCode).toBe(201);
    expect(fx.lastPrepared().payMethod).toBe(payMethod);
  });

  test('PT45_멱등 키가 없으면 400 idempotency-key-invalid다', async () => {
    const r = await post({}, { key: null });
    expect(r.statusCode).toBe(400);
    expect(json(r).type).toBe(problem('idempotency-key-invalid'));
    expect(fx.calls).toEqual([]);
  });

  test('FR011_구매 세션 서명이 없으면 401이다', async () => {
    const r = await post({}, { mac: null });
    expect(r.statusCode).toBe(401);
    expect(fx.calls).toEqual([]);
  });

  test('FR011_ticket:buy 스코프가 없으면 403이다', async () => {
    const r = await post({}, { scope: 'profile:read' });
    expect(r.statusCode).toBe(403);
    expect(fx.calls).toEqual([]);
  });

  test('PT26_payment-svc가 수단을 거절하면 400 about:blank이고 시도를 만들지 않는다', async () => {
    fx.checkoutAnswers = [{ status: 'PAY_METHOD_INVALID' }];
    const r = await post({ payMethod: 'VIRTUAL_ACCOUNT' });
    expect(r.statusCode).toBe(400);
    expect(json(r).type).toBe('about:blank');
    expect(fx.started).toHaveLength(0);
  });
});

const REJECTIONS: Record<StartPaymentRejection, { arrange?: () => void; headers?: Record<string, string> }> = {
  SESSION_ENDED: { arrange: () => (fx.session = undefined) },
  IDEM_REUSED: { arrange: () => (fx.committed = { status: 'MISMATCH' }) },
  NOT_FOUND: { arrange: () => (fx.order = undefined) },
  ORDER_EXPIRED: { arrange: () => (fx.order = startOrder({ status: 'EXPIRED' })) },
  ALREADY_ACCEPTED: { arrange: () => (fx.order = startOrder({ status: 'ACCEPTED' })) },
  ATTEMPTS_EXCEEDED: { arrange: () => (fx.count = 3) },
  SALE_PAUSED: { arrange: () => (fx.slot = { status: 'PAUSED' }) },
  SEAT_STORE_UNAVAILABLE: { arrange: () => (fx.slot = { status: 'NOT_READY' }) },
  PG_UNAVAILABLE: { arrange: () => (fx.checkoutAnswers = [{ status: 'PG_UNAVAILABLE', reason: 'pg_unavailable' }]) },
  CHECKOUT_MISCONFIGURED: { arrange: () => (fx.checkoutAnswers = [{ status: 'MISCONFIGURED', reason: 'unimplemented' }]) },
  PAY_METHOD_INVALID: { arrange: () => (fx.checkoutAnswers = [{ status: 'PAY_METHOD_INVALID' }]) },
  DEADLINE_EXCEEDED: { headers: { [DEADLINE_HEADER]: '4' } },
};

function contractProblemTypes(): Map<string, { status: number; title: string }> {
  const yaml = readFileSync(fileURLToPath(new URL('../../../docs/api/openapi.yaml', import.meta.url)), 'utf8');
  const out = new Map<string, { status: number; title: string }>();
  for (const m of yaml.matchAll(/^ {4}([a-z0-9-]+): \{ status: (\d+), title: "([^"]*)"/gm)) out.set(m[1]!, { status: Number(m[2]), title: m[3]! });
  return out;
}

describe('거절 → 문제 상세(START_PAYMENT_PROBLEMS 전부)', () => {
  test('FR011_대응표는 거절 까닭 모두를 덮고, 이름 있는 줄의 status·title은 계약과 같다', () => {
    expect(Object.keys(START_PAYMENT_PROBLEMS).sort()).toEqual(Object.keys(REJECTIONS).sort());
    const contract = contractProblemTypes();
    for (const [reason, spec] of Object.entries(START_PAYMENT_PROBLEMS)) {
      if (spec.type === 'about:blank') continue;
      expect({ reason, got: { status: spec.status, title: spec.title } }).toEqual({ reason, got: contract.get(spec.type) });
    }
  });

  test('FR011_503 셋은 Retry-After 2초이고 두 탭 경합만 정상 분기다', () => {
    for (const r of ['SEAT_STORE_UNAVAILABLE', 'PG_UNAVAILABLE', 'CHECKOUT_MISCONFIGURED'] as const) expect(START_PAYMENT_PROBLEMS[r].retryAfterSeconds, r).toBe(2);
    expect(START_PAYMENT_PROBLEMS.ALREADY_ACCEPTED.normalBranch).toBe(true);
    expect(START_PAYMENT_PROBLEMS.ATTEMPTS_EXCEEDED.normalBranch).toBeUndefined();
  });

  test.each(Object.keys(REJECTIONS) as StartPaymentRejection[])('PT23_PT25_PT27_%s → 대응표의 상태 코드·문제 상세·Retry-After, no-store이고 시도를 만들지 않는다', async (reason) => {
    const spec = START_PAYMENT_PROBLEMS[reason];
    const setup = REJECTIONS[reason];
    setup.arrange?.();
    const r = await post({}, setup.headers ? { headers: setup.headers } : {});
    expect(r.statusCode).toBe(spec.status);
    expect(r.headers['content-type']).toMatch(/^application\/problem\+json/);
    expect(r.headers['cache-control']).toBe('no-store');
    if (spec.type === 'about:blank') expect(json(r)).toMatchObject({ type: 'about:blank', status: spec.status });
    else expect(json(r)).toMatchObject({ type: problem(spec.type), status: spec.status, title: spec.title });
    expect(r.headers['retry-after']).toBe(spec.retryAfterSeconds === undefined ? undefined : String(spec.retryAfterSeconds));
    expect(fx.started).toHaveLength(0);
  });

  test('FR011_구매 세션이 끝났으면 WWW-Authenticate: Cookie realm="peaket"이다', async () => {
    fx.session = undefined;
    const r = await post({});
    expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
  });
});

describe('조립하지 않은 앱', () => {
  test('FR011_startPayment를 넘기지 않으면 404 not-found다(경로가 없는 것과 같은 본문)', async () => {
    const bare = await createService({
      name: 'purchase-svc',
      module: AppModule.register({ memory: true, sessions, booking: { ...orders.ports(), sessions: fx.sessions, ...accepts.bookingPorts(), consentVersion: CONSENT_VERSION, clock } }),
      purchaseSessions: sessions,
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet,
    });
    try {
      const r = await post({}, { app: bare });
      expect(r.statusCode).toBe(404);
      expect(json(r).type).toBe(problem('not-found'));
    } finally {
      await bare.close();
    }
  });
});

describe('로그·지표 어댑터', () => {
  const recording = () => {
    const lines: { level: 'warn' | 'error'; obj: Record<string, unknown> }[] = [];
    const logger = {
      warn: (obj: unknown) => void lines.push({ level: 'warn', obj: obj as Record<string, unknown> }),
      error: (obj: unknown) => void lines.push({ level: 'error', obj: obj as Record<string, unknown> }),
    };
    return { lines, log: new LoggerOrderLog(logger as never) };
  };

  test('PT25_상한 초과는 warn 한 줄이고 계정·주문만 싣는다 [ASVS v5.0.0-16.3.3] [ASVS v5.0.0-16.2.5]', () => {
    const { lines, log } = recording();
    log.attemptsExceeded({ accountId: ACCOUNT, orderId: ORDER_ID, ...({ amount: AMOUNT } as object) });
    expect(lines).toEqual([{ level: 'warn', obj: { kind: 'security', event: 'payment_attempts_exceeded', accountId: ACCOUNT, orderId: ORDER_ID } }]);
  });

  test('PT26_설정 오류는 error 한 줄이고 SEV2·까닭만 싣는다 [ASVS v5.0.0-16.3.4]', () => {
    const { lines, log } = recording();
    log.checkoutMisconfigured({ reason: 'unimplemented' });
    expect(lines).toEqual([{ level: 'error', obj: { kind: 'config', what: 'checkout_misconfigured', reason: 'unimplemented', severity: 'SEV2' } }]);
  });

  test('FR011_리뷰 고침 L7: 홀드 만료를 읽지 못한 줄은 error 한 줄이고 SEV2·회차만 싣는다 [ASVS v5.0.0-16.2.5]', () => {
    const { lines, log } = recording();
    log.holdExpiryUnreadable({ eventId: EVENT, ...({ holdId: 'h' } as object) });
    expect(lines).toEqual([{ level: 'error', obj: { kind: 'config', what: 'hold_expiry_unreadable', eventId: EVENT, severity: 'SEV2' } }]);
  });

  test('PT25_PT51_지표 두 이름이 레지스트리에 붙고 값이 오른다', async () => {
    const { registry } = new PlatformMetrics('purchase-svc');
    const s = new PromOrderSignals().register(registry);
    s.paymentAttempt('TOSS', 'started');
    s.paymentAttempt('none', 'exceeded');
    s.telemetryDropped('behavior_signal');
    const text = await registry.metrics();
    expect(text).toContain('purchase_payment_attempts_total{pg="TOSS",outcome="started"} 1');
    expect(text).toContain('purchase_payment_attempts_total{pg="none",outcome="exceeded"} 1');
    expect(text).toContain('telemetry_dropped_total{record="behavior_signal"} 1');
  });
});
