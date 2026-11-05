// 결제 결과 당기기의 어댑터(BUILD_ORDER PRF-171 설계 4·8, docs/features/payment.md §2 '결제 결과 당기기의 첫 구현', ADR-0140 결정 2·3·4,
// docs/api/proto/peaket/payment/v1/payment.proto BatchGetPayments·OrderPaymentState).
// - paymentResultReaderFromEnv: 주소(PEAKET_PAYMENT_GRPC_ADDR, 승인 명령과 같다)가 없으면 local·ci만 '기록 없음' 대역(늘 빈 답, 경고 한 줄), 그 밖은 던진다
// - paymentPullCodeOf(gRPC 상태 번호 → 이름, 0·모르는 번호는 UNKNOWN)·orderPaymentStatesOf(답 모양 → 도메인 OrderPaymentState, 틀리면 BAD_ANSWER)
// - GrpcPaymentResultReader: 빈 묻기·100건 넘음은 부르지 않음, 차단기 열림 CIRCUIT_OPEN·동시 상한 RESOURCE_EXHAUSTED·남은 시간 없음 DEADLINE_EXCEEDED·
//   gRPC가 아닌 예외 UNKNOWN, 같은 프로세스의 가짜 payment-svc로 요청 칸·답 옮기기·gRPC 오류 코드·데드라인(상한 500ms)
// - paymentPullDatabaseOptions(전용 일반 풀 2개), DrizzlePaymentPull의 입력 검사(DB에 가기 전)와 트랜잭션 선택값, PromPaymentPullSignals(지표 이름·이름표)
// LoggerPaymentPullLog는 구현이 만든다(아직 없다). 실제 PostgreSQL로 도는 잡기·미루기는 test-int/payment-pull.int.test.ts(다른 담당)다.
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { type CircuitBreaker, type Database, deadlineExceeded, dependencyUnavailable, fakeClock, PlatformMetrics, type Registry, serverBusy, type TransactionOptions } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  DrizzlePaymentPull,
  emptyPaymentResultReader,
  GRPC_STATUS_NAMES,
  GrpcPaymentResultReader,
  orderPaymentStatesOf,
  PAYMENT_GRPC_ADDR_ENV,
  PAYMENT_PULL_BATCH,
  PAYMENT_PULL_BREAKER,
  PAYMENT_PULL_CAP_MS,
  PAYMENT_PULL_DEADLINE_MS,
  PAYMENT_PULL_STUB_ENVS,
  PaymentPullCallError,
  paymentPullCodeOf,
  paymentPullDatabaseOptions,
  paymentResultReaderFromEnv,
  PromPaymentPullSignals,
  SAGA_STATEMENT_TIMEOUT_MS,
} from '../src/modules/booking/index.js';
import { EVENT_KEY, ORDER_ID } from './payment-result-cases.js';
import { AMOUNT, NOW } from './order-cases.js';

const ORDER_B = '0190f3a1-7c2e-7f00-8000-0000000000f3';
const PAYMENT_ID = '0190f3a1-7c2e-7f00-8000-0000000000a9';
/** 승인 시각(Timestamp seconds·nanos로 싣는다) */
const APPROVED_AT_MS = NOW + 5_250;

/** 뼈대의 '구현 전' 오류(던지기만 보는 시험이 뼈대에서 그냥 통과하지 않게, 던진 오류가 이것이 아님을 본다) */
const NOT_BUILT = /구현 전\(뼈대\)/;
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
/** p가 PaymentPullCallError로 거절한 그 오류 */
async function callErrorOf(p: Promise<unknown>): Promise<PaymentPullCallError> {
  const err = await p.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(PaymentPullCallError);
  return err as PaymentPullCallError;
}

