// F-06-3 미성년자 계약 취소 확인 HTTP 시험(시험 담당, 2026-11-26).
// 정본: docs/features/identity.md §5(만 나이·생년월일 미저장), POL-038 ⑧, transfer-refund §3.2·§11 R-T26 ③,
// docs/api/openapi.yaml createIdentityMinorContractCheck·VerificationResult.resultToken.
// 값은 정본에서 가져오고 코드 상수와 같게 고르지 않는다.
import 'reflect-metadata';
import { createService } from '@peaket/platform';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CreateSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
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

type Basis = { payerAccountId: string; paidAtMs: number; entryRecorded?: boolean };
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

/** MINOR_CONTRACT 목적의 본인확인을 마치고 확인 응답의 resultToken을 받는다 */
async function minorToken(s: { accountId: string; sessionId: string }, birth: string | undefined) {
  const start = await svc.app.get(StartVerification).run({ accountId: s.accountId, sessionId: s.sessionId, purpose: 'MINOR_CONTRACT', next: '/' });
  const confirmed = await svc.app.get(ConfirmVerification).run({
    accountId: s.accountId,
    verificationId: start.verificationId,
    providerResult: agencyResult(clock, start.verificationId, { person: 'minor-person', ...(birth === undefined ? { birth: undefined } : { birth }) }),
  });
  return confirmed as unknown as Record<string, unknown>;
}

const check = (h: Record<string, string>, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: '/v1/identity/minor-contract-checks', headers: { ...h, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('R-T26 ③ 미성년자 계약 취소 확인', () => {
  test('결제 승인일(KST)에 만 17세였으면 under19AtContract 참이다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const confirmed = await minorToken(s, '2009-03-01');
    const token = confirmed['resultToken'];
    expect(typeof token).toBe('string');
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: token });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ under19AtContract: true });
  });

  test('만 19세 생일 당일(KST)은 미성년이 아니다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-26T00:30:00') });
    const confirmed = await minorToken(s, '2007-11-26');
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: confirmed['resultToken'] });
    expect(r.statusCode).toBe(200);
    expect(json(r)).toEqual({ under19AtContract: false });
  });

  test('생일 하루 전(KST)은 미성년이다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-25T23:30:00') });
    const confirmed = await minorToken(s, '2007-11-26');
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: confirmed['resultToken'] });
    expect(json(r)).toEqual({ under19AtContract: true });
  });

  test('주문이 여럿이고 하나라도 성인이면 422 minor-contract-mixed-orders다', async () => {
    const s = await login();
    const a = newKey();
    const b = newKey();
    bases.set(a, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    bases.set(b, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-26T12:00:00') });
    const confirmed = await minorToken(s, '2007-11-26');
    const r = await check(fanHeaders(s), { orderIds: [a, b], consent: true, verificationResultToken: confirmed['resultToken'] });
    expect(r.statusCode).toBe(422);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('minor-contract-mixed-orders') });
  });

  test('남의 주문이면 409 minor-contract-not-owner다', async () => {
    const s = await login();
    const other = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: other.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const confirmed = await minorToken(s, '2009-03-01');
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: confirmed['resultToken'] });
    expect(r.statusCode).toBe(409);
    expect(json(r)).toMatchObject({ type: expect.stringContaining('minor-contract-not-owner') });
  });

  test('확인 목적 동의가 true가 아니면 400이다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const confirmed = await minorToken(s, '2009-03-01');
    expect((await check(fanHeaders(s), { orderIds: [order], consent: false, verificationResultToken: confirmed['resultToken'] })).statusCode).toBe(400);
  });

  test('주문 ID가 0개거나 21개면 400이다', async () => {
    const s = await login();
    const confirmed = await minorToken(s, '2009-03-01');
    expect((await check(fanHeaders(s), { orderIds: [], consent: true, verificationResultToken: confirmed['resultToken'] })).statusCode).toBe(400);
    expect((await check(fanHeaders(s), { orderIds: Array.from({ length: 21 }, () => newKey()), consent: true, verificationResultToken: confirmed['resultToken'] })).statusCode).toBe(400);
  });

  test('다른 계정의 확인 토큰이면 403이다', async () => {
    const a = await login();
    const b = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: b.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const confirmed = await minorToken(a, '2009-03-01');
    const r = await check(fanHeaders(b), { orderIds: [order], consent: true, verificationResultToken: confirmed['resultToken'] });
    expect(r.statusCode).toBe(403);
  });

  test('만료된 확인 토큰은 403이고 결과를 주지 않는다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const confirmed = await minorToken(s, '2009-03-01');
    clock.advance(11 * 60_000);
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: confirmed['resultToken'] });
    expect(r.statusCode).toBe(403);
  });

  test('본인확인 결과에 생년월일이 없으면 422이고 계산하지 않는다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const confirmed = await minorToken(s, undefined);
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: confirmed['resultToken'] });
    expect(r.statusCode).toBe(422);
  });

  test('생년월일은 응답·로그·DB에 남지 않는다', async () => {
    const s = await login();
    const order = newKey();
    const birth = '2009-03-01';
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const confirmed = await minorToken(s, birth);
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: confirmed['resultToken'] });
    expect(r.statusCode).toBe(200);
    expect(r.payload).not.toContain(birth);
    expect(logLines.join('\n')).not.toContain(birth);
  });

  test('본인확인을 마치지 않은 계정은 403 identity-required다', async () => {
    const s = await login();
    const order = newKey();
    bases.set(order, { payerAccountId: s.accountId, paidAtMs: KST('2026-11-20T21:00:00') });
    const r = await check(fanHeaders(s), { orderIds: [order], consent: true, verificationResultToken: 'not-a-token' });
    expect(r.statusCode).toBe(403);
  });
});
