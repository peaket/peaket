// 예매 취소의 환불 계좌 규칙과 계좌 대기를 HTTP 바깥 경계에서 본다(P-T72 ①~④·⑥, BUILD_ORDER GAT-090, BAT-420-rest, 시험 담당 l3-b420-test).
// 정본: docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현'(purchase-svc 견적·purchase-svc 예매 취소·계좌 대기), §11 P-T72,
// docs/api/openapi.yaml getCancellationQuote(refundAccountRequired, 503)·createTicketCancellation(422 refund-account-required, 503 dependency-unavailable, 202 refundAccountRequired).
// AppModule 메모리 조립에 BAT-415-reauth의 실제 JwksFanReauthGate(시험 키·가짜 공개키 묶음·가짜 좌석 Redis)를 꽂고, 결제 수단 읽기(PaymentMethodLookup)는
// 답을 바꿔 가며(가상계좌·카드·읽기 실패) 부른 횟수와 데드라인을 적는 대역이다. 판정만이 아니라 컨트롤러·Saga가 그 결과를 써서 ticket·payment 취소와
// order_cancellation 쓰기를 부르지 않는지까지 본다. 단언 값(300ms, 입장 시작 경계 = 입장 시작 시각 정각부터 '입장 시작 뒤')은 정본에서 가져온다.
// 실제 PostgreSQL 행(next_refund_at·refund_account_required_at)·틱 끝 다시 열기(⑤)는 test-int/cancellation.int.test.ts가 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
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
  type RefundAccountWrites,
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
const viewOf = (ticketId: string, entryOpensAtMs: number, saleEndsAtMs = Date.parse('2026-11-19T19:00:00+09:00')): CancellationOrderView => ({
  orderId: ORDER,
  eventId: EVENT,
  ticketId,
  seatId: SEAT,
  payerAccountId: ACCOUNT,
  ticketPrice: 33_333,
  bookedAtMs: Date.parse('2026-11-01T10:00:00+09:00'),
  saleEndsAtMs,
  entryOpensAtMs,
  orderStatus: 'CONFIRMED',
});

const logs: string[] = [];
const state = {
  lookup: 'VIRTUAL' as Lookup,
  lookups: [] as { orderId: string; deadlineMs: number }[],
  payment: 'CANCELLED' as PaymentCancelOutcome,
  ticketCalls: [] as unknown[],
  paymentCalls: [] as { cancellationId: string; refundAccount?: unknown; refundAttempt?: number; amount?: number; reason?: string }[],
  created: [] as Record<string, unknown>[],
  accountMarks: [] as { cancellationId: string; nowMs: number }[],
  retries: [] as unknown[],
  failures: [] as unknown[],
  /** R-T42: 계좌 다시 받기 시도 올리기·상태 전이 기록 */
  accountStarts: [] as { cancellationId: string; oldAttempt: number; attempt: number }[],
  accountClears: [] as { cancellationId: string; nextRefundAtMs?: number; lastError?: string }[],
  accountUpdates: [] as { cancellationId: string; status: string }[],
  accountFailures: [] as { cancellationId: string; attempts: number; lastError: string }[],
  /** 표 ID → 입장 시작 시각 */
  entryOf: new Map<string, number>(),
  records: new Map<string, CancellationRecord>(),
  /** BAT-420-rest 리뷰 반영: 재인증 확인 횟수(P-T74 ①), 표마다 ticket-svc 답(다시 누름 ALREADY_CANCELLED, P-T73 ⑤)·판매 종료 시각(공연 시작 뒤) */
  verifies: 0,
  ticketAnswer: new Map<string, unknown>(),
  saleEndsOf: new Map<string, number>(),
};
const redis = fakeSeatRedis();
const jwks = fakeJwksFetch([fan]);
/** 키 묶음을 한 번도 받지 못한 확인기(R-T42 ②): 앞 시험이 키를 받아 둔 같은 게이트로는 첫 읽기 장애를 재현할 수 없다 */
const coldJwks = fakeJwksFetch([fan]);
/** RV-24 재시작 시험용 새 프로세스: 앞 시험의 확인기 캐시·jti와 섞이지 않게 따로 둔다 */
const restartJwks = fakeJwksFetch([fan]);
let svc: Awaited<ReturnType<typeof createService>>;
let coldSvc: Awaited<ReturnType<typeof createService>>;
let restartSvc: Awaited<ReturnType<typeof createService>>;
let seq = 0;

