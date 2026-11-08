// payment-svc 승인 명령 포트(booking adapters/grpc-payment-confirm.ts, docs/features/payment.md §2 'Saga 1단계의 첫 구현' 단계 CONFIRM,
// docs/architecture.md 시간 초과 표 '승인 명령 gRPC' 200ms [가정], BUILD_ORDER PRF-165)의 단위 시험.
// - '늘 접수' 대역(payment-svc ConfirmPayment 서버가 생기기 전, local·ci에서만)
// - paymentConfirmsFromEnv: 주소가 없으면 local·ci만 대역(경고 한 줄), 그 밖(PEAKET_ENV가 없으면 prod로 본다)은 던진다(시작 실패)
// - confirmOutcomeOf: gRPC 상태 → 결과(DEADLINE_EXCEEDED·UNAVAILABLE은 RETRYABLE, 그 밖은 REJECTED)
// - GrpcPaymentConfirms: 차단기 열림은 부르지 않고 RETRYABLE circuit_open, 아무도 듣지 않는 주소는 RETRYABLE(던지지 않는다)
// 실제 payment-svc 서버와 도는 시험은 서버가 생기는 단계의 몫이다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { CircuitBreaker, dependencyUnavailable } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  acceptingPaymentConfirms,
  CONFIRM_CALL_DEADLINE_MS,
  CONFIRM_CAP_MS,
  type ConfirmCommand,
  confirmOutcomeOf,
  GrpcPaymentConfirms,
  PAYMENT_GRPC_ADDR_ENV,
  paymentConfirmsFromEnv,
} from '../src/modules/booking/index.js';
import { ATTEMPT_ID, ORDER_ID, PAYMENT_KEY, PAYMENT_TOKEN, PORTONE_PAYMENT_ID, TX_ID } from './accept-cases.js';
import { AMOUNT, EVENT, NOW } from './order-cases.js';

/** 정상 승인 명령(토스) */
function tossCommand(over: Partial<ConfirmCommand> = {}): ConfirmCommand {
  return { orderId: ORDER_ID, attemptId: ATTEMPT_ID, eventId: EVENT, attemptNo: 1, authenticatedAtMs: NOW, pg: 'TOSS', refs: { pg: 'TOSS', paymentKey: PAYMENT_KEY }, amount: AMOUNT, deadlineMs: 200, ...over };
}
const portoneCommand = (): ConfirmCommand =>
  tossCommand({ pg: 'PORTONE', refs: { pg: 'PORTONE', paymentId: PORTONE_PAYMENT_ID, txId: TX_ID, paymentToken: PAYMENT_TOKEN } });

/** 뼈대의 '미구현' 오류(던지기만 보는 시험이 뼈대에서 그냥 통과하지 않게, 던진 오류가 이것이 아님을 본다) */
const NOT_BUILT = /미구현/;
/** fn이 던진 Error. 던지지 않으면 실패 */
function thrownBy(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(Error);
    return e as Error;
  }
  throw new Error('던지지 않았다');
}

/** 아무도 부르지 않는 주소(가짜 차단기가 호출 전에 끊는다) */
const ADDR = '127.0.0.1:9';
/** run이 action을 부르지 않고 err를 던지는 가짜 차단기(열린 차단기) */
const refusing = (err: unknown, runs: unknown[] = []) =>
  ({
    run: async (action: unknown) => {
      runs.push(action);
      throw err;
    },
  }) as unknown as CircuitBreaker;

describe("'늘 접수' 대역", () => {
  test('FR011_어느 명령이든(토스·포트원) 늘 { ACCEPTED, IN_PROGRESS }이다', async () => {
    expect(await acceptingPaymentConfirms.confirm(tossCommand())).toEqual({ status: 'ACCEPTED', result: 'IN_PROGRESS' });
    expect(await acceptingPaymentConfirms.confirm(portoneCommand())).toEqual({ status: 'ACCEPTED', result: 'IN_PROGRESS' });
  });
});

