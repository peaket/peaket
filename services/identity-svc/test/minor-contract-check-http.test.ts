// F-06-3 미성년자 계약 취소 확인 HTTP 시험(시험 담당, 2026-11-26. 시험 리뷰 TR-04·05·13 반영).
// 정본: docs/features/identity.md §5(만 나이·생년월일 미저장·resultToken), POL-038 ⑧,
// openapi createIdentityMinorContractCheck·VerificationResult.resultToken.
// 토큰은 실제 HTTP 확인 POST에서 읽고, GET·다른 목적에는 없고, 로그에 원문이 남지 않는지 본다.
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CreateSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { agencyResult, fanKey, ISSUER, newKey, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const KST = (s: string): number => Date.parse(`${s}+09:00`);
const NOW = KST('2026-11-26T10:00:00');
let wall = NOW;
const clock = { now: () => wall, monotonicMs: () => wall, advance: (ms: number) => { wall += ms; } };
const logLines: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    logLines.push(String(c));
    cb();
  },
});

type Basis = { payerAccountId: string; paidAtMs: number };
const bases = new Map<string, Basis>();
const minorContractOrders = {
  async basis(orderId: string) {
    return bases.get(orderId);
  },
};

let svc: Awaited<ReturnType<typeof createService>>;
let signer: JoseTokenSigner;
let keys: TokenKeyRing;

beforeAll(async () => {
  const fan = await fanKey();
  keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  signer = new JoseTokenSigner(keys, ISSUER);
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({
      memory: true,
      session: { signer, keys, deviceRefs: testDeviceRefs(), signals: recordingSignals(), cookieDomain: 'peaket.example' },
      verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)), minorContractOrders } as never,
    }),
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});
beforeEach(() => {
  bases.clear();
  logLines.length = 0;
  wall = NOW;
});

const login = () => svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `u-${newKey().slice(0, 8)}`, email: null, deviceId: null });
const fanHeaders = (s: { accountId: string; sessionId: string }) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '' });
const start = (s: { accountId: string; sessionId: string }, purpose: 'FIRST' | 'MINOR_CONTRACT' = 'MINOR_CONTRACT') =>
  svc.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: { ...fanHeaders(s), 'content-type': 'application/json' }, payload: JSON.stringify({ purpose, next: '/' }) });
const confirm = (s: { accountId: string; sessionId: string }, verificationId: string, providerResult: Record<string, string>) =>
  svc.http.inject({ method: 'POST', url: `/v1/identity/verifications/${verificationId}/result`, headers: { ...fanHeaders(s), 'content-type': 'application/json' }, payload: JSON.stringify({ providerResult }) });