const writes: CancellationWrites = {
  create: async (q) => {
    state.created.push({ ...q });
    state.records.set(q.cancellationId, { cancellationId: q.cancellationId, orderId: q.orderId, ticketId: q.ticketId, refundAmount: q.refundAmount, state: q.status, refundAttempts: 0, refundAttempt: 0, refundAccountRequired: false });
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

/** R-T42: 계좌 다시 받기 쓰기 대역. 행 잠금 안에서 조건을 다시 보고 시도를 1 올린다 */
const refundAccountWrites: RefundAccountWrites = {
  beginAttempt: async (q) => {
    const r = state.records.get(q.cancellationId);
    const old = r?.refundAttempt ?? 0;
    if (!r || r.state !== 'REFUND_PENDING' || r.refundAccountRequired !== true || old !== q.oldAttempt || old >= 3) return undefined;
    const attempt = old + 1;
    state.records.set(q.cancellationId, { ...r, refundAttempt: attempt });
    state.accountStarts.push({ cancellationId: q.cancellationId, oldAttempt: old, attempt });
    return { attempt, orderId: r.orderId, ticketId: r.ticketId, refundAmount: r.refundAmount, reason: 'USER', retryAttempts: r.refundAttempts };
  },
  clearWaiting: async (q) => {
    const r = state.records.get(q.cancellationId);
    if (r?.state === 'REFUND_PENDING') state.records.set(q.cancellationId, { ...r, refundAccountRequired: false });
    state.accountClears.push({ cancellationId: q.cancellationId, ...(q.nextRefundAtMs === undefined ? {} : { nextRefundAtMs: q.nextRefundAtMs }), ...(q.lastError === undefined ? {} : { lastError: q.lastError }) });
  },
  updateStatus: async (q) => {
    const r = state.records.get(q.cancellationId);
    if (r) state.records.set(q.cancellationId, { ...r, state: q.status });
    state.accountUpdates.push({ cancellationId: q.cancellationId, status: q.status });
  },
  markFailed: async (q) => {
    state.accountFailures.push({ cancellationId: q.cancellationId, attempts: q.attempts, lastError: q.lastError });
  },
};

beforeAll(async () => {
  const sessions = new MemoryPurchaseSessions();
  sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: 'journey', loginSessionId: LOGIN, key: KEY });
  const refund = {
    orders: {
      findByTicket: async (id: string) => viewOf(id, state.entryOf.get(id) ?? Date.parse('2026-11-20T18:00:00+09:00'), state.saleEndsOf.get(id)),
      findCancellation: async (id: string) => state.records.get(id),
    },
    tickets: {
      cancel: async (q: { ticketIds: readonly string[] }) => {
        state.ticketCalls.push(q);
        const answer = state.ticketAnswer.get(q.ticketIds[0]!);
        if (answer !== undefined) return answer as never;
        return (state.entryOf.get(q.ticketIds[0]!) ?? Number.POSITIVE_INFINITY) <= NOW ? 'REFUND_AFTER_CLOSE' : 'REFUND_NOW';
      },
    },
    payments: {
      cancel: async (q: { cancellationId: string; refundAccount?: unknown; refundAttempt?: number; amount: number; reason: string }) => {
        state.paymentCalls.push({
          cancellationId: q.cancellationId,
          ...(q.refundAccount !== undefined ? { refundAccount: q.refundAccount } : {}),
          ...(q.refundAttempt === undefined ? {} : { refundAttempt: q.refundAttempt }),
          amount: q.amount,
          reason: q.reason,
        });
        return state.payment;
      },
    },
    writes,
    refundAccountWrites,
    calendar: new WeekendBusinessCalendar(),
    paymentMethods: {
      virtualAccountPaid: async (q: { orderId: string; deadlineMs: number }) => {
        state.lookups.push({ orderId: q.orderId, deadlineMs: q.deadlineMs });
        if (state.lookup === 'FAIL') throw new Error('payment-svc GetPayment 시간 초과(시험의 장애 주입)');
        return state.lookup === 'VIRTUAL';
      },
    },
  };
  const warmGate = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock: fakeClock({ now: NOW }), fetch: jwks.fetch });
  const make = (reauth: typeof warmGate) =>
    createService({
      name: 'purchase-svc',
      module: AppModule.register({
        memory: true,
        sessions,
        refund: { ...refund, reauth: { verify: (t: string | undefined, q) => (state.verifies++, reauth.verify(t, q)) } },
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
  svc = await make(warmGate);
  const coldGate = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(fakeSeatRedis()), clock: fakeClock({ now: NOW }), fetch: coldJwks.fetch });
  coldSvc = await make(coldGate);
  const restartGate = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(fakeSeatRedis()), clock: fakeClock({ now: NOW }), fetch: restartJwks.fetch });
  restartSvc = await make(restartGate);
});
afterAll(async () => {
  await svc?.close();
  await coldSvc?.close();
});
afterAll(async () => {
  await restartSvc?.close();
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  state.lookup = 'VIRTUAL';
  state.payment = 'CANCELLED';
  for (const a of [state.lookups, state.ticketCalls, state.paymentCalls, state.created, state.accountMarks, state.retries, state.failures, state.accountStarts, state.accountClears, state.accountUpdates, state.accountFailures]) a.length = 0;
  state.verifies = 0;
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
    expect(state.paymentCalls.map((c) => c.cancellationId)).toEqual([r.idem]);
  });
});