describe('paymentConfirmsFromEnv: 주소가 없을 때', () => {
  test.each(['local', 'ci'])('FR011_PEAKET_ENV=%s면 늘 접수 대역과 경고 한 줄이다(빠진 설정 이름을 담는다)', async (env) => {
    for (const addr of [undefined, '']) {
      const c = paymentConfirmsFromEnv({ PEAKET_ENV: env, [PAYMENT_GRPC_ADDR_ENV]: addr });
      expect(c.confirms).toBe(acceptingPaymentConfirms);
      expect(c.warnings).toHaveLength(1);
      expect(c.warnings[0]).toContain(PAYMENT_GRPC_ADDR_ENV);
      expect(await c.confirms.confirm(tossCommand())).toEqual({ status: 'ACCEPTED', result: 'IN_PROGRESS' });
      c.close();
    }
  });

  test.each(['prod', 'demo', 'staging', undefined, ''])(
    'ASVS16.5.3_PEAKET_ENV=%j(값이 없으면 prod로 본다)면 주소 없이 대역으로 뜨지 않고 던진다(시작 실패. 승인 없이 접수만 하는 결제가 운영에 생기지 않게) [ASVS v5.0.0-16.5.3]',
    (env) => {
      for (const addr of [undefined, '']) {
        expect(() => paymentConfirmsFromEnv({ ...(env === undefined ? {} : { PEAKET_ENV: env }), [PAYMENT_GRPC_ADDR_ENV]: addr })).toThrow(new RegExp(PAYMENT_GRPC_ADDR_ENV));
      }
    },
  );

  test('FR011_주소가 있으면 어느 환경이든 gRPC 클라이언트이고 경고가 없다. 넘긴 차단기를 클라이언트에 넘긴다', () => {
    const breaker = refusing(new Error('x'));
    const c = paymentConfirmsFromEnv({ PEAKET_ENV: 'prod', [PAYMENT_GRPC_ADDR_ENV]: ADDR }, { breaker });
    try {
      expect(c.warnings).toEqual([]);
      expect(c.confirms).toBeInstanceOf(GrpcPaymentConfirms);
      expect((c.confirms as GrpcPaymentConfirms).o.breaker).toBe(breaker);
    } finally {
      c.close();
    }
  });

  test('FR011_주소가 host:port 모양이 아니면 던진다(시작 실패)', () => {
    for (const addr of ['payment-svc', ':50051', 'payment-svc:0', 'payment-svc:x']) {
      expect(thrownBy(() => paymentConfirmsFromEnv({ PEAKET_ENV: 'ci', [PAYMENT_GRPC_ADDR_ENV]: addr })).message, addr).not.toMatch(NOT_BUILT);
    }
  });
});

describe('confirmOutcomeOf: gRPC 상태 → 결과', () => {
  test.each<[number, string, ReturnType<typeof confirmOutcomeOf>]>([
    [4, 'DEADLINE_EXCEEDED', { status: 'RETRYABLE', reason: 'deadline' }],
    [14, 'UNAVAILABLE', { status: 'RETRYABLE', reason: 'unavailable' }],
    [3, 'INVALID_ARGUMENT', { status: 'REJECTED', reason: 'invalid_argument' }],
    [9, 'FAILED_PRECONDITION', { status: 'REJECTED', reason: 'failed_precondition' }],
    [7, 'PERMISSION_DENIED', { status: 'REJECTED', reason: 'permission_denied' }],
    [12, 'UNIMPLEMENTED', { status: 'REJECTED', reason: 'unimplemented' }],
    [16, 'UNAUTHENTICATED', { status: 'REJECTED', reason: 'unauthenticated' }],
    [5, 'NOT_FOUND', { status: 'REJECTED', reason: 'not_found' }],
    [8, 'RESOURCE_EXHAUSTED', { status: 'REJECTED', reason: 'resource_exhausted' }],
    [13, 'INTERNAL', { status: 'REJECTED', reason: 'internal' }],
    [2, 'UNKNOWN', { status: 'REJECTED', reason: 'unknown' }],
    [99, '모르는 코드', { status: 'REJECTED', reason: 'unexpected' }],
  ])('FR011_코드 %i(%s) → %o', (code, _name, outcome) => {
    expect(confirmOutcomeOf(code)).toEqual(outcome);
  });

  test('FR011_다시 보내는(RETRYABLE) 코드는 4·14 둘뿐이다(0~16 가운데)', () => {
    const retryable = Array.from({ length: 17 }, (_, i) => i).filter((code) => confirmOutcomeOf(code).status === 'RETRYABLE');
    expect(retryable).toEqual([4, 14]);
  });
});

