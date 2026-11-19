// 탈퇴 요청의 HTTP 답(DELETE /v1/identity/account, docs/api/openapi.yaml deleteIdentityAccount 204·202, docs/features/identity.md §8
// '탈퇴 참여자와 탈퇴 미룸의 첫 구현' '차례' '미사용 티켓 확인과 취소', ADR-0284, BUILD_ORDER PRF-169·PRF-174, I-T84 ①②, I-T26 ①, BAT-010·BAT-013 시험 담당).
// 끝냈으면 204, 참여자를 기다려 미뤘으면 본문 없는 202이고 둘 다 Cache-Control: no-store다. 미사용 티켓이 있으면 409의 unusedTickets로
// 환급 예상을 보이고(같은 토큰으로 다시 보낸다), 견적을 받지 못하면 503 dependency-unavailable(Retry-After 1초)이다.
// 참여자는 SessionModule 선택지로 넣는 대역이다(구현 전 트리에서도 읽히도록 새 모듈을 가져오지 않는다).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CreateSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { fanKey, ISSUER, newKey, recordingSignals, testAgency, testDeviceRefs } from './support.js';

type Answer = { state: 'DONE' } | { state: 'PENDING'; reasons: readonly string[] };
/** 미사용 티켓 견적(identity §8 '미사용 티켓 확인과 취소'와 openapi unusedTickets의 여섯 칸) */
interface Quote {
  count: number;
  ticketAmount: number;
  deductionAmount: number;
  refundAmount: number;
  transferableCount: number;
  deferredRefundCount: number;
}
/** 견적의 데드라인은 정본의 2초 [가정]이다 */
const QUOTE_DEADLINE_MS = 2_000;
let svc: Awaited<ReturnType<typeof createService>>;
let signer: JoseTokenSigner;
const clock = fakeClock({ now: Date.parse('2026-11-18T08:21:09.117Z') });
let answer: Answer = { state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER'] };
/** 견적 대역: undefined면 '취소할 표가 없다'(0장). quoteFails면 견적 실패(503)다 */
let quote: Quote | undefined;
let quoteFails = false;
const asked: string[] = [];
const quoted: { accountId: string; deadlineMs: number }[] = [];
const participant = {
  name: 'purchase',
  process: async (accountId: string) => {
    asked.push(accountId);
    return answer;
  },
  unusedTickets: async (accountId: string, o: { deadlineMs: number }): Promise<Quote | undefined> => {
    quoted.push({ accountId, deadlineMs: o.deadlineMs });
    if (quoteFails) throw new Error('주입한 견적 실패');
    return quote;
  },
};

beforeAll(async () => {
  const fan = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  const session = { signer: (signer = new JoseTokenSigner(keys, ISSUER)), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals(), cookieDomain: 'peaket.example', withdrawalParticipants: [participant] };
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({ memory: true, session: session as never, verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: new Writable({ write: (_c, _e, cb) => cb() }),
  });
});
afterAll(async () => {
  await svc?.close();
});

beforeEach(() => {
  // 견적은 시험마다 정한다(기본은 0장: I-T84 시험은 409 없이 지금 길을 본다)
  quote = undefined;
  quoteFails = false;
  asked.length = 0;
  quoted.length = 0;
});

const login = () => svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `w-${newKey().slice(0, 8)}`, email: null, deviceId: null });
const fanHeaders = (s: { accountId: string; sessionId: string }) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '' });
const reauth = async (s: { accountId: string; sessionId: string }) => (await signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', operation: 'ACCOUNT_WITHDRAW' }, svc.clock.now())).token;
const del = async (s: { accountId: string; sessionId: string }, body: Record<string, unknown> = {}) =>
  svc.http.inject({ method: 'DELETE', url: '/v1/identity/account', headers: { ...fanHeaders(s), 'content-type': 'application/json', 'x-reauth-token': await reauth(s) }, payload: JSON.stringify(body) });
/** 같은 재인증 토큰으로 다시 보낸다(409는 토큰을 쓰지 않는다) */
const delWith = (s: { accountId: string; sessionId: string }, token: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'DELETE', url: '/v1/identity/account', headers: { ...fanHeaders(s), 'content-type': 'application/json', 'x-reauth-token': token }, payload: JSON.stringify(body) });
const refresh = (rt: string) => svc.http.inject({ method: 'POST', url: '/v1/identity/access-tokens', headers: { cookie: `__Secure-peaket_rt=${rt}` } });