/** 아무도 부르지 않는 주소(가짜 차단기가 호출 전에 끊는다) */
const ADDR = '127.0.0.1:9';
/** run이 action을 부르지 않고 err를 던지는 가짜 차단기(열린 차단기·동시 상한·남은 시간 없음) */
const refusing = (err: unknown, runs: unknown[] = []) =>
  ({
    run: async (action: unknown) => {
      runs.push(action);
      throw err;
    },
  }) as unknown as CircuitBreaker;

/** 답의 주문 하나(proto 칸 이름 그대로. 토스 승인) */
function wireState(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: ORDER_ID,
    payment_id: PAYMENT_ID,
    pg: 'PG_PROVIDER_TOSS',
    status: 'PAYMENT_STATUS_APPROVED',
    amount: { krw: AMOUNT },
    approved_at: { seconds: Math.floor(APPROVED_AT_MS / 1000), nanos: (APPROVED_AT_MS % 1000) * 1_000_000 },
    failure_category: 'FAILURE_CATEGORY_UNSPECIFIED',
    event_key: EVENT_KEY,
    event_seq: 3,
    ...over,
  };
}

describe("'기록 없음' 대역과 paymentResultReaderFromEnv(설계 4)", () => {
  test("'기록 없음' 대역은 어느 주문이든 늘 빈 답이다(payment-svc BatchGetPayments 서버가 생기기 전, PRF-180 무렵)", async () => {
    expect(await emptyPaymentResultReader.batchGet([ORDER_ID, ORDER_B])).toEqual([]);
    expect(await emptyPaymentResultReader.batchGet([])).toEqual([]);
  });

  test.each(['local', 'ci'])('PEAKET_ENV=%s이고 주소가 없으면(빈 글 포함) 기록 없음 대역과 경고 한 줄이다(빠진 설정 이름을 담는다) (ADR0140)', async (env) => {
    expect([...PAYMENT_PULL_STUB_ENVS].sort()).toEqual(['ci', 'local']);
    for (const addr of [undefined, '']) {
      const r = paymentResultReaderFromEnv({ PEAKET_ENV: env, [PAYMENT_GRPC_ADDR_ENV]: addr });
      expect(r.reader).toBe(emptyPaymentResultReader);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toContain(PAYMENT_GRPC_ADDR_ENV);
      expect(await r.reader.batchGet([ORDER_ID])).toEqual([]);
      expect(() => r.close()).not.toThrow();
    }
  });

  test.each(['prod', 'demo', 'staging', undefined, ''])(
    'PEAKET_ENV=%j(값이 없으면 prod로 본다)면 주소 없이 대역으로 뜨지 않고 던진다(시작 실패: 사건 길이 멈추면 결제 확정도 멈추는 운영을 만들지 않게) (ADR0140) [ASVS v5.0.0-16.5.3]',
    (env) => {
      for (const addr of [undefined, '']) {
        expect(() => paymentResultReaderFromEnv({ ...(env === undefined ? {} : { PEAKET_ENV: env }), [PAYMENT_GRPC_ADDR_ENV]: addr })).toThrow(new RegExp(PAYMENT_GRPC_ADDR_ENV));
      }
    },
  );

  test('주소가 있으면 어느 환경이든 gRPC 클라이언트이고 경고가 없다. 넘긴 차단기를 클라이언트에 넘기고 주소는 승인 명령과 같은 PEAKET_PAYMENT_GRPC_ADDR다', () => {
    expect(PAYMENT_GRPC_ADDR_ENV).toBe('PEAKET_PAYMENT_GRPC_ADDR');
    const breaker = refusing(new Error('x'));
    const r = paymentResultReaderFromEnv({ PEAKET_ENV: 'prod', [PAYMENT_GRPC_ADDR_ENV]: ADDR }, { breaker });
    try {
      expect(r.warnings).toEqual([]);
      expect(r.reader).toBeInstanceOf(GrpcPaymentResultReader);
      expect((r.reader as GrpcPaymentResultReader).o.breaker).toBe(breaker);
      expect((r.reader as GrpcPaymentResultReader).o.address).toBe(ADDR);
    } finally {
      r.close();
    }
  });

  test('주소가 host:port 모양이 아니면 던진다(시작 실패) [ASVS v5.0.0-16.5.3]', () => {
    for (const addr of ['payment-svc', ':50051', 'payment-svc:0', 'payment-svc:x']) {
      expect(thrownBy(() => paymentResultReaderFromEnv({ PEAKET_ENV: 'ci', [PAYMENT_GRPC_ADDR_ENV]: addr })).message, addr).not.toMatch(NOT_BUILT);
    }
  });
});

