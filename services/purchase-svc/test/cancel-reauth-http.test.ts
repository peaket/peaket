// 팬 예매 취소의 재인증 확인을 HTTP 바깥 경계에서 본다(R-T39 ①~⑤, BAT-415-reauth, 시험 담당 l3-b415r-test).
// 정본: docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'·§11 R-T39, docs/security/authz-matrix.md §6 '작업 묶음 `act`의 값',
// docs/data.md §3 `reauth:jti:{jti}`, docs/api/openapi.yaml createTicketCancellation 403·503.
// AppModule 메모리 조립에 실제 JwksFanReauthGate를 꽂고, 시험 안에서 만든 ES256 키의 팬 공개키 묶음을 가짜 fetch가 주며,
// jti 저장소는 플랫폼 RedisReauthJtiStore에 명령을 적는 가짜 좌석 Redis를 넘긴다. 토큰 수명은 5분 상수와 다른 180초다.
// 판정만이 아니라 컨트롤러가 그 결과를 써서 Saga(ticket-svc·payment-svc 호출, order_cancellation 쓰기)를 부르지 않는지까지 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { createService, fakeClock, PROBLEM_TYPE_BASE, purchaseMac, purchaseMacInput, RedisReauthJtiStore } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryPurchaseSessions } from '../src/modules/inventory/index.js';
import {
  JwksFanReauthGate,
  ReauthUnavailable,
  WeekendBusinessCalendar,
  type CancellationOrderView,
  type CancellationRecord,
  type CancellationWrites,
  type ReauthGate,
} from '../src/modules/refund/index.js';
import { DEFAULT_ISS, fakeJwksFetch, fakeSeatRedis, fanKey, ISS, JWKS_URL, reauthClaims, signReauth } from './fan-reauth-fixtures.js';

const NOW = Date.parse('2026-11-13T10:00:00+09:00');
const NOW_S = NOW / 1000;
const KEY = Buffer.alloc(32, 7);
const ACCOUNT = '0193a100-0000-7000-8000-000000000001';
const OTHER_ACCOUNT = '0193a100-0000-7000-8000-000000000009';
const LOGIN = '0193a100-0000-7000-8000-000000000002';
const OTHER_LOGIN = '0193a100-0000-7000-8000-00000000000a';
const PSID = '0193a100-0000-7000-8000-000000000003';
const EVENT = '0193a100-0000-7000-8000-000000000004';
const SEAT = '0193a100-0000-7000-8000-000000000006';
const ORDER = '0193a100-0000-7000-8000-000000000007';
const quiet = new Writable({ write: (_c, _e, cb) => cb() });
const fan = fanKey('fan-2026-11');
const admin = fanKey('admin-2026-11');
const impostor = fanKey('fan-2026-11'); // 같은 kid, 다른 키
const REFUND_ACCOUNT = { bankCode: '088', accountNumber: '110-123-456789', holderName: '김결제' };

/** 결제자 ACCOUNT의 표. 견적 시험(refund-http)과 같은 표: 33,333원, 공제 10% → 환급 30,000원(transfer-refund §2) */
const viewOf = (ticketId: string): CancellationOrderView => ({
  orderId: ORDER,
  eventId: EVENT,
  ticketId,
  seatId: SEAT,
  payerAccountId: ACCOUNT,
  ticketPrice: 33_333,
  bookedAtMs: Date.parse('2026-11-01T10:00:00+09:00'),
  saleEndsAtMs: Date.parse('2026-11-19T19:00:00+09:00'),
  entryOpensAtMs: Date.parse('2026-11-20T18:00:00+09:00'),
  orderStatus: 'CONFIRMED',
});

interface Harness {
  svc: Awaited<ReturnType<typeof createService>>;
  ticketCalls: unknown[];
  paymentCalls: { refundAccount?: unknown }[];
  created: unknown[];
  send(o: { ticketId?: string; token?: string; body?: unknown; idem?: string; badMac?: boolean }): Promise<{ statusCode: number; payload: string; headers: Record<string, unknown> }>;
  reset(): void;
}