describe('DELETE /v1/identity/account의 204·202(I-T84 ①②)', () => {
  test('I-T84②_참여자가PENDING이면_본문없는202이고Cache-Control no-store이며_세션은살아있어갱신이된다', async () => {
    answer = { state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER'] };
    const s = await login();
    const r = await del(s);
    expect(r.statusCode).toBe(202);
    expect(r.payload).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(asked).toContain(s.accountId);
    expect((await refresh(s.refreshToken)).statusCode).toBe(204);
  });

  test('I-T84①_미룬계정이다시요청해참여자가DONE이면_204·no-store이고그세션의갱신이더는안된다 [ASVS v5.0.0-7.4.2]', async () => {
    answer = { state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING'] };
    const s = await login();
    expect((await del(s)).statusCode).toBe(202);
    answer = { state: 'DONE' };
    clock.advance(4_000);
    const r = await del(s);
    expect(r.statusCode).toBe(204);
    expect(r.payload).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    expect((await refresh(s.refreshToken)).statusCode).toBe(401);
  });
});

// ---- 미사용 티켓 확인 409·견적 실패 503(I-T26 ①, identity §8 '미사용 티켓 확인과 취소', openapi deleteIdentityAccount, BAT-013) ----
// 단언 값은 정본에서 적는다(POL-032 예: 33,333원 20% = 6,666/26,667, 132,500원 10% = 13,250/119,250. 견적 데드라인 2초 [가정]).
// 코드 상수를 가져오지 않는다.
describe('미사용 티켓 409 견적과 503(I-T26 ①)', () => {
  const TWO = { count: 2, ticketAmount: 165_833, deductionAmount: 19_916, refundAmount: 145_917, transferableCount: 1, deferredRefundCount: 1 } as const;

  test('I-T26 ①_미사용티켓2장이면409unusedTickets(수2·결제165833·공제19916·환급145917·양도1·마감뒤1)이고_no-store이며_계정·세션·참여자그대로고_같은재인증토큰이다시409다', async () => {
    answer = { state: 'DONE' };
    quote = TWO;
    const s = await login();
    const first = await del(s);
    expect(first.statusCode).toBe(409);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(first.payload)).toMatchObject({
      type: 'https://peaket.example/problems/withdrawal-confirmation-required',
      status: 409,
      title: '탈퇴 전에 확인해 주세요',
      unusedTickets: { count: 2, ticketAmount: 165_833, deductionAmount: 19_916, refundAmount: 145_917, transferableCount: 1, deferredRefundCount: 1 },
    });
    // 견적은 그 계정을 2초 [가정] 데드라인으로 한 번 불렀고, 참여자(정리)는 부르지 않았다: 계정 상태가 바뀌지 않는다
    expect(quoted).toEqual([{ accountId: s.accountId, deadlineMs: QUOTE_DEADLINE_MS }]);
    expect(asked).toEqual([]);
    // 세션은 살아 있고(갱신 204) 계정도 그대로다. 같은 재인증 토큰으로 다시 보내도 403이 아니라 다시 409다(토큰을 쓰지 않는다)
    expect((await refresh(s.refreshToken)).statusCode).toBe(204);
    const token = await reauth(s);
    const again = await delWith(s, token, {});
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.payload)).toMatchObject({ type: 'https://peaket.example/problems/withdrawal-confirmation-required', unusedTickets: TWO });
    // 확인(true)을 실어 같은 토큰으로 보내면 진행한다(견적을 다시 부르지 않는다)
    const done = await delWith(s, token, { confirmCancelUnusedTickets: true });
    expect(done.statusCode).toBe(204);
    expect(asked).toEqual([s.accountId]);
    expect(quoted).toHaveLength(2);
    expect((await refresh(s.refreshToken)).statusCode).toBe(401);
  });

  test('I-T26 ①_티켓이0장이면409가없고지금처럼204다(견적은불렀다)', async () => {
    answer = { state: 'DONE' };
    quote = undefined;
    const s = await login();
    const r = await del(s);
    expect(r.statusCode).toBe(204);
    expect(quoted).toEqual([{ accountId: s.accountId, deadlineMs: QUOTE_DEADLINE_MS }]);
    expect(asked).toEqual([s.accountId]);
  });

  test('I-T26 ①_견적이실패하면503dependency-unavailable·Retry-After 1초·no-store이고_계정·세션·같은재인증토큰이그대로다', async () => {
    answer = { state: 'DONE' };
    quoteFails = true;
    const s = await login();
    const token = await reauth(s);
    const r = await delWith(s, token, {});
    expect(r.statusCode).toBe(503);
    expect(r.headers['retry-after']).toBe('1');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/dependency-unavailable', status: 503 });
    // 계정·세션·재인증 토큰이 그대로다: 참여자(정리)는 부르지 않았고 같은 토큰으로 견적이 돌아오면 204다
    expect(asked).toEqual([]);
    expect((await refresh(s.refreshToken)).statusCode).toBe(204);
    quoteFails = false;
    expect((await delWith(s, token, {})).statusCode).toBe(204);
    expect(asked).toEqual([s.accountId]);
  });

});
