// payment-svc 결제창 준비 포트(booking adapters/grpc-payment-checkout.ts, docs/features/payment.md §2 '결제 시도 시작의 첫 구현', BUILD_ORDER PRF-191)의 단위 시험.
// 요청 모양(pinned_pg 포함), 답 해석, gRPC 상태 → 결과, 차단기, local·ci 대역과 시작 조건, 같은 프로세스 가짜 서버로 선 위의 값.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { CircuitBreaker, dependencyUnavailable, fakeClock, ProblemError } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  checkoutAnswerOf,
  checkoutFailureOf,
  discardBehaviorSignals,
  GrpcPaymentCheckouts,
  KafkaBehaviorSignals,
  PAYMENT_CHECKOUT_BREAKER_OPTIONS,
  PAYMENT_GRPC_ADDR_ENV,
  paymentCheckoutsFromEnv,
  PREPARE_CHECKOUT_MAX_CONCURRENT,
  type PrepareCheckoutQuery,
  prepareCheckoutRequestOf,
  simulatorPaymentCheckouts,
  StartPayment,
  TELEMETRY_BEHAVIOR_TOPIC,
} from '../src/modules/booking/index.js';
import { ATTEMPT_ID, ORDER_ID, PORTONE_PAYMENT_ID } from './accept-cases.js';
import { AMOUNT, EVENT, JOURNEY, NOW, PID } from './order-cases.js';
import { BEHAVIOR, ENTRY_OPENS_AT_MS, ORDER_NAME, startCommand, StartFakes } from './start-payment-cases.js';

const query = (over: Partial<PrepareCheckoutQuery> = {}): PrepareCheckoutQuery => ({ orderId: ORDER_ID, attemptId: ATTEMPT_ID, eventId: EVENT, amount: AMOUNT, orderName: ORDER_NAME, deadlineMs: 300, ...over });

const tossAnswer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pg: 'PG_PROVIDER_TOSS',
  switched: false,
  checkout: 'toss',
  toss: { client_key: 'test_ck_1', customer_key: 'cust-1', order_id: ORDER_ID, order_name: ORDER_NAME, amount: { krw: AMOUNT }, success_url: 'https://p.test/ok', fail_url: 'https://p.test/fail' },
  allowed_pay_methods: ['CARD', 'VIRTUAL_ACCOUNT'],
  deposit_due_at: { seconds: 1_800_000_000, nanos: 5_000_000 },
  ...over,
});
const portoneAnswer = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  pg: 'PG_PROVIDER_PORTONE',
  switched: true,
  checkout: 'portone',
  portone: { store_id: 'store-1', channel_key: 'channel-1', payment_id: PORTONE_PAYMENT_ID, order_name: ORDER_NAME, total_amount: { krw: AMOUNT }, currency: 'KRW', redirect_url: 'https://p.test/r', custom_data: { order_id: ORDER_ID } },
  allowed_pay_methods: ['CARD'],
  ...over,
});

describe('prepareCheckoutRequestOf: proto 칸', () => {
  test('PT26_입장권 주문의 칸을 싣고, 고정·입장 시각·가상계좌가 없으면 칸도 없다', () => {
    const r = prepareCheckoutRequestOf(query());
    expect(r).toEqual({ order_kind: 'ORDER_KIND_TICKET', order_id: ORDER_ID, attempt_id: ATTEMPT_ID, event_id: EVENT, amount: { krw: AMOUNT }, order_name: ORDER_NAME, pay_method: '' });
  });

  test('PT27_재생의 pinned_pg·입장 시각·가상계좌를 싣는다 [ASVS v5.0.0-2.2.3]', () => {
    const r = prepareCheckoutRequestOf(query({ pinnedPg: 'PORTONE', entryOpensAtMs: ENTRY_OPENS_AT_MS + 7, virtualAccountAllowed: false, payMethod: 'CARD' }));
    expect(r).toMatchObject({ pinned_pg: 'PG_PROVIDER_PORTONE', virtual_account_allowed: false, pay_method: 'CARD', entry_opens_at: { seconds: Math.floor((ENTRY_OPENS_AT_MS + 7) / 1000), nanos: 7_000_000 } });
  });

  test('PT26_구매자 키는 싣지 않는다(payment-svc가 CSPRNG 값을 만든다) [ASVS v5.0.0-11.5.1]', () => {
    expect(prepareCheckoutRequestOf(query({ pinnedPg: 'TOSS' }))).not.toHaveProperty('customer_key');
  });
});

