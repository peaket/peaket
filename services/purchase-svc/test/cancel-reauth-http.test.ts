// 팬 예매 취소의 재인증 확인을 HTTP 바깥 경계에서 본다(R-T39 ①~⑤·⑦, BAT-415-reauth, 시험 담당 l3-b415r-test).
// 정본: docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'·§11 R-T39, docs/security/authz-matrix.md §6 '작업 묶음 `act`의 값',
// docs/data.md §3 `reauth:jti:{jti}`, docs/api/openapi.yaml createTicketCancellation 403·503.
// AppModule 메모리 조립에 실제 JwksFanReauthGate를 꽂고, 시험 안에서 만든 ES256 키의 팬 공개키 묶음을 가짜 fetch가 주며,
// jti 저장소는 플랫폼 RedisReauthJtiStore에 명령을 적는 가짜 좌석 Redis를 넘긴다. 토큰 수명은 상수와 다른 180초다.
// 판정만이 아니라 컨트롤러가 그 결과를 써서 Saga(ticket-svc·payment-svc 호출, order_cancellation 쓰기)를 부르지 않는지까지 본다.
// 리뷰 반영 재현(RV-02 남은 수명 상한, RV-05·V7 확인기 오류의 경계, RV-06 거절 기록, RV-09 답하지 않는 읽기·동시 요청·alg)은
// 같은 시험 담당 세션이 더했다. 단언 값(5분 30초, 1,000ms, 까닭 이름표)은 §3.1 '한 번 쓰기'·'공개키 묶음 읽기'·'거절 기록'에서 가져온다.
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
import { DEFAULT_ISS, fakeJwksFetch, fakeSeatRedis, fanKey, hs256Reauth, ISS, JWKS_URL, reauthClaims, signReauth, unsignedReauth, type FanKey } from './fan-reauth-fixtures.js';

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
/** 정본의 공개키 묶음 읽기 한 번의 시간 상한 1,000ms [가정](transfer-refund §3.1 '공개키 묶음 읽기') */
const JWKS_READ_CAP_MS = 1_000;

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
const good = (over: Record<string, unknown> = {}, act = 'FAN_SENSITIVE', lifeS?: number) =>
  reauthClaims({ nowMs: NOW, accountId: ACCOUNT, sessionId: LOGIN, act, ...(lifeS !== undefined ? { lifeS } : {}) }, over);
const setOf = (jti: string, px: string) => ['SET', `reauth:jti:${jti}`, '1', 'NX', 'PX', px];

type Redis = ReturnType<typeof fakeSeatRedis>;
type Reply = { statusCode: number; payload: string; headers: Record<string, unknown> };

/** 거절(403 reauth-required)이고 Saga·jti 잡기가 0번인지 */
function expectRejected(h: Harness, redis: Redis, r: Reply, what: string): void {
  expect(r.statusCode, what).toBe(403);
  expect(problemType(r.payload), what).toBe(`${PROBLEM_TYPE_BASE}reauth-required`);
  expect(h.ticketCalls, what).toHaveLength(0);
  expect(h.paymentCalls, what).toHaveLength(0);
  expect(h.created, what).toHaveLength(0);
  expect(redis.commands, `${what}: jti를 잡지 않는다`).toHaveLength(0);
}

/** 확인 못 함(503 reauth-unavailable, Retry-After 5)이고 Saga가 0번인지 */
function expectUnavailable(h: Harness, r: Reply, what = ''): void {
  expect(r.statusCode, what).toBe(503);
  expect(problemType(r.payload), what).toBe(`${PROBLEM_TYPE_BASE}reauth-unavailable`);
  expect(r.headers['retry-after'], what).toBe('5');
  expect(h.ticketCalls, what).toHaveLength(0);
  expect(h.paymentCalls, what).toHaveLength(0);
  expect(h.created, what).toHaveLength(0);
}

/** 실제 확인기 조립(가짜 공개키 묶음·가짜 좌석 Redis). 거절 기록(onResult, 리뷰 RV-06 (가))을 모은다 */
async function bootReal(keys: readonly FanKey[] = [fan]) {
  const redis = fakeSeatRedis();
  const jwks = fakeJwksFetch(keys);
  const results: unknown[] = [];
  const gate = new JwksFanReauthGate({
    jwksUrl: JWKS_URL,
    issuer: ISS,
    jti: new RedisReauthJtiStore(redis),
    clock: fakeClock({ now: NOW }),
    fetch: jwks.fetch,
    onResult: (r: unknown) => void results.push(r),
  });
  return { h: await boot(gate), redis, jwks, results };
}

