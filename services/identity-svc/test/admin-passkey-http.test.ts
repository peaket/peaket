// 관리 계정 재인증과 내 패스키의 받는 층(openapi /v1/{partner,ops}/auth/reauthentications·/passkey-registrations·/passkeys, BUILD_ORDER BOT-122, ADR-0206).
// 서비스 뼈대를 실제로 띄워 계약 Zod 본문 검사, 오류 이름(Problem type)과 상태 코드, X-Reauth-Token 머리, 캐시 금지를 본다. 브라우저 대신 시험용 소프트웨어 인증기를 쓴다.
import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { type AdminAuthz, createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { JoseAdminReauthVerifier } from '../src/modules/admin/adapters/jose-admin-reauth-verifier.js';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import type { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { loadPolicyLists } from '../src/modules/admin/adapters/word-list-files.js';
import { LoginPasswordStep } from '../src/modules/admin/application/login-password-step.js';
import { LoginSecondStep } from '../src/modules/admin/application/login-second-step.js';
import { SetAdminPassword } from '../src/modules/admin/application/set-admin-password.js';
import { BeginTotpEnrollment, ConfirmTotpEnrollment } from '../src/modules/admin/application/totp-enrollment.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { ADMIN_LOGIN_STORE } from '../src/modules/admin/domain/ports.js';
import { base32Decode, totpAt } from '../src/modules/admin/domain/totp.js';
import { JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { SoftAuthenticator } from './soft-authenticator.js';
import { fanKey, ISSUER, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const PA = '0190f3a1-7c2e-7a00-8000-00000000f101';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000000f1';
const PW = '봄비내리는월요일아침의커피한잔';
const clock = fakeClock({ now: Date.parse('2026-11-05T15:00:00Z') });
const authz = new Map<string, AdminAuthz>();
let svc: Awaited<ReturnType<typeof createService>>;
let seed: Buffer;
let sid: string;
let store: MemoryAdminAccountStore;

const code = () => {
  clock.advance(30_000);
  return totpAt(seed, Math.floor(clock.now() / 30_000));
};

beforeAll(async () => {
  const fan = await fanKey();
  const admin = await fanKey();
  const keys = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-http-pk' }) });
  svc = await createService({
    name: 'identity-svc',
    module: AppModule.register({
      memory: true,
      session: { signer: new JoseTokenSigner(keys, ISSUER), keys, deviceRefs: testDeviceRefs(), signals: recordingSignals() },
      verification: { provider: testAgency(clock), hashers: HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5)) },
      admin: {
        config: DEFAULT_ADMIN_AUTH_CONFIG,
        lists: loadPolicyLists({}),
        pepper: new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1),
        iterations: 1_000,
        breaches: { isBreached: async () => false },
        humanCheck: { verify: async () => 'OK' },
        signals: { failure: () => {}, alert: () => {} },
        totpCipher: new LocalTotpSeedCipher(Buffer.alloc(32, 6)),
        signer: new JoseAdminTokenSigner(keys, ISSUER),
        reauthVerifier: new JoseAdminReauthVerifier(keys, ISSUER, clock),
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    adminAuthz: { getAdminAuthz: async (q) => authz.get(q.sessionId) ?? { valid: false, role: '' } },
  });
  store = svc.app.get<MemoryAdminAccountStore>(ADMIN_LOGIN_STORE);
  store.create({ id: PA, role: 'partner_admin', email: 'pk.http@stella.example', status: 'ACTIVE', promoterId: PROMOTER, displayName: '대표 담당', now: clock.now() });
  await svc.app.get(SetAdminPassword).run({ accountId: PA, password: PW, partner: { names: [], numbers: [] } });
  const { otpauthUri } = await svc.app.get(BeginTotpEnrollment).run({ accountId: PA, now: clock.now() });
  seed = base32Decode(new URL(otpauthUri).searchParams.get('secret')!);
  await svc.app.get(ConfirmTotpEnrollment).run({ accountId: PA, code: totpAt(seed, Math.floor(clock.now() / 30_000)) });
  const s1 = await svc.app.get(LoginPasswordStep).run({ aud: 'partner', email: 'pk.http@stella.example', password: PW, ip: '203.0.113.30', deviceId: 'dev-h', humanCheckToken: 'ok' });
  if (s1.kind !== 'PASSED') throw new Error(s1.kind);
  const s2 = await svc.app.get(LoginSecondStep).run({ aud: 'partner', loginStep: s1.loginStep, code: code(), ip: '203.0.113.30', deviceId: 'dev-h' });
  if (s2.kind !== 'DONE') throw new Error(s2.kind);
  sid = s2.sessionId;
  authz.set(sid, { valid: true, role: 'partner_admin', tenantId: PROMOTER });
});

afterAll(async () => {
  await svc?.close();
});

const headers = (extra: Record<string, string> = {}) => ({ 'x-user-id': PA, 'x-session-id': sid, 'x-user-aud': 'partner', ...extra });
const post = (url: string, payload?: object, extra: Record<string, string> = {}) => svc.http.inject({ method: 'POST', url, headers: headers(extra), ...(payload ? { payload } : {}) });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown> & { type?: string };
const problemOf = (r: { statusCode: number; payload: string }) => ({ status: r.statusCode, type: String(json(r).type ?? '').replace(/^.*\//, '') });

describe('관리 계정 재인증·패스키 REST(BOT-122)', () => {
  test('I-T53③④_HTTP: 비밀번호·TOTP 토큰으로첫패스키를등록하고_패스키재인증은factors셋_다른출처서명은422·같은단계는410·마지막하나는409·10개면등록시작409이며캐시하지않는다 [ASVS v5.0.0-6.3.3]', async () => {
    // 첫 패스키: 비밀번호·TOTP만으로 ACCOUNT_SECURITY 토큰
    const r1 = await post('/v1/partner/auth/reauthentications', { act: 'ACCOUNT_SECURITY', password: PW, code: code() });
    expect(r1.statusCode).toBe(200);
    expect(r1.headers['cache-control']).toBe('no-store');
    expect(json(r1)).toMatchObject({ next: 'DONE', factors: ['password', 'totp'], expiresInSeconds: 300 });
    // 토큰 없이 등록 시작은 403
    expect(problemOf(await post('/v1/partner/auth/passkey-registrations'))).toEqual({ status: 403, type: 'reauth-required' });
    const begin = await post('/v1/partner/auth/passkey-registrations', undefined, { 'x-reauth-token': String(json(r1).reauthToken) });
    expect(begin.statusCode).toBe(201);
    const b = json(begin) as { registrationId: string; publicKey: { challenge: string; rp: { id: string } } };
    expect(b.publicKey.rp.id).toBe('partner.peaket.example');
    const authn = new SoftAuthenticator();
    const created = await post('/v1/partner/auth/passkeys', { registrationId: b.registrationId, credential: authn.register(b.publicKey), name: '사무실 노트북' });
    expect(created.statusCode).toBe(201);
    expect(json(created)).toMatchObject({ name: '사무실 노트북', backedUp: true, deviceType: 'multiDevice', lastUsedAt: null, createdAt: new Date(clock.now()).toISOString() });
    expect(created.payload).not.toContain(authn.credentialId.toString('base64url'));
    // 같은 등록 ID는 다시 쓰지 못한다
    expect(problemOf(await post('/v1/partner/auth/passkeys', { registrationId: b.registrationId, credential: new SoftAuthenticator().register(b.publicKey) }))).toEqual({ status: 410, type: 'passkey-registration-invalid' });
    const list = await svc.http.inject({ method: 'GET', url: '/v1/partner/auth/passkeys', headers: headers() });
    expect(list.statusCode).toBe(200);
    expect((json(list).items as unknown[]).length).toBe(1);
    // 패스키 재인증
    const step = async () => {
      const r = await post('/v1/partner/auth/reauthentications', { act: 'PAYOUT_ACCOUNT', password: PW, code: code(), withPasskey: true });
      expect(r.statusCode).toBe(200);
      return json(r) as { next: string; reauthStep: string; publicKey: { challenge: string; rpId: string } };
    };
    const p1 = await step();
    expect(p1.next).toBe('PASSKEY');
    const evil = await post('/v1/partner/auth/reauthentications', { reauthStep: p1.reauthStep, credential: authn.assert(p1.publicKey, { origin: 'https://partner.peaket-login.example' }) });
    expect(problemOf(evil)).toEqual({ status: 422, type: 'passkey-assertion-invalid' });
    expect(problemOf(await post('/v1/partner/auth/reauthentications', { reauthStep: p1.reauthStep, credential: authn.assert(p1.publicKey) }))).toEqual({ status: 410, type: 'reauth-step-invalid' });
    const p2 = await step();
    const ok = await post('/v1/partner/auth/reauthentications', { reauthStep: p2.reauthStep, credential: authn.assert(p2.publicKey) });
    expect(ok.statusCode).toBe(200);
    expect(json(ok)).toMatchObject({ next: 'DONE', factors: ['password', 'totp', 'passkey'] });
    // 패스키가 생긴 뒤에는 비밀번호·TOTP 토큰으로 지우지 못하고(403), 패스키 토큰으로도 파트너 관리자의 마지막 하나는 409다
    const pk = (json(created) as { passkeyId: string }).passkeyId;
    const plain = json(await post('/v1/partner/auth/reauthentications', { act: 'ACCOUNT_SECURITY', password: PW, code: code() })).reauthToken as string;
    expect(problemOf(await svc.http.inject({ method: 'DELETE', url: `/v1/partner/auth/passkeys/${pk}`, headers: headers({ 'x-reauth-token': plain }) }))).toEqual({ status: 403, type: 'reauth-required' });
    const p3 = await svc.http.inject({ method: 'POST', url: '/v1/partner/auth/reauthentications', headers: headers(), payload: { act: 'ACCOUNT_SECURITY', password: PW, code: code(), withPasskey: true } });
    const s3 = json(p3) as { reauthStep: string; publicKey: { challenge: string; rpId: string } };
    const strong = json(await post('/v1/partner/auth/reauthentications', { reauthStep: s3.reauthStep, credential: authn.assert(s3.publicKey) })).reauthToken as string;
    expect(problemOf(await svc.http.inject({ method: 'DELETE', url: `/v1/partner/auth/passkeys/${pk}`, headers: headers({ 'x-reauth-token': strong }) }))).toEqual({ status: 409, type: 'last-passkey' });
    // 10개 [가정]가 차면 등록 시작은 409 passkey-limit(나머지 아홉은 저장소에 바로 넣는다)
    for (let n = 0; n < 9; n++) {
      const row = { id: randomUUID(), accountId: PA, credentialId: randomBytes(32), publicKey: randomBytes(77), signCount: 0, transports: [], deviceType: 'multiDevice' as const, backedUp: true, aaguid: '00000000-0000-0000-0000-000000000000', name: `채움 ${n}`, createdAt: clock.now(), lastUsedAt: null };
      expect(await store.addPasskey(row, 10, clock.now())).toBe('ADDED');
    }
    const s4 = json(await post('/v1/partner/auth/reauthentications', { act: 'ACCOUNT_SECURITY', password: PW, code: code(), withPasskey: true })) as { reauthStep: string; publicKey: { challenge: string; rpId: string } };
    const strong2 = json(await post('/v1/partner/auth/reauthentications', { reauthStep: s4.reauthStep, credential: authn.assert(s4.publicKey) })).reauthToken as string;
    expect(problemOf(await post('/v1/partner/auth/passkey-registrations', undefined, { 'x-reauth-token': strong2 }))).toEqual({ status: 409, type: 'passkey-limit' });
  });

  test('HTTP: 틀린코드는422reauth-code-invalid·틀린비밀번호는422current-password-invalid_관제작업묶음은파트너경로에서400_비밀번호바꾸기필요세션은403', async () => {
    expect(problemOf(await post('/v1/partner/auth/reauthentications', { act: 'PAYOUT_ACCOUNT', password: PW, code: '000000' }))).toEqual({ status: 422, type: 'reauth-code-invalid' });
    expect(problemOf(await post('/v1/partner/auth/reauthentications', { act: 'PAYOUT_ACCOUNT', password: '틀린 비밀번호입니다 정말로', code: code() }))).toEqual({ status: 422, type: 'current-password-invalid' });
    expect((await post('/v1/partner/auth/reauthentications', { act: 'OPS_COMMAND', password: PW, code: code() })).statusCode).toBe(400);
    // 복구 코드 꼴은 받지 않는다(TOTP 6자리만), 모르는 칸도 400
    expect((await post('/v1/partner/auth/reauthentications', { act: 'PAYOUT_ACCOUNT', password: PW, code: 'ABCD-EFGH-JKMN-PQRS' })).statusCode).toBe(400);
    expect((await post('/v1/partner/auth/reauthentications', { act: 'PAYOUT_ACCOUNT', password: PW, code: code(), extra: 1 })).statusCode).toBe(400);
    const limited = await post('/v1/partner/auth/reauthentications', { act: 'PAYOUT_ACCOUNT', password: PW, code: code() }, { 'x-user-scope': 'password:change' });
    expect(problemOf(limited)).toEqual({ status: 403, type: 'password-change-required' });
    // 관제 경로는 관제 역할 세션만
    expect((await svc.http.inject({ method: 'GET', url: '/v1/ops/auth/passkeys', headers: { ...headers(), 'x-user-aud': 'ops' } })).statusCode).toBe(403);
  });
});