describe('paymentPullCodeOf: gRPC 상태 번호 → 실패 코드', () => {
  test.each(Array.from({ length: 16 }, (_, i) => [i + 1, GRPC_STATUS_NAMES[i + 1]!] as const))('번호 %i → %s(grpc-js status 이름과 같다)', (code, name) => {
    expect(paymentPullCodeOf(code)).toBe(name);
    expect((grpc.status as unknown as Record<string, number>)[name]).toBe(code);
  });

  test.each([0, 17, 99, -1])('번호 %i(OK·모르는 번호)는 UNKNOWN으로 접는다(실행기는 코드와 상관없이 다음 점검에 다시 묻는다) [ASVS v5.0.0-16.5.2]', (code) => {
    expect(paymentPullCodeOf(code)).toBe('UNKNOWN');
  });
});

describe('orderPaymentStatesOf: 받은 답 → 주문별 결제 원장 상태', () => {
  test('payments[]의 칸 이름을 바꾸고 enum 앞머리를 떼며(PAYMENT_STATUS_·PG_PROVIDER_), Money.krw → amount, Timestamp approved_at → approvedAtMs(밀리초), int64 event_seq → eventSeq로 차례 그대로 옮긴다. 다른 칸은 버린다 (ADR0140)', () => {
    const out = orderPaymentStatesOf({ payments: [wireState({ extra: 'x' }), wireState({ order_id: ORDER_B, status: 'PAYMENT_STATUS_ACCEPTED', approved_at: null, event_seq: 1 })] });
    expect(out).toEqual([
      { orderId: ORDER_ID, paymentId: PAYMENT_ID, pg: 'TOSS', status: 'APPROVED', amount: AMOUNT, approvedAtMs: APPROVED_AT_MS, eventKey: EVENT_KEY, eventSeq: 3 },
      { orderId: ORDER_B, paymentId: PAYMENT_ID, pg: 'TOSS', status: 'ACCEPTED', amount: AMOUNT, eventKey: EVENT_KEY, eventSeq: 1 },
    ]);
    expect(out[1]!.approvedAtMs).toBeUndefined();
    // 실패 범주 UNSPECIFIED는 칸 없음이다
    expect(out[0]!.failureCategory).toBeUndefined();
    expect(orderPaymentStatesOf({ payments: [] })).toEqual([]);
  });

  test('상태 여덟·결제사 셋·실패 범주 여섯을 앞머리 없이 옮기고, FAILED의 실패 범주를 싣는다', () => {
    for (const s of ['UNSPECIFIED', 'ACCEPTED', 'AWAITING_DEPOSIT', 'APPROVED', 'UNKNOWN', 'FAILED', 'PARTIAL_CANCELED', 'CANCELED']) {
      expect(orderPaymentStatesOf({ payments: [wireState({ status: `PAYMENT_STATUS_${s}` })] })[0]!.status, s).toBe(s);
    }
    for (const pg of ['TOSS', 'PORTONE', 'SIMULATOR']) expect(orderPaymentStatesOf({ payments: [wireState({ pg: `PG_PROVIDER_${pg}` })] })[0]!.pg, pg).toBe(pg);
    for (const f of ['CARD_DECLINED', 'USER_ABORTED', 'VALIDATION', 'EXPIRED', 'PG_ERROR', 'THROTTLED']) {
      const [x] = orderPaymentStatesOf({ payments: [wireState({ status: 'PAYMENT_STATUS_FAILED', approved_at: null, failure_category: `FAILURE_CATEGORY_${f}` })] });
      expect(x, f).toMatchObject({ status: 'FAILED', failureCategory: f });
    }
  });

  test('모르는 상태는 UNSPECIFIED, 모르는·빠진 결제사와 실패 범주는 칸 없음, 금액·순번이 수가 아니면 NaN, event_key가 글이 아니면 빈 글이다(그 주문만 도메인이 IGNORE MALFORMED로 본다)', () => {
    const [x] = orderPaymentStatesOf({
      payments: [wireState({ status: 'PAYMENT_STATUS_BOGUS', pg: 'PG_PROVIDER_UNSPECIFIED', failure_category: 'FAILURE_CATEGORY_BOGUS', amount: null, event_seq: 'x', event_key: 7 })],
    });
    expect(x!.status).toBe('UNSPECIFIED');
    expect(x!.pg).toBeUndefined();
    expect(x!.failureCategory).toBeUndefined();
    expect(Number.isNaN(x!.amount)).toBe(true);
    expect(Number.isNaN(x!.eventSeq)).toBe(true);
    expect(x!.eventKey).toBe('');
    const [y] = orderPaymentStatesOf({ payments: [wireState({ pg: 'PG_PROVIDER_KAKAO' })] });
    expect(y!.pg).toBeUndefined();
    expect(y!.status).toBe('APPROVED');
  });

  test.each<[string, Record<string, unknown>]>([
    ['payments 칸 없음', {}],
    ['payments가 배열이 아님(글)', { payments: 'x' }],
    ['payments가 null', { payments: null }],
    ['항목이 객체가 아님', { payments: ['x'] }],
    ['항목이 null', { payments: [null] }],
    ['order_id가 글이 아님', { payments: [wireState({ order_id: 1 })] }],
    ['order_id 없음', { payments: [wireState({ order_id: undefined })] }],
  ])('%s이면 PaymentPullCallError BAD_ANSWER를 던진다(어느 주문의 답인지 몰라 묶음 전체가 실패다) (ADR0140)', (_name, v) => {
    const err = thrownBy(() => orderPaymentStatesOf(v));
    expect(err).toBeInstanceOf(PaymentPullCallError);
    expect((err as PaymentPullCallError).code).toBe('BAD_ANSWER');
  });
});

