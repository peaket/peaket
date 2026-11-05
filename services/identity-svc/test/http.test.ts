// identity-svc 앱 포트의 REST 경로: 팬 토큰 갱신(openapi POST /v1/identity/access-tokens, I-T4)과 공개키 묶음(GET /internal/jwks/{set}.json, I-T20).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AddProvider, CreateSession, JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { MergeCheckUnavailable } from '../src/modules/session/domain/ports.js';
import { HmacIdentityHashers, SetRestrictedCiHold } from '../src/modules/verification/index.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { AGENCY_URL, agencyResult, fanKey, ISSUER, newKey, recordingSignals, testAgency, testDeviceRefs } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
let signer: JoseTokenSigner;
const clock = fakeClock({ now: Date.parse('2026-11-03T03:00:00Z') });
/** 서비스 로그(정규 로그 줄)를 모은다: 기관 결과 값이 로그에 남지 않는지 본다(I-T45) */
const logLines: string[] = [];
const quiet = new Writable({
  write: (c, _e, cb) => {
    logLines.push(String(c));
    cb();
  },
});

beforeAll(async () => {
  const fan = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({ memory: true, session: { signer: (signer = new JoseTokenSigner(keys, ISSUER)), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals(), cookieDomain: 'peaket.example' }, verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) } }),
    // 정규 로그 줄을 모두 남긴다(표본 1/1): 기관 결과 값이 로그에 없는지 본다
    env: { PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1' },
    clock,
    logDestination: quiet,
  });
});
afterAll(async () => {
  await svc?.close();
});

const login = () => svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `u-${newKey().slice(0, 8)}`, email: null, deviceId: null });
const refresh = (cookie?: string) => svc.http.inject({ method: 'POST', url: '/v1/identity/access-tokens', headers: cookie ? { cookie } : {} });
const attrs = (c: string) => Object.fromEntries(c.split(';').slice(1).map((x) => { const [k, v] = x.trim().split('='); return [k!.toLowerCase(), v ?? true]; }));

describe('탈퇴 경로(DELETE /v1/identity/account, identity §8 탈퇴의 첫 구현)', () => {
  const fanHeaders = (s: { accountId: string; sessionId: string }) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '' });
  const del = (headers: Record<string, string>, payload = '{}') =>
    svc.http.inject({ method: 'DELETE', url: '/v1/identity/account', headers: { ...headers, 'content-type': 'application/json' }, payload });

  test('I-T16_재인증토큰머리가없거나틀리면403reauth-required이고_맞으면204·캐시하지않으며_그세션의갱신이더는안된다 [ASVS v5.0.0-7.4.2]', async () => {
    const s = await login();
    for (const r of [await del(fanHeaders(s)), await del({ ...fanHeaders(s), 'x-reauth-token': 'nope' })]) {
      expect(r.statusCode).toBe(403);
      expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/reauth-required', status: 403 });
    }
    const token = (await signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, svc.clock.now())).token;
    const ok = await del({ ...fanHeaders(s), 'x-reauth-token': token });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['cache-control']).toBe('no-store');
    expect((await refresh(`__Secure-peaket_rt=${s.refreshToken}`)).statusCode).toBe(401);
    // 같은 토큰을 다시 쓰면 403이다(세션이 끝나 게이트웨이를 지나지 못하지만, 지났다고 쳐도)
    expect((await del({ ...fanHeaders(s), 'x-reauth-token': token })).statusCode).toBe(403);
  });

  test('I-T68⑨_대조값보관행이있는계정의첫탈퇴는409withdrawal-confirmation-required와fraudHold(상태·끝)이고_acknowledgeFraudHold로다시보내면204다', async () => {
    const s = await login();
    const caseId = '0190f3a1-7c2e-7a00-8000-00000000ca5c';
    const until = svc.clock.now() + 30 * 86_400_000;
    // 본인확인을 마친 계정이어야 행이 생긴다
    expect(await svc.app.get(SetRestrictedCiHold).run({ accountId: s.accountId, fraudCaseId: caseId, state: 'CASE_OPEN', until, version: 1 })).toBe('NO_VERIFICATION');
    const st = await svc.app.get(StartVerification).run({ accountId: s.accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    await svc.app.get(ConfirmVerification).run({ accountId: s.accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person: 'http-hold-person' }) });
    expect(await svc.app.get(SetRestrictedCiHold).run({ accountId: s.accountId, fraudCaseId: caseId, state: 'CASE_OPEN', until, version: 1 })).toBe('OK');
    const token = (await signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, svc.clock.now())).token;
    const first = await del({ ...fanHeaders(s), 'x-reauth-token': token });
    expect(first.statusCode).toBe(409);
    expect(JSON.parse(first.payload)).toMatchObject({ type: 'https://peaket.example/problems/withdrawal-confirmation-required', status: 409, fraudHold: { state: 'CASE_OPEN', until: new Date(until).toISOString() } });
    expect((await del({ ...fanHeaders(s), 'x-reauth-token': token }, JSON.stringify({ acknowledgeFraudHold: true }))).statusCode).toBe(204);
  });

  test('탈퇴본문은계약처럼닫혀있다_모르는칸이나환불계좌의모르는칸·빠진칸은400이고_계약의환불계좌는받는다(guidelines §1, BAS-040이 넘긴 것)', async () => {
    const s = await login();
    const bad = [{ unknown: true }, { refundAccount: { bankCode: '004', accountNumber: '1', holderName: '가', memo: 'x' } }, { refundAccount: { bankCode: '004' } }];
    for (const b of bad) expect((await del(fanHeaders(s), JSON.stringify(b))).statusCode).toBe(400);
    // 본문이 맞으면 재인증 확인까지 간다(토큰이 없어 403)
    expect((await del(fanHeaders(s), JSON.stringify({ confirmCancelUnusedTickets: true, refundAccount: { bankCode: '004', accountNumber: '1234', holderName: '김민지' } }))).statusCode).toBe(403);
  });
});