describe('checkoutAnswerOf: 답 해석', () => {
  test('PT26_토스 답은 TOSS 모양이고 허용 수단·입금 기한을 읽는다', () => {
    expect(checkoutAnswerOf(tossAnswer(), query())).toEqual({
      status: 'OK',
      pg: 'TOSS',
      switched: false,
      checkout: { shape: 'TOSS', clientKey: 'test_ck_1', customerKey: 'cust-1', orderId: ORDER_ID, orderName: ORDER_NAME, amount: AMOUNT, successUrl: 'https://p.test/ok', failUrl: 'https://p.test/fail' },
      allowedPayMethods: ['CARD', 'VIRTUAL_ACCOUNT'],
      depositDueAtMs: 1_800_000_000_005,
    });
  });

  test('PT28_포트원 답은 PORTONE 모양이고 입금 기한이 없으면 칸이 없다', () => {
    const r = checkoutAnswerOf(portoneAnswer(), query());
    expect(r).toMatchObject({ status: 'OK', pg: 'PORTONE', switched: true, checkout: { shape: 'PORTONE', paymentId: PORTONE_PAYMENT_ID, totalAmount: AMOUNT, currency: 'KRW', customData: { orderId: ORDER_ID } } });
    expect(r).not.toHaveProperty('depositDueAtMs');
  });

  test('PT26_시뮬레이터는 toss와 같은 모양의 simulator 칸이다', () => {
    const { toss, ...rest } = tossAnswer({ pg: 'PG_PROVIDER_SIMULATOR', checkout: 'simulator' });
    expect(checkoutAnswerOf({ ...rest, simulator: toss }, query())).toMatchObject({ status: 'OK', pg: 'SIMULATOR', checkout: { shape: 'TOSS', orderId: ORDER_ID } });
  });

  test.each([
    ['결제사가 비었다', tossAnswer({ pg: 'PG_PROVIDER_UNSPECIFIED' })],
    ['값 칸이 없다', tossAnswer({ checkout: undefined, toss: undefined })],
    ['결제사와 값 칸이 어긋난다', tossAnswer({ pg: 'PG_PROVIDER_PORTONE' })],
    ['답의 주문이 요청과 다르다', tossAnswer({ toss: { ...(tossAnswer().toss as object), order_id: '0190f3a1-7c2e-7f00-8000-000000000999' } })],
    ['포트원 답의 주문이 요청과 다르다', portoneAnswer({ portone: { ...(portoneAnswer().portone as object), custom_data: { order_id: 'other' } } })],
    ['금액 칸이 수가 아니다', tossAnswer({ toss: { ...(tossAnswer().toss as object), amount: {} } })],
    ['글 칸이 비었다', tossAnswer({ toss: { ...(tossAnswer().toss as object), client_key: '' } })],
  ])('PT26_%s면 MISCONFIGURED다(값을 쓰지 않는다) [ASVS v5.0.0-16.5.3]', (_name, answer) => {
    expect(checkoutAnswerOf(answer, query())).toEqual({ status: 'MISCONFIGURED', reason: 'bad_answer' });
  });
});