describe('GrpcPaymentResultReader: 차단기·데드라인·예외 → 실패 코드', () => {
  test('상수: 데드라인 상한 500ms(실행기 데드라인과 같다)·차단기 의존 이름 payment-svc-batch(승인 명령의 payment-svc 차단기와 따로)·한 번에 100건 (ADR0140)', () => {
    expect([PAYMENT_PULL_CAP_MS, PAYMENT_PULL_DEADLINE_MS]).toEqual([500, 500]);
    expect(PAYMENT_PULL_BREAKER).toBe('payment-svc-batch');
    expect(PAYMENT_PULL_BREAKER).not.toBe('payment-svc');
    expect(PAYMENT_PULL_BATCH).toBe(100);
  });

  test('빈 배열이면 부르지 않고 []다(차단기도 거치지 않는다)', async () => {
    const runs: unknown[] = [];
    const c = new GrpcPaymentResultReader({ address: ADDR, breaker: refusing(dependencyUnavailable(5), runs) });
    try {
      expect(await c.batchGet([])).toEqual([]);
      expect(runs).toEqual([]);
    } finally {
      c.close();
    }
  });

  test('100건을 넘으면 부르지 않고 RangeError다(부르는 쪽이 나눠 부른다. payment-svc는 INVALID_ARGUMENT) (ADR0140)', async () => {
    const runs: unknown[] = [];
    const c = new GrpcPaymentResultReader({ address: ADDR, breaker: refusing(dependencyUnavailable(5), runs) });
    try {
      const ids = Array.from({ length: 101 }, (_, i) => `0190f3a1-7c2e-7f00-8000-${(0x300000 + i).toString(16).padStart(12, '0')}`);
      await expect(c.batchGet(ids)).rejects.toBeInstanceOf(RangeError);
      expect(runs).toEqual([]);
    } finally {
      c.close();
    }
  });

  test.each<[string, () => unknown, string]>([
    ['차단기 열림(503 dependency-unavailable)', () => dependencyUnavailable(5), 'CIRCUIT_OPEN'],
    ['동시 호출 상한(429 server-busy)', () => serverBusy(), 'RESOURCE_EXHAUSTED'],
    ['남은 시간 없음(504 deadline-exceeded)', () => deadlineExceeded(), 'DEADLINE_EXCEEDED'],
    ['gRPC가 아닌 예외(TypeError)', () => new TypeError('Cannot read properties of undefined'), 'UNKNOWN'],
  ])('%s면 부르지 않고 PaymentPullCallError %s다(실행기는 지표만 센다) (ADR0140) [ASVS v5.0.0-16.5.2]', async (_name, err, code) => {
    const runs: unknown[] = [];
    const c = new GrpcPaymentResultReader({ address: ADDR, breaker: refusing(err(), runs) });
    try {
      const e = await callErrorOf(c.batchGet([ORDER_ID]));
      expect(e.code).toBe(code);
      expect(runs).toHaveLength(1);
      // 오류 글에 주문 ID는 싣지 않는다(코드만)
      expect(e.message).not.toContain(ORDER_ID);
      expect(e.message).toContain(code);
    } finally {
      c.close();
    }
  });

  test('주소가 host:port 모양이 아니면 만들 때 던진다', () => {
    for (const address of ['payment-svc', ':50051', 'payment-svc:0']) {
      expect(thrownBy(() => new GrpcPaymentResultReader({ address })).message, address).not.toMatch(NOT_BUILT);
    }
  });

  test('아무도 듣지 않는 주소면 DEADLINE_EXCEEDED나 UNAVAILABLE이다 [ASVS v5.0.0-16.5.2]', async () => {
    const c = new GrpcPaymentResultReader({ address: '127.0.0.1:1' });
    try {
      const e = await callErrorOf(c.batchGet([ORDER_ID], { deadlineMs: 50 }));
      expect(['DEADLINE_EXCEEDED', 'UNAVAILABLE']).toContain(e.code);
    } finally {
      c.close();
    }
  });
});