describe('GrpcPaymentConfirms', () => {
  test('FR011_차단기가 열려 있으면(503 dependency-unavailable) 부르지 않고 RETRYABLE circuit_open이다(던지지 않는다). 데드라인 상한은 200ms다', async () => {
    const runs: unknown[] = [];
    const c = new GrpcPaymentConfirms({ address: ADDR, breaker: refusing(dependencyUnavailable(5), runs) });
    try {
      expect(await c.confirm(tossCommand())).toEqual({ status: 'RETRYABLE', reason: 'circuit_open' });
      expect(runs).toHaveLength(1);
      expect([CONFIRM_CAP_MS, CONFIRM_CALL_DEADLINE_MS]).toEqual([200, 200]);
    } finally {
      c.close();
    }
  });

  test('FR011_gRPC가 아닌 예외(TypeError)는 REJECTED unexpected다(던지지 않는다)', async () => {
    const c = new GrpcPaymentConfirms({ address: ADDR, breaker: refusing(new TypeError('Cannot read properties of undefined')) });
    try {
      expect(await c.confirm(portoneCommand())).toEqual({ status: 'REJECTED', reason: 'unexpected' });
    } finally {
      c.close();
    }
  });

  test('FR011_아무도 듣지 않는 주소면 데드라인 초과나 UNAVAILABLE로 RETRYABLE이고, 결과의 까닭에 결제 참조가 실리지 않는다', async () => {
    const c = new GrpcPaymentConfirms({ address: '127.0.0.1:1' });
    try {
      const out = await c.confirm(tossCommand({ deadlineMs: 50 }));
      expect(out.status).toBe('RETRYABLE');
      expect(['deadline', 'unavailable']).toContain((out as { reason: string }).reason);
      expect(JSON.stringify(out)).not.toContain(PAYMENT_KEY);
    } finally {
      c.close();
    }
  });

  test('FR011_실제 차단기(의존 payment-svc)가 연속 실패로 열리면 다음 호출은 부르지 않고 circuit_open이다', async () => {
    const breaker = new CircuitBreaker({ service: 'purchase-svc', dependency: 'payment-svc', minCalls: 1, failureRatePercent: 50, openMs: 60_000 });
    const c = new GrpcPaymentConfirms({ address: '127.0.0.1:1', breaker });
    try {
      const first = await c.confirm(tossCommand({ deadlineMs: 50 }));
      expect(first.status).toBe('RETRYABLE');
      expect(breaker.state).toBe('open');
      expect(await c.confirm(tossCommand({ deadlineMs: 50 }))).toEqual({ status: 'RETRYABLE', reason: 'circuit_open' });
    } finally {
      c.close();
      breaker.shutdown();
    }
  });

  test('FR011_주소가 host:port 모양이 아니면 만들 때 던진다', () => {
    for (const address of ['payment-svc', ':50051', 'payment-svc:0']) {
      expect(thrownBy(() => new GrpcPaymentConfirms({ address })).message, address).not.toMatch(NOT_BUILT);
    }
  });
});

/** 같은 프로세스의 가짜 payment-svc(PaymentService.ConfirmPayment만). answer가 돌려주는 답을 그대로 보낸다 */
async function fakePaymentServer(answer: (req: Record<string, unknown>) => Record<string, unknown>) {
  const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: { PaymentService: grpc.ServiceClientConstructor } } } }).peaket.payment.v1;
  const server = new grpc.Server();
  const requests: Record<string, unknown>[] = [];
  server.addService(pkg.PaymentService.service, {
    ConfirmPayment: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      requests.push(call.request);
      cb(null, answer(call.request));
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))),
  );
  return { address: `127.0.0.1:${port}`, requests, close: () => server.forceShutdown() };
}