describe('checkoutAnswerOf: 리뷰 고침 M3 답 대조', () => {
  const toss = tossAnswer().toss as object;
  const portone = portoneAnswer().portone as object;

  test.each<[string, Record<string, unknown>, PrepareCheckoutQuery]>([
    ['재생으로 고정한 결제사와 답의 결제사가 다르다', tossAnswer(), query({ pinnedPg: 'PORTONE' })],
    ['토스 답의 금액이 주문 금액보다 적다', tossAnswer({ toss: { ...toss, amount: { krw: AMOUNT - 1 } } }), query()],
    ['포트원 답의 금액이 주문 금액보다 많다', portoneAnswer({ portone: { ...portone, total_amount: { krw: AMOUNT + 1 } } }), query()],
  ])('PT27_리뷰 고침 M3: %s면 bad_answer다(값을 쓰지 않는다) [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.5.3]', (_name, answer, q) => {
    expect(checkoutAnswerOf(answer, q)).toEqual({ status: 'MISCONFIGURED', reason: 'bad_answer' });
  });

  test('PT27_리뷰 고침 M3: 고정한 결제사·주문 금액과 같으면 값을 쓴다', () => {
    expect(checkoutAnswerOf(portoneAnswer(), query({ pinnedPg: 'PORTONE' }))).toMatchObject({ status: 'OK', pg: 'PORTONE' });
    expect(checkoutAnswerOf(tossAnswer(), query({ pinnedPg: 'TOSS' }))).toMatchObject({ status: 'OK', pg: 'TOSS' });
  });
});

describe('checkoutFailureOf: gRPC 상태 → 결과', () => {
  test('PT26_UNAVAILABLE 글 pg-unavailable은 결제사를 고르지 못한 것이다', () => {
    expect(checkoutFailureOf(grpc.status.UNAVAILABLE, 'pg-unavailable')).toEqual({ status: 'PG_UNAVAILABLE', reason: 'pg_unavailable' });
  });

  test('PT26_그 밖의 UNAVAILABLE·DEADLINE_EXCEEDED도 503 쪽이다 [ASVS v5.0.0-16.5.2]', () => {
    expect(checkoutFailureOf(grpc.status.UNAVAILABLE, '지금 처리할 수 없다')).toEqual({ status: 'PG_UNAVAILABLE', reason: 'unavailable' });
    expect(checkoutFailureOf(grpc.status.DEADLINE_EXCEEDED, 'x')).toEqual({ status: 'PG_UNAVAILABLE', reason: 'deadline' });
  });

  test('PT26_INVALID_ARGUMENT 글이 pay_method면 PAY_METHOD_INVALID다', () => {
    expect(checkoutFailureOf(grpc.status.INVALID_ARGUMENT, '입력이 틀렸다: pay_method')).toEqual({ status: 'PAY_METHOD_INVALID' });
  });

  test.each<[number, string, string]>([
    [grpc.status.INVALID_ARGUMENT, '입력이 틀렸다: order_name', 'invalid_argument'],
    [grpc.status.PERMISSION_DENIED, 'x', 'permission_denied'],
    [grpc.status.UNIMPLEMENTED, 'x', 'unimplemented'],
    [grpc.status.INTERNAL, 'x', 'internal'],
    [99, 'x', 'unexpected'],
  ])('PT26_코드 %s는 MISCONFIGURED %s이다 [ASVS v5.0.0-16.5.3]', (code, details, reason) => {
    expect(checkoutFailureOf(code, details)).toEqual({ status: 'MISCONFIGURED', reason });
  });
});