describe('로그인 수단 목록(GET /v1/identity/providers, identity §8 탈퇴 화면 연결)', () => {
  test('I-T16_연결한로그인수단을연결한순서로주고_마지막로그인시각을주며_캐시하지않는다(BOT-041부터 로그인 때 적는다)', async () => {
    const s = await login();
    const r = await svc.http.inject({ method: 'GET', url: '/v1/identity/providers', headers: { 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '' } });
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.payload)).toEqual({ providers: [{ provider: 'kakao', linkedAt: new Date(svc.clock.now()).toISOString(), lastLoginAt: new Date(svc.clock.now()).toISOString() }] });
  });
});

describe('팬 토큰 갱신 경로', () => {
  test('I-T4_리프레시쿠키로갱신하면_204와새쿠키둘이고본문에토큰이없다 [ASVS v5.0.0-3.3.4]', async () => {
    const s = await login();
    const r = await refresh(`__Secure-peaket_rt=${s.refreshToken}; other=1`);
    expect(r.statusCode).toBe(204);
    expect(r.payload).toBe('');
    expect(r.headers['cache-control']).toBe('no-store');
    const cookies = [r.headers['set-cookie']].flat() as string[];
    const at = cookies.find((c) => c.startsWith('__Secure-peaket_at='))!;
    const rt = cookies.find((c) => c.startsWith('__Secure-peaket_rt='))!;
    expect(attrs(at)).toMatchObject({ path: '/', domain: 'peaket.example', httponly: true, secure: true, samesite: 'Strict' });
    expect(attrs(rt)).toMatchObject({ path: '/v1/identity/access-tokens', domain: 'peaket.example', httponly: true, secure: true, samesite: 'Strict' });
    // 액세스 쿠키 수명은 리프레시 쿠키와 같다(identity §3)
    expect(attrs(at)['max-age']).toBe(attrs(rt)['max-age']);
    expect(rt).not.toContain(s.refreshToken);
  });

  test('I-T4_재사용탐지와모르는토큰과쿠키없음은_401과WWW-Authenticate이고쿠키를지운다', async () => {
    const s = await login();
    expect((await refresh(`__Secure-peaket_rt=${s.refreshToken}`)).statusCode).toBe(204);
    // 30초 [가정] 유예 밖에서 다시 쓴다(시계를 민다)
    (svc.clock as ReturnType<typeof fakeClock>).advance(31_000);
    for (const r of [await refresh(`__Secure-peaket_rt=${s.refreshToken}`), await refresh('__Secure-peaket_rt=nope'), await refresh()]) {
      expect(r.statusCode).toBe(401);
      expect(r.headers['www-authenticate']).toBe('Cookie realm="peaket"');
      expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/refresh-token-invalid', status: 401 });
      const cleared = [r.headers['set-cookie']].flat() as string[];
      expect(cleared.map((c) => attrs(c)['max-age'])).toEqual(['0', '0']);
    }
  });
});

