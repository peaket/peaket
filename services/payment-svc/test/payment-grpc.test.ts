// gRPC PaymentService 받는 층(docs/api/proto/peaket/payment/v1/payment.proto, docs/features/payment.md §2 '승인 명령 접수의 첫 구현', BUILD_ORDER PRF-180).
// 실제 grpc-js 서버를 루프백에 띄우고 계약 설명자로 만든 클라이언트로 부른다(identity.grpc.test.ts와 같은 꼴). 칸 이름·enum 앞머리·Timestamp는 선을 지난 값으로 본다.
// 실제 PostgreSQL까지 잇는 것은 test-int가 본다.
import * as grpc from '@grpc/grpc-js';
import { fakeClock } from '@peaket/platform';
import { afterEach, describe, expect, test } from 'vitest';
import { AcceptPaymentCommand } from '../src/modules/payment/application/accept-payment-command.js';
import { type ConfirmAnswer, type ConfirmPaymentInput, PAYMENT_LEDGER_STATUSES, PaymentCommandMismatchError, PaymentDeadlineError, PaymentInputError, type PaymentState } from '../src/modules/payment/domain/confirm-command.js';
import { type PaymentGrpcUseCases, paymentPackage, paymentServiceHandlers } from '../src/modules/payment/inbound/payment.grpc.js';
import { startGrpcServer } from '../src/grpc-server.js';
import {
  ATTEMPT_ID,
  AUTHENTICATED_AT,
  EVENT_ID,
  FakeCommandLog,
  FakeCommandStore,
  FakeSignals,
  NOW,
  ORDER_ID,
  OTHER_ATTEMPT_ID,
  PAYMENT_ID,
  SECRET_PAYMENT_KEY,
  SECRET_PAYMENT_TOKEN,
  stateOf,
  TX_ID,
  uuidAt,
} from './confirm-cases.js';

type Message = Record<string, unknown>;
type Cb = (e: grpc.ServiceError | null, v?: Message) => void;
type Unary = (req: Message, md: grpc.Metadata, opts: grpc.CallOptions, cb: Cb) => void;
const RPCS = ['ConfirmPayment', 'BatchGetPayments', 'PrepareCheckout', 'GetPayment', 'CancelPayment', 'RegisterPayoutSeller', 'ApprovePayoutBatch', 'GetNewPaymentPause'] as const;
type Client = grpc.Client & Record<(typeof RPCS)[number], Unary>;

const ANSWER: ConfirmAnswer = { result: 'IN_PROGRESS', paymentId: PAYMENT_ID };
/** 승인 시각의 선 위 모양(초·나노초). 밀리초 값과 짝이다 */
const APPROVED_MS = 1_794_200_000_123;
const APPROVED_TS = { seconds: 1_794_200_000, nanos: 123_000_000 };
const AUTH_TS = { seconds: Math.floor(AUTHENTICATED_AT / 1000), nanos: (AUTHENTICATED_AT % 1000) * 1_000_000 };

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((c) => c()));
});

/** 처리기를 루프백 서버에 올리고 클라이언트를 돌려준다 */
async function serve(useCases: Partial<PaymentGrpcUseCases> = {}) {
  const inputs: ConfirmPaymentInput[] = [];
  const batchInputs: string[][] = [];
  const errors: [string, unknown][] = [];
  const handlers = paymentServiceHandlers(
    {
      accept: useCases.accept ?? {
        execute: async (input) => {
          inputs.push(input);
          return ANSWER;
        },
      },
      batchGet: useCases.batchGet ?? {
        execute: async (ids) => {
          batchInputs.push([...ids]);
          return [];
        },
      },
    },
    (method, err) => errors.push([method, err]),
  );
  const server = await startGrpcServer({ host: '127.0.0.1', port: 0, services: [{ definition: paymentPackage().PaymentService.service, handlers }] });
  const client = new (paymentPackage().PaymentService)(`127.0.0.1:${server.port}`, grpc.credentials.createInsecure()) as unknown as Client;
  closers.push(async () => {
    client.close();
    await server.close();
  });
  const call = (rpc: (typeof RPCS)[number], req: Message) =>
    new Promise<Message>((res, rej) => client[rpc](req, new grpc.Metadata(), { deadline: Date.now() + 5_000 }, (e, v) => (e ? rej(e) : res(v!))));
  return { call, server, inputs, batchInputs, errors };
}