describe('GrpcPaymentCheckouts', () => {
  test('PT26_차단기가 열려 있으면(503 dependency-unavailable) 부르지 않고 PG_UNAVAILABLE circuit_open이다', async () => {
    const breaker = { run: async () => Promise.reject(dependencyUnavailable(5)) } as unknown as CircuitBreaker;
    const c = new GrpcPaymentCheckouts({ address: '127.0.0.1:1', breaker });
    try {
      expect(await c.prepare(query())).toEqual({ status: 'PG_UNAVAILABLE', reason: 'circuit_open' });
    } finally {
      c.close();
    }
  });

  test('PT26_남은 시간 없음(504)·과부하(429) ProblemError도 503 쪽이다', async () => {
    for (const [slug, status, reason] of [['deadline-exceeded', 504, 'deadline'], ['server-busy', 429, 'unavailable']] as const) {
      const breaker = { run: async () => Promise.reject(new ProblemError({ type: slug, status, title: 'x' })) } as unknown as CircuitBreaker;
      const c = new GrpcPaymentCheckouts({ address: '127.0.0.1:1', breaker });
      try {
        expect(await c.prepare(query())).toEqual({ status: 'PG_UNAVAILABLE', reason });
      } finally {
        c.close();
      }
    }
  });

  test('PT26_gRPC가 아닌 예외는 MISCONFIGURED unexpected다(던지지 않는다)', async () => {
    const breaker = { run: async () => Promise.reject(new TypeError('boom')) } as unknown as CircuitBreaker;
    const c = new GrpcPaymentCheckouts({ address: '127.0.0.1:1', breaker });
    try {
      expect(await c.prepare(query())).toEqual({ status: 'MISCONFIGURED', reason: 'unexpected' });
    } finally {
      c.close();
    }
  });

  test('PT26_아무도 듣지 않는 주소면 PG_UNAVAILABLE이고 던지지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const c = new GrpcPaymentCheckouts({ address: '127.0.0.1:1' });
    try {
      expect(await c.prepare(query({ deadlineMs: 100 }))).toMatchObject({ status: 'PG_UNAVAILABLE' });
    } finally {
      c.close();
    }
  });

  test('FR011_주소가 host:port 모양이 아니면 만들 때 던진다', () => {
    expect(() => new GrpcPaymentCheckouts({ address: 'not-an-address' })).toThrow(PAYMENT_GRPC_ADDR_ENV);
  });
});

/** 같은 프로세스의 가짜 payment-svc(PrepareCheckout만) */
async function fakeServer(answer: (req: Record<string, unknown>) => Record<string, unknown> | grpc.ServiceError) {
  const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: { PaymentService: grpc.ServiceClientConstructor } } } }).peaket.payment.v1;
  const server = new grpc.Server();
  const requests: Record<string, unknown>[] = [];
  server.addService(pkg.PaymentService.service, {
    PrepareCheckout: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      requests.push(call.request);
      const a = answer(call.request);
      if ('code' in a) cb(a as grpc.ServiceError);
      else cb(null, a);
    },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  return { address: `127.0.0.1:${port}`, requests, close: () => server.forceShutdown() };
}

describe('GrpcPaymentCheckouts와 가짜 payment-svc', () => {
  test('PT27_요청의 pinned_pg·order_kind가 선을 지나고 답을 읽는다 [ASVS v5.0.0-2.2.3]', async () => {
    const srv = await fakeServer(() => portoneAnswer());
    const c = new GrpcPaymentCheckouts({ address: srv.address });
    try {
      expect(await c.prepare(query({ pinnedPg: 'PORTONE' }))).toMatchObject({ status: 'OK', pg: 'PORTONE' });
      expect(srv.requests[0]).toMatchObject({ order_kind: 'ORDER_KIND_TICKET', pinned_pg: 'PG_PROVIDER_PORTONE', order_id: ORDER_ID, attempt_id: ATTEMPT_ID, amount: { krw: AMOUNT } });
    } finally {
      c.close();
      srv.close();
    }
  });

  test('PT26_고정하지 않으면 pinned_pg는 UNSPECIFIED로 간다', async () => {
    const srv = await fakeServer(() => tossAnswer());
    const c = new GrpcPaymentCheckouts({ address: srv.address });
    try {
      expect((await c.prepare(query())).status).toBe('OK');
      expect(srv.requests[0]!.pinned_pg).toBe('PG_PROVIDER_UNSPECIFIED');
    } finally {
      c.close();
      srv.close();
    }
  });

  test('PT26_UNAVAILABLE 글 pg-unavailable을 그대로 받는다', async () => {
    const srv = await fakeServer(() => Object.assign(new Error('pg-unavailable'), { code: grpc.status.UNAVAILABLE, details: 'pg-unavailable', metadata: new grpc.Metadata() }) as grpc.ServiceError);
    const c = new GrpcPaymentCheckouts({ address: srv.address });
    try {
      expect(await c.prepare(query())).toEqual({ status: 'PG_UNAVAILABLE', reason: 'pg_unavailable' });
    } finally {
      c.close();
      srv.close();
    }
  });
});

