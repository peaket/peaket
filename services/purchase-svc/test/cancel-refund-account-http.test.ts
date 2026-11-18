// 예매 취소의 환불 계좌 규칙과 계좌 대기를 HTTP 바깥 경계에서 본다(P-T72 ①~④·⑥, BUILD_ORDER GAT-090, BAT-420-rest, 시험 담당 l3-b420-test).
// 정본: docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현'(purchase-svc 견적·purchase-svc 예매 취소·계좌 대기), §11 P-T72,
// docs/api/openapi.yaml getCancellationQuote(refundAccountRequired, 503)·createTicketCancellation(422 refund-account-required, 503 dependency-unavailable, 202 refundAccountRequired).
// AppModule 메모리 조립에 BAT-415-reauth의 실제 JwksFanReauthGate(시험 키·가짜 공개키 묶음·가짜 좌석 Redis)를 꽂고, 결제 수단 읽기(PaymentMethodLookup)는
// 답을 바꿔 가며(가상계좌·카드·읽기 실패) 부른 횟수와 데드라인을 적는 대역이다. 판정만이 아니라 컨트롤러·Saga가 그 결과를 써서 ticket·payment 취소와
// order_cancellation 쓰기를 부르지 않는지까지 본다. 단언 값(300ms, 입장 시작 경계 = 입장 시작 시각 정각부터 '입장 시작 뒤')은 정본에서 가져온다.
// 실제 PostgreSQL 행(next_refund_at·refund_account_required_at)·틱 끝 다시 열기(⑤)는 test-int/cancellation.int.test.ts가 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput, RedisReauthJtiStore } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import {
  JwksFanReauthGate,
  RefundAfterEntry,
  WeekendBusinessCalendar,
  type CancellationOrderView,
  type CancellationRecord,
  type CancellationWrites,
  type PaymentCancelOutcome,
} from '../src/modules/refund/index.js';
import { fakeJwksFetch, fakeSeatRedis, fanKey, ISS, JWKS_URL, reauthClaims, signReauth } from './fan-reauth-fixtures.js';

const NOW = Date.parse('2026-11-13T10:00:00+09:00');
const KEY = Buffer.alloc(32, 7);
const ACCOUNT = '0193a100-0000-7000-8000-000000000201';
const LOGIN = '0193a100-0000-7000-8000-000000000202';
const PSID = '0193a100-0000-7000-8000-000000000203';
const EVENT = '0193a100-0000-7000-8000-000000000204';
const SEAT = '0193a100-0000-7000-8000-000000000206';
const ORDER = '0193a100-0000-7000-8000-000000000207';
/** 계좌 글 누설 검사용 값(계획 §5) */
const ACCOUNT_NO = '110-987-654321';
const HOLDER = '김환불';
const REFUND_ACCOUNT = { bankCode: '88', accountNumber: ACCOUNT_NO, holderName: HOLDER };
/** 정본 'purchase-svc 견적': GetPayment 데드라인 300ms [가정] */
const LOOKUP_DEADLINE_MS = 300;
const fan = fanKey('fan-2026-11-b420');

type Lookup = 'VIRTUAL' | 'CARD' | 'FAIL';

/** 결제자 ACCOUNT의 표. 33,333원, 공제 10% → 환급 30,000원(refund-http와 같은 표). entryOpensAtMs를 표마다 바꾼다 */
const viewOf = (ticketId: string, entryOpensAtMs: number): CancellationOrderView => ({
  orderId: ORDER,
  eventId: EVENT,
  ticketId,
  seatId: SEAT,
  payerAccountId: ACCOUNT,
  ticketPrice: 33_333,
  bookedAtMs: Date.parse('2026-11-01T10:00:00+09:00'),
  saleEndsAtMs: Date.parse('2026-11-19T19:00:00+09:00'),
  entryOpensAtMs,
  orderStatus: 'CONFIRMED',
});

const logs: string[] = [];
const state = {
  lookup: 'VIRTUAL' as Lookup,
  lookups: [] as { orderId: string; deadlineMs: number }[],
  payment: 'CANCELLED' as PaymentCancelOutcome,
  ticketCalls: [] as unknown[],
  paymentCalls: [] as { cancellationId: string; refundAccount?: unknown }[],
  created: [] as Record<string, unknown>[],
  accountMarks: [] as { cancellationId: string; nowMs: number }[],
  retries: [] as unknown[],
  failures: [] as unknown[],
  /** 표 ID → 입장 시작 시각 */
  entryOf: new Map<string, number>(),
  records: new Map<string, CancellationRecord>(),
};
const redis = fakeSeatRedis();
let svc: Awaited<ReturnType<typeof createService>>;
let seq = 0;