/** 같은 프로세스의 가짜 payment-svc(PaymentService.BatchGetPayments만). answer가 답(객체) 또는 gRPC 오류({ error })를 정한다 */
async function fakePaymentServer(
  answer: (req: Record<string, unknown>) => Promise<Record<string, unknown> | { error: grpc.status }> | Record<string, unknown> | { error: grpc.status },
) {
  const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
  const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: { PaymentService: grpc.ServiceClientConstructor } } } }).peaket.payment.v1;
  const server = new grpc.Server();
  const requests: Record<string, unknown>[] = [];
  server.addService(pkg.PaymentService.service, {
    BatchGetPayments: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
      requests.push(call.request);
      void Promise.resolve(answer(call.request)).then((a) => {
        if ('error' in a) cb({ code: a.error as grpc.status, details: 'fake payment-svc' });
        else cb(null, a);
      });
    },
  });
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))),
  );
  return { address: `127.0.0.1:${port}`, requests, close: () => server.forceShutdown() };
}

describe('GrpcPaymentResultReader와 가짜 payment-svc', () => {
  test('요청은 order_ids(묻는 차례 그대로)뿐이고, 답의 payments를 도메인 모양으로 돌려준다(기록 없는 주문은 답에 없다) (P-T47, ADR0140)', async () => {
    const srv = await fakePaymentServer(() => ({ payments: [wireState()] }));
    const c = new GrpcPaymentResultReader({ address: srv.address });
    try {
      const out = await c.batchGet([ORDER_B, ORDER_ID]);
      expect(out).toEqual([{ orderId: ORDER_ID, paymentId: PAYMENT_ID, pg: 'TOSS', status: 'APPROVED', amount: AMOUNT, approvedAtMs: APPROVED_AT_MS, eventKey: EVENT_KEY, eventSeq: 3 }]);
      expect(srv.requests).toEqual([{ order_ids: [ORDER_B, ORDER_ID] }]);
    } finally {
      srv.close();
      c.close();
    }
  });

  test('실패 범주가 있는 FAILED 답·approved_at이 빠진 답도 옮긴다(proto 기본값)', async () => {
    const srv = await fakePaymentServer(() => ({
      payments: [{ order_id: ORDER_ID, payment_id: PAYMENT_ID, pg: 'PG_PROVIDER_PORTONE', status: 'PAYMENT_STATUS_FAILED', amount: { krw: 1000 }, failure_category: 'FAILURE_CATEGORY_USER_ABORTED', event_key: 'ek-2', event_seq: 7 }],
    }));
    const c = new GrpcPaymentResultReader({ address: srv.address });
    try {
      const [x] = await c.batchGet([ORDER_ID]);
      expect(x).toEqual({ orderId: ORDER_ID, paymentId: PAYMENT_ID, pg: 'PORTONE', status: 'FAILED', amount: 1000, failureCategory: 'USER_ABORTED', eventKey: 'ek-2', eventSeq: 7 });
      expect(x!.approvedAtMs).toBeUndefined();
    } finally {
      srv.close();
      c.close();
    }
  });

  test.each<[grpc.status, string]>([
    [grpc.status.UNAVAILABLE, 'UNAVAILABLE'],
    [grpc.status.INVALID_ARGUMENT, 'INVALID_ARGUMENT'],
    [grpc.status.RESOURCE_EXHAUSTED, 'RESOURCE_EXHAUSTED'],
    [grpc.status.INTERNAL, 'INTERNAL'],
    [grpc.status.UNIMPLEMENTED, 'UNIMPLEMENTED'],
  ])('payment-svc가 gRPC 상태 %i로 답하면 PaymentPullCallError(%s)이고 다시 묻지 않는다(다시 묻기는 실행기의 다음 점검이다) (ADR0140) [ASVS v5.0.0-16.5.2]', async (status, code) => {
    const srv = await fakePaymentServer(() => ({ error: status }));
    const c = new GrpcPaymentResultReader({ address: srv.address });
    try {
      const e = await callErrorOf(c.batchGet([ORDER_ID]));
      expect(e.code).toBe(code);
      expect(srv.requests).toHaveLength(1);
      expect(e.message).not.toContain(ORDER_ID);
    } finally {
      srv.close();
      c.close();
    }
  });

  test('데드라인 안에 답하지 않으면 DEADLINE_EXCEEDED다(데드라인 = o.deadlineMs) [ASVS v5.0.0-16.5.2]', async () => {
    const srv = await fakePaymentServer(async () => {
      await new Promise((r) => setTimeout(r, 300));
      return { payments: [] };
    });
    const c = new GrpcPaymentResultReader({ address: srv.address });
    try {
      const e = await callErrorOf(c.batchGet([ORDER_ID], { deadlineMs: 50 }));
      expect(e.code).toBe('DEADLINE_EXCEEDED');
    } finally {
      srv.close();
      c.close();
    }
  });

  test('데드라인을 500ms보다 길게 줘도 상한 500ms로 자른다: 1.5초 걸리는 답은 DEADLINE_EXCEEDED이고 1.2초 안에 끝난다 (ADR0140) [ASVS v5.0.0-16.5.2]', async () => {
    const srv = await fakePaymentServer(async () => {
      await new Promise((r) => setTimeout(r, 1500));
      return { payments: [] };
    });
    const c = new GrpcPaymentResultReader({ address: srv.address });
    try {
      const started = Date.now();
      const e = await callErrorOf(c.batchGet([ORDER_ID], { deadlineMs: 5000 }));
      expect(e.code).toBe('DEADLINE_EXCEEDED');
      expect(Date.now() - started).toBeLessThan(1200);
    } finally {
      srv.close();
      c.close();
    }
  });
});

