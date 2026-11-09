// payment-svc 새 결제 일시 정지 조회 클라이언트(adapters/grpc-new-payment-pause.ts, ADR-0085, P-T43, BUILD_ORDER PRF-201).
// 실제 grpc-js 서버(같은 프로세스의 가짜 payment-svc)와 계약 설명자로 왕복을 본다. 만료 작업의 조립은 HOT-070이다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { CIRCUIT_BREAKER_DEFAULTS, CircuitBreaker, ProblemError } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { checkoutFailureOf, GrpcNewPaymentPauses, GrpcPaymentCheckouts, NEW_PAYMENT_PAUSE_CAP_MS, NEW_PAYMENT_PAUSE_MAX_EVENTS, newPaymentPausesFromEnv, newPaymentPausesOf, noNewPaymentPauses, PAYMENT_CHECKOUT_BREAKER_OPTIONS, PAYMENT_GRPC_ADDR_ENV, PAYMENT_PAUSE_BREAKER, PAYMENT_PAUSE_BREAKER_OPTIONS } from '../src/modules/booking/index.js';

const EVENT_A = '11111111-1111-7111-8111-111111111111';
const EVENT_B = '22222222-2222-7222-8222-222222222222';

type Answer = (req: Record<string, unknown>) => Record<string, unknown> | grpc.ServiceError;

async function fakeServer(answer: Answer, delayMs = 0) {
  const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: { PaymentService: grpc.ServiceClientConstructor } } } }).peaket.payment.v1;
  const server = new grpc.Server();
  const requests: Record<string, unknown>[] = [];
  const deadlines: unknown[] = [];
  server.addService(pkg.PaymentService.service, {
    GetNewPaymentPause: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      requests.push(call.request);
      deadlines.push(call.getDeadline());
      const a = answer(call.request);
      const reply = () => ('code' in a ? cb(a as grpc.ServiceError) : cb(null, a));
      if (delayMs > 0) setTimeout(reply, delayMs);
      else reply();
    },
  });
  const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
  return { address: `127.0.0.1:${port}`, requests, deadlines, close: () => server.forceShutdown() };
}

const openers: (() => void)[] = [];
afterEach(() => {
  for (const close of openers.splice(0)) close();
});

const serviceError = (code: grpc.status, details: string): grpc.ServiceError => Object.assign(new Error(details), { code, details, metadata: new grpc.Metadata() }) as grpc.ServiceError;

describe('newPaymentPausesOf: 답 읽기', () => {
  test('P-T43_회차와 시작 시각을 읽고 0도 그대로다 [ASVS v5.0.0-16.5.3]', () => {
    expect(
      newPaymentPausesOf({
        pauses: [
          { event_id: EVENT_A, paused_since: { seconds: 1_794_200_000, nanos: 123_000_000 } },
          { event_id: EVENT_B, paused_since: { seconds: 0, nanos: 0 } },
        ],
      }),
    ).toEqual({
      status: 'OK',
      pauses: [
        { eventId: EVENT_A, pausedSinceMs: 1_794_200_000_123 },
        { eventId: EVENT_B, pausedSinceMs: 0 },
      ],
    });
  });

  test('P-T43_칸이 없으면 빈 목록이다', () => {
    expect(newPaymentPausesOf({})).toEqual({ status: 'OK', pauses: [] });
  });

  test('P-T43_회차 ID가 빈 칸은 버린다(남의 회차로 잘못 읽지 않는다) [ASVS v5.0.0-16.5.3]', () => {
    expect(newPaymentPausesOf({ pauses: [{ event_id: '', paused_since: { seconds: 1, nanos: 0 } }] })).toEqual({ status: 'OK', pauses: [] });
  });

  test('P-T43_시각 칸이 없거나 틀리면 0으로 읽는다(멈춘 쪽으로 판단한다)', () => {
    expect(newPaymentPausesOf({ pauses: [{ event_id: EVENT_A }] })).toEqual({ status: 'OK', pauses: [{ eventId: EVENT_A, pausedSinceMs: 0 }] });
  });
});