const failureOf = async (p: Promise<unknown>): Promise<{ code: string; details: string }> => {
  try {
    await p;
  } catch (e) {
    const err = e as grpc.ServiceError;
    return { code: grpc.status[err.code]!, details: err.details };
  }
  return { code: 'OK', details: '' };
};

const tossRequest = (over: Message = {}): Message => ({
  order_id: ORDER_ID,
  attempt_id: ATTEMPT_ID,
  attempt_no: 1,
  event_id: EVENT_ID,
  pg: 'PG_PROVIDER_TOSS',
  toss: { payment_key: SECRET_PAYMENT_KEY },
  amount: { krw: 55_000 },
  authenticated_at: AUTH_TS,
  ...over,
});

const throwing = (err: unknown): Partial<PaymentGrpcUseCases> => ({
  accept: {
    execute: async () => {
      throw err;
    },
  },
  batchGet: {
    execute: async () => {
      throw err;
    },
  },
});

describe('ConfirmPayment: 요청 → 쓰임새 입력', () => {
  test('P-T53_토스 요청의 칸을 입력으로 바꾼다(앞머리 PG_PROVIDER_ 떼기, Money.krw, Timestamp → 밀리초) [ASVS v5.0.0-2.2.1]', async () => {
    const s = await serve();
    await s.call('ConfirmPayment', tossRequest());
    expect(s.inputs).toEqual([
      {
        orderId: ORDER_ID,
        attemptId: ATTEMPT_ID,
        attemptNo: 1,
        eventId: EVENT_ID,
        pg: 'TOSS',
        paymentRef: { kind: 'toss', paymentKey: SECRET_PAYMENT_KEY },
        amount: 55_000,
        authenticatedAtMs: AUTHENTICATED_AT,
      },
    ]);
  });

  test('P-T53_Timestamp의 나노초를 밀리초로 더한다', async () => {
    const s = await serve();
    await s.call('ConfirmPayment', tossRequest({ authenticated_at: APPROVED_TS }));
    expect(s.inputs[0]!.authenticatedAtMs).toBe(APPROVED_MS);
  });

  test('P-T53_포트원 요청은 portone 칸을 참조로 바꾼다 [ASVS v5.0.0-2.2.3]', async () => {
    const s = await serve();
    const { toss: _toss, ...rest } = tossRequest({ pg: 'PG_PROVIDER_PORTONE' });
    await s.call('ConfirmPayment', { ...rest, portone: { payment_id: `pay-${ORDER_ID}`, tx_id: TX_ID, payment_token: SECRET_PAYMENT_TOKEN } });
    expect(s.inputs[0]!.pg).toBe('PORTONE');
    expect(s.inputs[0]!.paymentRef).toEqual({ kind: 'portone', paymentId: `pay-${ORDER_ID}`, txId: TX_ID, paymentToken: SECRET_PAYMENT_TOKEN });
  });

  test('P-T53_시뮬레이터 요청은 pg만 SIMULATOR이고 toss 칸을 쓴다 [ASVS v5.0.0-2.2.3]', async () => {
    const s = await serve();
    await s.call('ConfirmPayment', tossRequest({ pg: 'PG_PROVIDER_SIMULATOR' }));
    expect(s.inputs[0]!.pg).toBe('SIMULATOR');
    expect(s.inputs[0]!.paymentRef).toEqual({ kind: 'toss', paymentKey: SECRET_PAYMENT_KEY });
  });

  test('P-T53_빈 요청은 정해진 빈 값으로 넘긴다(검사는 쓰임새가 한다) [ASVS v5.0.0-2.2.1]', async () => {
    const s = await serve();
    await s.call('ConfirmPayment', {});
    expect(s.inputs).toEqual([{ orderId: '', attemptId: '', attemptNo: 0, eventId: '', pg: 'UNSPECIFIED', amount: Number.NaN }]);
    expect(s.inputs[0]!.paymentRef).toBeUndefined();
    expect(s.inputs[0]!.authenticatedAtMs).toBeUndefined();
  });
});