/** 메모리 조립. 취소 기록은 가짜 저장소에 남겨 같은 취소 ID의 다시 보냄이 앞 결과를 받게 한다 */
async function boot(reauth: ReauthGate): Promise<Harness> {
  const sessions = new MemoryPurchaseSessions();
  sessions.open({ sessionId: PSID, accountId: ACCOUNT, eventId: EVENT, journeyId: 'journey', loginSessionId: LOGIN, key: KEY });
  const ticketCalls: unknown[] = [];
  const paymentCalls: { refundAccount?: unknown }[] = [];
  const created: unknown[] = [];
  const records = new Map<string, CancellationRecord>();
  const writes: CancellationWrites = {
    create: async (q) => {
      created.push(q);
      records.set(q.cancellationId, { cancellationId: q.cancellationId, orderId: q.orderId, ticketId: q.ticketId, refundAmount: q.refundAmount, state: q.status, refundAttempts: 0 });
      return { status: 'CREATED' };
    },
    updateStatus: async (q) => {
      const r = records.get(q.cancellationId);
      if (r) records.set(q.cancellationId, { ...r, state: q.status });
    },
    scheduleRefundRetry: async () => undefined,
    markRefundFailed: async () => undefined,
    dueRefunds: async () => [],
  };
  const clock = fakeClock({ now: NOW });
  const svc = await createService({
    name: 'purchase-svc',
    module: AppModule.register({
      memory: true,
      sessions,
      refund: {
        orders: { findByTicket: async (id) => viewOf(id), findCancellation: async (id) => records.get(id) },
        tickets: {
          cancel: async (q) => {
            ticketCalls.push(q);
            return 'REFUND_NOW';
          },
        },
        payments: {
          cancel: async (q) => {
            paymentCalls.push(q);
            return 'CANCELLED';
          },
        },
        writes,
        calendar: new WeekendBusinessCalendar(),
        reauth,
      },
    }),
    purchaseSessions: sessions,
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet,
  });
  let seq = 0;
  return {
    svc,
    ticketCalls,
    paymentCalls,
    created,
    reset() {
      ticketCalls.length = 0;
      paymentCalls.length = 0;
      created.length = 0;
    },
    async send(o) {
      const ticketId = o.ticketId ?? randomUUID();
      const url = `/v1/tickets/${ticketId}/cancellation`;
      const payload = JSON.stringify(o.body ?? {});
      seq += 1;
      const mac = purchaseMac(KEY, purchaseMacInput('POST', url, seq, Buffer.from(payload, 'utf8')));
      return svc.http.inject({
        method: 'POST',
        url,
        headers: {
          'x-user-id': ACCOUNT,
          'x-session-id': LOGIN,
          'x-user-aud': 'fan',
          'x-user-scope': 'ticket:buy',
          'content-type': 'application/json',
          'idempotency-key': o.idem ?? randomUUID(),
          'x-purchase-seq': String(seq),
          'x-purchase-mac': o.badMac ? purchaseMac(Buffer.alloc(32, 9), purchaseMacInput('POST', url, seq, Buffer.from(payload, 'utf8'))) : mac,
          ...(o.token !== undefined ? { 'x-reauth-token': o.token } : {}),
        },
        payload,
      });
    },
  };
}

const problemType = (payload: string) => (JSON.parse(payload) as { type: string }).type;
const good = (over: Record<string, unknown> = {}, act = 'FAN_SENSITIVE') => reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN, act }, over);
const setOf = (jti: string, px: string) => ['SET', `reauth:jti:${jti}`, '1', 'NX', 'PX', px];

