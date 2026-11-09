// 가상계좌 입금 대기의 주문 쪽 규칙(docs/features/payment.md §6 '주문 쪽'·'결제 상태 응답', BUILD_ORDER HOT-151, P-T36).
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { paymentV1Payment } from '@peaket/contracts/proto';
import { fakeClock, ProblemError } from '@peaket/platform';
import { describe, expect, test, vi } from 'vitest';
import { depositInfoOf, GrpcPaymentDepositReader } from '../src/modules/booking/adapters/grpc-payment-deposit.js';
import { orderPaymentStatesOf } from '../src/modules/booking/adapters/grpc-payment-results.js';
import { LoggerPaymentResultLog } from '../src/modules/booking/adapters/order-log.js';
import {
  ApplyPaymentResult,
  type ApplyPaymentResultDeps,
  DEPOSIT_PENDING_GRACE_MS,
  depositPendingUntilMs,
  GetPaymentStatus,
  type OrderPaymentState,
  PAYMENT_DEPOSIT_READ_TRANSIENT,
  type PaymentDepositRead,
  type PaymentDepositReader,
  type PaymentMarkInput,
  type PaymentResultEvent,
  type PaymentStatusView,
  paymentStateToResultEvent,
} from '../src/modules/booking/index.js';
import { PaymentResultHandler } from '../src/modules/booking/inbound/payment-result.handler.js';

const ORDER = '0195f3a0-0000-7000-8000-000000000021';
const EVENT = '0195f3a0-0000-7000-8000-000000000022';
const ACCOUNT = '0195f3a0-0000-7000-8000-000000000023';
const SEAT = '0195f3a0-0000-7000-8000-000000000024';
const DUE = '2026-11-12T01:00:00.000Z';
const DUE_MS = Date.parse(DUE);
const NOW = Date.parse('2026-11-09T01:00:00.000Z');

const event = (o: Partial<PaymentResultEvent> = {}): PaymentResultEvent => ({
  eventId: EVENT,
  orderId: ORDER,
  pg: 'TOSS',
  type: 'AWAITING_DEPOSIT',
  amount: 5_000,
  refMissing: false,
  attemptNo: 1,
  occurredAt: new Date(NOW).toISOString(),
  eventSeq: 1,
  eventKey: '0195f3a0-0000-7000-8000-000000000029',
  depositDueAt: DUE,
  ...o,
});

function applying(status = 'RESERVED', log: Partial<ApplyPaymentResultDeps['log']> = {}) {
  const marks: PaymentMarkInput[] = [];
  const held = vi.fn();
  const apply = new ApplyPaymentResult({
    reads: { read: async () => ({ orderId: ORDER, status, amount: 5_000, paymentEventSeq: 0, acceptedPg: 'TOSS', eventId: EVENT, accountId: ACCOUNT, purchaseSessionId: 'sess', seatIds: [SEAT] }) as never },
    writes: {
      approve: async () => ({ status: 'APPLIED' }),
      fail: async () => ({ status: 'APPLIED' }),
      mark: async (i) => {
        marks.push(i);
        return { status: 'APPLIED' };
      },
    },
    sessions: { complete: async () => true, unmarkPaying: async () => true },
    saga: { kick: vi.fn() },
    log: { held, afterCommitFailed: vi.fn(), ...log },
    clock: fakeClock({ now: NOW }),
  });
  return { apply, marks };
}

