// F-05-12 O-T28 ① 부스 본인확인 대조(대조 목적 동의·ci_hmac 일치·reverificationToken 5분·계정/티켓 묶임).
// 정본: docs/features/offline-gate.md §9.1 '부스 재발급', docs/features/identity.md §6.1·§11 I-T40,
//       openapi createIdentityBoothReverification, docs/api/openapi.yaml VerificationStart/VerificationResult.
// 시험 값은 정본 숫자(5분)를 그대로 쓴다. 코드 상수를 가져오지 않는다.
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { CreateSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { agencyResult, fanKey, ISSUER, newKey, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const NOW = Date.parse('2026-11-26T03:00:00.000Z');
const TICKET = '0190f3a1-7c2e-7a00-8000-000000000f01';
const OTHER_TICKET = '0190f3a1-7c2e-7a00-8000-000000000f02';
const TOKEN_MS = 5 * 60_000;

let svc: Awaited<ReturnType<typeof createService>>;
const clock = fakeClock({ now: NOW });
const quiet = () => new Writable({ write: (_c, _e, cb) => cb() });

const login = () => svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `u-${newKey().slice(0, 8)}`, email: null, deviceId: null });
const fanHeaders = (s: { accountId: string; sessionId: string }) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '' });
const boothStart = (s: { accountId: string; sessionId: string }, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: '/v1/identity/booth-reverifications', headers: { ...fanHeaders(s), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const verifyResult = (s: { accountId: string; sessionId: string }, verificationId: string, providerResult: Record<string, string>) =>
  svc.http.inject({ method: 'POST', url: `/v1/identity/verifications/${verificationId}/result`, headers: { ...fanHeaders(s), 'content-type': 'application/json' }, payload: JSON.stringify({ providerResult }) });

/** 그 계정을 먼저 본인확인한다(부스 대조는 이미 본인확인한 계정만 받는다). person이 계정의 ci_hmac을 정한다 */
async function verifyFirst(accountId: string, person: string): Promise<void> {
  const st = await svc.app.get(StartVerification).run({ accountId, sessionId: null, purpose: 'FIRST', next: '/' });
  await svc.app.get(ConfirmVerification).run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person }) });
}

let signer: JoseTokenSigner;

beforeAll(async () => {
  const fan = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  signer = new JoseTokenSigner(keys, ISSUER);
  svc = await createService({
    name: 'identity-svc-f0512-booth',
    module: AppModule.register({
      memory: true,
      session: { signer, keys, deviceRefs: testDeviceRefs(), signals: recordingSignals(), cookieDomain: 'peaket.example' },
      verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
  });
});
afterAll(async () => {
  await svc?.close().catch(() => {});
});

describe('O-T28 ① 부스 본인확인 대조', () => {
  test('O-T28 ① 대조 목적 동의가 없으면 422이고 시작하지 않는다', async () => {
    const s = await login();
    await verifyFirst(s.accountId, 'holder-consent');
    const r = await boothStart(s, { ticketId: TICKET, consent: false });
    expect(r.statusCode).toBe(422);
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/booth-consent-required', status: 422 });
  });

  test('O-T28 ① 본인확인 기록이 없는 계정은 409 booth-mismatch이고 시작하지 않는다', async () => {
    const s = await login();
    const r = await boothStart(s, { ticketId: TICKET, consent: true });
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/booth-mismatch', status: 409 });
  });

  test('O-T28 ① 결과가 다른 사람이면 409 booth-mismatch이고 토큰이 없으며, ci_matched=false 행만 남는다', async () => {
    const s = await login();
    await verifyFirst(s.accountId, 'holder-mismatch');
    const st = await boothStart(s, { ticketId: TICKET, consent: true });
    expect(st.statusCode).toBe(201);
    const start = JSON.parse(st.payload) as { verificationId: string };
    const r = await verifyResult(s, start.verificationId, agencyResult(clock, start.verificationId, { person: 'other-person' }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/booth-mismatch', status: 409 });
    // 결과 응답에 토큰이 없다
    expect((JSON.parse(r.payload) as { resultToken?: string }).resultToken).toBeUndefined();
  });

  test('O-T28 ① 결과가 같은 사람이면 resultToken(5분, 계정·티켓 묶임)이 나오고 연계정보·토큰 원문은 저장하지 않는다', async () => {
    const s = await login();
    await verifyFirst(s.accountId, 'holder-match');
    const st = await boothStart(s, { ticketId: TICKET, consent: true });
    expect(st.statusCode).toBe(201);
    const start = JSON.parse(st.payload) as { verificationId: string; expiresAt: string };
    expect(Date.parse(start.expiresAt) - NOW).toBe(300_000);
    // 대조 목적 동의 때 확인한 계정의 ci_hmac과 같은 사람이어야 한다(다른 문자열이면 409)
    const r = await verifyResult(s, start.verificationId, agencyResult(clock, start.verificationId, { person: 'holder-match' }));
    expect(r.statusCode).toBe(200);
    const done = JSON.parse(r.payload) as { resultToken?: string };
    expect(done.resultToken).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // 토큰 확인은 같은 계정·티켓일 때만 true다. 만료 경계는 5분−1ms/5분이다.
    const verifyPath = '../src/modules/verification/application/verify-booth-reverification.js';
    const mod = (await import(verifyPath)) as { VerifyBoothReverification: new (...args: never[]) => { run(i: { token: string; accountId: string; ticketId: string }): Promise<boolean> } };
    const verify = svc.app.get(mod.VerifyBoothReverification as never) as { run(i: { token: string; accountId: string; ticketId: string }): Promise<boolean> };
    expect(await verify.run({ token: done.resultToken!, accountId: s.accountId, ticketId: TICKET })).toBe(true);
    expect(await verify.run({ token: done.resultToken!, accountId: s.accountId, ticketId: OTHER_TICKET })).toBe(false);
    expect(await verify.run({ token: done.resultToken!, accountId: '0190f3a1-7c2e-7a00-8000-000000000f99', ticketId: TICKET })).toBe(false);
    clock.advance(TOKEN_MS - 1);
    expect(await verify.run({ token: done.resultToken!, accountId: s.accountId, ticketId: TICKET })).toBe(true);
    clock.advance(1);
    expect(await verify.run({ token: done.resultToken!, accountId: s.accountId, ticketId: TICKET })).toBe(false);
  });
});
