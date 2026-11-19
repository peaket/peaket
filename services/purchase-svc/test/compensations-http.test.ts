// 배상 목록·상세·계좌 입력 HTTP 시험(R-T46 ③·R-T47 ①~②, BAT-425, ADR-0317).
// 정본: docs/features/transfer-refund.md §6 '배상금 지급의 첫 구현'·§11 R-T46·R-T47, docs/api/openapi.yaml
// listCompensations·getCompensation·createCompensationAccount, docs/features/settlement.md §7.
// 그 계정이 결제한 주문의 배상만 주고, 없거나 남의 건은 같은 404다. 응답·저장에는 계좌번호 원문이 없고 accountLast4만 있다.
// 계좌 입력은 ACCOUNT_PENDING에만 받고(그 밖 409), 재인증 op COMPENSATION_ACCOUNT·act FAN_HIGH_RISK, jti 한 번 쓰기다.
// payment-svc 송금 대역의 답(REQUESTED·PAID·FAILED·UNAVAILABLE)을 purchase 행 상태·HTTP 답으로 옮기는지 본다.
// 실제 PostgreSQL 행·유일 인덱스는 test-int/compensation-transfer.int.test.ts(payment)·R-T46 통합 몫이다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, RedisReauthJtiStore } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import {
  CompensationTransferUnavailable,
  JwksFanReauthGate,
  WeekendBusinessCalendar,
  type CancellationOrderView,
  type CancellationRecord,
  type CancellationWrites,
  type CompensationCaseNotice,
  type CompensationRecord,
  type CompensationStore,
  type CompensationTransfer,
  type CompensationTransferResult,
  type CompensationView,
} from '../src/modules/refund/index.js';
import { fakeJwksFetch, fakeSeatRedis, fanKey, ISS, JWKS_URL, reauthClaims, signReauth } from './fan-reauth-fixtures.js';

const NOW = Date.parse('2026-11-20T07:10:00+09:00');
const KEY = Buffer.alloc(32, 9);
const ACCOUNT = '0193b425-0000-7000-8000-000000000201';
const LOGIN = '0193b425-0000-7000-8000-000000000202';
const PSID = '0193b425-0000-7000-8000-000000000203';
const EVENT = '0193b425-0000-7000-8000-000000000204';
const ORDER = '0193b425-0000-7000-8000-000000000205';
/** 계획 §5의 계좌 글. 배상은 33,333원 표 하나 → 10% 원 미만 올림 3,334원 */
const ACCOUNT_NO = '110-987-654321';
const HOLDER = '김배상';
const REFUND_ACCOUNT = { bankCode: '88', accountNumber: ACCOUNT_NO, holderName: HOLDER };
const fan = fanKey('fan-2026-11-b425-comp');

/** 시험 값은 코드 상수와 다르게 고른다. 33,333원의 10% = 3,333.3 → 올림 3,334원 */
const BASE_AMOUNT = 33_333;
const COMP_AMOUNT = 3_334;

const logs: string[] = [];

interface Rec extends CompensationRecord {}
const records = new Map<string, Rec>();
const transfers: Parameters<CompensationTransfer['request']>[0][] = [];
const notices: Parameters<CompensationCaseNotice['open']>[0][] = [];
const transferAnswers = { next: { status: 'REQUESTED', transferId: 'tr_bat425_1' } as CompensationTransferResult, unavailable: false };

const viewOf = (r: Rec): CompensationView => ({
  compensationId: r.compensationId,
  orderId: r.orderId,
  amount: r.amount,
  status: r.status,
  ...(r.accountLast4 === undefined ? {} : { accountLast4: r.accountLast4 }),
  ...(r.eventId === '' ? {} : { eventId: r.eventId }),
  ...(r.failureReason === undefined ? {} : {}),
  createdAt: new Date(r.createdAtMs).toISOString(),
});