const writes: CancellationWrites = {
  create: async (q) => {
    state.created.push({ ...q });
    state.records.set(q.cancellationId, { cancellationId: q.cancellationId, orderId: q.orderId, ticketId: q.ticketId, refundAmount: q.refundAmount, state: q.status, refundAttempts: 0 });
    return { status: 'CREATED' };
  },
  updateStatus: async (q) => {
    const r = state.records.get(q.cancellationId);
    if (r) state.records.set(q.cancellationId, { ...r, state: q.status });
  },
  scheduleRefundRetry: async (q) => void state.retries.push(q),
  markRefundFailed: async (q) => void state.failures.push(q),
  markRefundAccountRequired: async (q) => void state.accountMarks.push({ ...q }),
  dueRefunds: async () => [],
};

beforeAll(async () => {
  const sessions = new MemoryPurchaseSessions();
  sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: 'journey', loginSessionId: LOGIN, key: KEY });
  const jwks = fakeJwksFetch([fan]);
  const reauth = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock: fakeClock({ now: NOW }), fetch: jwks.fetch });
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      refund: {
        orders: { findByTicket: async (id) => viewOf(id, state.entryOf.get(id) ?? Date.parse('2026-11-20T18:00:00+09:00')), findCancellation: async (id) => state.records.get(id) },
        tickets: {
          cancel: async (q) => {
            state.ticketCalls.push(q);
            return (state.entryOf.get(q.ticketIds[0]!) ?? Number.POSITIVE_INFINITY) <= NOW ? 'REFUND_AFTER_CLOSE' : 'REFUND_NOW';
          },
        },
        payments: {
          cancel: async (q) => {
            state.paymentCalls.push({ cancellationId: q.cancellationId, ...(q.refundAccount !== undefined ? { refundAccount: q.refundAccount } : {}) });
            return state.payment;
          },
        },
        writes,
        calendar: new WeekendBusinessCalendar(),
        reauth,
        paymentMethods: {
          virtualAccountPaid: async (q) => {
            state.lookups.push({ orderId: q.orderId, deadlineMs: q.deadlineMs });
            if (state.lookup === 'FAIL') throw new Error('payment-svc GetPayment 시간 초과(시험의 장애 주입)');
            return state.lookup === 'VIRTUAL';
          },
        },
      },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'debug' },
    clock: fakeClock({ now: NOW }),
    logDestination: new Writable({
      write: (c, _e, cb) => {
        logs.push(String(c));
        cb();
      },
    }),
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  state.lookup = 'VIRTUAL';
  state.payment = 'CANCELLED';
  for (const a of [state.lookups, state.ticketCalls, state.paymentCalls, state.created, state.accountMarks, state.retries, state.failures]) a.length = 0;
  redis.commands.length = 0;
});

const fanHeaders = { 'x-user-id': ACCOUNT, 'x-session-id': LOGIN, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy' };
/** 새 표 하나(입장 시작 시각을 정한다) */
const ticket = (entryOpensAtMs = Date.parse('2026-11-20T18:00:00+09:00')): string => {
  const id = randomUUID();
  state.entryOf.set(id, entryOpensAtMs);
  return id;
};
const quote = async (ticketId: string) => {
  const r = await svc.http.inject({ method: 'GET', url: `/v1/tickets/${ticketId}/cancellation-quote`, headers: fanHeaders });
  return { statusCode: r.statusCode, body: JSON.parse(r.payload) as Record<string, unknown>, headers: r.headers };
};
const token = (withAccount: boolean) => signReauth(fan, reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN, act: withAccount ? 'FAN_HIGH_RISK' : 'FAN_SENSITIVE' }));
const send = async (ticketId: string, body: Record<string, unknown> = {}, idem = randomUUID()) => {
  const url = `/v1/tickets/${ticketId}/cancellation`;
  const payload = JSON.stringify(body);
  seq += 1;
  const r = await svc.http.inject({
    method: 'POST',
    url,
    headers: {
      ...fanHeaders,
      'content-type': 'application/json',
      'idempotency-key': idem,
      'x-purchase-seq': String(seq),
      'x-purchase-mac': purchaseMac(KEY, purchaseMacInput('POST', url, seq, Buffer.from(payload, 'utf8'))),
      'x-reauth-token': token(body.refundAccount !== undefined),
    },
    payload,
  });
  return { statusCode: r.statusCode, body: JSON.parse(r.payload) as Record<string, unknown>, headers: r.headers, idem };
};
const nothingRan = (what: string) => {
  expect(state.ticketCalls, `${what}: ticket 취소`).toHaveLength(0);
  expect(state.paymentCalls, `${what}: payment 취소`).toHaveLength(0);
  expect(state.created, `${what}: order_cancellation 쓰기`).toHaveLength(0);
};