describe('P-T72 ③ 계좌를 싣는 자리', () => {
  test('P-T72 ③ 가상계좌·입장 시작 전에 계좌를 실으면 payment 대역이 받은 계좌가 본문과 같고 202 REFUNDED다', async () => {
    const r = await send(ticket(), { refundAccount: REFUND_ACCOUNT });
    expect(r.statusCode).toBe(202);
    expect(r.body).toEqual({ cancellationId: r.idem, status: 'REFUNDED', refundAmount: 30_000 });
    expect(state.paymentCalls).toHaveLength(1);
    expect(state.paymentCalls[0]).toMatchObject({ cancellationId: r.idem, refundAccount: REFUND_ACCOUNT });
    // 취소 행 쓰기에는 계좌가 없다(저장하지 않는다)
    expect(JSON.stringify(state.created)).not.toContain(ACCOUNT_NO);
  });

  test('P-T72 ③ 카드 결제에 온 계좌는 버리고 접수한다: payment 대역이 계좌를 받지 않는다', async () => {
    state.lookup = 'CARD';
    const r = await send(ticket(), { refundAccount: REFUND_ACCOUNT });
    expect(r.statusCode).toBe(202);
    expect(state.paymentCalls.map((c) => c.cancellationId)).toEqual([r.idem]);
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

// ---- BAT-425 R-T42: 지연 환급 계좌 다시 받기 HTTP ----

/** 계좌 대기(REFUND_PENDING·refund_account_required_at 있음) 취소 하나를 메모리에 넣는다 */
const accountPending = (o: { cancellationId?: string; ticketId?: string; refundAttempt?: number; required?: boolean; state?: CancellationRecord['state'] } = {}): string => {
  const ticketId = o.ticketId ?? randomUUID();
  state.entryOf.set(ticketId, Date.parse('2026-11-20T18:00:00+09:00'));
  const cancellationId = o.cancellationId ?? randomUUID();
  state.records.set(cancellationId, {
    cancellationId,
    orderId: ORDER,
    ticketId,
    refundAmount: 30_000,
    state: o.state ?? 'REFUND_PENDING',
    refundAttempts: 0,
    refundAttempt: o.refundAttempt ?? 0,
    refundAccountRequired: o.required ?? true,
  });
  return cancellationId;
};

const accountToken = (o: { accountId?: string; sessionId?: string; act?: string; op?: string; lifeS?: number; jti?: string } = {}): { t: string; jti: string } => {
  const claims = reauthClaims({
    nowMs: NOW,
    accountId: o.accountId ?? ACCOUNT,
    sessionId: o.sessionId ?? LOGIN,
    act: o.act ?? 'FAN_HIGH_RISK',
    op: o.op ?? 'REFUND_ACCOUNT',
    lifeS: o.lifeS ?? 180,
    ...(o.jti === undefined ? {} : { jti: o.jti }),
  });
  return { t: signReauth(fan, claims), jti: claims.jti as string };
};

const postAccount = async (
  cancellationId: string,
  body: Record<string, unknown> = REFUND_ACCOUNT,
  o: { accountId?: string; sessionId?: string; token?: string; key?: string; svc?: typeof svc } = {},
) =>
  (o.svc ?? svc).http.inject({
    method: 'POST',
    url: `/v1/cancellations/${cancellationId}/account`,
    headers: {
      ...fanHeaders,
      'x-user-id': o.accountId ?? ACCOUNT,
      'x-session-id': o.sessionId ?? LOGIN,
      'content-type': 'application/json',
      'idempotency-key': o.key ?? randomUUID(),
      ...(o.token === undefined ? {} : { 'x-reauth-token': o.token }),
    },
    payload: JSON.stringify(body),
  });

const accountProblem = (r: { statusCode: number; payload: string }) => {
  const b = JSON.parse(r.payload) as { type?: string; title?: string };
  return { status: r.statusCode, type: String(b.type ?? '').replace(/^.*\/problems\//, ''), title: b.title };
};

describe('R-T42 ① 예매 취소의 지연 환급 계좌 다시 받기(202·404·409)', () => {
  test('R-T42 ①_결제자_본인의_REFUND_PENDING_계좌_대기_행에_계좌를_보내면_202_REFUNDED이고_payment에_새_시도_번호가_간다', async () => {
    const id = accountPending();
    const tk = accountToken();
    const r = await postAccount(id, REFUND_ACCOUNT, { token: tk.t });
    expect(r.statusCode, r.payload).toBe(202);
    expect(JSON.parse(r.payload)).toEqual({ cancellationId: id, status: 'REFUNDED', refundAmount: 30_000 });
    // 정확한 금액(33,333원의 10% 공제 = 30,000원)·시도 1·계좌는 하이픈을 뺀 세 칸
    expect(state.accountStarts).toEqual([{ cancellationId: id, oldAttempt: 0, attempt: 1 }]);
    expect(state.paymentCalls).toEqual([{ cancellationId: id, amount: 30_000, reason: 'USER', refundAttempt: 1, refundAccount: { bankCode: '88', accountNumber: ACCOUNT_NO, holderName: HOLDER } }]);
    expect(state.accountUpdates).toEqual([{ cancellationId: id, status: 'REFUNDED' }]);
  });

  test('R-T42 ①_다른_계정과_없는_취소는_같은_404_not-found이고_시도_올리기·payment가_0이다', async () => {
    const id = accountPending();
    const other = await postAccount(id, REFUND_ACCOUNT, { accountId: LOGIN, token: accountToken().t });
    const missing = await postAccount(randomUUID(), REFUND_ACCOUNT, { token: accountToken().t });
    expect(accountProblem(other)).toEqual(accountProblem(missing));
    expect(other.statusCode).toBe(404);
    expect(accountProblem(other).type).toContain('not-found');
    expect(state.accountStarts).toEqual([]);
    expect(state.paymentCalls).toEqual([]);
  });

  test('R-T42 ①_REFUNDED·REQUESTED·계좌_대기_아님은_409_cancellation-not-account-pending이고_쓰기가_0이다', async () => {
    const cases: [string, string, boolean][] = [
      ['REFUNDED', 'REFUNDED', false],
      ['REQUESTED', 'REQUESTED', false],
      ['계좌 대기 아님', 'REFUND_PENDING', false],
    ];
    for (const [what, status, required] of cases) {
      const id = accountPending({ state: status as CancellationRecord['state'], required });
      const r = await postAccount(id, REFUND_ACCOUNT, { token: accountToken().t });
      expect(r.statusCode, `${what}: ${r.payload}`).toBe(409);
      expect(accountProblem(r).type, what).toContain('cancellation-not-account-pending');
    }
    expect(state.accountStarts).toEqual([]);
    expect(state.paymentCalls).toEqual([]);
  });

  test('R-T42 ①_같은_Idempotency-Key_다시_보냄은_같은_202이고_시도_1·payment_1건이다', async () => {
    const id = accountPending();
    const key = randomUUID();
    const first = await postAccount(id, REFUND_ACCOUNT, { key, token: accountToken().t });
    expect(first.statusCode, first.payload).toBe(202);
    const second = await postAccount(id, REFUND_ACCOUNT, { key, token: accountToken().t });
    expect(second.statusCode, second.payload).toBe(202);
    expect(JSON.parse(second.payload)).toEqual(JSON.parse(first.payload));
    expect(state.accountStarts).toHaveLength(1);
    expect(state.paymentCalls).toHaveLength(1);
  });

  // RV-24(중간): 상태 전이(REFUNDED) 커밋과 답 저장(refund_account_answer)은 다른 쓰기다. 그 사이 프로세스가 끊기면
  // 같은 키의 재시도가 #replayOf를 지나지 못하고 #assertPending에서 409가 된다. 새 프로세스(restartSvc)로 같은 키를 다시 보내도
  // 첫 202·같은 답이어야 한다(같은 키·같은 지문 = 같은 답).
  test('R-T42 ④_RV24_상태_전이와_답_저장_사이에_재시작해도_같은_키는_202·같은_답이다', async () => {
    const id = accountPending();
    const key = randomUUID();
    const first = await postAccount(id, REFUND_ACCOUNT, { key, token: accountToken().t });
    expect(first.statusCode, first.payload).toBe(202);
    expect(JSON.parse(first.payload)).toEqual({ cancellationId: id, status: 'REFUNDED', refundAmount: 30_000 });
    // 메모리 저장소는 saveAnswer를 쓰지 않는다: 상태는 REFUNDED인데 답은 비어 있는 '끊긴 창'과 같다
    expect(state.records.get(id)).toMatchObject({ state: 'REFUNDED', refundAttempt: 1 });
    expect(state.records.get(id)!.refundAccountAnswer).toBeUndefined();

    const restarted = await postAccount(id, REFUND_ACCOUNT, { key, token: accountToken().t, svc: restartSvc });
    expect(restarted.statusCode, restarted.payload).toBe(202);
    expect(JSON.parse(restarted.payload)).toEqual(JSON.parse(first.payload));
    expect(state.accountStarts).toHaveLength(1);
    expect(state.paymentCalls).toHaveLength(1);
  });

  // RV-03(높음): 첫 답이 CANCEL_PENDING이어도 같은 키의 재요청은 처음 202(REFUND_PENDING)를 재생해야 한다.
  // 지금은 RequestRefundAccount가 idempotencyKey를 쓰지 않아 beginAttempt가 0행을 받고 409가 되며, 재시도마다 3회 상한을 갉아먹는다.
  test('R-T42 ④_같은_Idempotency-Key는_첫_답이_CANCEL_PENDING이어도_같은_202를_재생하고_시도를_더_올리지_않는다', async () => {
    const id = accountPending();
    const key = randomUUID();
    state.payment = 'PENDING';
    const first = await postAccount(id, REFUND_ACCOUNT, { key, token: accountToken().t });
    expect(first.statusCode, first.payload).toBe(202);
    expect(JSON.parse(first.payload)).toEqual({ cancellationId: id, status: 'REFUND_PENDING', refundAmount: 30_000 });
    const second = await postAccount(id, REFUND_ACCOUNT, { key, token: accountToken().t });
    expect(second.statusCode, second.payload).toBe(202);
    expect(JSON.parse(second.payload)).toEqual(JSON.parse(first.payload));
    expect(state.accountStarts).toHaveLength(1);
    expect(state.paymentCalls).toHaveLength(1);
  });

  test('R-T42 ④_시도_3회를_넘으면(저장된_시도_3)_409이고_payment가_0이다', async () => {
    const id = accountPending({ refundAttempt: 3 });
    const r = await postAccount(id, REFUND_ACCOUNT, { token: accountToken().t });
    expect(r.statusCode, r.payload).toBe(409);
    expect(accountProblem(r).type).toContain('cancellation-not-account-pending');
    expect(state.accountStarts).toEqual([]);
    expect(state.paymentCalls).toEqual([]);
  });
});

describe('R-T42 ② 재인증(REFUND_ACCOUNT·FAN_HIGH_RISK)', () => {
  test('R-T42 ②_토큰_없음·틀림·만료·sid/sub/act/op_어긋남·TICKET_CANCEL은_403_reauth-required이고_시도·payment가_0이다', async () => {
    const cases: [string, (o: { accountId: string; sessionId: string }) => { sessionId: string; token?: string }][] = [
      ['없음', ({ sessionId }) => ({ sessionId })],
      ['틀림', ({ sessionId }) => ({ sessionId, token: 'not-a-jwt' })],
      ['만료', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId, lifeS: -5 }).t })],
      ['sid 어긋남', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId: randomUUID() }).t })],
      ['sub 어긋남', ({ sessionId }) => ({ sessionId, token: accountToken({ accountId: randomUUID(), sessionId }).t })],
      ['act 어긋남', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId, act: 'FAN_SENSITIVE' }).t })],
      ['op 티켓 취소', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId, op: 'TICKET_CANCEL' }).t })],
      ['op 계좌 재입력(굿즈)', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId, op: 'SHOP_CANCEL_REFUND_ACCOUNT' }).t })],
    ];
    for (const [what, make] of cases) {
      const id = accountPending();
      const r = await postAccount(id, REFUND_ACCOUNT, make({ accountId: ACCOUNT, sessionId: LOGIN }));
      expect(r.statusCode, `${what}: ${r.payload}`).toBe(403);
      expect(accountProblem(r).type, what).toContain('reauth-required');
      expect(state.accountStarts, what).toEqual([]);
      expect(state.paymentCalls, what).toEqual([]);
    }
  });

  test('R-T42 ②_이미_쓴_jti는_403_reauth-required이고_두_번째_취소는_시도가_오르지_않는다', async () => {
    const first = accountPending();
    const second = accountPending();
    const tk = accountToken();
    expect((await postAccount(first, REFUND_ACCOUNT, { token: tk.t })).statusCode).toBe(202);
    const reused = await postAccount(second, REFUND_ACCOUNT, { token: tk.t });
    expect(reused.statusCode, reused.payload).toBe(403);
    expect(accountProblem(reused).type).toContain('reauth-required');
    expect(state.accountStarts).toHaveLength(1);
    expect(state.paymentCalls).toHaveLength(1);
  });

  test('R-T42 ②_팬_공개키_묶음_장애는_503_reauth-unavailable·Retry-After_5초이고_쓰기가_0이다', async () => {
    const id = accountPending();
    const tk = accountToken();
    coldJwks.mode = 'throw';
    try {
      const r = await postAccount(id, REFUND_ACCOUNT, { token: tk.t, svc: coldSvc });
      expect(r.statusCode, r.payload).toBe(503);
      expect(accountProblem(r).type).toContain('reauth-unavailable');
      expect(r.headers['retry-after']).toBe('5');
      expect(coldJwks.urls.length, '장애가 실제로 끼어들었다').toBeGreaterThanOrEqual(1);
    } finally {
      coldJwks.mode = 'up';
    }
    expect(state.accountStarts).toEqual([]);
    expect(state.paymentCalls).toEqual([]);
  });

  test('R-T42 ②_jti_저장소_장애는_503_reauth-unavailable·Retry-After_5초이고_쓰기가_0이다', async () => {
    // 공개키를 미리 받아 둔다
    const warm = accountPending();
    expect((await postAccount(warm, REFUND_ACCOUNT, { token: accountToken().t })).statusCode).toBe(202);
    const id = accountPending();
    const tk = accountToken();
    redis.mode = 'throw';
    try {
      const r = await postAccount(id, REFUND_ACCOUNT, { token: tk.t });
      expect(r.statusCode, r.payload).toBe(503);
      expect(accountProblem(r).type).toContain('reauth-unavailable');
      expect(r.headers['retry-after']).toBe('5');
    } finally {
      redis.mode = 'real';
    }
    expect(state.accountStarts).toHaveLength(1);
    expect(state.paymentCalls).toHaveLength(1);
  });
});