describe('GrpcNewPaymentPauses', () => {
  const pod = async (answer: Answer, o: { delayMs?: number; breaker?: CircuitBreaker } = {}) => {
    const srv = await fakeServer(answer, o.delayMs ?? 0);
    const c = new GrpcNewPaymentPauses({ address: srv.address, ...(o.breaker ? { breaker: o.breaker } : {}) });
    openers.push(() => {
      c.close();
      srv.close();
    });
    return { srv, c };
  };

  test('P-T43_회차를 보내고 답을 읽는다 [ASVS v5.0.0-2.2.1]', async () => {
    const { srv, c } = await pod(() => ({ pauses: [{ event_id: EVENT_A, paused_since: { seconds: 2, nanos: 0 } }] }));
    expect(await c.read([EVENT_A, EVENT_B], { deadlineMs: 300 })).toEqual({ status: 'OK', pauses: [{ eventId: EVENT_A, pausedSinceMs: 2_000 }] });
    expect(srv.requests[0]).toMatchObject({ event_ids: [EVENT_A, EVENT_B] });
  });

  test('P-T43_빈 목록은 부르지 않고 빈 답이다', async () => {
    const { srv, c } = await pod(() => ({ pauses: [] }));
    expect(await c.read([], { deadlineMs: 300 })).toEqual({ status: 'OK', pauses: [] });
    expect(srv.requests).toHaveLength(0);
  });

  test('P-T43_데드라인 상한은 500ms다', async () => {
    expect(NEW_PAYMENT_PAUSE_CAP_MS).toBe(500);
    const { srv, c } = await pod(() => ({ pauses: [] }));
    const before = Date.now();
    await c.read([EVENT_A], { deadlineMs: 60_000 });
    expect(Number(srv.deadlines[0]) - before).toBeLessThanOrEqual(NEW_PAYMENT_PAUSE_CAP_MS + 200);
  });

  test('P-T43_시간 초과는 던지지 않고 UNAVAILABLE이다 [ASVS v5.0.0-16.5.2]', async () => {
    const { c } = await pod(() => ({ pauses: [] }), { delayMs: 200 });
    expect(await c.read([EVENT_A], { deadlineMs: 20 })).toMatchObject({ status: 'UNAVAILABLE', reason: 'DEADLINE_EXCEEDED' });
  });

  test('P-T43_서버가 UNAVAILABLE이면 던지지 않고 UNAVAILABLE이다 [ASVS v5.0.0-16.5.2]', async () => {
    const { c } = await pod(() => serviceError(grpc.status.UNAVAILABLE, '처리할 수 없다'));
    expect(await c.read([EVENT_A], { deadlineMs: 300 })).toMatchObject({ status: 'UNAVAILABLE', reason: 'UNAVAILABLE' });
  });

  test('P-T43_차단기가 열리면 부르지 않고 UNAVAILABLE(circuit_open)이다 [ASVS v5.0.0-16.5.2]', async () => {
    const breaker = {
      run: async () => {
        throw new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 잠시 쓸 수 없습니다' });
      },
    } as unknown as CircuitBreaker;
    const { srv, c } = await pod(() => ({ pauses: [] }), { breaker });
    expect(await c.read([EVENT_A], { deadlineMs: 300 })).toMatchObject({ status: 'UNAVAILABLE', reason: 'CIRCUIT_OPEN' });
    expect(srv.requests).toHaveLength(0);
  });

  const manyIds = (n: number) => Array.from({ length: n }, (_, i) => `${String(i).padStart(8, '0')}-1111-7111-8111-111111111111`);

  test('P-T43_리뷰 고침 M2: 200개씩 나눠 부르고 답을 합친다 [ASVS v5.0.0-2.2.1]', async () => {
    expect(NEW_PAYMENT_PAUSE_MAX_EVENTS).toBe(200);
    const ids = manyIds(450);
    const { srv, c } = await pod((req) => ({ pauses: [{ event_id: (req.event_ids as string[])[0], paused_since: { seconds: 1, nanos: 0 } }] }));
    expect(await c.read(ids, { deadlineMs: 300 })).toEqual({
      status: 'OK',
      pauses: [ids[0], ids[200], ids[400]].map((eventId) => ({ eventId, pausedSinceMs: 1_000 })),
    });
    expect(srv.requests.map((r) => (r.event_ids as string[]).length)).toEqual([200, 200, 50]);
    expect(srv.requests.flatMap((r) => r.event_ids as string[])).toEqual(ids);
  });

  test('P-T43_리뷰 고침 M2: 한 묶음이라도 실패하면 전체가 실패다(일부를 열림으로 읽지 않는다) [ASVS v5.0.0-16.5.3]', async () => {
    let n = 0;
    const { c } = await pod(() => (++n === 2 ? serviceError(grpc.status.UNAVAILABLE, '끊김') : { pauses: [] }));
    expect(await c.read(manyIds(450), { deadlineMs: 300 })).toMatchObject({ status: 'UNAVAILABLE', reason: 'UNAVAILABLE' });
    expect(n).toBe(2);
  });

  test('P-T43_리뷰 고침 M2: INVALID_ARGUMENT는 UNAVAILABLE로 뭉개지 않고 REJECTED로 따로 경보한다 [ASVS v5.0.0-16.3.4]', async () => {
    const srv = await fakeServer(() => serviceError(grpc.status.INVALID_ARGUMENT, 'event_ids'));
    const alerts: string[] = [];
    const c = new GrpcNewPaymentPauses({ address: srv.address, onRejected: (reason) => alerts.push(reason) });
    openers.push(() => {
      c.close();
      srv.close();
    });
    expect(await c.read([EVENT_A], { deadlineMs: 300 })).toEqual({ status: 'REJECTED', reason: 'INVALID_ARGUMENT' });
    expect(alerts).toEqual(['INVALID_ARGUMENT']);
  });

  test('P-T43_리뷰 고침 L7: 1초 주기로도 창 안에서 열리도록 전용 minCalls를 둔다 [ASVS v5.0.0-16.5.2]', async () => {
    expect(PAYMENT_PAUSE_BREAKER_OPTIONS).toMatchObject({ dependency: PAYMENT_PAUSE_BREAKER, minCalls: 5 });
    expect(PAYMENT_PAUSE_BREAKER_OPTIONS.minCalls).toBeLessThan(CIRCUIT_BREAKER_DEFAULTS.windowMs / 1_000);
    const breaker = new CircuitBreaker({ service: 'purchase-svc', ...PAYMENT_PAUSE_BREAKER_OPTIONS });
    const { srv, c } = await pod(() => serviceError(grpc.status.UNAVAILABLE, '끊김'), { breaker });
    for (let i = 0; i < PAYMENT_PAUSE_BREAKER_OPTIONS.minCalls; i += 1) expect(await c.read([EVENT_A], { deadlineMs: 300 })).toMatchObject({ status: 'UNAVAILABLE', reason: 'UNAVAILABLE' });
    expect(await c.read([EVENT_A], { deadlineMs: 300 })).toMatchObject({ status: 'UNAVAILABLE', reason: 'CIRCUIT_OPEN' });
    expect(srv.requests).toHaveLength(PAYMENT_PAUSE_BREAKER_OPTIONS.minCalls);
    breaker.shutdown();
  });

  test('P-T43_주소 모양이 틀리면 시작 실패다', () => {
    expect(() => new GrpcNewPaymentPauses({ address: 'not-an-address' })).toThrow(PAYMENT_GRPC_ADDR_ENV);
  });
});