const grpcError = (code: number, details: string) => Object.assign(new Error(details), { code, details, metadata: new grpc.Metadata() }) as grpc.ServiceError;

describe('리뷰 고침 H1·L8: 운영과 같은 설정의 실제 차단기', () => {
  /** main.ts와 같은 설정. 시험을 짧게 하려고 판정 문턱만 낮춘다 */
  const realBreaker = () => new CircuitBreaker({ service: 'purchase-svc', ...PAYMENT_CHECKOUT_BREAKER_OPTIONS, minCalls: 5 });

  test('PT26_리뷰 고침 H1: 결제사를 고르지 못한 업무 답(UNAVAILABLE 글 pg-unavailable)은 몇 번이어도 차단기를 열지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const srv = await fakeServer(() => grpcError(grpc.status.UNAVAILABLE, 'pg-unavailable'));
    const breaker = realBreaker();
    const c = new GrpcPaymentCheckouts({ address: srv.address, breaker });
    try {
      for (let i = 0; i < 6; i += 1) expect(await c.prepare(query())).toEqual({ status: 'PG_UNAVAILABLE', reason: 'pg_unavailable' });
      expect(breaker.state).toBe('closed');
      expect(srv.requests).toHaveLength(6);
    } finally {
      breaker.shutdown();
      c.close();
      srv.close();
    }
  });

  test('PT26_리뷰 고침 H1: 그 밖의 UNAVAILABLE은 실제 장애로 세어 차단기를 열고, 열리면 부르지 않는다 [ASVS v5.0.0-16.5.2]', async () => {
    const srv = await fakeServer(() => grpcError(grpc.status.UNAVAILABLE, 'overloaded'));
    const breaker = realBreaker();
    const c = new GrpcPaymentCheckouts({ address: srv.address, breaker });
    try {
      for (let i = 0; i < 5; i += 1) expect(await c.prepare(query())).toEqual({ status: 'PG_UNAVAILABLE', reason: 'unavailable' });
      expect(breaker.state).toBe('open');
      expect(await c.prepare(query())).toEqual({ status: 'PG_UNAVAILABLE', reason: 'circuit_open' });
      expect(srv.requests).toHaveLength(5);
    } finally {
      breaker.shutdown();
      c.close();
      srv.close();
    }
  });

  test('PT26_리뷰 고침 H1: 연결 실패(아무도 듣지 않는 주소)는 실제 장애로 세어 차단기를 연다', async () => {
    const breaker = realBreaker();
    const c = new GrpcPaymentCheckouts({ address: '127.0.0.1:1', breaker });
    try {
      for (let i = 0; i < 5; i += 1) expect(await c.prepare(query({ deadlineMs: 100 }))).toMatchObject({ status: 'PG_UNAVAILABLE' });
      expect(breaker.state).toBe('open');
    } finally {
      breaker.shutdown();
      c.close();
    }
  });

  test.each<[string, unknown, boolean]>([
    ['UNAVAILABLE 글 pg-unavailable', grpcError(grpc.status.UNAVAILABLE, 'pg-unavailable'), false],
    ['그 밖의 UNAVAILABLE', grpcError(grpc.status.UNAVAILABLE, 'No connection established'), true],
    ['DEADLINE_EXCEEDED', grpcError(grpc.status.DEADLINE_EXCEEDED, 'pg-unavailable'), true],
    ['INVALID_ARGUMENT(업무 거절)', grpcError(grpc.status.INVALID_ARGUMENT, '입력이 틀렸다: pay_method'), false],
    ['gRPC가 아닌 예외', new TypeError('boom'), true],
  ])('PT26_리뷰 고침 H1: 차단기 분류 %s → 실패 %s', (_name, err, failed) => {
    expect(PAYMENT_CHECKOUT_BREAKER_OPTIONS.isFailure(err)).toBe(failed);
  });

  test('PT26_리뷰 고침 L8: 파드당 동시 호출 상한을 넘은 호출은 부르지 않고 PG_UNAVAILABLE(503 쪽)이다 [ASVS v5.0.0-16.5.2]', async () => {
    const srv = await fakeServer(() => tossAnswer());
    const breaker = realBreaker();
    const c = new GrpcPaymentCheckouts({ address: srv.address, breaker });
    try {
      const held = Array.from({ length: PREPARE_CHECKOUT_MAX_CONCURRENT }, () => c.prepare(query()));
      expect(breaker.inFlight).toBe(PREPARE_CHECKOUT_MAX_CONCURRENT);
      expect(await c.prepare(query())).toEqual({ status: 'PG_UNAVAILABLE', reason: 'unavailable' });
      await Promise.all(held);
      expect(srv.requests).toHaveLength(PREPARE_CHECKOUT_MAX_CONCURRENT);
    } finally {
      breaker.shutdown();
      c.close();
      srv.close();
    }
  });
});