describe('R-T42 ③ 계좌 모양 경계와 결제사 답', () => {
  const CODES = ['02', '03', '06', '07', '11', '12', '20', '23', '27', '31', '32', '34', '35', '37', '39', '45', '48', '50', '54', '64', '71', '81', '88', '89', '90', '92'];

  test('R-T42 ③_토스_은행_코드_26개는_모두_202이고_목록_밖_99·04는_400_invalid-body이며_재인증·payment·행_쓰기가_0이다', async () => {
    expect(CODES).toHaveLength(26);
    for (const bankCode of CODES) {
      const id = accountPending();
      const r = await postAccount(id, { ...REFUND_ACCOUNT, bankCode }, { token: accountToken().t });
      expect(r.statusCode, `${bankCode}: ${r.payload}`).toBe(202);
      expect(state.paymentCalls.at(-1)!.refundAccount).toMatchObject({ bankCode });
    }
    const afterOk = { starts: state.accountStarts.length, pays: state.paymentCalls.length, verifies: state.verifies };
    for (const bankCode of ['99', '04']) {
      const id = accountPending();
      const r = await postAccount(id, { ...REFUND_ACCOUNT, bankCode }, { token: accountToken().t });
      expect(r.statusCode, `${bankCode}: ${r.payload}`).toBe(400);
      expect(accountProblem(r).type, bankCode).toContain('invalid-body');
    }
    expect(state.accountStarts).toHaveLength(afterOk.starts);
    expect(state.paymentCalls).toHaveLength(afterOk.pays);
    expect(state.verifies).toBe(afterOk.verifies);
  });

  test('R-T42 ③_계좌번호_20자·하이픈_섞인_30자·예금주_60자는_202이고_21자·31자·61자는_400이다', async () => {
    const good = [
      { ...REFUND_ACCOUNT, accountNumber: '1'.repeat(20) },
      { ...REFUND_ACCOUNT, accountNumber: '12-34-56-78-90-12-34-56-78-9-0' },
      { ...REFUND_ACCOUNT, holderName: '가'.repeat(60) },
    ];
    for (const body of good) {
      const id = accountPending();
      const r = await postAccount(id, body, { token: accountToken().t });
      expect(r.statusCode, `${JSON.stringify(body).slice(0, 80)}: ${r.payload}`).toBe(202);
    }
    const before = { starts: state.accountStarts.length, pays: state.paymentCalls.length, verifies: state.verifies };
    const bad = [
      { ...REFUND_ACCOUNT, accountNumber: '1'.repeat(21) },
      { ...REFUND_ACCOUNT, accountNumber: '1-2-3-4-5-6-7-8-9-0-1-2-3-4-5-6' },
      { ...REFUND_ACCOUNT, holderName: '가'.repeat(61) },
    ];
    for (const body of bad) {
      const id = accountPending();
      const r = await postAccount(id, body, { token: accountToken().t });
      expect(r.statusCode, `${JSON.stringify(body).slice(0, 80)}: ${r.payload}`).toBe(400);
      expect(accountProblem(r).type).toContain('invalid-body');
    }
    expect(state.accountStarts).toHaveLength(before.starts);
    expect(state.paymentCalls).toHaveLength(before.pays);
    expect(state.verifies).toBe(before.verifies);
  });

  test('R-T42 ⑤_결제사_답_다섯을_행_상태로_옮긴다: CANCELLED→REFUNDED, PENDING/UNKNOWN→REFUND_PENDING·1분, REFUND_ACCOUNT_REQUIRED→422·대기 유지, REJECTED→422·CS', async () => {
    const cancelled = accountPending();
    state.payment = 'CANCELLED';
    expect((await postAccount(cancelled, REFUND_ACCOUNT, { token: accountToken().t })).statusCode).toBe(202);
    expect(state.accountUpdates.at(-1)).toEqual({ cancellationId: cancelled, status: 'REFUNDED' });

    for (const outcome of ['PENDING', 'UNKNOWN'] as const) {
      const id = accountPending();
      state.payment = outcome;
      const r = await postAccount(id, REFUND_ACCOUNT, { token: accountToken().t });
      expect(r.statusCode, `${outcome}: ${r.payload}`).toBe(202);
      expect(JSON.parse(r.payload)).toEqual({ cancellationId: id, status: 'REFUND_PENDING', refundAmount: 30_000 });
      expect(state.accountClears.find((c) => c.cancellationId === id)).toMatchObject({ nextRefundAtMs: NOW + 60_000, lastError: outcome });
    }

    const required = accountPending();
    state.payment = 'REFUND_ACCOUNT_REQUIRED';
    const again = await postAccount(required, REFUND_ACCOUNT, { token: accountToken().t });
    expect(again.statusCode, again.payload).toBe(422);
    expect(accountProblem(again).type).toContain('refund-account-required');
    expect(state.records.get(required)!.refundAccountRequired).toBe(true);

    const rejected = accountPending();
    state.payment = 'REJECTED';
    const no = await postAccount(rejected, REFUND_ACCOUNT, { token: accountToken().t });
    expect(no.statusCode, no.payload).toBe(422);
    expect(accountProblem(no).type).toContain('refund-rejected');
    expect(state.accountFailures).toEqual([{ cancellationId: rejected, attempts: 1, lastError: 'REJECTED' }]);
  });

  test('R-T42 ⑤_계좌번호_원문은_응답과_행_기록에_없다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-16.2.5]', async () => {
    const id = accountPending();
    const r = await postAccount(id, REFUND_ACCOUNT, { token: accountToken().t });
    expect(r.statusCode, r.payload).toBe(202);
    expect(r.payload).not.toContain(ACCOUNT_NO);
    expect(r.payload).not.toContain(HOLDER);
    expect(JSON.stringify(state.records.get(id))).not.toContain(ACCOUNT_NO);
    expect(JSON.stringify(state.accountStarts)).not.toContain(ACCOUNT_NO);
    expect(logs.join('\n')).not.toContain(ACCOUNT_NO);
  });
});