const result = (s: { accountId: string; sessionId: string }, verificationId: string) => svc.http.inject({ method: 'GET', url: `/v1/identity/verifications/${verificationId}/result`, headers: fanHeaders(s) });
const check = (h: Record<string, string>, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: '/v1/identity/minor-contract-checks', headers: { ...h, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

/** MINOR_CONTRACT 목적의 본인확인을 HTTP로 마치고 확인 POST 응답 전체와 resultToken을 준다 */
async function minorConfirmation(s: { accountId: string; sessionId: string }, birth: string | undefined, person?: string, skipFirst = false) {
  // 계정마다 다른 사람이어야 한다. 같은 연계정보를 여러 계정에 쓰면 두 번째 확인이 DUPLICATE_ACCOUNT다.
  const who = person ?? `minor-person-${s.accountId}`;
  // 계정의 연계정보를 먼저 만든다(휴대폰 본인확인을 마친 계정만 확인할 수 있다). 같은 사람이면 다시 해도 같은 CI다.
  if (!skipFirst) await firstVerify(s, who);
  const st = await start(s, 'MINOR_CONTRACT');
  expect(st.statusCode).toBe(201);
  const verificationId = json(st)['verificationId'] as string;
  const confirmed = await confirm(s, verificationId, agencyResult(clock, verificationId, { person: who, ...(birth === undefined ? { birth: undefined } : { birth }) }));
  expect(confirmed.statusCode).toBe(200);
  return { verificationId, body: json(confirmed), token: json(confirmed)['resultToken'] as string | undefined };
}
const firstVerify = async (s: { accountId: string; sessionId: string }, person: string) => {
  const st = await start(s, 'FIRST');
  expect(st.statusCode).toBe(201);
  const verificationId = json(st)['verificationId'] as string;
  const confirmed = await confirm(s, verificationId, agencyResult(clock, verificationId, { person }));
  expect(confirmed.statusCode).toBe(200);
  return { verificationId, body: json(confirmed) };
};

describe('R-T26 ③ 미성년자 계약 취소 확인', () => {
  test('결제 승인일(KST)에 만 17세였으면 under19AtContract 참이고 토큰은 HTTP 확인 POST에만 있다 [ASVS v5.0.0-8.2.2]', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const { verificationId, token } = await minorConfirmation(s, '2009-03-01');
    expect(typeof token).toBe('string');
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: token });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ under19AtContract: true });
    const got = await result(s, verificationId);
    expect(got.statusCode).toBe(200);
    expect(got.payload).not.toContain('resultToken');
  });

  test('FIRST·REVERIFY 확인 POST에는 resultToken이 없고, GET 결과에도 없다', async () => {
    const s = await login();
    const first = await firstVerify(s, 'first-person');
    expect(first.body).not.toHaveProperty('resultToken');
    const got = await result(s, first.verificationId);
    expect(got.statusCode).toBe(200);
    expect(got.payload).not.toContain('resultToken');

    const rv = await svc.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: { ...fanHeaders(s), 'content-type': 'application/json' }, payload: JSON.stringify({ purpose: 'REVERIFY', next: '/' }) });
    expect(rv.statusCode).toBe(201);
    const id = json(rv)['verificationId'] as string;
    const rc = await confirm(s, id, agencyResult(clock, id, { person: 'first-person' }));
    expect(rc.statusCode).toBe(200);
    expect(json(rc)).not.toHaveProperty('resultToken');
    expect((await result(s, id)).payload).not.toContain('resultToken');

    // 같은 계정의 MINOR_CONTRACT 확인에만 토큰이 붙는다(이 줄이 기준 트리에서 실패해 음성 단언만 통과하는 것을 막는다)
    const minor = await minorConfirmation(s, '2009-03-01', 'first-person', true);
    expect(typeof minor.token).toBe('string');
    expect(minor.token).not.toBe('');
  });

  test('만 19세 생일 당일(KST)은 미성년이 아니다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-26T00:30:00') });
    const { token } = await minorConfirmation(s, '2007-11-26');
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: token });
    expect(json(r)).toEqual({ under19AtContract: false });
  });

  test('생일 하루 전(KST)은 미성년이다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-25T23:30:00') });
    const { token } = await minorConfirmation(s, '2007-11-26');
    expect(json(await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: token }))).toEqual({ under19AtContract: true });
  });

  test('이미 다른 연계정보로 본인확인한 계정의 MINOR_CONTRACT 확인은 확인 경로에서 409 minor-contract-ci-mismatch다 [ASVS v5.0.0-8.2.2]', async () => {
    const s = await login();
    await firstVerify(s, 'lee');
    const st = await start(s, 'MINOR_CONTRACT');
    const verificationId = json(st)['verificationId'] as string;
    const confirmed = await confirm(s, verificationId, agencyResult(clock, verificationId, { person: 'kim', birth: '2009-03-01' }));
    expect(confirmed.statusCode).toBe(200);
    const token = json(confirmed)['resultToken'];
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: token });
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('minor-contract-ci-mismatch') });
  });

  test('주문이 여럿이고 하나라도 성인이면 422 minor-contract-mixed-orders다', async () => {
    const s = await login();
    const a = newKey();
    const b = newKey();
    bases.set(a, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    bases.set(b, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-26T12:00:00') });
    const { token } = await minorConfirmation(s, '2007-11-26');
    const r = await check(fanHeaders(s), { orderIds: [a, b], consent: true, verificationResultToken: token });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('minor-contract-mixed-orders') });
  });

  test('남의 주문이면 409 minor-contract-not-owner다', async () => {
    const s = await login();
    const other = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: other.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const { token } = await minorConfirmation(s, '2009-03-01');
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: token });
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('minor-contract-not-owner') });
  });

  test('확인 목적 동의가 true가 아니면 400이다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const { token } = await minorConfirmation(s, '2009-03-01');
    expect((await check(fanHeaders(s), { orderIds: [order], consent: false, verificationResultToken: token })).statusCode).toBe(400);
  });

  test('주문 ID가 0개거나 21개면 400이다', async () => {
    const s = await login();
    const { token } = await minorConfirmation(s, '2009-03-01');
    expect((await check(fanHeaders(s), { orderIds: [], consent: true, verificationResultToken: token })).statusCode).toBe(400);
    expect((await check(fanHeaders(s), { orderIds: Array.from({ length: 21 }, () => newKey()), consent: true, verificationResultToken: token })).statusCode).toBe(400);
  });

  test('다른 계정의 확인 토큰이면 403이다 [ASVS v5.0.0-8.2.2]', async () => {
    const a = await login();
    const b = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: b.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const { token } = await minorConfirmation(a, '2009-03-01');
    expect((await check(fanHeaders(b), { orderIds: [order], consent: true, verificationResultToken: token })).statusCode).toBe(403);
  });

  test('만료된 확인 토큰(10분)은 403이고 결과를 주지 않는다 [ASVS v5.0.0-16.3.2]', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const { token } = await minorConfirmation(s, '2009-03-01');
    wall = NOW + 10 * 60_000 + 1;
    expect((await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: token })).statusCode).toBe(403);
  });

  test('본인확인 결과에 생년월일이 없으면 확인 토큰을 주지 않는다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const { token } = await minorConfirmation(s, undefined);
    expect(token).toBeUndefined();
    expect((await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: token })).statusCode).toBe(400);
  });

  test('생년월일·토큰 원문은 응답·로그에 남지 않는다 [ASVS v5.0.0-16.3.2]', async () => {
    const s = await login();
    const order = newKey();
    const birth = '2009-03-01';
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const { token } = await minorConfirmation(s, birth);
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: token });
    expect(r.statusCode).toBe(200);
    expect(r.payload).not.toContain(birth);
    expect(logLines.join('\n')).not.toContain(birth);
    expect(logLines.join('\n')).not.toContain(String(token));
  });

  test('본인확인을 마치지 않은 계정은 403 identity-required다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    expect((await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: 'not-a-token' })).statusCode).toBe(403);
  });

  test('IR-16 확인되지 않은 MINOR_CONTRACT 결과에는 resultToken을 주지 않는다', async () => {
    const s = await login();
    await firstVerify(s, `minor-person-${s.accountId}`);
    const st = await start(s, 'MINOR_CONTRACT');
    const id = json(st)['verificationId'] as string;
    const confirmed = await confirm(s, id, agencyResult(clock, id, { person: `minor-person-${s.accountId}`, birth: undefined }));
    expect(confirmed.statusCode).toBe(200);
    expect(json(confirmed)).not.toHaveProperty('resultToken');
    expect((await result(s, id)).payload).not.toContain('resultToken');
  });
});