describe('입금 대기 전이', () => {
  test('P-T36_판매 행 기한은 입금 기한 + 10분이다', () => {
    expect(depositPendingUntilMs(DUE)).toBe(DUE_MS + DEPOSIT_PENDING_GRACE_MS);
    expect(DEPOSIT_PENDING_GRACE_MS).toBe(600_000);
  });

  test.each([undefined, 'soon'])('P-T36_기한이 없거나 날짜가 아니면(%s) 판매 행 기한도 없다', (v) => {
    expect(depositPendingUntilMs(v)).toBeUndefined();
  });

  test('P-T36_T10은 판매 행 기한을 함께 쓴다', async () => {
    const h = applying();
    await h.apply.execute(event());
    expect(h.marks).toHaveLength(1);
    expect(h.marks[0]).toMatchObject({ transition: 'T10', depositPending: { eventId: EVENT, seatIds: [SEAT], pendingUntilMs: DUE_MS + DEPOSIT_PENDING_GRACE_MS } });
  });

  test('P-T36_T14도 판매 행 기한을 함께 쓴다', async () => {
    const h = applying('UNKNOWN');
    await h.apply.execute(event());
    expect(h.marks[0]).toMatchObject({ transition: 'T14', depositPending: { pendingUntilMs: DUE_MS + DEPOSIT_PENDING_GRACE_MS } });
  });

  test('P-T36_사건에 기한이 없으면 비워 두고 경고 한 줄이다', async () => {
    const depositDueMissing = vi.fn();
    const h = applying('RESERVED', { depositDueMissing });
    const { depositDueAt: _omit, ...rest } = event();
    await h.apply.execute(rest);
    expect(h.marks[0]).not.toHaveProperty('depositPending');
    expect(depositDueMissing).toHaveBeenCalledWith({ orderId: ORDER });
  });

  test('P-T36_T12에는 판매 행 기한이 없고 경고도 없다', async () => {
    const depositDueMissing = vi.fn();
    const h = applying('RESERVED', { depositDueMissing });
    const { depositDueAt: _omit, ...rest } = event({ type: 'UNKNOWN' });
    await h.apply.execute(rest);
    expect(h.marks[0]).toMatchObject({ transition: 'T12' });
    expect(h.marks[0]).not.toHaveProperty('depositPending');
    expect(depositDueMissing).not.toHaveBeenCalled();
  });

  test('P-T36_처리기는 사건의 입금 기한을 도메인 값으로 옮긴다', () => {
    const handler = new PaymentResultHandler({ execute: vi.fn() } as never);
    const value = Buffer.from(JSON.stringify({ ...event(), occurredAt: new Date(NOW).toISOString() }));
    const r = handler.decode({ topic: 'trade.payments', partition: 0, offset: 0n, key: EVENT, value, headers: {}, timestamp: NOW });
    expect(r).toMatchObject({ kind: 'event', event: { depositDueAt: DUE } });
  });

  test('P-T36_경고 줄은 주문 ID만 싣는다 [ASVS v5.0.0-16.2.5]', () => {
    const warn = vi.fn();
    new LoggerPaymentResultLog({ warn, error: vi.fn() }).depositDueMissing({ orderId: ORDER });
    expect(warn.mock.calls[0]![0]).toEqual({ kind: 'payment-result-deposit-due-missing', orderId: ORDER });
  });
});

describe('결과 당기기', () => {
  const state = (o: Partial<OrderPaymentState> = {}): OrderPaymentState => ({ orderId: ORDER, paymentId: 'p', pg: 'TOSS', status: 'AWAITING_DEPOSIT', amount: 5_000, eventKey: 'k', eventSeq: 2, depositDueAtMs: DUE_MS, ...o });
  const ctx = { eventId: EVENT, attemptNo: 1, confirmSentAtMs: NOW - 1_000, pulledAtMs: NOW };

  test('P-T36_입금 대기 답의 기한을 사건에 싣는다', () => {
    expect(paymentStateToResultEvent(state(), ctx)).toMatchObject({ kind: 'APPLY', event: { type: 'AWAITING_DEPOSIT', depositDueAt: DUE } });
  });

  test('P-T36_승인 답에는 기한을 싣지 않는다', () => {
    const d = paymentStateToResultEvent(state({ status: 'APPROVED', approvedAtMs: NOW }), ctx);
    expect(d).toMatchObject({ kind: 'APPLY', event: { type: 'APPROVED' } });
    expect((d as { event: PaymentResultEvent }).event).not.toHaveProperty('depositDueAt');
  });

  test('P-T36_기한 칸이 없으면 사건에도 없다', () => {
    const { depositDueAtMs: _omit, ...rest } = state();
    expect((paymentStateToResultEvent(rest, ctx) as { event: PaymentResultEvent }).event).not.toHaveProperty('depositDueAt');
  });

  test('P-T36_gRPC 답의 deposit_due_at을 옮긴다', () => {
    const [r] = orderPaymentStatesOf({ payments: [{ order_id: ORDER, payment_id: 'p', status: 'PAYMENT_STATUS_AWAITING_DEPOSIT', pg: 'PG_PROVIDER_TOSS', amount: { krw: 5_000 }, event_key: 'k', event_seq: 2, deposit_due_at: { seconds: Math.floor(DUE_MS / 1000), nanos: 0 } }] });
    expect(r!.depositDueAtMs).toBe(DUE_MS);
  });
});