describe('ConfirmPayment: 답 → 응답', () => {
  const answered = async (answer: ConfirmAnswer) => (await serve({ accept: { execute: async () => answer } })).call('ConfirmPayment', tossRequest());

  test('P-T53_IN_PROGRESS는 CONFIRM_RESULT_IN_PROGRESS와 결제 ID이고 승인 시각·실패 범주가 비어 있다', async () => {
    const r = await answered(ANSWER);
    expect(r.result).toBe('CONFIRM_RESULT_IN_PROGRESS');
    expect(r.payment_id).toBe(PAYMENT_ID);
    expect(r.approved_at ?? null).toBeNull();
    expect(r.failure_category).toBe('FAILURE_CATEGORY_UNSPECIFIED');
  });

  test('P-T53_APPROVED는 승인 시각을 Timestamp로 싣는다', async () => {
    const r = await answered({ result: 'APPROVED', paymentId: PAYMENT_ID, approvedAtMs: APPROVED_MS });
    expect(r.result).toBe('CONFIRM_RESULT_APPROVED');
    expect(r.approved_at).toMatchObject(APPROVED_TS);
  });

  test('P-T53_DECLINED는 실패 범주를 앞머리 붙여 싣는다', async () => {
    const r = await answered({ result: 'DECLINED', paymentId: PAYMENT_ID, failureCategory: 'CARD_DECLINED' });
    expect(r.result).toBe('CONFIRM_RESULT_DECLINED');
    expect(r.failure_category).toBe('FAILURE_CATEGORY_CARD_DECLINED');
  });

  test('P-T53_WAITING_FOR_DEPOSIT을 그대로 바꾼다', async () => {
    expect((await answered({ result: 'WAITING_FOR_DEPOSIT', paymentId: PAYMENT_ID })).result).toBe('CONFIRM_RESULT_WAITING_FOR_DEPOSIT');
  });
});

describe('BatchGetPayments: 요청과 응답', () => {
  test('P-T54_order_ids를 그대로 넘긴다', async () => {
    const s = await serve();
    await s.call('BatchGetPayments', { order_ids: [ORDER_ID, uuidAt(1)] });
    expect(s.batchInputs).toEqual([[ORDER_ID, uuidAt(1)]]);
  });

  test('P-T54_빈 요청도 쓰임새에 넘겨 검사받는다 [ASVS v5.0.0-2.2.1]', async () => {
    const s = await serve();
    await s.call('BatchGetPayments', {});
    expect(s.batchInputs).toEqual([[]]);
  });

  const stated = async (states: PaymentState[]) => (await serve({ batchGet: { execute: async () => states } })).call('BatchGetPayments', { order_ids: [ORDER_ID] });

  test('P-T54_P-T15_수출 사건이 있으면 event_key·event_seq를 그 값으로 싣는다 (ADR0140)', async () => {
    const eventKey = uuidAt(77);
    const r = await stated([stateOf({ status: 'APPROVED', approvedAtMs: APPROVED_MS, lastEvent: { eventKey, eventSeq: 3 } })]);
    expect(r.payments).toEqual([
      expect.objectContaining({
        order_id: ORDER_ID,
        payment_id: PAYMENT_ID,
        pg: 'PG_PROVIDER_TOSS',
        status: 'PAYMENT_STATUS_APPROVED',
        amount: expect.objectContaining({ krw: 55_000 }),
        approved_at: expect.objectContaining(APPROVED_TS),
        failure_category: 'FAILURE_CATEGORY_UNSPECIFIED',
        event_key: eventKey,
        event_seq: 3,
      }),
    ]);
  });

  test('P-T54_수출 사건이 없으면 event_key·event_seq가 비어 있다 (ADR0140)', async () => {
    const r = await stated([stateOf()]);
    expect((r.payments as Message[])[0]).toMatchObject({ status: 'PAYMENT_STATUS_ACCEPTED', event_key: '', event_seq: 0 });
    expect((r.payments as Message[])[0]!.approved_at ?? null).toBeNull();
  });

  test('P-T54_실패 범주를 앞머리 붙여 싣는다', async () => {
    const r = await stated([stateOf({ status: 'FAILED', failureCategory: 'PG_ERROR', lastEvent: { eventKey: uuidAt(78), eventSeq: 2 } })]);
    expect((r.payments as Message[])[0]).toMatchObject({ status: 'PAYMENT_STATUS_FAILED', failure_category: 'FAILURE_CATEGORY_PG_ERROR' });
  });

  test('P-T47_큰 순번도 숫자로 온다(int64)', async () => {
    const r = await stated([stateOf({ lastEvent: { eventKey: uuidAt(79), eventSeq: 9_007_199_254 } })]);
    expect((r.payments as Message[])[0]!.event_seq).toBe(9_007_199_254);
  });

  test.each(PAYMENT_LEDGER_STATUSES)('P-T54_원장 상태 %s를 PaymentStatus로 바꾼다', async (status) => {
    const r = await stated([stateOf({ status })]);
    expect((r.payments as Message[])[0]!.status).toBe(`PAYMENT_STATUS_${status}`);
  });

  test.each(['TOSS', 'PORTONE', 'SIMULATOR'] as const)('P-T54_결제사 %s를 PgProvider로 바꾼다', async (pg) => {
    const r = await stated([stateOf({ pg })]);
    expect((r.payments as Message[])[0]!.pg).toBe(`PG_PROVIDER_${pg}`);
  });

  test('P-T54_결과가 없으면 빈 목록이다', async () => {
    expect((await stated([])).payments).toEqual([]);
  });
});