describe('공개키 묶음 경로', () => {
  test('I-T20_키셋마다공개키묶음을주고_캐시5분이며_없는키셋은404다', async () => {
    const r = await svc.http.inject({ method: 'GET', url: '/internal/jwks/fan.json' });
    expect(r.statusCode).toBe(200);
    expect(r.headers['content-type']).toContain('application/jwk-set+json');
    expect(r.headers['cache-control']).toBe('public, max-age=300');
    const body = JSON.parse(r.payload) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]).not.toHaveProperty('d');
    expect(JSON.parse((await svc.http.inject({ method: 'GET', url: '/internal/jwks/admin.json' })).payload)).toEqual({ keys: [] });
    expect((await svc.http.inject({ method: 'GET', url: '/internal/jwks/other.json' })).statusCode).toBe(404);
  });
});

describe('본인확인 경로(시험 어댑터)', () => {
  const fan = (accountId: string, sessionId: string) => ({ 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'fan', 'content-type': 'application/json' });

  test('FR002_시작·결과확정·조회를거쳐_다음갱신의액세스토큰에ticket:buy와pid가실린다', async () => {
    const s = await login();
    const h = fan(s.accountId, s.sessionId);
    const start = await svc.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: h, payload: JSON.stringify({ next: '/booking/e-1' }) });
    expect(start.statusCode).toBe(201);
    const { verificationId, window } = JSON.parse(start.payload) as { verificationId: string; window: { url: string } };
    expect(window.url).toBe(AGENCY_URL);
    const done = await svc.http.inject({ method: 'POST', url: `/v1/identity/verifications/${verificationId}/result`, headers: h, payload: JSON.stringify({ providerResult: agencyResult(clock, verificationId, { person: 'http-1' }) }) });
    expect(done.statusCode).toBe(200);
    expect(done.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(done.payload)).toEqual({ verificationId, purpose: 'FIRST', status: 'VERIFIED', next: '/booking/e-1', restrictedUntil: null });
    const got = await svc.http.inject({ method: 'GET', url: `/v1/identity/verifications/${verificationId}/result`, headers: h });
    expect(JSON.parse(got.payload).status).toBe('VERIFIED');
    const r = await refresh(`__Secure-peaket_rt=${s.refreshToken}`);
    const at = ([r.headers['set-cookie']].flat() as string[]).find((c) => c.startsWith('__Secure-peaket_at='))!.split(';')[0]!.split('=')[1]!;
    const claims = JSON.parse(Buffer.from(at.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;
    expect(claims.scope).toBe('ticket:buy');
    expect(typeof claims.pid).toBe('string');
  });

  test('I-T6_[ASVS v5.0.0-3.7.2]_다른계정의같은사람은409이고_다른출처next는400이다', async () => {
    const a = await login();
    const b = await login();
    const go = async (s: { accountId: string; sessionId: string }) => {
      const st = await svc.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: fan(s.accountId, s.sessionId), payload: JSON.stringify({ next: '/' }) });
      const id = (JSON.parse(st.payload) as { verificationId: string }).verificationId;
      return svc.http.inject({ method: 'POST', url: `/v1/identity/verifications/${id}/result`, headers: fan(s.accountId, s.sessionId), payload: JSON.stringify({ providerResult: agencyResult(clock, id, { person: 'http-dup' }) }) });
    };
    expect((await go(a)).statusCode).toBe(200);
    const dup = await go(b);
    expect(dup.statusCode).toBe(409);
    expect(JSON.parse(dup.payload).type).toBe('https://peaket.example/problems/duplicate-account');
    const bad = await svc.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: fan(b.accountId, b.sessionId), payload: JSON.stringify({ next: '//evil.example' }) });
    expect(bad.statusCode).toBe(400);
  });
});