describe('팬 취소 재인증: 실제 확인기 조립 [BAT-415-reauth]', () => {
  let h: Harness;
  let redis: ReturnType<typeof fakeSeatRedis>;
  let jwks: ReturnType<typeof fakeJwksFetch>;
  beforeAll(async () => {
    redis = fakeSeatRedis();
    jwks = fakeJwksFetch([fan]);
    const gate = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock: fakeClock({ now: NOW }), fetch: jwks.fetch });
    h = await boot(gate);
  });
  afterAll(async () => {
    await h?.svc.close();
  });

  test('R-T39 ① 같은 세션·계정의 FAN_SENSITIVE 토큰이면 취소가 202이고 Saga가 한 번 돈다', async () => {
    h.reset();
    redis.commands.length = 0;
    const claims = good();
    const idem = randomUUID();
    const r = await h.send({ token: signReauth(fan, claims), idem });
    expect(r.statusCode).toBe(202);
    expect(JSON.parse(r.payload)).toEqual({ cancellationId: idem, status: 'REFUNDED', refundAmount: 30_000 });
    expect(h.ticketCalls).toHaveLength(1);
    expect(h.paymentCalls).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    // 수명 = min(5분, exp − 지금) = 180초(docs/data.md §3 `reauth:jti:{jti}`)
    expect(redis.commands).toEqual([setOf(claims.jti as string, '180000')]);
  });

  test('R-T39 ② 토큰이 없거나 맞지 않으면 403 reauth-required이고 아무것도 부르지 않는다', async () => {
    const cases: [string, string | undefined, unknown?][] = [
      ['머리 없음', undefined],
      ['빈 값', ''],
      ['형식 깨짐', 'not-a-jwt'],
      ['만료(exp = 지금)', signReauth(fan, good({ exp: NOW_S }))],
      ['다른 세션(sid)', signReauth(fan, good({ sid: OTHER_LOGIN }))],
      ['다른 계정(sub)', signReauth(fan, good({ sub: OTHER_ACCOUNT }))],
      ['계좌 없는 본문에 FAN_HIGH_RISK', signReauth(fan, good({}, 'FAN_HIGH_RISK'))],
      ['BOOKER_EXPORT', signReauth(fan, good({}, 'BOOKER_EXPORT'))],
      ['OPS_COMMAND', signReauth(fan, good({}, 'OPS_COMMAND'))],
      ['act 없음', signReauth(fan, good({ act: undefined }))],
      ['jti 없음', signReauth(fan, good({ jti: undefined }))],
      ['관리 키로 서명(팬 묶음에 없는 kid)', signReauth(admin, good())],
      ['같은 kid의 다른 키로 서명', signReauth(fan, good(), { signWith: impostor.priv })],
      ['액세스 토큰(typ at+jwt)', signReauth(fan, good(), { header: { typ: 'at+jwt' } })],
      ['aud partner', signReauth(fan, good({ aud: 'partner' }))],
      ['iss 기본값(설정한 발급자와 다름)', signReauth(fan, good({ iss: DEFAULT_ISS }))],
      ['iss 다른 곳', signReauth(fan, good({ iss: 'https://evil.test' }))],
    ];
    for (const [what, token] of cases) {
      h.reset();
      redis.commands.length = 0;
      const r = await h.send({ token });
      expect(r.statusCode, what).toBe(403);
      expect(problemType(r.payload), what).toBe(`${PROBLEM_TYPE_BASE}reauth-required`);
      expect(h.ticketCalls, what).toHaveLength(0);
      expect(h.paymentCalls, what).toHaveLength(0);
      expect(h.created, what).toHaveLength(0);
      expect(redis.commands, `${what}: jti를 잡지 않는다`).toHaveLength(0);
    }
  });

  test('R-T39 ② 경계 대조: exp가 지금 + 1초면 202이고 jti 수명은 1,000ms다', async () => {
    h.reset();
    redis.commands.length = 0;
    const claims = good({ exp: NOW_S + 1 });
    const r = await h.send({ token: signReauth(fan, claims) });
    expect(r.statusCode).toBe(202);
    expect(h.ticketCalls).toHaveLength(1);
    expect(redis.commands).toEqual([setOf(claims.jti as string, '1000')]);
  });

  test('R-T39 ③ 쓴 토큰은 다른 표에 다시 못 쓰고 Saga를 부르지 않는다', async () => {
    h.reset();
    redis.commands.length = 0;
    const claims = good();
    const token = signReauth(fan, claims);
    const first = await h.send({ token });
    expect(first.statusCode).toBe(202);
    const second = await h.send({ token });
    expect(second.statusCode).toBe(403);
    expect(problemType(second.payload)).toBe(`${PROBLEM_TYPE_BASE}reauth-required`);
    expect(h.ticketCalls, '두 번째는 ticket-svc를 부르지 않는다').toHaveLength(1);
    expect(h.paymentCalls).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    // 두 번째도 확인을 마친 뒤 같은 키를 잡으려 했고 이미 있어 막혔다
    expect(redis.commands).toEqual([setOf(claims.jti as string, '180000'), setOf(claims.jti as string, '180000')]);
  });

  test('R-T39 ③ 구매 서명에서 막힌 요청(401)은 토큰을 잡지 않아 같은 토큰으로 바른 요청이 202다', async () => {
    h.reset();
    redis.commands.length = 0;
    const token = signReauth(fan, good());
    const ticketId = randomUUID();
    const bad = await h.send({ ticketId, token, badMac: true });
    expect(bad.statusCode).toBe(401);
    expect(redis.commands, '401 요청은 jti를 잡지 않는다').toHaveLength(0);
    expect(h.ticketCalls).toHaveLength(0);
    const ok = await h.send({ ticketId, token });
    expect(ok.statusCode).toBe(202);
    expect(h.ticketCalls).toHaveLength(1);
    expect(redis.commands).toHaveLength(1);
  });

  test('R-T39 ③ 본문 검사에서 막힌 요청(400)은 토큰을 잡지 않아 같은 토큰으로 바른 요청이 202다', async () => {
    h.reset();
    redis.commands.length = 0;
    const token = signReauth(fan, good());
    const ticketId = randomUUID();
    const bad = await h.send({ ticketId, token, body: { unknown: true } });
    expect(bad.statusCode).toBe(400);
    expect(redis.commands, '400 요청은 jti를 잡지 않는다').toHaveLength(0);
    const ok = await h.send({ ticketId, token });
    expect(ok.statusCode).toBe(202);
    expect(redis.commands).toHaveLength(1);
  });

  test('R-T39 ③ 같은 Idempotency-Key를 새 토큰으로 다시 보내면 처음 취소 ID로 202이고 환급은 한 번이다', async () => {
    h.reset();
    const idem = randomUUID();
    const ticketId = randomUUID();
    const first = await h.send({ ticketId, idem, token: signReauth(fan, good()) });
    expect(first.statusCode).toBe(202);
    const again = await h.send({ ticketId, idem, token: signReauth(fan, good()) });
    expect(again.statusCode).toBe(202);
    expect(JSON.parse(again.payload).cancellationId).toBe(idem);
    expect(JSON.parse(again.payload).cancellationId).toBe(JSON.parse(first.payload).cancellationId);
    expect(h.paymentCalls, '환급은 한 번').toHaveLength(1);
  });

  test('R-T39 ④ 환급 계좌를 담은 취소는 FAN_HIGH_RISK 토큰만 받는다', async () => {
    h.reset();
    redis.commands.length = 0;
    const sensitive = await h.send({ body: { refundAccount: REFUND_ACCOUNT }, token: signReauth(fan, good()) });
    expect(sensitive.statusCode).toBe(403);
    expect(problemType(sensitive.payload)).toBe(`${PROBLEM_TYPE_BASE}reauth-required`);
    expect(h.ticketCalls).toHaveLength(0);
    expect(h.paymentCalls).toHaveLength(0);
    expect(h.created).toHaveLength(0);
    expect(redis.commands).toHaveLength(0);

    const other = await h.send({ body: { refundAccount: REFUND_ACCOUNT }, token: signReauth(fan, good({}, 'PAYOUT_ACCOUNT')) });
    expect(other.statusCode, '목록 밖 PAYOUT_ACCOUNT').toBe(403);
    expect(redis.commands).toHaveLength(0);

    const claims = good({}, 'FAN_HIGH_RISK');
    const high = await h.send({ body: { refundAccount: REFUND_ACCOUNT }, token: signReauth(fan, claims) });
    expect(high.statusCode).toBe(202);
    expect(h.ticketCalls).toHaveLength(1);
    expect(h.paymentCalls).toHaveLength(1);
    expect(h.paymentCalls[0]!.refundAccount).toEqual(REFUND_ACCOUNT);
    expect(redis.commands).toEqual([setOf(claims.jti as string, '180000')]);
  });

  test('R-T39 ⑤ jti 저장소가 오류를 내면 503 reauth-unavailable·Retry-After 5이고 아무것도 부르지 않는다', async () => {
    h.reset();
    redis.commands.length = 0;
    redis.mode = 'throw';
    try {
      const r = await h.send({ token: signReauth(fan, good()) });
      expect(r.statusCode).toBe(503);
      expect(problemType(r.payload)).toBe(`${PROBLEM_TYPE_BASE}reauth-unavailable`);
      expect(r.headers['retry-after']).toBe('5');
      expect(redis.commands.length, '장애가 실제로 끼어들었다').toBeGreaterThanOrEqual(1);
      expect(h.ticketCalls).toHaveLength(0);
      expect(h.paymentCalls).toHaveLength(0);
      expect(h.created).toHaveLength(0);
    } finally {
      redis.mode = 'real';
    }
  });

  test('R-T39 ⑤ 세 상태의 가운데: jti 저장소가 이미 있다고 답하면 503이 아니라 403 reauth-required다', async () => {
    h.reset();
    redis.commands.length = 0;
    redis.mode = 'exists';
    try {
      const r = await h.send({ token: signReauth(fan, good()) });
      expect(r.statusCode).toBe(403);
      expect(problemType(r.payload)).toBe(`${PROBLEM_TYPE_BASE}reauth-required`);
      expect(redis.commands).toHaveLength(1);
      expect(h.ticketCalls).toHaveLength(0);
      expect(h.created).toHaveLength(0);
    } finally {
      redis.mode = 'real';
    }
  });
});