describe('오류 → gRPC 상태', () => {
  const RPC_CASES = [
    ['ConfirmPayment', tossRequest()],
    ['BatchGetPayments', { order_ids: [ORDER_ID] }],
  ] as const;

  test.each(RPC_CASES)('P-T53_%s의 PaymentInputError는 INVALID_ARGUMENT다 [ASVS v5.0.0-2.2.1]', async (rpc, req) => {
    const s = await serve(throwing(new PaymentInputError('order_id')));
    const f = await failureOf(s.call(rpc, req));
    expect(f.code).toBe('INVALID_ARGUMENT');
    expect(f.details).toContain('order_id');
    expect(s.errors).toEqual([]);
  });

  test('P-T53_PaymentCommandMismatchError는 FAILED_PRECONDITION이고 글에 주문 ID가 없다 [ASVS v5.0.0-2.2.3] [ASVS v5.0.0-16.2.5]', async () => {
    const s = await serve(throwing(new PaymentCommandMismatchError()));
    const f = await failureOf(s.call('ConfirmPayment', tossRequest()));
    expect(f.code).toBe('FAILED_PRECONDITION');
    expect(f.details).not.toContain(ORDER_ID);
    expect(s.errors).toEqual([]);
  });

  test.each(RPC_CASES)('P-T53_리뷰 고침 H3: %s의 SQL 오류(42P01)는 INTERNAL이고 글에 내부 정보가 없다, 이유는 onError로만 간다 [ASVS v5.0.0-16.2.5]', async (rpc, req) => {
    const err = Object.assign(new Error(`relation "payment" 실패 postgres://svc:hunter2@db/payment ${SECRET_PAYMENT_KEY}`), { code: '42P01' });
    const s = await serve(throwing(err));
    const f = await failureOf(s.call(rpc, req));
    expect(f.code).toBe('INTERNAL');
    for (const leak of ['relation', 'postgres://', 'hunter2', SECRET_PAYMENT_KEY]) expect(f.details).not.toContain(leak);
    expect(s.errors).toHaveLength(1);
    expect(s.errors[0]![0]).toContain(rpc);
    expect(s.errors[0]![1]).toBe(err);
  });

  test.each([
    ['연결 거부 ECONNREFUSED', { code: 'ECONNREFUSED' }],
    ['연결 끊김 ECONNRESET', { code: 'ECONNRESET' }],
    ['PostgreSQL 연결 예외 08006', { code: '08006' }],
    ['관리자 종료 57P01', { code: '57P01' }],
    ['원인에 있는 연결 거부', { cause: { code: 'ECONNREFUSED' } }],
  ])('PRF180_저장소에 닿지 못한 오류(%s)는 UNAVAILABLE이고 글에 내부 정보가 없다 [ASVS v5.0.0-16.2.5]', async (_name, fields) => {
    const s = await serve(throwing(Object.assign(new Error('connect 10.0.0.1:5432 실패'), fields)));
    const f = await failureOf(s.call('ConfirmPayment', tossRequest()));
    expect(f.code).toBe('UNAVAILABLE');
    expect(f.details).not.toContain('10.0.0.1');
  });

  const INNER = 'SECRET-STATEMENT postgres://svc:hunter2@10.0.0.1:5432/payment';

  /** Drizzle처럼 원인(cause)에 드라이버 오류를 단다 */
  const wrapped = (fields: object): Error => Object.assign(new Error(`Failed query: ${INNER}`), { cause: Object.assign(new Error(INNER), fields) });

  test.each([
    ['코드 없는 연결 끊김(Connection terminated unexpectedly)', new Error(`Connection terminated unexpectedly ${INNER}`)],
    ['코드 없는 연결 끊김(원인에 달림)', Object.assign(new Error(`Failed query: ${INNER}`), { cause: new Error('Connection terminated unexpectedly') })],
    ['읽기 전용 트랜잭션 25006(장애 조치 직후)', wrapped({ code: '25006' })],
    ['연결 수 초과 53300', wrapped({ code: '53300' })],
    ['디스크 부족 53100', wrapped({ code: '53100' })],
    ['잠금 시간 초과 55P03', wrapped({ code: '55P03' })],
    ['직렬화 실패 40001', wrapped({ code: '40001' })],
    ['풀 대기 초과(429 server-busy)', Object.assign(new Error('busy'), { status: 429 })],
  ])('P-T53_리뷰 고침 H3: 일시 오류(%s)는 UNAVAILABLE이고 글에 내부 정보가 없다, 이유는 onError로 간다 [ASVS v5.0.0-16.2.5]', async (_name, err) => {
    const s = await serve(throwing(err));
    const f = await failureOf(s.call('ConfirmPayment', tossRequest()));
    expect(f.code).toBe('UNAVAILABLE');
    for (const leak of ['SECRET-STATEMENT', 'postgres://', 'hunter2', '10.0.0.1']) expect(f.details).not.toContain(leak);
    expect(s.errors).toHaveLength(1);
  });

  test.each(RPC_CASES)('P-T53_리뷰 고침 H3: %s의 문장 시간 초과 57014는 DEADLINE_EXCEEDED다 [ASVS v5.0.0-16.2.5]', async (rpc, req) => {
    const s = await serve(throwing(wrapped({ code: '57014' })));
    const f = await failureOf(s.call(rpc, req));
    expect(f.code).toBe('DEADLINE_EXCEEDED');
    expect(f.details).not.toContain('SECRET-STATEMENT');
    expect(s.errors).toHaveLength(1);
  });

  test.each([
    ['문법·권한 42601', wrapped({ code: '42601' })],
    ['없는 칸 42703', wrapped({ code: '42703' })],
    ['제약 위반 23502', wrapped({ code: '23502' })],
    ['값 형식 22P02', wrapped({ code: '22P02' })],
    ['PL/pgSQL 예외 P0001', wrapped({ code: 'P0001' })],
    ['미지원 기능 0A000', wrapped({ code: '0A000' })],
    ['코드 결함 TypeError', new TypeError('x is not a function')],
    ['코드 결함 RangeError(원인에 달림)', Object.assign(new Error('실패'), { cause: new RangeError('범위') })],
  ])('P-T53_리뷰 고침 H3: 코드 오류로 보이는 것(%s)만 INTERNAL이다 [ASVS v5.0.0-16.2.5]', async (_name, err) => {
    const s = await serve(throwing(err));
    expect((await failureOf(s.call('ConfirmPayment', tossRequest()))).code).toBe('INTERNAL');
    expect(s.errors).toHaveLength(1);
  });

  test.each(['PrepareCheckout', 'GetPayment', 'CancelPayment', 'RegisterPayoutSeller', 'ApprovePayoutBatch', 'GetNewPaymentPause'] as const)('PRF180_구현하지 않은 %s는 UNIMPLEMENTED다', async (rpc) => {
    const s = await serve();
    expect((await failureOf(s.call(rpc, {}))).code).toBe('UNIMPLEMENTED');
    expect(s.errors).toEqual([]);
  });
});