/**
 * ② 거절 경우와 정본 '거절 기록'의 까닭 이름표(transfer-refund §3.1). 만들 때마다 새 jti다.
 * crit은 정본이 `claims`에 넣는다(`ERR_JOSE_NOT_SUPPORTED` 포함)
 */
const rejectCases = (): [string, string | undefined, string][] => [
  ['머리 없음', undefined, 'missing'],
  ['빈 값', '', 'missing'],
  ['형식 깨짐', 'not-a-jwt', 'format'],
  ['만료(exp = 지금)', signReauth(fan, good({ exp: NOW_S })), 'expired'],
  ['다른 세션(sid)', signReauth(fan, good({ sid: OTHER_LOGIN })), 'claims'],
  ['다른 계정(sub)', signReauth(fan, good({ sub: OTHER_ACCOUNT })), 'sub'],
  ['계좌 없는 본문에 FAN_HIGH_RISK', signReauth(fan, good({}, 'FAN_HIGH_RISK')), 'claims'],
  ['BOOKER_EXPORT', signReauth(fan, good({}, 'BOOKER_EXPORT')), 'claims'],
  ['OPS_COMMAND', signReauth(fan, good({}, 'OPS_COMMAND')), 'claims'],
  ['act 없음', signReauth(fan, good({ act: undefined })), 'claims'],
  ['jti 없음', signReauth(fan, good({ jti: undefined })), 'claims'],
  ['관리 키로 서명(팬 묶음에 없는 kid)', signReauth(admin, good()), 'kid'],
  ['같은 kid의 다른 키로 서명', signReauth(fan, good(), { signWith: impostor.priv }), 'signature'],
  ['액세스 토큰(typ at+jwt)', signReauth(fan, good(), { header: { typ: 'at+jwt' } }), 'typ'],
  ['aud partner', signReauth(fan, good({ aud: 'partner' })), 'aud'],
  ['iss 기본값(설정한 발급자와 다름)', signReauth(fan, good({ iss: DEFAULT_ISS })), 'iss'],
  ['iss 다른 곳', signReauth(fan, good({ iss: 'https://evil.test' })), 'iss'],
  ['alg none', unsignedReauth(fan.kid, good()), 'alg'],
  ['alg HS256', hs256Reauth(fan, good()), 'alg'],
  ['모르는 crit 머리', signReauth(fan, good(), { header: { crit: ['x-peaket-unknown'], 'x-peaket-unknown': 1 } }), 'claims'],
  ['남은 수명 600초(5분 30초 초과)', signReauth(fan, good({}, 'FAN_SENSITIVE', 600)), 'lifetime'],
];