describe('GrpcPaymentConfirms와 가짜 payment-svc(리뷰 고침 H1·낮음)', () => {
  test('H1_답을 받으면 ACCEPTED(결과 이름)이고, 보내기 전 표시(beforeSend)를 보내기 바로 전에 한 번 부른다. 요청은 order_id·attempt_id·pg·toss.payment_key·amount.krw다', async () => {
    const order: string[] = [];
    const srv = await fakePaymentServer(() => {
      order.push('server');
      return { result: 'CONFIRM_RESULT_IN_PROGRESS', payment_id: 'p1' };
    });
    const c = new GrpcPaymentConfirms({ address: srv.address });
    try {
      const out = await c.confirm(tossCommand(), {
        beforeSend: async () => {
          order.push('beforeSend');
        },
      });
      expect(out).toEqual({ status: 'ACCEPTED', result: 'IN_PROGRESS' });
      expect(order).toEqual(['beforeSend', 'server']);
      expect(srv.requests).toHaveLength(1);
      expect(srv.requests[0]).toMatchObject({ order_id: ORDER_ID, attempt_id: ATTEMPT_ID, pg: 'PG_PROVIDER_TOSS', toss: { payment_key: PAYMENT_KEY }, amount: { krw: AMOUNT } });
      // 포트원은 portone 칸(payment_id = pg_order_ref·tx_id·payment_token)
      await c.confirm(portoneCommand());
      expect(srv.requests[1]).toMatchObject({ pg: 'PG_PROVIDER_PORTONE', portone: { payment_id: PORTONE_PAYMENT_ID, tx_id: TX_ID, payment_token: PAYMENT_TOKEN } });
    } finally {
      c.close();
      srv.close();
    }
  });

  test.each(['CONFIRM_RESULT_UNKNOWN', 'CONFIRM_RESULT_UNSPECIFIED'])('낮음_답의 결과가 %s면 받아 적었다고 볼 수 없어 ACCEPTED가 아니라 REJECTED unexpected다(결제 참조를 지우지 않게)', async (result) => {
    const srv = await fakePaymentServer(() => ({ result }));
    const c = new GrpcPaymentConfirms({ address: srv.address });
    try {
      expect(await c.confirm(tossCommand())).toEqual({ status: 'REJECTED', reason: 'unexpected' });
      expect(srv.requests).toHaveLength(1);
    } finally {
      c.close();
      srv.close();
    }
  });

  test('H1_보내기 전 표시가 던지면 보내지 않고 그 오류를 그대로 던지며, 차단기 실패로 세지 않는다', async () => {
    const srv = await fakePaymentServer(() => ({ result: 'CONFIRM_RESULT_IN_PROGRESS' }));
    const breaker = new CircuitBreaker({ service: 'purchase-svc', dependency: 'payment-svc', minCalls: 1, failureRatePercent: 50, openMs: 60_000 });
    const c = new GrpcPaymentConfirms({ address: srv.address, breaker });
    const lost = new Error('lease lost');
    try {
      await expect(
        c.confirm(tossCommand(), {
          beforeSend: async () => {
            throw lost;
          },
        }),
      ).rejects.toBe(lost);
      expect(srv.requests).toEqual([]);
      expect(breaker.state).toBe('closed');
    } finally {
      c.close();
      breaker.shutdown();
      srv.close();
    }
  });

  test('H1_차단기가 열려 있으면 보내기 전 표시를 부르지 않는다(한 번도 보내지 않은 것으로 남는다)', async () => {
    let called = 0;
    const c = new GrpcPaymentConfirms({ address: ADDR, breaker: refusing(dependencyUnavailable(5)) });
    try {
      expect(
        await c.confirm(tossCommand(), {
          beforeSend: async () => {
            called += 1;
          },
        }),
      ).toEqual({ status: 'RETRYABLE', reason: 'circuit_open' });
      expect(called).toBe(0);
    } finally {
      c.close();
    }
  });

  test("H1_'늘 접수' 대역도 보내기 전 표시를 부른 뒤 접수한다", async () => {
    let called = 0;
    expect(
      await acceptingPaymentConfirms.confirm(tossCommand(), {
        beforeSend: async () => {
          called += 1;
        },
      }),
    ).toEqual({ status: 'ACCEPTED', result: 'IN_PROGRESS' });
    expect(called).toBe(1);
  });
});