describe('데드라인(docs/api/proto/README.md §2): 처리기를 서버 없이 바로 불러 남은 시간을 정확히 준다', () => {
  type Handler = grpc.handleUnaryCall<Message, object>;

  /** rpc 처리기를 getDeadline이 정해진 호출로 부른다. 쓰임새에 넘어간 예산과 답을 돌려준다 */
  async function direct(rpc: 'ConfirmPayment' | 'BatchGetPayments', deadline: grpc.Deadline) {
    const budgets: unknown[] = [];
    const errors: unknown[] = [];
    const record = async (_input: unknown, budget?: unknown) => {
      budgets.push(budget);
      return rpc === 'ConfirmPayment' ? ANSWER : [];
    };
    const handlers = paymentServiceHandlers({ accept: { execute: record as PaymentGrpcUseCases['accept']['execute'] }, batchGet: { execute: record as PaymentGrpcUseCases['batchGet']['execute'] } }, (_m, e) => errors.push(e));
    const request = rpc === 'ConfirmPayment' ? tossRequest() : { order_ids: [ORDER_ID] };
    const error = await new Promise<grpc.ServerErrorResponse | null>((resolve) => {
      (handlers[rpc] as Handler)({ request, getDeadline: () => deadline } as unknown as grpc.ServerUnaryCall<Message, object>, (e) => resolve(e as grpc.ServerErrorResponse | null));
    });
    return { budgets, error, errors };
  }

  test('P-T53_리뷰 고침 M4: ConfirmPayment는 남은 시간이 50ms [가정] 미만이면 시작하지 않고 DEADLINE_EXCEEDED다', async () => {
    const r = await direct('ConfirmPayment', new Date(Date.now() + 49));
    expect(r.error?.code).toBe(grpc.status.DEADLINE_EXCEEDED);
    expect(r.budgets).toEqual([]);
    expect(r.errors).toEqual([]);
  });

  test('P-T54_리뷰 고침 M4: BatchGetPayments는 남은 시간이 50ms [가정] 미만이면 시작하지 않고 DEADLINE_EXCEEDED다', async () => {
    const r = await direct('BatchGetPayments', Date.now() + 10);
    expect(r.error?.code).toBe(grpc.status.DEADLINE_EXCEEDED);
    expect(r.budgets).toEqual([]);
  });

  test('P-T53_리뷰 고침 M4: 이미 지난 데드라인도 시작하지 않는다', async () => {
    const r = await direct('ConfirmPayment', new Date(Date.now() - 1_000));
    expect(r.error?.code).toBe(grpc.status.DEADLINE_EXCEEDED);
    expect(r.budgets).toEqual([]);
  });

  test('P-T53_리뷰 고침 M4: 남은 시간이 넉넉하면 그 값을 쓰임새에 넘긴다', async () => {
    const r = await direct('ConfirmPayment', new Date(Date.now() + 180));
    expect(r.error).toBeNull();
    const { remainingMs } = r.budgets[0] as { remainingMs: number };
    expect(remainingMs).toBeGreaterThan(50);
    expect(remainingMs).toBeLessThanOrEqual(180);
  });

  test('P-T54_리뷰 고침 M4: 데드라인이 수(number)로 와도 남은 시간을 잰다', async () => {
    const r = await direct('BatchGetPayments', Date.now() + 300);
    expect(r.error).toBeNull();
    expect((r.budgets[0] as { remainingMs: number }).remainingMs).toBeLessThanOrEqual(300);
  });

  test('P-T53_리뷰 고침 M4: 데드라인 없는 호출(Infinity)은 시작하고 남은 시간도 Infinity다', async () => {
    const r = await direct('ConfirmPayment', Number.POSITIVE_INFINITY);
    expect(r.error).toBeNull();
    expect(r.budgets).toEqual([{ remainingMs: Number.POSITIVE_INFINITY }]);
  });

  test('P-T53_리뷰 고침 M4: 저장소가 낸 시간 모자람(PaymentDeadlineError)은 DEADLINE_EXCEEDED이고 글에 내부 정보가 없다', async () => {
    const s = await serve(throwing(new PaymentDeadlineError()));
    const f = await failureOf(s.call('ConfirmPayment', tossRequest()));
    expect(f.code).toBe('DEADLINE_EXCEEDED');
    expect(f.details).not.toContain('ms');
  });
});