describe('기관 결과 값과 로그', () => {
  test('I-T45_[ASVS v5.0.0-16.2.5]_결과경로에보낸기관값(result·mac)은_서비스로그에0건이다', async () => {
    const s = await login();
    const h = { 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'content-type': 'application/json' };
    const st = await svc.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: h, payload: JSON.stringify({ next: '/' }) });
    const id = (JSON.parse(st.payload) as { verificationId: string }).verificationId;
    // 서명이 틀린 결과(기관 값 확인이 실패하는 길)는 따로 시작한 건으로 보낸다
    const st2 = await svc.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: h, payload: JSON.stringify({ next: '/' }) });
    const id2 = (JSON.parse(st2.payload) as { verificationId: string }).verificationId;
    const sealed = agencyResult(clock, id, { person: 'log-check', birth: '2001-02-03' });
    const forged = agencyResult(clock, id2, { person: 'log-forged', birth: '2002-03-04' });
    forged.mac = forged.mac!.replace(/.$/, forged.mac!.endsWith('A') ? 'B' : 'A');
    const before = logLines.length;
    const ok = await svc.http.inject({ method: 'POST', url: `/v1/identity/verifications/${id}/result`, headers: h, payload: JSON.stringify({ providerResult: sealed }) });
    expect(JSON.parse(ok.payload).status).toBe('VERIFIED');
    const bad = await svc.http.inject({ method: 'POST', url: `/v1/identity/verifications/${id2}/result`, headers: h, payload: JSON.stringify({ providerResult: forged }) });
    expect(JSON.parse(bad.payload).status).toBe('FAILED');
    const logged = logLines.slice(before).join('');
    expect(logged).toContain('/v1/identity/verifications/');
    for (const v of [sealed.result!, sealed.mac!, forged.result!, forged.mac!, 'log-check', 'log-forged', '2001-02-03', '2002-03-04']) expect(logged).not.toContain(v);
  });
});

describe('만 14세 미만과 로그(BOT-020)', () => {
  test('I-T42_[ASVS v5.0.0-16.2.5]_만14세미만이면_403under-14이고_생년월일은서비스로그에0건이다', async () => {
    const s = await login();
    const h = { 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'content-type': 'application/json' };
    const st = await svc.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: h, payload: JSON.stringify({ next: '/' }) });
    const id = (JSON.parse(st.payload) as { verificationId: string }).verificationId;
    const birth = '2013-09-27';
    const before = logLines.length;
    const r = await svc.http.inject({ method: 'POST', url: `/v1/identity/verifications/${id}/result`, headers: h, payload: JSON.stringify({ providerResult: agencyResult(clock, id, { person: 'log-kid', birth }) }) });
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.payload).type).toBe('https://peaket.example/problems/under-14');
    const got = await svc.http.inject({ method: 'GET', url: `/v1/identity/verifications/${id}/result`, headers: h });
    expect(JSON.parse(got.payload).status).toBe('UNDER_14');
    // 정리 중인 계정은 다시 시작하지 못한다
    const again = await svc.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: h, payload: JSON.stringify({ next: '/' }) });
    expect(again.statusCode).toBe(403);
    const logged = logLines.slice(before).join('');
    for (const v of [birth, 'log-kid']) expect(logged).not.toContain(v);
  });
});

describe('본인확인기관이 없는 환경', () => {
  test('identity§10_시작은503provider-down이고_Retry-After를싣는다(새맥락리뷰)', async () => {
    const { unavailableHashers, unavailableProvider } = await import('../src/modules/verification/index.js');
    const fan = await fanKey();
    const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk) });
    const down = await createService({
      name: 'identity-svc',
      module: AppModule.register({ memory: true, session: { signer: new JoseTokenSigner(keys, ISSUER), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals() }, verification: { provider: unavailableProvider, hashers: unavailableHashers } }),
      env: { PEAKET_ENV: 'ci' },
      clock: fakeClock({ now: Date.parse('2026-11-03T03:00:00Z') }),
      logDestination: quiet,
    });
    try {
      const r = await down.http.inject({ method: 'POST', url: '/v1/identity/verifications', headers: { 'x-user-id': '0190f3a1-7c2e-7a00-8000-000000000001', 'x-session-id': 's', 'x-user-aud': 'fan', 'content-type': 'application/json' }, payload: JSON.stringify({ next: '/' }) });
      expect(r.statusCode).toBe(503);
      expect(r.headers['retry-after']).toBeDefined();
      expect(JSON.parse(r.payload).type).toBe('https://peaket.example/problems/provider-down');
    } finally {
      await down.close();
    }
  });
});