describe('결제 상태 응답', () => {
  const view = (o: Partial<PaymentStatusView> = {}): PaymentStatusView => ({ orderId: ORDER, accountId: ACCOUNT, status: 'AWAITING_DEPOSIT', pg: 'TOSS', ...o });
  const useCase = (v: PaymentStatusView | undefined, deposits?: PaymentDepositReader) =>
    new GetPaymentStatus({ reads: { read: async () => v, readMany: async () => [] }, waiters: { wait: vi.fn() as never, notify: vi.fn() }, clock: fakeClock({ now: NOW }), ...(deposits ? { deposits } : {}) });
  const info = { bank: '20', accountNumber: '1234567890', dueAt: DUE };

  test('P-T36 ③_입금 대기면 은행·계좌번호·기한을 싣는다 [ASVS v5.0.0-8.2.2]', async () => {
    const read = vi.fn(async () => info);
    const r = await useCase(view(), { read }).execute({ accountId: ACCOUNT, orderId: ORDER });
    expect(r).toEqual({ status: 200, body: { status: 'AWAITING_DEPOSIT', issueDelayed: false, pg: 'TOSS', virtualAccount: info } });
    expect(read).toHaveBeenCalledWith(ORDER, { deadlineMs: 300 });
  });

  test('P-T36_읽지 못하면 계좌 칸 없이 답한다(주문 상태는 그대로다) [ASVS v5.0.0-16.5.3]', async () => {
    const r = await useCase(view(), { read: async () => undefined }).execute({ accountId: ACCOUNT, orderId: ORDER });
    expect(r).toEqual({ status: 200, body: { status: 'AWAITING_DEPOSIT', issueDelayed: false, pg: 'TOSS' } });
  });

  test('P-T36_리뷰 고침 H1: GetPayment가 일시 실패면 입금 대기로 끝내지 않고 처리 중으로 답해 화면이 다시 묻는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await useCase(view(), { read: async () => PAYMENT_DEPOSIT_READ_TRANSIENT }).execute({ accountId: ACCOUNT, orderId: ORDER });
    expect(r).toEqual({ status: 200, body: { status: 'RESERVED', issueDelayed: false, pg: 'TOSS' } });
  });

  test('P-T36_리뷰 고침 H1: 일시 실패가 이어져도 요청마다 처리 중으로 답한다(상한은 화면의 long polling 규칙이다)', async () => {
    const read = vi.fn(async (): Promise<PaymentDepositRead> => PAYMENT_DEPOSIT_READ_TRANSIENT);
    const u = useCase(view(), { read });
    for (let i = 0; i < 3; i += 1) await expect(u.execute({ accountId: ACCOUNT, orderId: ORDER })).resolves.toMatchObject({ status: 200, body: { status: 'RESERVED' } });
    expect(read).toHaveBeenCalledTimes(3);
  });

  test('P-T36_리뷰 고침 H1: 포트가 던져도 입금 대기로 끝내지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const r = await useCase(view(), { read: async () => Promise.reject(new Error('x')) }).execute({ accountId: ACCOUNT, orderId: ORDER });
    expect(r).toMatchObject({ status: 200, body: { status: 'RESERVED' } });
    expect((r as { body: object }).body).not.toHaveProperty('virtualAccount');
  });

  test('P-T36_리뷰 고침 H2: 번호가 저장되지 않은 답은 입금 대기에 번호 없이 답한다', async () => {
    const r = await useCase(view(), { read: async () => ({ bank: '20', dueAt: DUE }) }).execute({ accountId: ACCOUNT, orderId: ORDER });
    expect(r).toEqual({ status: 200, body: { status: 'AWAITING_DEPOSIT', issueDelayed: false, pg: 'TOSS', virtualAccount: { bank: '20', dueAt: DUE } } });
  });

  test('P-T36_남의 주문은 부르지 않고 404다 [ASVS v5.0.0-8.2.2]', async () => {
    const read = vi.fn(async () => info);
    await expect(useCase(view({ accountId: 'other' }), { read }).execute({ accountId: ACCOUNT, orderId: ORDER })).resolves.toEqual({ status: 404 });
    expect(read).not.toHaveBeenCalled();
  });

  test('P-T36_입금 대기가 아니면 부르지 않는다', async () => {
    const read = vi.fn(async () => info);
    await useCase(view({ status: 'FAILED' }), { read }).execute({ accountId: ACCOUNT, orderId: ORDER });
    expect(read).not.toHaveBeenCalled();
  });

  test('P-T36_요청의 남은 시간이 300ms보다 적으면 그 안에서 묻는다', async () => {
    const read = vi.fn(async () => info);
    await useCase(view(), { read }).execute({ accountId: ACCOUNT, orderId: ORDER, deadline: { remainingMs: () => 120 } as never });
    expect(read).toHaveBeenCalledWith(ORDER, { deadlineMs: 120 });
  });

  test('P-T36_리뷰 고침 H1: 남은 시간이 없으면 부르지 않고 처리 중으로 답한다', async () => {
    const read = vi.fn(async () => info);
    const r = await useCase(view(), { read }).execute({ accountId: ACCOUNT, orderId: ORDER, deadline: { remainingMs: () => 0 } as never });
    expect(read).not.toHaveBeenCalled();
    expect(r).toMatchObject({ status: 200, body: { status: 'RESERVED' } });
    expect((r as { body: object }).body).not.toHaveProperty('virtualAccount');
  });
});