describe('팬 취소 재인증: 실제 확인기 조립 [BAT-415-reauth]', () => {
  let h: Harness;
  let redis: Redis;
  let results: unknown[];
  beforeAll(async () => {
    ({ h, redis, results } = await bootReal());
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
    // 수명 = 토큰의 남은 시간 180초(5분 30초 안, docs/data.md §3 `reauth:jti:{jti}`)
    expect(redis.commands).toEqual([setOf(claims.jti as string, '180000')]);
  });

  test('R-T39 ② 토큰이 없거나 맞지 않으면 403 reauth-required이고 아무것도 부르지 않는다', async () => {
    // 리뷰 반영 뒤 새로 더한 경우(alg·crit·수명)는 아래 따로 이름 붙인 시험이 보고, 여기는 처음 목록이다
    const first = rejectCases().filter(([what]) => !what.startsWith('alg ') && what !== '모르는 crit 머리' && !what.startsWith('남은 수명'));
    expect(first).toHaveLength(17);
    for (const [what, token] of first) {
      h.reset();
      redis.commands.length = 0;
      expectRejected(h, redis, await h.send({ token }), what);
    }
  });

  test('R-T39 ② 남은 수명이 5분 30초를 넘는 토큰(600초)은 403이고 jti를 잡지 않는다', async () => {
    h.reset();
    redis.commands.length = 0;
    expectRejected(h, redis, await h.send({ token: signReauth(fan, good({}, 'FAN_SENSITIVE', 600)) }), '600초');
  });

  test('R-T39 ② 모르는 crit 머리의 토큰은 403이다', async () => {
    h.reset();
    redis.commands.length = 0;
    const token = signReauth(fan, good(), { header: { crit: ['x-peaket-unknown'], 'x-peaket-unknown': 1 } });
    expectRejected(h, redis, await h.send({ token }), 'crit');
  });

  test('R-T39 ② alg none·HS256 토큰은 403이다', async () => {
    for (const [what, token] of [
      ['alg none', unsignedReauth(fan.kid, good())],
      ['alg HS256', hs256Reauth(fan, good())],
    ] as const) {
      h.reset();
      redis.commands.length = 0;
      expectRejected(h, redis, await h.send({ token }), what);
    }
  });

  test('R-T39 ② 거절마다 까닭 이름표 하나를 로그에 남기고 토큰·계정 ID는 싣지 않는다', async () => {
    for (const [what, token, reason] of rejectCases()) {
      h.reset();
      redis.commands.length = 0;
      results.length = 0;
      const r = await h.send({ token });
      expect(r.statusCode, what).toBe(403);
      expect(results, what).toEqual([{ outcome: 'rejected', reason }]);
      const text = JSON.stringify(results);
      for (const secret of [token, ACCOUNT, OTHER_ACCOUNT, LOGIN, OTHER_LOGIN].filter((v): v is string => typeof v === 'string' && v !== '')) {
        expect(text.includes(secret), `${what}: 기록에 토큰·계정·세션 ID가 없다`).toBe(false);
      }
    }
    // 다시 쓴 토큰: 첫 번째는 통과, 두 번째 거절의 까닭은 replay이고 jti는 싣지 않는다
    const claims = good();
    const token = signReauth(fan, claims);
    expect((await h.send({ token })).statusCode).toBe(202);
    results.length = 0;
    expect((await h.send({ token })).statusCode).toBe(403);
    expect(results).toEqual([{ outcome: 'rejected', reason: 'replay' }]);
    expect(JSON.stringify(results).includes(claims.jti as string), 'jti를 싣지 않는다').toBe(false);
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

  test('R-T39 ③ 같은 토큰으로 다른 표 둘을 동시에 보내면 하나만 지난다', async () => {
    h.reset();
    redis.commands.length = 0;
    const claims = good();
    const token = signReauth(fan, claims);
    const both = await Promise.all([h.send({ token }), h.send({ token })]);
    expect(both.map((r) => r.statusCode).sort()).toEqual([202, 403]);
    const lost = both.find((r) => r.statusCode === 403)!;
    expect(problemType(lost.payload)).toBe(`${PROBLEM_TYPE_BASE}reauth-required`);
    expect(h.ticketCalls, 'ticket-svc 호출 1').toHaveLength(1);
    expect(h.paymentCalls).toHaveLength(1);
    expect(h.created).toHaveLength(1);
    // 둘 다 확인을 마치고 같은 키를 잡으려 했고, 하나는 이미 있음(null)을 받았다
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
      expectUnavailable(h, r);
      expect(redis.commands.length, '장애가 실제로 끼어들었다').toBeGreaterThanOrEqual(1);
    } finally {
      redis.mode = 'real';
    }
  });

  test('R-T39 ⑤ 확인하지 못함은 까닭 store 하나를 남긴다(jti 저장소 오류)', async () => {
    h.reset();
    results.length = 0;
    redis.mode = 'throw';
    try {
      expect((await h.send({ token: signReauth(fan, good()) })).statusCode).toBe(503);
      expect(results).toEqual([{ outcome: 'unavailable', reason: 'store' }]);
    } finally {
      redis.mode = 'real';
    }
  });

  test('R-T39 ⑤ 세 상태의 가운데: jti 저장소가 이미 있다고 답하면 503이 아니라 403 reauth-required다', async () => {
    h.reset();
    redis.commands.length = 0;
    results.length = 0;
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
  let redis: Redis;
  let jwks: ReturnType<typeof fakeJwksFetch>;
  let results: unknown[];
  beforeAll(async () => {
    ({ h, redis, jwks, results } = await bootReal());
    jwks.mode = 'throw';
  });
  afterAll(async () => {
    await h?.svc.close();
  });

  test('R-T39 ⑤ 팬 공개키 묶음을 받지 못하면 503 reauth-unavailable·Retry-After 5이고, 살아나면 새 토큰으로 202다', async () => {
    results.length = 0;
    const r = await h.send({ token: signReauth(fan, good()) });
    expectUnavailable(h, r);
    expect(jwks.urls.length, '장애가 실제로 끼어들었다').toBeGreaterThanOrEqual(1);
    expect(redis.commands).toHaveLength(0);
    // 확인하지 못함의 까닭은 keys 하나(transfer-refund §3.1 '거절 기록')
    expect(results, '까닭 keys').toEqual([{ outcome: 'unavailable', reason: 'keys' }]);

    jwks.mode = 'up';
    const ok = await h.send({ token: signReauth(fan, good()) });
    expect(ok.statusCode, '실패를 영구로 들고 있지 않다').toBe(202);
    expect(h.ticketCalls).toHaveLength(1);
  });
});

describe('팬 취소 재인증: 공개키 묶음 안의 키가 깨짐 [BAT-415-reauth]', () => {
  let h: Harness;
  let redis: Redis;
  let jwks: ReturnType<typeof fakeJwksFetch>;
  let results: unknown[];
  beforeAll(async () => {
    // 같은 kid의 다른 키 둘(jose ERR_JWKS_MULTIPLE_MATCHING_KEYS, 정본 §3.1 '답'의 503 목록)
    ({ h, redis, jwks, results } = await bootReal([fan, fanKey(fan.kid)]));
  });
  afterAll(async () => {
    await h?.svc.close();
  });

  test('R-T39 ⑤ 공개키 묶음 안의 키가 깨지면 503 reauth-unavailable이다', async () => {
    const r = await h.send({ token: signReauth(fan, good()) });
    expectUnavailable(h, r);
    expect(jwks.urls.length, '깨진 묶음을 실제로 받았다').toBeGreaterThanOrEqual(1);
    expect(redis.commands, 'jti를 잡지 않는다').toHaveLength(0);
    expect(results, '까닭 keys').toEqual([{ outcome: 'unavailable', reason: 'keys' }]);
  });
});

describe('팬 취소 재인증: 좌표가 곡선 밖인 키 [BAT-415-reauth]', () => {
  // 같은 kid, x는 팬 키 그대로이고 y만 다른 키의 것(jose가 DOMException DataError를 낸다, 정본 §3.1 '답'의 503 목록)
  const offCurve: FanKey = { ...fan, publicJwk: { ...fan.publicJwk, y: fanKey(fan.kid).publicJwk.y! } };
  // 대조: crv가 빠진 키(맞는 키 없음 → 403, 까닭 kid)
  const noCrv: FanKey = { ...fan, publicJwk: Object.fromEntries(Object.entries(fan.publicJwk).filter(([k]) => k !== 'crv')) };
  let bad: Awaited<ReturnType<typeof bootReal>>;
  let control: Awaited<ReturnType<typeof bootReal>>;
  beforeAll(async () => {
    bad = await bootReal([offCurve]);
    control = await bootReal([noCrv]);
  });
  afterAll(async () => {
    await bad?.h.svc.close();
    await control?.h.svc.close();
  });

  test('R-T39 ⑤ 좌표가 곡선 밖인 키를 담은 공개키 묶음이면 503 reauth-unavailable이다', async () => {
    const r = await bad.h.send({ token: signReauth(fan, good()) });
    expectUnavailable(bad.h, r);
    expect(bad.jwks.urls.length, '깨진 묶음을 실제로 받았다').toBeGreaterThanOrEqual(1);
    expect(bad.redis.commands, 'jti를 잡지 않는다').toHaveLength(0);
    expect(bad.results, '까닭 keys').toEqual([{ outcome: 'unavailable', reason: 'keys' }]);

    const c = await control.h.send({ token: signReauth(fan, good()) });
    expectRejected(control.h, control.redis, c, 'crv 없음');
    expect(control.results, 'crv 없음: 까닭 kid').toEqual([{ outcome: 'rejected', reason: 'kid' }]);
  });
});

describe('팬 취소 재인증: 처음 공개키 읽기가 답하지 않음 [BAT-415-reauth]', () => {
  let h: Harness;
  let redis: Redis;
  let jwks: ReturnType<typeof fakeJwksFetch>;
  beforeAll(async () => {
    ({ h, redis, jwks } = await bootReal());
    jwks.mode = 'hang';
  });
  afterAll(async () => {
    await h?.svc.close();
  });

  test('R-T39 ⑤ 처음 공개키 읽기가 답하지 않으면 1,000ms 안팎에 503이다', { timeout: 15_000 }, async () => {
    const started = performance.now();
    const r = await h.send({ token: signReauth(fan, good()) });
    const took = performance.now() - started;
    expectUnavailable(h, r);
    // 가짜 시계는 AbortSignal.timeout을 움직이지 않아 실제 시간으로 잰다(아래쪽은 상한 − 100ms, 위쪽은 2,500ms)
    expect(took, `걸린 시간 ${Math.round(took)}ms`).toBeGreaterThanOrEqual(JWKS_READ_CAP_MS - 100);
    expect(took, `걸린 시간 ${Math.round(took)}ms`).toBeLessThan(2_500);
    expect(jwks.urls, '읽기 한 번').toHaveLength(1);
    expect(redis.commands).toHaveLength(0);
  });
});

describe('팬 취소 재인증: 실제 확인기의 뜻밖 오류 [BAT-415-reauth]', () => {
  // 고친 곳 검증 E7: 실제 어댑터가 뜻밖 오류를 503으로 덮지 않는지 HTTP 경계에서 본다. 시계(jti 저장소가 아닌 주입 지점)가 TypeError를 낸다
  let h: Harness;
  let redis: Redis;
  const results: unknown[] = [];
  beforeAll(async () => {
    redis = fakeSeatRedis();
    const bug = (): never => {
      throw new TypeError("Cannot read properties of undefined (reading 'now')");
    };
    const gate = new JwksFanReauthGate({
      jwksUrl: JWKS_URL,
      issuer: ISS,
      jti: new RedisReauthJtiStore(redis),
      clock: { now: bug, monotonicMs: bug },
      fetch: fakeJwksFetch([fan]).fetch,
      onResult: (r) => void results.push(r),
    });
    h = await boot(gate);
  });
  afterAll(async () => {
    await h?.svc.close();
  });

  test('R-T39 ⑦ 실제 확인기가 뜻밖의 오류를 내면 500이고 Retry-After가 없으며 아무것도 부르지 않는다', async () => {
    const r = await h.send({ token: signReauth(fan, good()) });
    expect(r.statusCode).toBe(500);
    expect(r.headers['retry-after'], 'Retry-After 없음').toBeUndefined();
    expect(h.ticketCalls).toHaveLength(0);
    expect(h.paymentCalls).toHaveLength(0);
    expect(h.created).toHaveLength(0);
    expect(redis.commands, 'jti를 잡지 않는다').toHaveLength(0);
    expect(results, '거절·확인 못 함 기록 0번').toHaveLength(0);
  });
});

describe('팬 취소 재인증: 컨트롤러가 확인기에 묻는 것과 답을 쓰는 것 [BAT-415-reauth]', () => {
  let h: Harness;
  const asked: { token: string | undefined; q: unknown }[] = [];
  let answer: 'pass' | 'reject' | 'unavailable' | 'bug' = 'pass';
  beforeAll(async () => {
    h = await boot({
      verify: async (token, q) => {
        asked.push({ token, q });
        if (answer === 'unavailable') throw new ReauthUnavailable();
        if (answer === 'bug') throw new TypeError("Cannot read properties of undefined (reading 'kid')");
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
      expectUnavailable(h, await h.send({ token: 'tok-c' }));
    } finally {
      answer = 'pass';
    }
  });

  test('R-T39 ⑦ 확인기가 뜻밖의 오류를 내면 500이고 Retry-After가 없으며 아무것도 부르지 않는다', async () => {
    answer = 'bug';
    h.reset();
    try {
      const r = await h.send({ token: 'tok-d' });
      expect(r.statusCode).toBe(500);
      expect(r.headers['retry-after'], 'Retry-After 없음').toBeUndefined();
      expect(h.ticketCalls).toHaveLength(0);
      expect(h.paymentCalls).toHaveLength(0);
      expect(h.created).toHaveLength(0);
      // 대조: 같은 대역이 ReauthUnavailable을 던지면 503(위 ⑤)이다. 여기서 바로 한 번 더 본다
      answer = 'unavailable';
      h.reset();
      expect((await h.send({ token: 'tok-e' })).statusCode).toBe(503);
    } finally {
      answer = 'pass';
    }
  });
});