describe('리뷰 고침 M3: 쓰임새 + 실제 클라이언트', () => {
  const useCase = (fx: StartFakes, checkouts: GrpcPaymentCheckouts) =>
    new StartPayment({ sessions: fx.sessions, reads: fx.starts, writes: fx.starts, slots: fx.slots, saleConfigs: fx.saleConfigs, holdExpiries: fx.holdExpiries, checkouts, behavior: fx.behavior, signals: fx.signals, log: fx.log, clock: fakeClock({ now: NOW }) });

  test('PT27_리뷰 고침 M3: 금액이 주문과 다른 답은 503 설정 오류·SEV2 로그이고 시도 행을 쓰지 않는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    const srv = await fakeServer(() => tossAnswer({ toss: { ...(tossAnswer().toss as object), amount: { krw: AMOUNT + 1 } } }));
    const c = new GrpcPaymentCheckouts({ address: srv.address });
    const fx = new StartFakes();
    try {
      expect(await useCase(fx, c).execute(startCommand())).toEqual({ status: 'REJECTED', reason: 'CHECKOUT_MISCONFIGURED' });
      expect(fx.misconfiguredLogs).toEqual([{ reason: 'bad_answer' }]);
      expect(fx.started).toHaveLength(0);
    } finally {
      c.close();
      srv.close();
    }
  });

  test('PT27_리뷰 고침 M3: 재생의 답이 고정한 결제사와 다르면 503 설정 오류다(전환이 켜져도 결제사가 바뀌지 않는다) [ASVS v5.0.0-2.2.3]', async () => {
    const srv = await fakeServer(() => tossAnswer());
    const c = new GrpcPaymentCheckouts({ address: srv.address });
    const fx = new StartFakes();
    fx.committed = { status: 'COMMITTED', attemptId: ATTEMPT_ID };
    fx.attemptView = { attemptId: ATTEMPT_ID, orderId: ORDER_ID, pg: 'PORTONE' };
    try {
      expect(await useCase(fx, c).execute(startCommand())).toEqual({ status: 'REJECTED', reason: 'CHECKOUT_MISCONFIGURED' });
      expect(fx.misconfiguredLogs).toEqual([{ reason: 'bad_answer' }]);
      expect(fx.metrics).toEqual([{ pg: 'none', outcome: 'misconfigured' }]);
    } finally {
      c.close();
      srv.close();
    }
  });
});