describe('GetPayment 답 읽기', () => {
  test('P-T36_은행·계좌번호·기한을 옮긴다', () => {
    expect(depositInfoOf({ virtual_account: { bank: '20', account_number: '1234', due_at: { seconds: Math.floor(DUE_MS / 1000), nanos: 0 } } })).toEqual({ bank: '20', accountNumber: '1234', dueAt: DUE });
  });

  test('P-T36_비어 있는 칸은 싣지 않는다', () => {
    expect(depositInfoOf({ virtual_account: { bank: '20', account_number: '', due_at: null } })).toEqual({ bank: '20' });
  });

  test.each([[{}], [{ virtual_account: null }]])('P-T36_입금 안내가 없으면 undefined다', (v) => {
    expect(depositInfoOf(v as Record<string, unknown>)).toBeUndefined();
  });

  test('P-T36_주소가 틀리면 만들지 못한다', () => {
    expect(() => new GrpcPaymentDepositReader({ address: 'no-port' })).toThrow();
  });

  /** 같은 프로세스의 가짜 payment-svc(PaymentService.GetPayment만). 물은 주문의 계좌를 답한다 */
  async function fakePaymentServer(accounts: Record<string, string>) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: { PaymentService: grpc.ServiceClientConstructor } } } }).peaket.payment.v1;
    const server = new grpc.Server();
    const requests: Record<string, unknown>[] = [];
    server.addService(pkg.PaymentService.service, {
      GetPayment: (call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
        requests.push(call.request);
        const orderId = call.request.order_id as string;
        cb(null, { order_id: orderId, virtual_account: { bank: '20', account_number: accounts[orderId], due_at: { seconds: Math.floor(DUE_MS / 1000), nanos: 0 } } });
      },
    });
    const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
    return { address: `127.0.0.1:${port}`, requests, close: () => server.forceShutdown() };
  }

  test('P-T36 ③_주문마다 그 주문의 답을 쓴다(앞 주문의 GetPayment 답을 다시 쓰지 않는다) [ASVS v5.0.0-8.2.2]', async () => {
    const OTHER = '0195f3a0-0000-7000-8000-000000000025';
    const srv = await fakePaymentServer({ [ORDER]: '1111111111', [OTHER]: '2222222222' });
    const c = new GrpcPaymentDepositReader({ address: srv.address });
    try {
      await expect(c.read(ORDER)).resolves.toEqual({ bank: '20', accountNumber: '1111111111', dueAt: DUE });
      await expect(c.read(OTHER)).resolves.toEqual({ bank: '20', accountNumber: '2222222222', dueAt: DUE });
      expect(srv.requests.map((r) => r.order_id)).toEqual([ORDER, OTHER]);
    } finally {
      srv.close();
      c.close();
    }
  });

  /** 같은 프로세스의 가짜 payment-svc. 정해 둔 답이나 gRPC 오류를 낸다 */
  async function scriptedPaymentServer(reply: { error: grpc.status } | { body: Record<string, unknown> }) {
    const def = protoLoader.fromJSON(paymentV1Payment as Parameters<typeof protoLoader.fromJSON>[0], { keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true });
    const pkg = (grpc.loadPackageDefinition(def) as unknown as { peaket: { payment: { v1: { PaymentService: grpc.ServiceClientConstructor } } } }).peaket.payment.v1;
    const server = new grpc.Server();
    server.addService(pkg.PaymentService.service, {
      GetPayment: (_call: grpc.ServerUnaryCall<Record<string, unknown>, unknown>, cb: grpc.sendUnaryData<unknown>) => {
        if ('error' in reply) cb({ code: reply.error, details: 'x' } as grpc.ServiceError);
        else cb(null, reply.body);
      },
    });
    const port = await new Promise<number>((resolve, reject) => server.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (e, p) => (e ? reject(e) : resolve(p))));
    return { address: `127.0.0.1:${port}`, close: () => server.forceShutdown() };
  }

  test.each([
    ['UNAVAILABLE', grpc.status.UNAVAILABLE],
    ['DEADLINE_EXCEEDED', grpc.status.DEADLINE_EXCEEDED],
    ['RESOURCE_EXHAUSTED', grpc.status.RESOURCE_EXHAUSTED],
  ])('P-T36_리뷰 고침 H1: %s는 일시 실패로 돌려준다 [ASVS v5.0.0-16.5.3]', async (code, status) => {
    const srv = await scriptedPaymentServer({ error: status });
    const onFailure = vi.fn();
    const c = new GrpcPaymentDepositReader({ address: srv.address, onFailure });
    try {
      await expect(c.read(ORDER)).resolves.toBe(PAYMENT_DEPOSIT_READ_TRANSIENT);
      expect(onFailure).toHaveBeenCalledWith(code);
    } finally {
      srv.close();
      c.close();
    }
  });

  test('P-T36_리뷰 고침 H1: 차단기가 열려 있으면 일시 실패다', async () => {
    const open = new ProblemError({ type: 'dependency-unavailable', status: 503, title: '의존 서비스를 쓸 수 없습니다' });
    const c = new GrpcPaymentDepositReader({ address: '127.0.0.1:1', breaker: { run: async () => Promise.reject(open) } as never });
    try {
      await expect(c.read(ORDER)).resolves.toBe(PAYMENT_DEPOSIT_READ_TRANSIENT);
    } finally {
      c.close();
    }
  });

  test('P-T36_리뷰 고침 H1: NOT_FOUND는 일시 실패가 아니다(칸 없이 답한다)', async () => {
    const srv = await scriptedPaymentServer({ error: grpc.status.NOT_FOUND });
    const c = new GrpcPaymentDepositReader({ address: srv.address });
    try {
      await expect(c.read(ORDER)).resolves.toBeUndefined();
    } finally {
      srv.close();
      c.close();
    }
  });

  test.each([
    ['다른 주문', '0195f3a0-0000-7000-8000-000000000025'],
    ['빈 값', ''],
  ])('P-T36_리뷰 고침: 답의 order_id가 요청과 다르면(%s) 계좌 칸을 싣지 않고 경고한다 [ASVS v5.0.0-8.2.2]', async (_n, answered) => {
    const srv = await scriptedPaymentServer({ body: { order_id: answered, virtual_account: { bank: '20', account_number: '9999999999', due_at: { seconds: Math.floor(DUE_MS / 1000), nanos: 0 } } } });
    const onOrderMismatch = vi.fn();
    const c = new GrpcPaymentDepositReader({ address: srv.address, onOrderMismatch });
    try {
      await expect(c.read(ORDER)).resolves.toBeUndefined();
      expect(onOrderMismatch).toHaveBeenCalledTimes(1);
      expect(onOrderMismatch).toHaveBeenCalledWith(ORDER);
    } finally {
      srv.close();
      c.close();
    }
  });
});