describe('newPaymentPausesFromEnv', () => {
  test('P-T43_주소가 없으면 local·ci만 대역과 경고 한 줄이다 [ASVS v5.0.0-16.5.3]', async () => {
    const made = newPaymentPausesFromEnv({ PEAKET_ENV: 'local' });
    expect(made.pauses).toBe(noNewPaymentPauses);
    expect(made.warnings).toHaveLength(1);
    expect(await made.pauses.read([EVENT_A], { deadlineMs: 300 })).toEqual({ status: 'OK', pauses: [] });
    made.close();
  });

  test.each([{ PEAKET_ENV: 'prod' }, { PEAKET_ENV: 'stage' }, {}])('P-T43_%j는 주소 없이 시작하지 않는다 [ASVS v5.0.0-16.5.3]', (env) => {
    expect(() => newPaymentPausesFromEnv(env)).toThrow(PAYMENT_GRPC_ADDR_ENV);
  });

  test('P-T43_주소가 있으면 gRPC 클라이언트다', () => {
    const made = newPaymentPausesFromEnv({ PEAKET_ENV: 'prod', [PAYMENT_GRPC_ADDR_ENV]: '127.0.0.1:1' });
    expect(made.pauses).toBeInstanceOf(GrpcNewPaymentPauses);
    expect(made.warnings).toEqual([]);
    made.close();
  });
});

describe('결제창 준비의 새 결제 일시 정지(P-T43, BUILD_ORDER PRF-201)', () => {
  test('P-T43_FAILED_PRECONDITION 글 new-payment-paused는 NEW_PAYMENT_PAUSED다', () => {
    expect(checkoutFailureOf(grpc.status.FAILED_PRECONDITION, 'new-payment-paused')).toEqual({ status: 'NEW_PAYMENT_PAUSED' });
  });

  test('P-T43_글이 다른 FAILED_PRECONDITION은 설정 오류 그대로다', () => {
    expect(checkoutFailureOf(grpc.status.FAILED_PRECONDITION, '다른 글')).toMatchObject({ status: 'MISCONFIGURED' });
  });

  test('P-T43_차단기는 새 결제 일시 정지 답을 실패로 세지 않는다 [ASVS v5.0.0-16.5.2]', () => {
    expect(PAYMENT_CHECKOUT_BREAKER_OPTIONS.isFailure(serviceError(grpc.status.FAILED_PRECONDITION, 'new-payment-paused'))).toBe(false);
  });

  test('P-T43_다른 UNAVAILABLE은 차단기의 실패로 센다', () => {
    expect(PAYMENT_CHECKOUT_BREAKER_OPTIONS.isFailure(serviceError(grpc.status.UNAVAILABLE, '끊김'))).toBe(true);
  });

  test('P-T43_실제 클라이언트가 선을 지난 답을 NEW_PAYMENT_PAUSED로 읽는다', async () => {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: { PaymentService: grpc.ServiceClientConstructor } } } }).peaket.payment.v1;
    const server = new grpc.Server();
    server.addService(pkg.PaymentService.service, {
      PrepareCheckout: (_call: grpc.ServerUnaryCall<unknown, unknown>, cb: grpc.sendUnaryData<unknown>) => cb(serviceError(grpc.status.FAILED_PRECONDITION, 'new-payment-paused')),
    });
    const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
    const c = new GrpcPaymentCheckouts({ address: `127.0.0.1:${port}` });
    try {
      expect(await c.prepare({ orderId: EVENT_A, attemptId: EVENT_B, eventId: EVENT_A, amount: 1_000, orderName: 'n', deadlineMs: 300 })).toEqual({ status: 'NEW_PAYMENT_PAUSED' });
    } finally {
      c.close();
      server.forceShutdown();
    }
  });
});