describe('로그인 수단 해제 경로(BOT-041, I-T33)', () => {
  const fan = (s: { accountId: string; sessionId: string }) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '' });
  const reauthOf = async (s: { accountId: string; sessionId: string }) => (await signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, svc.clock.now())).token;
  const unlink = (p: string, headers: Record<string, string>) => svc.http.inject({ method: 'DELETE', url: `/v1/identity/providers/${p}`, headers });

  test('I-T33_마지막로그인수단해제는409last-login-method_재인증없으면403_없는종류는404_둘이면204이고캐시하지않는다', async () => {
    const s = await login();
    expect((await unlink('kakao', fan(s))).statusCode).toBe(403);
    const last = await unlink('kakao', { ...fan(s), 'x-reauth-token': await reauthOf(s) });
    expect(last.statusCode).toBe(409);
    expect(JSON.parse(last.payload)).toMatchObject({ type: expect.stringMatching(/last-login-method$/), status: 409 });
    expect(last.headers['cache-control']).toBe('no-store');
    expect((await unlink('naver', { ...fan(s), 'x-reauth-token': await reauthOf(s) })).statusCode).toBe(404);
    expect((await unlink('apple', { ...fan(s), 'x-reauth-token': await reauthOf(s) })).statusCode).toBe(404);
    expect(await svc.app.get(AddProvider).run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: await reauthOf(s), provider: 'google', providerUserId: `g-${newKey().slice(0, 8)}` })).toBe('LINKED');
    const ok = await unlink('google', { ...fan(s), 'x-reauth-token': await reauthOf(s) });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['cache-control']).toBe('no-store');
  });
});