describe('팬 취소 재인증: 팬 공개키 묶음을 한 번도 받지 못함 [BAT-415-reauth]', () => {
  let h: Harness;
  let redis: ReturnType<typeof fakeSeatRedis>;
  let jwks: ReturnType<typeof fakeJwksFetch>;
  beforeAll(async () => {
    redis = fakeSeatRedis();
    jwks = fakeJwksFetch([fan]);
    jwks.mode = 'throw';
    const gate = new JwksFanReauthGate({ jwksUrl: JWKS_URL, issuer: ISS, jti: new RedisReauthJtiStore(redis), clock: fakeClock({ now: NOW }), fetch: jwks.fetch });
    h = await boot(gate);
  });
  afterAll(async () => {
    await h?.svc.close();
  });

  test('R-T39 ⑤ 팬 공개키 묶음을 받지 못하면 503 reauth-unavailable·Retry-After 5이고, 살아나면 새 토큰으로 202다', async () => {
    const r = await h.send({ token: signReauth(fan, good()) });
    expect(r.statusCode).toBe(503);
    expect(problemType(r.payload)).toBe(`${PROBLEM_TYPE_BASE}reauth-unavailable`);
    expect(r.headers['retry-after']).toBe('5');
    expect(jwks.urls.length, '장애가 실제로 끼어들었다').toBeGreaterThanOrEqual(1);
    expect(h.ticketCalls).toHaveLength(0);
    expect(h.paymentCalls).toHaveLength(0);
    expect(h.created).toHaveLength(0);
    expect(redis.commands).toHaveLength(0);

    jwks.mode = 'up';
    const ok = await h.send({ token: signReauth(fan, good()) });
    expect(ok.statusCode, '실패를 영구로 들고 있지 않다').toBe(202);
    expect(h.ticketCalls).toHaveLength(1);
  });
});