describe('P-T73 ⑤ 다시 누름의 계좌는 payment로 가지 않는다(RV-02, 검증 A05)', () => {
  /** 앞 팬 취소(첫 취소 ID)가 REFUND_PENDING으로 남은 표: ticket-svc 대역은 새 키에 ALREADY_CANCELLED로 첫 취소를 알린다 */
  const pressedBefore = (t: string) => {
    const first = randomUUID();
    state.records.set(first, { cancellationId: first, orderId: ORDER, ticketId: t, refundAmount: 30_000, state: 'REFUND_PENDING', refundAttempts: 1 });
    state.ticketAnswer.set(t, { result: 'ALREADY_CANCELLED', firstCancellationId: first, firstResult: 'REFUND_NOW', firstCancelledAtMs: NOW - 60_000 });
    return first;
  };

  test('P-T73 ⑤ 가상계좌 표를 새 멱등 키로 다시 누르며 본문에 계좌를 실어도 payment 대역이 받은 호출(첫 취소 ID)에 refundAccount가 없다', async () => {
    const t = ticket();
    const first = pressedBefore(t);
    const r = await send(t, { refundAccount: REFUND_ACCOUNT });
    expect(r.statusCode).toBe(202);
    expect(state.paymentCalls.map((c) => c.cancellationId)).toEqual([first]);
  });

  test('P-T73 ⑤ 공연 시작 뒤 다시 누름(견적 EVENT_STARTED, ticket 대역 ALREADY_CANCELLED·REFUND_NOW)에 실은 계좌도 payment 대역이 받지 않는다', async () => {
    const t = ticket();
    // 공연 시작 = 판매 종료 + 24시간 ≤ 지금
    state.saleEndsOf.set(t, NOW - 25 * 3_600_000);
    const first = pressedBefore(t);
    const r = await send(t, { refundAccount: REFUND_ACCOUNT });
    expect(r.statusCode).toBe(202);
    expect(state.paymentCalls.map((c) => c.cancellationId)).toEqual([first]);
  });
});