describe('계정 병합 경로(BOT-042, I-T31·I-T32)', () => {
  const fan = (s: { accountId: string; sessionId: string }) => ({ 'x-user-id': s.accountId, 'x-session-id': s.sessionId, 'x-user-aud': 'fan', 'x-user-scope': '' });
  const reauthOf = async (s: { accountId: string; sessionId: string }) => (await signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, svc.clock.now())).token;

  test('I-T31·I-T32_병합제안은제안한계정만읽고_확정은재인증이있어야202이며_그뒤흡수계정의제공자로로그인하면대표계정이다', async () => {
    const a = await login();
    const gsub = `g-${newKey().slice(0, 8)}`;
    const b = await svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'google', providerUserId: gsub, email: null, deviceId: null });
    const r = await svc.app.get(AddProvider).add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await reauthOf(a), provider: 'google', providerUserId: gsub });
    expect(r.result).toBe('OTHER_ACCOUNT');
    const url = `/v1/identity/merge-proposals/${r.mergeProposalId}`;
    const got = await svc.http.inject({ method: 'GET', url, headers: fan(a) });
    expect(got.statusCode).toBe(200);
    expect(got.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(got.payload)).toMatchObject({ proposalId: r.mergeProposalId, primaryAccountId: a.accountId, mergedAccountId: b.accountId, status: 'PROPOSED', blockers: [], moved: { providers: 1 } });
    expect((await svc.http.inject({ method: 'GET', url, headers: fan(b) })).statusCode).toBe(404);
    expect((await svc.http.inject({ method: 'POST', url: `${url}/confirmation`, headers: fan(a) })).statusCode).toBe(403);
    const ok = await svc.http.inject({ method: 'POST', url: `${url}/confirmation`, headers: { ...fan(a), 'x-reauth-token': await reauthOf(a) } });
    expect(ok.statusCode).toBe(202);
    expect((await svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'google', providerUserId: gsub, email: null, deviceId: null })).accountId).toBe(a.accountId);
    expect((await svc.http.inject({ method: 'POST', url: `${url}/confirmation`, headers: { ...fan(a), 'x-reauth-token': await reauthOf(a) } })).statusCode).toBe(404);
  });

  test('I-T31_OPEN21_두계정에같은종류의다른로그인수단이있으면_조회는BLOCKED와SAME_PROVIDER_KIND·sameKindProviders이고_확정은409merge-blocked와같은두칸이다', async () => {
    const a = await login();
    const gsub = `g-${newKey().slice(0, 8)}`;
    const b = await svc.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'google', providerUserId: gsub, email: null, deviceId: null });
    // 두 계정에 서로 다른 네이버 계정을 잇는다
    for (const s of [a, b]) expect(await svc.app.get(AddProvider).run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: await reauthOf(s), provider: 'naver', providerUserId: `n-${newKey().slice(0, 8)}` })).toBe('LINKED');
    const r = await svc.app.get(AddProvider).add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await reauthOf(a), provider: 'google', providerUserId: gsub });
    const url = `/v1/identity/merge-proposals/${r.mergeProposalId}`;
    const got = await svc.http.inject({ method: 'GET', url, headers: fan(a) });
    expect(JSON.parse(got.payload)).toMatchObject({ status: 'BLOCKED', blockers: ['SAME_PROVIDER_KIND'], sameKindProviders: ['naver'] });
    const blocked = await svc.http.inject({ method: 'POST', url: `${url}/confirmation`, headers: { ...fan(a), 'x-reauth-token': await reauthOf(a) } });
    expect(blocked.statusCode).toBe(409);
    expect(JSON.parse(blocked.payload)).toMatchObject({ type: expect.stringMatching(/merge-blocked$/), blockers: ['SAME_PROVIDER_KIND'], sameKindProviders: ['naver'] });
  });

  test('새맥락리뷰낮음9_확정의막는사유는409merge-blocked와blockers_불변식위반은409merge-invariant-violated_세서비스가답하지않으면503과Retry-After다', async () => {
    let mode: 'ok' | 'blocked' | 'invariant' | 'down' = 'ok';
    const checkers = (['purchase', 'ticket', 'core'] as const).map((service) => ({
      service,
      check: async () => {
        if (mode === 'down' && service === 'core') throw new MergeCheckUnavailable(service);
        if (mode === 'blocked' && service === 'purchase') return { blocks: [{ service, reason: 'SEAT_HOLD' as const }], counts: {} };
        if (mode === 'invariant' && service === 'ticket') return { blocks: [{ service, reason: 'ABSORBED_HAS_TICKETS' as const }], counts: {} };
        return { blocks: [], counts: {} };
      },
    }));
    const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify((await fanKey()).privateJwk) });
    const signer2 = new JoseTokenSigner(keys, ISSUER);
    const seen2 = recordingSignals();
    const reauth2 = async (s: { accountId: string; sessionId: string }) => (await signer2.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, clock.now())).token;
    const s2 = await createService({
      name: 'identity-svc',
      module: AppModule.register({ memory: true, session: { signer: signer2, keys, deviceRefs: testDeviceRefs(), signals: seen2, mergeCheckers: checkers as never }, verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) } }),
      env: { PEAKET_ENV: 'ci' },
      clock,
      logDestination: quiet,
    });
    try {
      const a = await s2.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: `k-${newKey().slice(0, 8)}`, email: null, deviceId: null });
      const gsub = `g-${newKey().slice(0, 8)}`;
      await s2.app.get(CreateSession).run({ idempotencyKey: newKey(), provider: 'google', providerUserId: gsub, email: null, deviceId: null });
      const r = await s2.app.get(AddProvider).add({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await reauth2(a), provider: 'google', providerUserId: gsub });
      const url = `/v1/identity/merge-proposals/${r.mergeProposalId}/confirmation`;
      const post = async () => s2.http.inject({ method: 'POST', url, headers: { ...fan(a), 'x-reauth-token': await reauth2(a) } });
      mode = 'blocked';
      const blocked = await post();
      expect(blocked.statusCode).toBe(409);
      expect(JSON.parse(blocked.payload)).toMatchObject({ type: expect.stringMatching(/merge-blocked$/), blockers: ['ACTIVE_PURCHASE_SESSION'] });
      // 같은 종류의 로그인 수단으로 막은 것이 아니면 sameKindProviders를 싣지 않는다
      expect(JSON.parse(blocked.payload)).not.toHaveProperty('sameKindProviders');
      mode = 'invariant';
      const inv = await post();
      expect(inv.statusCode).toBe(409);
      expect(JSON.parse(inv.payload)).toMatchObject({ type: expect.stringMatching(/merge-invariant-violated$/) });
      expect(seen2.seen.filter((x) => x === 'merge-invariant')).toHaveLength(1);
      mode = 'down';
      const down = await post();
      expect(down.statusCode).toBe(503);
      expect(JSON.parse(down.payload)).toMatchObject({ type: expect.stringMatching(/merge-check-unavailable$/) });
      expect(down.headers['retry-after']).toBe('5');
    } finally {
      await s2.close();
    }
  });
});