describe('팬 취소 재인증: 컨트롤러가 확인기에 묻는 것과 답을 쓰는 것 [BAT-415-reauth]', () => {
  let h: Harness;
  const asked: { token: string | undefined; q: unknown }[] = [];
  let answer: 'pass' | 'reject' | 'unavailable' = 'pass';
  beforeAll(async () => {
    h = await boot({
      verify: async (token, q) => {
        asked.push({ token, q });
        if (answer === 'unavailable') throw new ReauthUnavailable();
        return answer === 'pass';
      },
    });
  });
  afterAll(async () => {
    await h?.svc.close();
  });

  test('R-T39 ④ 컨트롤러는 본문에 환급 계좌가 있으면 FAN_HIGH_RISK, 없으면 FAN_SENSITIVE를 요청 세션·계정과 함께 묻는다', async () => {
    answer = 'pass';
    asked.length = 0;
    expect((await h.send({ token: 'tok-a' })).statusCode).toBe(202);
    expect((await h.send({ token: 'tok-b', body: { refundAccount: REFUND_ACCOUNT } })).statusCode).toBe(202);
    expect(asked).toEqual([
      { token: 'tok-a', q: { accountId: ACCOUNT, sessionId: LOGIN, act: 'FAN_SENSITIVE' } },
      { token: 'tok-b', q: { accountId: ACCOUNT, sessionId: LOGIN, act: 'FAN_HIGH_RISK' } },
    ]);
  });

  test('R-T39 ⑤ 확인기가 확인하지 못하면(ReauthUnavailable) 503 reauth-unavailable·Retry-After 5이고 Saga를 부르지 않는다', async () => {
    answer = 'unavailable';
    h.reset();
    try {
      const r = await h.send({ token: 'tok-c' });
      expect(r.statusCode).toBe(503);
      expect(problemType(r.payload)).toBe(`${PROBLEM_TYPE_BASE}reauth-unavailable`);
      expect(r.headers['retry-after']).toBe('5');
      expect(h.ticketCalls).toHaveLength(0);
      expect(h.paymentCalls).toHaveLength(0);
      expect(h.created).toHaveLength(0);
    } finally {
      answer = 'pass';
    }
  });
});