describe('P-T72 ① 견적의 refundAccountRequired', () => {
  test('P-T72 ① 가상계좌·입장 시작 전이면 참이고 GetPayment를 그 주문으로 300ms 데드라인에 한 번 읽는다', async () => {
    const r = await quote(ticket());
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ refundAccountRequired: true, refundAfterEntryClose: false, refundAmount: 30_000 });
    expect(state.lookups).toEqual([{ orderId: ORDER, deadlineMs: LOOKUP_DEADLINE_MS }]);
  });

  test('P-T72 ① 카드 결제는 거짓이다', async () => {
    state.lookup = 'CARD';
    expect((await quote(ticket())).body).toMatchObject({ refundAccountRequired: false, refundAfterEntryClose: false });
    expect(state.lookups).toHaveLength(1);
  });

  test('P-T72 ① 경계: 입장 시작 1ms 뒤(아직 전)는 참, 입장 시작 정각(= 지금)과 그 뒤는 가상계좌여도 거짓이고 결제 수단을 읽지 않는다', async () => {
    expect((await quote(ticket(NOW + 1))).body).toMatchObject({ refundAccountRequired: true, refundAfterEntryClose: false });
    state.lookups.length = 0;
    expect((await quote(ticket(NOW))).body).toMatchObject({ refundAccountRequired: false, refundAfterEntryClose: true });
    expect((await quote(ticket(NOW - 60_000))).body).toMatchObject({ refundAccountRequired: false, refundAfterEntryClose: true });
    expect(state.lookups).toEqual([]);
  });

  test('P-T72 ① GetPayment를 읽지 못하면 견적은 503 dependency-unavailable이다(모르는 것을 \'계좌 필요 없음\'으로 보이지 않는다)', async () => {
    state.lookup = 'FAIL';
    const r = await quote(ticket());
    expect(r.statusCode).toBe(503);
    expect(r.body.type).toBe(`${PROBLEM_TYPE_BASE}dependency-unavailable`);
    expect(r.body).not.toHaveProperty('refundAccountRequired');
    expect(state.lookups).toHaveLength(1);
  });
});

describe('P-T72 ② Saga 앞의 계좌 규칙', () => {
  test('P-T72 ② 가상계좌·입장 시작 전에 계좌 없이 취소하면 422 refund-account-required이고 ticket·payment 취소와 order_cancellation 쓰기가 0이다(재인증 토큰은 이미 썼다)', async () => {
    const r = await send(ticket());
    expect(r.statusCode).toBe(422);
    expect(r.body.type).toBe(`${PROBLEM_TYPE_BASE}refund-account-required`);
    nothingRan('422');
    expect(state.lookups).toEqual([{ orderId: ORDER, deadlineMs: LOOKUP_DEADLINE_MS }]);
    // 남는 한계(계획 §6): 재인증 jti는 Saga 앞 판정 전에 잡혔다
    expect(redis.commands.filter((c) => c[0] === 'SET')).toHaveLength(1);
  });

  test('P-T72 ② GetPayment를 읽지 못하면 503 dependency-unavailable이고 계좌가 있어도 없어도 Saga가 0이다', async () => {
    state.lookup = 'FAIL';
    for (const body of [{}, { refundAccount: REFUND_ACCOUNT }]) {
      const r = await send(ticket(), body);
      expect(r.statusCode, JSON.stringify(body)).toBe(503);
      expect(r.body.type).toBe(`${PROBLEM_TYPE_BASE}dependency-unavailable`);
      nothingRan(`503 ${JSON.stringify(body)}`);
    }
    expect(state.lookups).toHaveLength(2);
  });

  test('P-T72 ② 대조: 카드 결제는 계좌 없이도 202 REFUNDED이고 Saga가 한 번 돈다(카드 결제는 계좌 규칙이 바꾸지 않는다)', async () => {
    state.lookup = 'CARD';
    const r = await send(ticket());
    expect(r.statusCode).toBe(202);
    expect(r.body).toEqual({ cancellationId: r.idem, status: 'REFUNDED', refundAmount: 30_000 });
    expect(state.ticketCalls).toHaveLength(1);
    expect(state.paymentCalls).toEqual([{ cancellationId: r.idem }]);
  });
});