interface ShapeRow {
  name: string;
  input: { bankCode: string; accountNumber: string; holderName: string };
  ok: boolean;
}
const SHAPES = (JSON.parse(readFileSync(fileURLToPath(new URL('../../../packages/validation/test/fixtures/refund-account-cases.json', import.meta.url)), 'utf8')) as { cases: ShapeRow[] }).cases;

describe('P-T74 ① 본문 계좌 모양(RV-04, 공용 표 packages/validation/test/fixtures/refund-account-cases.json)', () => {
  test('P-T74 ① 표의 틀린 모양은 각각 400 invalid-body이고 재인증 확인·결제 수단 읽기·Saga(ticket·payment 취소, order_cancellation 쓰기)가 0이다', async () => {
    const bad = SHAPES.filter((c) => !c.ok);
    expect(bad).toHaveLength(8);
    for (const c of bad) {
      state.verifies = 0;
      state.lookups.length = 0;
      const r = await send(ticket(), { refundAccount: c.input });
      expect(r.statusCode, c.name).toBe(400);
      expect(r.body.type, c.name).toBe(`${PROBLEM_TYPE_BASE}invalid-body`);
      expect(state.verifies, `${c.name}: 재인증 확인`).toBe(0);
      expect(state.lookups, `${c.name}: 결제 수단 읽기`).toEqual([]);
      nothingRan(c.name);
    }
  });

  test('P-T74 ① 경계 대조(숫자 20자·하이픈 섞인 30자·예금주 60자 등 표의 맞는 모양)는 지나 202이고 payment 대역이 받은 계좌는 본문 그대로다', async () => {
    for (const c of SHAPES.filter((x) => x.ok)) {
      state.paymentCalls.length = 0;
      const r = await send(ticket(), { refundAccount: c.input });
      expect(r.statusCode, c.name).toBe(202);
      expect(state.paymentCalls, c.name).toHaveLength(1);
    }
  });
});