describe('당기기 전용 DB 풀과 DrizzlePaymentPull의 입력 검사(설계 4)', () => {
  test('당기기의 잡기·미루기는 핫패스 풀과 따로인 전용 일반 풀(profile general, 연결 2개 [가정], 이름 purchase-svc-payment-pull)을 쓴다. 주소는 받은 그대로다 (ADR0140) [ASVS v5.0.0-16.5.2]', () => {
    const url = 'postgres://purchase:secret@db.internal:5432/purchase';
    expect(paymentPullDatabaseOptions(url)).toEqual({ url, profile: 'general', max: 2, applicationName: 'purchase-svc-payment-pull' });
  });

  /** transaction에 넘긴 선택값을 적고 바로 멈추는 Database 대역(DB에 가지 않는다). db.execute를 부르면 적는다 */
  function recordingDb() {
    const seen: (TransactionOptions | undefined)[] = [];
    const direct: unknown[] = [];
    const db = {
      db: {
        execute: async (q: unknown) => {
          direct.push(q);
          throw new Error('stop');
        },
      },
      pool: undefined,
      close: async () => {},
      transaction: async (_fn: unknown, o?: TransactionOptions) => {
        seen.push(o);
        throw new Error('stop');
      },
    } as unknown as Database;
    return { db, seen, direct };
  }
  const clock = fakeClock({ now: NOW });

  test('claimDue는 READ COMMITTED·문장 시간 한도 5초 [가정]의 짧은 트랜잭션 하나다(요청 밖이다) [ASVS v5.0.0-2.3.4]', async () => {
    const { db, seen } = recordingDb();
    await expect(new DrizzlePaymentPull({ database: db, clock }).claimDue(100)).rejects.toThrow('stop');
    expect(seen).toEqual([{ isolationLevel: 'read committed', statementTimeoutMs: SAGA_STATEMENT_TIMEOUT_MS }]);
    expect(SAGA_STATEMENT_TIMEOUT_MS).toBe(5000);
  });

  test.each([0, -1, 1.5, Number.NaN, PAYMENT_PULL_BATCH + 1])('claimDue(%s): limit이 1 ~ 100의 정수가 아니면 RangeError이고 DB에 가지 않는다 [ASVS v5.0.0-2.3.4]', async (limit) => {
    const { db, seen, direct } = recordingDb();
    await expect(new DrizzlePaymentPull({ database: db, clock }).claimDue(limit)).rejects.toBeInstanceOf(RangeError);
    expect([seen, direct]).toEqual([[], []]);
  });

  test('defer: 빈 목록이거나 소문자 UUID가 아닌 ID만 있으면 DB에 가지 않고 0이다', async () => {
    const { db, seen, direct } = recordingDb();
    const pull = new DrizzlePaymentPull({ database: db, clock });
    expect(await pull.defer([], NOW + 60_000)).toBe(0);
    expect(await pull.defer(['not-a-uuid', ORDER_ID.toUpperCase(), "x' or 1=1 --"], NOW + 60_000)).toBe(0);
    expect([seen, direct]).toEqual([[], []]);
  });

  test.each([Number.NaN, 8.64e15 + 1, '2026-11-05' as unknown as number])('defer(ids, %s): untilMs가 날짜(유닉스 밀리초)가 아니면 RangeError이고 DB에 가지 않는다', async (untilMs) => {
    const { db, seen, direct } = recordingDb();
    await expect(new DrizzlePaymentPull({ database: db, clock }).defer([ORDER_ID], untilMs)).rejects.toBeInstanceOf(RangeError);
    expect([seen, direct]).toEqual([[], []]);
  });
});