const store: CompensationStore = {
  list: async (accountId, q) => {
    const all = [...records.values()].filter((r) => r.accountId === accountId).sort((a, b) => b.createdAtMs - a.createdAtMs || b.compensationId.localeCompare(a.compensationId));
    const limit = q?.limit ?? 20;
    return { items: all.slice(0, limit).map(viewOf), nextCursor: all.length > limit ? 'next' : null };
  },
  get: async (accountId, compensationId) => {
    const r = records.get(compensationId);
    return r && r.accountId === accountId ? viewOf(r) : undefined;
  },
  findForAccount: async (accountId, compensationId) => {
    const r = records.get(compensationId);
    return r && r.accountId === accountId ? { ...r } : undefined;
  },
  saveTransfer: async (q) => {
    const r = records.get(q.compensationId);
    if (!r) return undefined;
    // ACCOUNT_PENDING에만 쓴다(그사이 다른 요청이 끝냈으면 지금 행)
    if (r.status === 'ACCOUNT_PENDING') {
      records.set(q.compensationId, {
        ...r,
        status: q.status,
        accountLast4: q.accountLast4,
        ...(q.transferId === undefined ? {} : { transferId: q.transferId }),
        ...(q.receivableId === undefined ? {} : { receivableId: q.receivableId }),
        ...(q.failureReason === undefined ? {} : { failureReason: q.failureReason }),
        updatedAtMs: q.nowMs,
      });
    }
    return { ...records.get(q.compensationId)! };
  },
};

const transfer: CompensationTransfer = {
  request: async (q) => {
    transfers.push(q);
    if (transferAnswers.unavailable) throw new CompensationTransferUnavailable();
    const answer = transferAnswers.next;
    if (answer.status === 'FAILED') return answer;
    return { ...answer, accountLast4: q.account.accountNumber.replace(/-/g, '').slice(-4) };
  },
};

const notice: CompensationCaseNotice = { open: async (q) => void notices.push(q) };

const inertOrders = {
  findByTicket: async (id: string): Promise<CancellationOrderView> => ({
    orderId: ORDER,
    eventId: EVENT,
    ticketId: id,
    seatId: randomUUID(),
    payerAccountId: ACCOUNT,
    ticketPrice: 33_333,
    bookedAtMs: NOW - 86_400_000,
    saleEndsAtMs: NOW + 86_400_000,
    orderStatus: 'CONFIRMED',
  }),
  findCancellation: async (): Promise<CancellationRecord | undefined> => undefined,
};
const inertWrites: CancellationWrites = {
  create: async () => ({ status: 'CREATED' }),
  updateStatus: async () => undefined,
  scheduleRefundRetry: async () => undefined,
  markRefundFailed: async () => undefined,
  markRefundAccountRequired: async () => undefined,
  dueRefunds: async () => [],
};

const redis = fakeSeatRedis();
const jwks = fakeJwksFetch([fan]);
let svc: Awaited<ReturnType<typeof createService>>;

beforeAll(async () => {
  const sessions = new MemoryPurchaseSessions();
  sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: 'journey', loginSessionId: LOGIN, key: KEY });
  const reauth = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock: fakeClock({ now: NOW }), fetch: jwks.fetch });
  svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      refund: {
        orders: inertOrders,
        tickets: { cancel: async () => 'REFUND_NOW' },
        payments: { cancel: async () => 'CANCELLED' },
        writes: inertWrites,
        calendar: new WeekendBusinessCalendar(),
        compensationStore: store,
        compensationTransfer: transfer,
        compensationNotice: notice,
        reauth,
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
  records.clear();
  transfers.length = 0;
  notices.length = 0;
  logs.length = 0;
  redis.commands.length = 0;
  transferAnswers.next = { status: 'REQUESTED', transferId: 'tr_bat425_1' };
  transferAnswers.unavailable = false;
});