describe('P-T72 ③ 계좌를 싣는 자리', () => {
  test('P-T72 ③ 가상계좌·입장 시작 전에 계좌를 실으면 payment 대역이 받은 계좌가 본문과 같고 202 REFUNDED다', async () => {
    const r = await send(ticket(), { refundAccount: REFUND_ACCOUNT });
    expect(r.statusCode).toBe(202);
    expect(r.body).toEqual({ cancellationId: r.idem, status: 'REFUNDED', refundAmount: 30_000 });
    expect(state.paymentCalls).toEqual([{ cancellationId: r.idem, refundAccount: REFUND_ACCOUNT }]);
    // 취소 행 쓰기에는 계좌가 없다(저장하지 않는다)
    expect(JSON.stringify(state.created)).not.toContain(ACCOUNT_NO);
  });

  test('P-T72 ③ 카드 결제에 온 계좌는 버리고 접수한다: payment 대역이 계좌를 받지 않는다', async () => {
    state.lookup = 'CARD';
    const r = await send(ticket(), { refundAccount: REFUND_ACCOUNT });
    expect(r.statusCode).toBe(202);
    expect(state.paymentCalls).toEqual([{ cancellationId: r.idem }]);
  });

  test('P-T72 ③ 입장 시작 뒤 취소에 실은 계좌는 버리고 202 REQUESTED이며(결제 수단을 읽지 않는다), 마감 뒤 재시도 실행기의 호출에도 계좌가 없다', async () => {
    const t = ticket(NOW);
    const r = await send(t, { refundAccount: REFUND_ACCOUNT });
    expect(r.statusCode).toBe(202);
    expect(r.body).toMatchObject({ cancellationId: r.idem, status: 'REQUESTED' });
    expect(state.lookups).toEqual([]);
    expect(state.paymentCalls).toEqual([]);
    expect(state.created).toHaveLength(1);
    expect(JSON.stringify(state.created)).not.toContain(ACCOUNT_NO);
    expect(JSON.stringify(state.created)).not.toContain(HOLDER);
    // 재시도 실행기: 집은 행으로 payment를 부르고, 그 호출에 계좌가 없다
    const calls: Record<string, unknown>[] = [];
    const runner = new RefundAfterEntry({
      nowMs: () => NOW + 60_000,
      writes: { ...writes, dueRefunds: async () => [{ cancellationId: r.idem, orderId: ORDER, ticketId: t, amount: 3_334, reason: 'USER', status: 'REQUESTED', attempts: 0 }] },
      payments: { cancel: async (q) => (calls.push({ ...q }), 'CANCELLED') },
      entries: { lookup: async (ids) => new Map(ids.map((id) => [id, { found: true, entered: false }])) },
      claims: { claimDue: async () => true, markEntryRecorded: async () => true },
    });
    await runner.run();
    expect(calls).toHaveLength(1);
    for (const c of calls) expect(c).not.toHaveProperty('refundAccount');
  });
});

describe('P-T72 ④ 계좌 대기', () => {
  test('P-T72 ④ payment가 REFUND_ACCOUNT_REQUIRED로 답하면 202 REFUND_PENDING·refundAccountRequired 참이고, 계좌 대기 표시 한 번·재시도 예약 0·실패 표시 0이다', async () => {
    state.payment = 'REFUND_ACCOUNT_REQUIRED';
    const r = await send(ticket(), { refundAccount: REFUND_ACCOUNT });
    expect(r.statusCode).toBe(202);
    expect(r.body).toEqual({ cancellationId: r.idem, status: 'REFUND_PENDING', refundAmount: 30_000, refundAccountRequired: true });
    expect(state.accountMarks).toEqual([{ cancellationId: r.idem, nowMs: NOW }]);
    expect(state.retries).toEqual([]);
    expect(state.failures).toEqual([]);
    expect(state.created).toHaveLength(1);
    expect(state.created[0]).toMatchObject({ status: 'REFUND_PENDING' });
  });

  test('P-T72 ④ 대조: 결과 모름(UNKNOWN)은 refundAccountRequired 없이 REFUND_PENDING이고 재시도를 예약한다(계좌 대기가 아니다)', async () => {
    state.payment = 'UNKNOWN';
    const r = await send(ticket(), { refundAccount: REFUND_ACCOUNT });
    expect(r.statusCode).toBe(202);
    expect(r.body).toEqual({ cancellationId: r.idem, status: 'REFUND_PENDING', refundAmount: 30_000 });
    expect(state.accountMarks).toEqual([]);
    expect(state.retries).toHaveLength(1);
  });
});

describe('P-T72 ⑥ 계좌 글 누설', () => {
  test('P-T72 ⑥ 422·503·202(계좌 대기) 경로를 돈 뒤 서비스 로그에 계좌번호·예금주 글이 없다 [ASVS v5.0.0-14.2.4] [ASVS v5.0.0-16.2.5]', async () => {
    logs.length = 0;
    await send(ticket());
    state.lookup = 'FAIL';
    await send(ticket(), { refundAccount: REFUND_ACCOUNT });
    state.lookup = 'VIRTUAL';
    state.payment = 'REFUND_ACCOUNT_REQUIRED';
    await send(ticket(), { refundAccount: REFUND_ACCOUNT });
    const text = logs.join('\n');
    expect(text.length).toBeGreaterThan(0);
    for (const needle of [ACCOUNT_NO, '110987654321', HOLDER]) expect(text).not.toContain(needle);
  });
});