describe('PromPaymentPullSignals(설계 8, ADR-0140 결정 4)', () => {
  /** 노출 글에서 이름이 name인 표본 줄(이름표가 있으면 그대로 남는다) */
  async function sampleLines(registry: Registry, name: string): Promise<string[]> {
    return (await registry.metrics()).split('\n').filter((l) => l.startsWith(`${name} `) || l.startsWith(`${name}{`));
  }

  test('register는 세 지표를 서비스 레지스트리에 붙이고 자신을 돌려준다. pulled_total{type}은 네 종류가 처음부터 0으로 보인다(경보식이 처음 당기기 전에도 값을 본다) (ADR0140)', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromPaymentPullSignals();
    expect(prom.register(metrics.registry)).toBe(prom);
    const text = await metrics.registry.metrics();
    for (const name of ['payment_result_pulled_total', 'payment_result_pull_failures_total', 'payment_result_pull_batches_total']) {
      expect(text, name).toContain(`# TYPE ${name} counter`);
      expect(text, name).toContain(`# HELP ${name} `);
    }
    expect((await sampleLines(metrics.registry, 'payment_result_pulled_total')).sort()).toEqual(
      ['APPROVED', 'AWAITING_DEPOSIT', 'FAILED', 'UNKNOWN'].map((t) => `payment_result_pulled_total{type="${t}"} 0`),
    );
  });

  test('pulled는 그 type을 1 올리고, 모르는 값은 버려 이름표 수가 늘지 않는다(던지지 않는다) (ADR0140)', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromPaymentPullSignals().register(metrics.registry);
    s.pulled('APPROVED');
    s.pulled('APPROVED');
    s.pulled('UNKNOWN');
    expect(() => s.pulled('CANCELED' as never)).not.toThrow();
    const lines = await sampleLines(metrics.registry, 'payment_result_pulled_total');
    expect(lines).toContain('payment_result_pulled_total{type="APPROVED"} 2');
    expect(lines).toContain('payment_result_pulled_total{type="UNKNOWN"} 1');
    expect(lines).toHaveLength(4);
    expect(lines.join('\n')).not.toContain('CANCELED');
  });

  test('batch는 부른 수, failure는 실패 수를 1씩 올린다(이름표 없음) (ADR0140) [ASVS v5.0.0-16.5.2]', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromPaymentPullSignals().register(metrics.registry);
    s.batch();
    s.batch();
    s.batch();
    s.failure();
    expect(await sampleLines(metrics.registry, 'payment_result_pull_batches_total')).toEqual(['payment_result_pull_batches_total 3']);
    expect(await sampleLines(metrics.registry, 'payment_result_pull_failures_total')).toEqual(['payment_result_pull_failures_total 1']);
  });

  test('붙이기 전에 불러도 던지지 않고, 두 번 만든 신호가 서로의 레지스트리를 더럽히지 않는다', async () => {
    const loose = new PromPaymentPullSignals();
    expect(() => {
      loose.pulled('APPROVED');
      loose.batch();
      loose.failure();
    }).not.toThrow();
    const a = new PlatformMetrics('purchase-svc');
    const b = new PlatformMetrics('purchase-svc');
    const sa = new PromPaymentPullSignals().register(a.registry);
    new PromPaymentPullSignals().register(b.registry);
    sa.failure();
    sa.failure();
    expect(await sampleLines(a.registry, 'payment_result_pull_failures_total')).toEqual(['payment_result_pull_failures_total 2']);
    expect(await sampleLines(b.registry, 'payment_result_pull_failures_total')).not.toContain('payment_result_pull_failures_total 2');
  });
});