const fanHeaders = { 'x-user-id': ACCOUNT, 'x-session-id': LOGIN, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy' };
const seed = (over: Partial<Rec> = {}): Rec => {
  const r: Rec = {
    compensationId: randomUUID(),
    eventCancellationRequestId: randomUUID(),
    orderId: ORDER,
    eventId: EVENT,
    accountId: ACCOUNT,
    baseAmount: BASE_AMOUNT,
    amount: COMP_AMOUNT,
    status: 'ACCOUNT_PENDING',
    createdAtMs: NOW - 60_000,
    updatedAtMs: NOW - 60_000,
    ...over,
  };
  records.set(r.compensationId, r);
  return r;
};
const accountToken = (o: { accountId?: string; sessionId?: string; act?: string; op?: string; lifeS?: number; jti?: string } = {}) => {
  const claims = reauthClaims({
    nowMs: NOW,
    accountId: o.accountId ?? ACCOUNT,
    sessionId: o.sessionId ?? LOGIN,
    act: o.act ?? 'FAN_HIGH_RISK',
    op: o.op ?? 'COMPENSATION_ACCOUNT',
    lifeS: o.lifeS ?? 180,
    ...(o.jti === undefined ? {} : { jti: o.jti }),
  });
  return signReauth(fan, claims);
};
const postAccount = (id: string, o: { body?: Record<string, unknown>; token?: string; accountId?: string; sessionId?: string; key?: string } = {}) =>
  svc.http.inject({
    method: 'POST',
    url: `/v1/compensations/${id}/account`,
    headers: {
      ...fanHeaders,
      'x-user-id': o.accountId ?? ACCOUNT,
      'x-session-id': o.sessionId ?? LOGIN,
      'content-type': 'application/json',
      'idempotency-key': o.key ?? randomUUID(),
      ...(o.token === undefined ? {} : { 'x-reauth-token': o.token }),
    },
    payload: JSON.stringify(o.body ?? REFUND_ACCOUNT),
  });
const problem = (r: { statusCode: number; payload: string }) => {
  const b = JSON.parse(r.payload) as { type?: string; title?: string };
  return { status: r.statusCode, type: String(b.type ?? '').replace(/^.*\/problems\//, ''), title: b.title };
};

describe('R-T46 ③ 배상 목록·상세(내 건만, 같은 404, 계좌 끝 4자리만)', () => {
  test('R-T46 ③_목록은_내_배상만_최근_순으로_주고_계좌번호_원문은_없다_남의_건과_없는_건은_같은_404다', async () => {
    const mine = seed({ accountLast4: '4321', status: 'PAID' });
    const other = seed({ accountId: randomUUID() });
    const list = await svc.http.inject({ method: 'GET', url: '/v1/compensations', headers: fanHeaders });
    expect(list.statusCode, list.payload).toBe(200);
    const body = JSON.parse(list.payload) as { items: CompensationView[]; nextCursor: string | null };
    expect(body.items.map((i) => i.compensationId)).toEqual([mine.compensationId]);
    expect(body.items[0]).toMatchObject({ amount: COMP_AMOUNT, status: 'PAID', accountLast4: '4321' });
    expect(list.payload).not.toContain(ACCOUNT_NO);
    expect(String(list.headers['cache-control'])).toContain('no-store');

    const own = await svc.http.inject({ method: 'GET', url: `/v1/compensations/${mine.compensationId}`, headers: fanHeaders });
    expect(own.statusCode, own.payload).toBe(200);
    expect(JSON.parse(own.payload)).toMatchObject({ compensationId: mine.compensationId, accountLast4: '4321' });
    expect(own.payload).not.toContain(ACCOUNT_NO);
    const foreign = await svc.http.inject({ method: 'GET', url: `/v1/compensations/${other.compensationId}`, headers: fanHeaders });
    const missing = await svc.http.inject({ method: 'GET', url: `/v1/compensations/${randomUUID()}`, headers: fanHeaders });
    expect(problem(foreign)).toEqual(problem(missing));
    expect(foreign.statusCode).toBe(404);
    expect(problem(foreign).type).toContain('not-found');
  });

  test('R-T46 ③_남의_건_계좌_입력은_404이고_transfer·저장이_0이다 [ASVS v5.0.0-8.2.2]', async () => {
    const other = seed({ accountId: randomUUID() });
    const missing = randomUUID();
    const a = await postAccount(other.compensationId, { token: accountToken() });
    const b = await postAccount(missing, { token: accountToken() });
    expect(problem(a)).toEqual(problem(b));
    expect(a.statusCode).toBe(404);
    expect(transfers).toEqual([]);
    expect(records.get(other.compensationId)!.status).toBe('ACCOUNT_PENDING');
  });
});

describe('R-T47 ① 배상 계좌 입력(202·409·403·503)', () => {
  test('R-T47 ①_ACCOUNT_PENDING에_계좌를_넣으면_202이고_송금_요청_금액은_주문_단위_10퍼센트_올림_3,334원이다', async () => {
    const r = seed();
    const res = await postAccount(r.compensationId, { token: accountToken() });
    expect(res.statusCode, res.payload).toBe(202);
    const body = JSON.parse(res.payload) as CompensationView;
    expect(body).toMatchObject({ compensationId: r.compensationId, amount: COMP_AMOUNT, status: 'REQUESTED', accountLast4: '4321' });
    expect(transfers).toEqual([
      expect.objectContaining({
        compensationId: r.compensationId,
        orderId: ORDER,
        accountId: ACCOUNT,
        eventId: EVENT,
        amount: COMP_AMOUNT,
        account: REFUND_ACCOUNT,
      }),
    ]);
    expect(records.get(r.compensationId)).toMatchObject({ status: 'REQUESTED', accountLast4: '4321', transferId: 'tr_bat425_1' });
  });

  test('R-T47 ①_PAID·FAILED·REQUESTED·계좌_대기_아님은_409_compensation-not-account-pending이고_transfer가_0이다', async () => {
    for (const status of ['PAID', 'FAILED', 'REQUESTED'] as const) {
      const r = seed({ status });
      const res = await postAccount(r.compensationId, { token: accountToken() });
      expect(res.statusCode, `${status}: ${res.payload}`).toBe(409);
      expect(problem(res).type).toContain('compensation-not-account-pending');
    }
    expect(transfers).toEqual([]);
  });

  test('R-T47 ①_재인증_없음·틀림·만료·sid/sub/act/op_어긋남·TICKET_CANCEL은_403이고_transfer·저장이_0이다', async () => {
    const cases: [string, (o: { accountId: string; sessionId: string }) => { token?: string; sessionId: string }][] = [
      ['없음', ({ sessionId }) => ({ sessionId })],
      ['틀림', ({ sessionId }) => ({ sessionId, token: 'not-a-jwt' })],
      ['만료', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId, lifeS: -5 }) })],
      ['sid 어긋남', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId: randomUUID() }) })],
      ['sub 어긋남', ({ sessionId }) => ({ sessionId, token: accountToken({ accountId: randomUUID(), sessionId }) })],
      ['act 어긋남', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId, act: 'FAN_SENSITIVE' }) })],
      ['op 티켓 취소', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId, op: 'TICKET_CANCEL' }) })],
      ['op 환급 계좌', ({ accountId, sessionId }) => ({ sessionId, token: accountToken({ accountId, sessionId, op: 'REFUND_ACCOUNT' }) })],
    ];
    for (const [what, make] of cases) {
      const r = seed();
      const res = await postAccount(r.compensationId, { ...make({ accountId: ACCOUNT, sessionId: LOGIN }) });
      expect(res.statusCode, `${what}: ${res.payload}`).toBe(403);
      expect(problem(res).type, what).toContain('reauth-required');
      expect(transfers, what).toEqual([]);
      expect(records.get(r.compensationId)!.status, what).toBe('ACCOUNT_PENDING');
    }
  });

  test('R-T47 ①_이미_쓴_jti는_403이고_두_번째_배상은_송금되지_않는다', async () => {
    const first = seed();
    const second = seed();
    const tk = accountToken();
    expect((await postAccount(first.compensationId, { token: tk })).statusCode).toBe(202);
    const res = await postAccount(second.compensationId, { token: tk });
    expect(res.statusCode, res.payload).toBe(403);
    expect(problem(res).type).toContain('reauth-required');
    expect(transfers).toHaveLength(1);
    expect(records.get(second.compensationId)!.status).toBe('ACCOUNT_PENDING');
  });

  test('R-T47 ①_UNAVAILABLE은_503_compensation-transfer-unavailable·Retry-After_5초이고_행은_ACCOUNT_PENDING_그대로다', async () => {
    const r = seed();
    transferAnswers.unavailable = true;
    const res = await postAccount(r.compensationId, { token: accountToken() });
    expect(res.statusCode, res.payload).toBe(503);
    expect(problem(res).type).toContain('compensation-transfer-unavailable');
    expect(res.headers['retry-after']).toBe('5');
    expect(records.get(r.compensationId)!.status).toBe('ACCOUNT_PENDING');
  });

  test('R-T47 ②_REQUESTED·PAID는_저장하고_FAILED는_422_compensation-transfer-failed에_CS_배상_대기_한_건이다', async () => {
    const requested = seed();
    transferAnswers.next = { status: 'REQUESTED', transferId: 'tr_req_1' };
    const a = await postAccount(requested.compensationId, { token: accountToken() });
    expect(a.statusCode, a.payload).toBe(202);
    expect(JSON.parse(a.payload)).toMatchObject({ status: 'REQUESTED', accountLast4: '4321' });
    expect(records.get(requested.compensationId)).toMatchObject({ status: 'REQUESTED', transferId: 'tr_req_1' });

    const paid = seed();
    transferAnswers.next = { status: 'PAID', transferId: 'tr_paid_1', receivableId: randomUUID() };
    const b = await postAccount(paid.compensationId, { token: accountToken() });
    expect(b.statusCode, b.payload).toBe(202);
    expect(JSON.parse(b.payload)).toMatchObject({ status: 'PAID', accountLast4: '4321' });
    expect(records.get(paid.compensationId)).toMatchObject({ status: 'PAID', transferId: 'tr_paid_1' });
    expect(records.get(paid.compensationId)!.receivableId).toEqual(expect.any(String));

    const failed = seed();
    transferAnswers.next = { status: 'FAILED', transferId: '', failureReason: 'PG_REJECTED' };
    const c = await postAccount(failed.compensationId, { token: accountToken() });
    expect(c.statusCode, c.payload).toBe(422);
    expect(problem(c).type).toContain('compensation-transfer-failed');
    expect(records.get(failed.compensationId)).toMatchObject({ status: 'FAILED', failureReason: 'PG_REJECTED' });
    expect(notices).toEqual([{ compensationId: failed.compensationId, orderId: ORDER, nowMs: NOW }]);
    expect(notices[0]!.compensationId).toBe(failed.compensationId);
  });

  test('R-T47 ②_계좌_끝_4자리만_응답·저장·로그에_남고_계좌번호_원문은_0건이다 [ASVS v5.0.0-8.2.3] [ASVS v5.0.0-16.2.5]', async () => {
    const r = seed();
    const res = await postAccount(r.compensationId, { token: accountToken() });
    expect(res.statusCode, res.payload).toBe(202);
    expect(res.payload).not.toContain(ACCOUNT_NO);
    expect(res.payload).not.toContain(HOLDER);
    const saved = JSON.stringify(records.get(r.compensationId));
    expect(saved).not.toContain(ACCOUNT_NO);
    expect(saved).toContain('4321');
    expect(logs.join('\n')).not.toContain(ACCOUNT_NO);
    expect(JSON.stringify(transfers)).toContain(ACCOUNT_NO); // 송금 요청에는 원문이 실린다(저장하지 않는다)
  });
});

describe('R-T46 ③ 모양 경계는 배상 계좌에도 같다', () => {
  test('R-T46 ③_목록_밖_은행_코드_99는_400이고_재인증·송금이_0이며_26개_코드는_202다', async () => {
    const bad = seed();
    const before = { transfers: transfers.length, redis: redis.commands.length };
    const r = await postAccount(bad.compensationId, { body: { ...REFUND_ACCOUNT, bankCode: '99' }, token: accountToken() });
    expect(r.statusCode, r.payload).toBe(400);
    expect(problem(r).type).toBe('invalid-body');
    expect(transfers).toHaveLength(before.transfers);
    expect(redis.commands).toHaveLength(before.redis);

    const codes = ['02', '03', '06', '07', '11', '12', '20', '23', '27', '31', '32', '34', '35', '37', '39', '45', '48', '50', '54', '64', '71', '81', '88', '89', '90', '92'];
    expect(codes).toHaveLength(26);
    for (const bankCode of codes) {
      const x = seed();
      const ok = await postAccount(x.compensationId, { body: { ...REFUND_ACCOUNT, bankCode }, token: accountToken() });
      expect(ok.statusCode, `${bankCode}: ${ok.payload}`).toBe(202);
    }
  });
});