describe('local·ci 대역과 시작 조건', () => {
  test('PT26_대역은 시뮬레이터 값을 돌려주고 고정이 있어도 시뮬레이터다', async () => {
    const r = await simulatorPaymentCheckouts.prepare(query());
    expect(r).toMatchObject({ status: 'OK', pg: 'SIMULATOR', switched: false, checkout: { shape: 'TOSS', orderId: ORDER_ID, orderName: ORDER_NAME, amount: AMOUNT }, allowedPayMethods: ['CARD'] });
  });

  test('PT26_대역의 구매자 키는 호출마다 다른 무작위 값이다 [ASVS v5.0.0-11.5.1]', async () => {
    const a = (await simulatorPaymentCheckouts.prepare(query())) as Extract<Awaited<ReturnType<typeof simulatorPaymentCheckouts.prepare>>, { status: 'OK' }>;
    const b = (await simulatorPaymentCheckouts.prepare(query())) as typeof a;
    const keyOf = (x: typeof a) => (x.checkout.shape === 'TOSS' ? x.checkout.customerKey : '');
    expect(keyOf(a)).not.toBe(keyOf(b));
    expect(keyOf(a)).toMatch(/^[A-Za-z0-9\-_=.@]{2,50}$/);
  });

  test.each(['local', 'ci'])('PT26_주소가 없으면 %s만 대역과 경고 한 줄이다', (PEAKET_ENV) => {
    const made = paymentCheckoutsFromEnv({ PEAKET_ENV });
    expect(made.checkouts).toBe(simulatorPaymentCheckouts);
    expect(made.warnings).toHaveLength(1);
    made.close();
  });

  test.each(['demo', 'staging', 'prod', undefined])('PT26_주소가 없으면 PEAKET_ENV=%s는 시작하지 않는다 [ASVS v5.0.0-16.5.3]', (PEAKET_ENV) => {
    expect(() => paymentCheckoutsFromEnv({ ...(PEAKET_ENV ? { PEAKET_ENV } : {}) })).toThrow(PAYMENT_GRPC_ADDR_ENV);
  });

  test('PT26_주소가 있으면 어느 환경이든 gRPC 클라이언트이고 경고가 없다', () => {
    const made = paymentCheckoutsFromEnv({ PEAKET_ENV: 'prod', [PAYMENT_GRPC_ADDR_ENV]: '127.0.0.1:1' });
    expect(made.checkouts).toBeInstanceOf(GrpcPaymentCheckouts);
    expect(made.warnings).toEqual([]);
    made.close();
  });
});

describe('행동 신호 어댑터', () => {
  const message = { pid: PID, refMissing: false as const, eventId: EVENT, journeyId: JOURNEY, screen: 'PAYMENT' as const, features: BEHAVIOR, ts: '2026-11-09T03:00:00.000Z', eventKey: 'k' };

  test('PT51_①KafkaBehaviorSignals는 telemetry.behavior에 키 pid, JSON 값으로 낸다', async () => {
    const sent: { topic: string; messages: { key: string; value: Buffer }[] }[] = [];
    await new KafkaBehaviorSignals({ send: async (r) => void sent.push(r) }).publish(message);
    expect(TELEMETRY_BEHAVIOR_TOPIC).toBe('telemetry.behavior');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.topic).toBe('telemetry.behavior');
    expect(sent[0]!.messages[0]!.key).toBe(PID);
    expect(JSON.parse(sent[0]!.messages[0]!.value.toString('utf8'))).toEqual(message);
  });

  test('PT51_④전송 실패는 던진다(쓰임새가 센다)', async () => {
    await expect(new KafkaBehaviorSignals({ send: async () => Promise.reject(new Error('down')) }).publish(message)).rejects.toThrow('down');
  });

  test('PT51_버리는 대역은 조용히 끝난다', async () => {
    await expect(discardBehaviorSignals.publish(message)).resolves.toBeUndefined();
  });
});