describe('쓰임새까지 이어서', () => {
  async function real() {
    const store = new FakeCommandStore();
    const log = new FakeCommandLog();
    const signals = new FakeSignals();
    const accept = new AcceptPaymentCommand({ store, clock: fakeClock({ now: NOW }), log, signals });
    return { store, log, signals, ...(await serve({ accept })) };
  }

  test('P-T53_처음과 다시 보낸 같은 요청은 같은 답이고 한 번만 쓴다 [ASVS v5.0.0-2.3.4]', async () => {
    const s = await real();
    const first = await s.call('ConfirmPayment', tossRequest());
    const second = await s.call('ConfirmPayment', tossRequest());
    expect(first.result).toBe('CONFIRM_RESULT_IN_PROGRESS');
    expect(second).toEqual(first);
    expect(s.store.writes).toBe(1);
  });

  test.each([
    ['다른 결제 시도', { attempt_id: OTHER_ATTEMPT_ID }],
    ['다른 금액', { amount: { krw: 1 } }],
    ['다른 결제사', { pg: 'PG_PROVIDER_SIMULATOR' }],
  ])('P-T53_%s로 다시 부르면 FAILED_PRECONDITION이고 원장이 그대로다 [ASVS v5.0.0-2.3.4]', async (_name, over) => {
    const s = await real();
    await s.call('ConfirmPayment', tossRequest());
    const before = s.store.records.get(ORDER_ID);
    expect((await failureOf(s.call('ConfirmPayment', tossRequest(over)))).code).toBe('FAILED_PRECONDITION');
    expect(s.store.records.get(ORDER_ID)).toBe(before);
    expect(s.log.mismatches).toEqual([{ orderId: ORDER_ID }]);
  });

  test.each([
    ['UUID 모양', { order_id: 'nope' }],
    ['금액 0', { amount: { krw: 0 } }],
    ['금액 없음', { amount: null }],
    ['결제사와 맞지 않는 참조', { pg: 'PG_PROVIDER_PORTONE' }],
    ['결제사 미지정', { pg: 'PG_PROVIDER_UNSPECIFIED' }],
    ['인증 시각 없음', { authenticated_at: null }],
    ['시도 순번 없음', { attempt_no: 0 }],
  ])('P-T53_%s이면 INVALID_ARGUMENT이고 쓴 행이 없다 [ASVS v5.0.0-2.2.1]', async (_name, over) => {
    const s = await real();
    expect((await failureOf(s.call('ConfirmPayment', tossRequest(over)))).code).toBe('INVALID_ARGUMENT');
    expect(s.store.writes).toBe(0);
    expect(s.signals.confirm).toEqual(['invalid']);
  });

  test('P-T53_틀린 결제 키의 값이 gRPC 오류 글에 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const s = await real();
    const f = await failureOf(s.call('ConfirmPayment', tossRequest({ toss: { payment_key: `${SECRET_PAYMENT_KEY} ` } })));
    expect(f.code).toBe('INVALID_ARGUMENT');
    expect(f.details).not.toContain(SECRET_PAYMENT_KEY);
  });
});

describe('startGrpcServer', () => {
  test('PRF180_port 0이면 빈 포트를 잡아 돌려준다', async () => {
    const s = await serve();
    expect(s.server.port).toBeGreaterThan(0);
  });

  test('PRF180_close는 처리 중인 호출이 끝나기를 기다린다(SIGTERM의 우아한 종료)', async () => {
    let release: (a: ConfirmAnswer) => void = () => {};
    let started: () => void = () => {};
    const entered = new Promise<void>((res) => {
      started = res;
    });
    const s = await serve({
      accept: {
        execute: () =>
          new Promise<ConfirmAnswer>((res) => {
            release = res;
            started();
          }),
      },
    });
    const pending = s.call('ConfirmPayment', tossRequest());
    await entered;
    let closed = false;
    const closing = s.server.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(closed).toBe(false);
    release(ANSWER);
    expect((await pending).result).toBe('CONFIRM_RESULT_IN_PROGRESS');
    await closing;
    expect(closed).toBe(true);
  });
});
