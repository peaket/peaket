// 관리 계정 패스키와 재인증의 시험(docs/features/identity.md §6 '관리 계정 패스키의 첫 구현', BUILD_ORDER BOT-122, I-T53 ②③④, ADR-0206).
// 메모리 저장소(단위)와 PostgreSQL·Valkey(통합)에 같은 시험을 돌린다. 브라우저 대신 시험용 소프트웨어 인증기(soft-authenticator.ts)를 쓴다.
import { randomBytes, randomUUID } from 'node:crypto';
import { type FakeClock, TokenRejected, TokenVerifier } from '@peaket/platform';
import { decodeJwt, decodeProtectedHeader, type JSONWebKeySet } from 'jose';
import { describe, expect, test } from 'vitest';
import { JoseAdminReauthVerifier } from '../src/modules/admin/adapters/jose-admin-reauth-verifier.js';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import { MemoryLoginCounters } from '../src/modules/admin/adapters/memory-login-counters.js';
import { Pbkdf2AdminPasswords, RECOVERY_CODE_ITERATIONS } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { SimpleWebAuthnCeremonies } from '../src/modules/admin/adapters/simple-webauthn.js';
import { LoginPasswordStep, shortHash, sourceAddressOf } from '../src/modules/admin/application/login-password-step.js';
import { LoginSecondStep } from '../src/modules/admin/application/login-second-step.js';
import { ManageAdminAccounts } from '../src/modules/admin/application/manage-admin-accounts.js';
import { ManagePasskeys } from '../src/modules/admin/application/manage-passkeys.js';
import { ReauthenticateAdmin, type ReauthStartOutcome } from '../src/modules/admin/application/reauthenticate-admin.js';
import { RecordAdminLoginSuccess } from '../src/modules/admin/application/record-login-success.js';
import { BeginTotpEnrollment, ConfirmTotpEnrollment } from '../src/modules/admin/application/totp-enrollment.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { type ReauthAct, relyingPartiesOf } from '../src/modules/admin/domain/passkey.js';
import type { AdminAccountStore, AdminAud, AdminLoginStore, AdminManagementStore, AdminPasskeyStore, AdminRole, AdminSecondStepStore, AdminSessionStore, PasskeyChallenges } from '../src/modules/admin/domain/ports.js';
import { base32Decode, totpAt } from '../src/modules/admin/domain/totp.js';
import { TokenKeyRing } from '../src/modules/session/index.js';
import { SoftAuthenticator } from './soft-authenticator.js';
import { fanKey, ISSUER } from './support.js';

type Store = AdminAccountStore & AdminLoginStore & AdminSecondStepStore & AdminSessionStore & AdminPasskeyStore & AdminManagementStore & {
  create(i: { id: string; role: AdminRole; email: string; status?: 'ACTIVE'; promoterId?: string | null; displayName?: string | null; now: number }): void | Promise<void>;
};

export interface PasskeyStoreUnderTest {
  store: Store;
  challenges: PasskeyChallenges;
  clock: FakeClock;
  /** 그 계정의 재인증 기록(발급 차례): 작업 묶음, factors, 쓴 때 */
  reauthRows(accountId: string): Promise<{ act: string; factors: string[]; usedAt: number | null; sessionId: string }[]>;
  /** 그 계정에 적은 알림 종류(적은 차례) */
  notices(accountId: string): Promise<string[]>;
}

const PW = '봄비내리는월요일아침의커피한잔';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000c0001';
const ORIGINS = { partner: 'https://partner.peaket.example', ops: 'https://console.peaket.example' };
const cfg = DEFAULT_ADMIN_AUTH_CONFIG;

/** 시험 도구 묶음(통합 시험이 Redis 키를 볼 때도 쓴다) */
export async function kitOf(t: PasskeyStoreUnderTest) {
  const { store, clock } = t;
  const pepper = new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1);
  const passwords = new Pbkdf2AdminPasswords(pepper, { iterations: 1_000 });
  const recovery = new Pbkdf2AdminPasswords(pepper, { iterations: RECOVERY_CODE_ITERATIONS, context: 'admin-rc-v1' });
  const cipher = new LocalTotpSeedCipher(Buffer.alloc(32, 3));
  const counters = new MemoryLoginCounters();
  const seen = { failures: [] as string[], alerts: [] as string[], issued: [] as string[] };
  const signals = { failure: (_a: string, r: string) => void seen.failures.push(r), alert: (k: string) => void seen.alerts.push(k), reauthIssued: (a: string, f: string) => void seen.issued.push(`${a}:${f}`) };
  const fan = await fanKey();
  const admin = await fanKey();
  const ring = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-pk' }) });
  const signer = new JoseAdminTokenSigner(ring, ISSUER);
  const verifier = new JoseAdminReauthVerifier(ring, ISSUER, clock);
  const rps = relyingPartiesOf(ORIGINS, { env: 'ci' });
  const webauthn = new SimpleWebAuthnCeremonies();
  const human = { verify: async () => 'OK' as const };
  const step1 = new LoginPasswordStep(store, counters, passwords, { isBreached: async () => false }, human, signals, cfg, clock);
  const step2 = new LoginSecondStep(store, counters, cipher, recovery, new RecordAdminLoginSuccess(store, counters, clock), signer, signals, cfg, clock);
  const reauth = new ReauthenticateAdmin(store, counters, passwords, cipher, t.challenges, webauthn, rps, signer, signals, cfg, clock);
  const passkeys = new ManagePasskeys(store, t.challenges, webauthn, rps, verifier, clock);
  const manage = new ManageAdminAccounts(store, clock);

  /** 비밀번호와 TOTP까지 갖춘 활성 계정 */
  const account = async (role: AdminRole, o: { aud?: AdminAud } = {}) => {
    const id = randomUUID();
    const aud: AdminAud = o.aud ?? (role === 'partner_admin' || role === 'partner_member' ? 'partner' : 'ops');
    const email = `pk.${randomBytes(4).toString('hex')}@peaket.example`;
    await store.create({ id, role, email, status: 'ACTIVE', promoterId: aud === 'partner' ? PROMOTER : null, displayName: '민지', now: clock.now() });
    await store.setPassword({ id, phc: await passwords.hash(id, PW), breachCheckedAt: clock.now(), now: clock.now() });
    const { otpauthUri } = await new BeginTotpEnrollment(store, cipher).run({ accountId: id, now: clock.now() });
    const seed = base32Decode(new URL(otpauthUri).searchParams.get('secret')!);
    await new ConfirmTotpEnrollment(store, cipher, recovery, clock).run({ accountId: id, code: totpAt(seed, Math.floor(clock.now() / 30_000)) });
    return { id, aud, email, seed };
  };
  type Account = Awaited<ReturnType<typeof account>>;
  /** 다음 30초 칸의 TOTP(같은 칸은 한 번만 받으므로 시계를 넘긴다) */
  const code = (a: Account) => {
    clock.advance(30_000);
    return totpAt(a.seed, Math.floor(clock.now() / 30_000));
  };
  const login = async (a: Account, ip = '203.0.113.20') => {
    const s1 = await step1.run({ aud: a.aud, email: a.email, password: PW, ip, deviceId: 'dev-pk', humanCheckToken: 'ok' });
    if (s1.kind !== 'PASSED') throw new Error(s1.kind);
    const s2 = await step2.run({ aud: a.aud, loginStep: s1.loginStep, code: code(a), ip, deviceId: 'dev-pk' });
    if (s2.kind !== 'DONE') throw new Error(s2.kind);
    return s2.sessionId;
  };
  const start = (a: Account, sid: string, act: ReauthAct, o: { withPasskey?: boolean; password?: string; code?: string; aud?: AdminAud } = {}) =>
    reauth.start({ aud: o.aud ?? a.aud, accountId: a.id, sessionId: sid, act, password: o.password ?? PW, code: o.code ?? code(a), withPasskey: o.withPasskey ?? false, ip: '203.0.113.20' });
  const passkeyStep = (r: ReauthStartOutcome) => {
    if (r.kind !== 'PASSKEY') throw new Error(`패스키 단계가 아니다: ${r.kind}`);
    return r as Extract<ReauthStartOutcome, { kind: 'PASSKEY' }> & { publicKey: { challenge: string; rpId: string; allowCredentials: { id: string }[]; userVerification: string } };
  };
  const done = (r: { kind: string }) => {
    if (r.kind !== 'DONE') throw new Error(`토큰이 아니다: ${r.kind}`);
    return r as { kind: 'DONE'; reauthToken: string; factors: string[]; expiresInSeconds: number };
  };
  /** 재인증 토큰(필요하면 그 인증기로 패스키까지) */
  const token = async (a: Account, sid: string, act: ReauthAct, authn?: SoftAuthenticator) => {
    if (!authn) return done(await start(a, sid, act)).reauthToken;
    const p = passkeyStep(await start(a, sid, act, { withPasskey: true }));
    return done(await reauth.finish({ aud: a.aud, accountId: a.id, sessionId: sid, reauthStep: p.reauthStep, credential: authn.assert(p.publicKey) })).reauthToken;
  };
  /** 등록 시작부터 마치기까지. using이 있으면 그 패스키로 재인증한다(패스키가 이미 있는 계정) */
  const register = async (a: Account, sid: string, authn: SoftAuthenticator, using?: SoftAuthenticator, name?: string) => {
    const begin = await passkeys.beginRegistration({ aud: a.aud, accountId: a.id, sessionId: sid, reauthToken: await token(a, sid, 'ACCOUNT_SECURITY', using) });
    if (begin.kind !== 'OK') throw new Error(`등록 시작 실패: ${begin.kind}`);
    return passkeys.finishRegistration({ aud: a.aud, accountId: a.id, sessionId: sid, registrationId: begin.registrationId, credential: authn.register(begin.publicKey as never), ...(name ? { name } : {}) });
  };
  const jwks = async () => ring.jwks('admin', clock.now()) as JSONWebKeySet;
  return { ...t, seen, reauth, passkeys, manage, account, login, start, passkeyStep, done, token, register, code, jwks, ring, counters, signer };
}

export function passkeyCases(name: string, make: () => Promise<PasskeyStoreUnderTest>) {
  describe(`관리 계정 패스키와 재인증(${name}, BOT-122)`, () => {
    test('I-T53③_비밀번호·TOTP·패스키로재인증하면factors셋인재인증토큰을주고재인증기록에factors셋이남는다 [ASVS v5.0.0-6.3.3] [ASVS v5.0.0-9.2.2]', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_admin');
      const sid = await k.login(a);
      const authn = new SoftAuthenticator();
      const reg = await k.register(a, sid, authn, undefined, '사무실 노트북');
      expect(reg).toMatchObject({ kind: 'OK', passkey: { name: '사무실 노트북', backedUp: true, deviceType: 'multiDevice' } });
      const p = k.passkeyStep(await k.start(a, sid, 'PAYOUT_ACCOUNT', { withPasskey: true }));
      // RP ID는 파트너 콘솔 호스트, 사용자 확인 필수, 그 계정 패스키만, 챌린지 32바이트
      expect(p.publicKey).toMatchObject({ rpId: 'partner.peaket.example', userVerification: 'required', allowCredentials: [{ id: authn.credentialId.toString('base64url') }] });
      expect(Buffer.from(p.publicKey.challenge, 'base64url')).toHaveLength(32);
      const d = k.done(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: p.reauthStep, credential: authn.assert(p.publicKey) }));
      expect(d.factors).toEqual(['password', 'totp', 'passkey']);
      expect(d.expiresInSeconds).toBe(300);
      expect(decodeProtectedHeader(d.reauthToken)).toMatchObject({ alg: 'ES256', typ: 'reauth+jwt', kid: 'admin-pk' });
      expect(decodeJwt(d.reauthToken)).toMatchObject({ iss: ISSUER, sub: a.id, aud: 'partner', sid, act: 'PAYOUT_ACCOUNT', factors: ['password', 'totp', 'passkey'] });
      // 받는 서비스의 공용 확인기가 그대로 읽는다(관리 키 셋, aud partner, 세션·작업 묶음)
      const verifier = new TokenVerifier({ issuer: ISSUER, jwks: () => k.jwks(), clock: k.clock });
      expect(await verifier.verifyReauth(d.reauthToken, { keySet: 'admin', audience: 'partner', sessionId: sid, act: 'PAYOUT_ACCOUNT' })).toMatchObject({ accountId: a.id, factors: ['password', 'totp', 'passkey'] });
      await expect(verifier.verifyReauth(d.reauthToken, { keySet: 'admin', audience: 'partner', sessionId: sid, act: 'BOOKER_EXPORT' })).rejects.toBeInstanceOf(TokenRejected);
      expect((await k.reauthRows(a.id)).at(-1)).toMatchObject({ act: 'PAYOUT_ACCOUNT', factors: ['password', 'totp', 'passkey'], sessionId: sid, usedAt: null });
      expect(k.seen.issued.at(-1)).toBe('partner:password_totp_passkey');
    });

    test('I-T53②_비밀번호·TOTP만으로재인증한토큰의factors에는passkey가없다', async () => {
      const k = await kitOf(await make());
      const a = await k.account('commander');
      const sid = await k.login(a);
      const d = k.done(await k.start(a, sid, 'OPS_COMMAND'));
      expect(d.factors).toEqual(['password', 'totp']);
      expect(decodeJwt(d.reauthToken)).toMatchObject({ aud: 'ops', act: 'OPS_COMMAND', factors: ['password', 'totp'] });
      expect((await k.reauthRows(a.id)).at(-1)).toMatchObject({ act: 'OPS_COMMAND', factors: ['password', 'totp'] });
      // 패스키를 요청했는데 등록한 패스키가 없으면 비밀번호를 보기 전에 거절한다(인증 앱 코드도 쓰지 않는다)
      expect(await k.start(a, sid, 'OPS_COMMAND', { withPasskey: true, password: '틀린 비밀번호' })).toEqual({ kind: 'NO_PASSKEY' });
      expect(k.seen.failures).not.toContain('password');
    });

    test('I-T53④_다른출처(가짜사이트)나다른RP ID에서받은패스키서명은거부되고_재인증단계도쓴다 [ASVS v5.0.0-6.3.3]', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_admin');
      const sid = await k.login(a);
      const authn = new SoftAuthenticator();
      await k.register(a, sid, authn);
      for (const bad of [{ origin: 'https://partner.peaket-login.example' }, { rpId: 'peaket-login.example' }, { origin: 'https://console.peaket.example', rpId: 'console.peaket.example' }]) {
        const p = k.passkeyStep(await k.start(a, sid, 'PAYOUT_ACCOUNT', { withPasskey: true }));
        expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: p.reauthStep, credential: authn.assert(p.publicKey, bad) })).toEqual({ kind: 'ASSERTION_INVALID' });
        // 같은 단계는 다시 내지 못한다(맞든 틀리든 한 번)
        expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: p.reauthStep, credential: authn.assert(p.publicKey) })).toEqual({ kind: 'STEP_INVALID' });
      }
      // 다른 출처에서 등록하려 해도 받지 않는다
      const begin = await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY', authn) });
      if (begin.kind !== 'OK') throw new Error(begin.kind);
      expect(await k.passkeys.finishRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, registrationId: begin.registrationId, credential: new SoftAuthenticator().register(begin.publicKey as never, { origin: 'https://partner.peaket-login.example' }) })).toEqual({ kind: 'ATTESTATION_INVALID' });
      // 패스키 확인 실패는 로그인 실패 수에 세지 않고 지표로만 센다
      expect(k.seen.failures.filter((f) => f === 'passkey')).toHaveLength(3);
    });

    test('사용자확인표시(UV)가없는자격은등록도재인증도받지않는다(userVerification required) [ASVS v5.0.0-6.3.3]', async () => {
      const k = await kitOf(await make());
      const a = await k.account('operator');
      const sid = await k.login(a);
      const begin = await k.passkeys.beginRegistration({ aud: 'ops', accountId: a.id, sessionId: sid, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY') });
      if (begin.kind !== 'OK') throw new Error(begin.kind);
      expect(begin.publicKey).toMatchObject({ rp: { id: 'console.peaket.example' }, authenticatorSelection: { userVerification: 'required' }, attestation: 'none' });
      const authn = new SoftAuthenticator({ origin: ORIGINS.ops });
      expect(await k.passkeys.finishRegistration({ aud: 'ops', accountId: a.id, sessionId: sid, registrationId: begin.registrationId, credential: authn.register(begin.publicKey as never, { uv: false }) })).toEqual({ kind: 'ATTESTATION_INVALID' });
      expect((await k.register(a, sid, authn)).kind).toBe('OK');
      const p = k.passkeyStep(await k.start(a, sid, 'APPROVAL', { withPasskey: true }));
      expect(await k.reauth.finish({ aud: 'ops', accountId: a.id, sessionId: sid, reauthStep: p.reauthStep, credential: authn.assert(p.publicKey, { uv: false }) })).toEqual({ kind: 'ASSERTION_INVALID' });
    });

    test('챌린지는32바이트이고한번만쓴다_다시내거나5분이지나거나다른세션·콘솔이면처음부터다 [ASVS v5.0.0-6.7.2]', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_admin');
      const sid = await k.login(a);
      const other = await k.login(a, '203.0.113.21');
      const authn = new SoftAuthenticator();
      await k.register(a, sid, authn);
      // 다시 내기
      const p1 = k.passkeyStep(await k.start(a, sid, 'BOOKER_EXPORT', { withPasskey: true }));
      k.done(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: p1.reauthStep, credential: authn.assert(p1.publicKey) }));
      expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: p1.reauthStep, credential: authn.assert(p1.publicKey) })).toEqual({ kind: 'STEP_INVALID' });
      // 5분이 지남
      const p2 = k.passkeyStep(await k.start(a, sid, 'BOOKER_EXPORT', { withPasskey: true }));
      expect(p2.expiresInSeconds).toBe(300);
      k.clock.advance(5 * 60_000 + 1);
      expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: p2.reauthStep, credential: authn.assert(p2.publicKey) })).toEqual({ kind: 'STEP_INVALID' });
      // 다른 세션·다른 콘솔·모르는 단계
      const p3 = k.passkeyStep(await k.start(a, sid, 'BOOKER_EXPORT', { withPasskey: true }));
      expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: other, reauthStep: p3.reauthStep, credential: authn.assert(p3.publicKey) })).toEqual({ kind: 'STEP_INVALID' });
      const p4 = k.passkeyStep(await k.start(a, sid, 'BOOKER_EXPORT', { withPasskey: true }));
      expect(await k.reauth.finish({ aud: 'ops', accountId: a.id, sessionId: sid, reauthStep: p4.reauthStep, credential: authn.assert(p4.publicKey) })).toEqual({ kind: 'STEP_INVALID' });
      expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: randomBytes(32).toString('base64url'), credential: authn.assert(p4.publicKey) })).toEqual({ kind: 'STEP_INVALID' });
      // 등록 챌린지도 같다: 한 번, 5분, 그 세션
      const begin = await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY', authn) });
      if (begin.kind !== 'OK') throw new Error(begin.kind);
      expect(Buffer.from((begin.publicKey as { challenge: string }).challenge, 'base64url')).toHaveLength(32);
      const second = new SoftAuthenticator();
      expect(await k.passkeys.finishRegistration({ aud: 'partner', accountId: a.id, sessionId: other, registrationId: begin.registrationId, credential: second.register(begin.publicKey as never) })).toEqual({ kind: 'REGISTRATION_INVALID' });
      expect(await k.passkeys.finishRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, registrationId: begin.registrationId, credential: second.register(begin.publicKey as never) })).toEqual({ kind: 'REGISTRATION_INVALID' });
      const again = await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY', authn) });
      if (again.kind !== 'OK') throw new Error(again.kind);
      k.clock.advance(5 * 60_000 + 1);
      expect(await k.passkeys.finishRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, registrationId: again.registrationId, credential: second.register(again.publicKey as never) })).toEqual({ kind: 'REGISTRATION_INVALID' });
    });

    test('남의자격으로낸서명은거부되고_남의자격ID는다시등록하지못한다', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_admin');
      const b = await k.account('partner_admin');
      const sa = await k.login(a);
      const sb = await k.login(b);
      const mine = new SoftAuthenticator();
      const theirs = new SoftAuthenticator();
      await k.register(a, sa, mine);
      await k.register(b, sb, theirs);
      const p = k.passkeyStep(await k.start(a, sa, 'PAYOUT_ACCOUNT', { withPasskey: true }));
      expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sa, reauthStep: p.reauthStep, credential: theirs.assert(p.publicKey) })).toEqual({ kind: 'ASSERTION_INVALID' });
      // B의 자격 ID를 A의 것처럼 실어도(서명은 A의 키) 받지 않는다
      const p2 = k.passkeyStep(await k.start(a, sa, 'PAYOUT_ACCOUNT', { withPasskey: true }));
      expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sa, reauthStep: p2.reauthStep, credential: mine.assert(p2.publicKey, { credentialId: theirs.credentialId }) })).toEqual({ kind: 'ASSERTION_INVALID' });
      // B의 자격 ID로 A에 등록하려 하면 409
      const begin = await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sa, reauthToken: await k.token(a, sa, 'ACCOUNT_SECURITY', mine) });
      if (begin.kind !== 'OK') throw new Error(begin.kind);
      expect(await k.passkeys.finishRegistration({ aud: 'partner', accountId: a.id, sessionId: sa, registrationId: begin.registrationId, credential: new SoftAuthenticator().register(begin.publicKey as never, { credentialId: theirs.credentialId }) })).toEqual({ kind: 'EXISTS' });
    });

    test('서명횟수가뒤로가면거부하고SEV3경보를내며_둘다0인동기화패스키는받는다', async () => {
      const k = await kitOf(await make());
      const a = await k.account('commander');
      const sid = await k.login(a);
      const hw = new SoftAuthenticator({ origin: ORIGINS.ops, counting: true });
      await k.register(a, sid, hw);
      const finish = async (o: { signCount?: number; authn?: SoftAuthenticator; credentialId?: Buffer } = {}) => {
        const p = k.passkeyStep(await k.start(a, sid, 'OPS_COMMAND', { withPasskey: true }));
        const x = { ...(o.signCount === undefined ? {} : { signCount: o.signCount }), ...(o.credentialId ? { credentialId: o.credentialId } : {}) };
        return k.reauth.finish({ aud: 'ops', accountId: a.id, sessionId: sid, reauthStep: p.reauthStep, credential: (o.authn ?? hw).assert(p.publicKey, x) });
      };
      expect((await finish({ signCount: 5 })).kind).toBe('DONE');
      // 같은 값·작은 값·0은 퇴행이다(복제한 인증기 신호)
      for (const n of [5, 3, 0]) expect(await finish({ signCount: n })).toEqual({ kind: 'ASSERTION_INVALID' });
      expect(k.seen.alerts.filter((x) => x === 'passkey_counter_regression')).toHaveLength(3);
      expect((await finish({ signCount: 6 })).kind).toBe('DONE');
      // 동기화 패스키는 늘 0이다
      const synced = new SoftAuthenticator({ origin: ORIGINS.ops });
      await k.register(a, sid, synced, hw);
      expect((await finish({ authn: synced })).kind).toBe('DONE');
      expect((await finish({ authn: synced })).kind).toBe('DONE');
      // 등록한 자격 ID에 다른 키로 서명한 위조 응답은 서명 확인에서 떨어지고, 횟수가 뒤로 가도 경보가 울리지 않는다(판정은 서명이 맞은 뒤)
      const before = k.seen.alerts.length;
      const forged = new SoftAuthenticator({ origin: ORIGINS.ops, counting: true });
      expect(await finish({ authn: forged, credentialId: hw.credentialId, signCount: 1 })).toEqual({ kind: 'ASSERTION_INVALID' });
      expect(k.seen.alerts).toHaveLength(before);
    });

    test('I-T10_패스키단계는비밀번호·TOTP1단계를지난재인증단계없이는받지않고_재인증의코드는TOTP만받는다', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_admin');
      const sid = await k.login(a);
      const authn = new SoftAuthenticator();
      await k.register(a, sid, authn);
      const fake = { challenge: randomBytes(32).toString('base64url'), rpId: 'partner.peaket.example' };
      expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: randomBytes(32).toString('base64url'), credential: authn.assert(fake) })).toEqual({ kind: 'STEP_INVALID' });
      // 복구 코드는 재인증에 받지 않는다(TOTP 6자리만)
      expect((await k.start(a, sid, 'PAYOUT_ACCOUNT', { code: 'ABCD-EFGH-JKMN-PQRS' })).kind).toBe('CODE_INVALID');
    });

    test('재인증의비밀번호·인증앱코드실패는로그인실패처럼세고_같은TOTP칸은다시받지않으며_보호잠금이면재인증토큰을주지않는다 [ASVS v5.0.0-6.5.1]', async () => {
      const k = await kitOf(await make());
      const a = await k.account('operator');
      const sid = await k.login(a);
      // 셈: 계정 실패 수·비밀번호 연속 실패 누계·2단계 실패 수(DB)와 그 세션이 로그인한 묶음의 실패 수(Redis 대역)
      const session = (await k.store.findSession(sid))!;
      const counts = async () => {
        const st = (await k.store.findLoginById(a.id))!.state;
        const peek = await k.counters.peek({ subject: a.id, pair: session.pairRef, ipHash: shortHash(sourceAddressOf('203.0.113.20')), now: k.clock.now() });
        return { failed: st.failedAttempts, total: st.passwordFailureTotal, second: st.secondFactorFailures, pair: peek.pairFailures };
      };
      expect(await counts()).toEqual({ failed: 0, total: 0, second: 0, pair: 0 });
      expect(await k.start(a, sid, 'APPROVAL', { password: '틀린 비밀번호입니다 정말로' })).toEqual({ kind: 'PASSWORD_INVALID' });
      expect(k.seen.failures).toContain('password');
      expect(await counts()).toEqual({ failed: 1, total: 1, second: 0, pair: 1 });
      expect(await k.start(a, sid, 'APPROVAL', { code: '000000' })).toMatchObject({ kind: 'CODE_INVALID' });
      expect(k.seen.failures).toContain('second_factor');
      expect(await counts()).toEqual({ failed: 2, total: 1, second: 1, pair: 2 });
      // 같은 TOTP 칸은 다시 받지 않는다
      const c = k.code(a);
      k.done(await k.start(a, sid, 'APPROVAL', { code: c }));
      expect((await k.start(a, sid, 'APPROVAL', { code: c })).kind).toBe('CODE_INVALID');
      // 끝난 세션·모르는 세션은 401
      expect((await k.start(a, randomUUID(), 'APPROVAL')).kind).toBe('SESSION_INVALID');
      // 2단계 실패가 5 [가정]가 되면 보호 잠금이고, 그 뒤로는 비밀번호를 보지 않고 423이다
      const b = await k.account('cs_lead');
      const sb = await k.login(b);
      const tries: string[] = [];
      for (let i = 0; i < 5; i++) tries.push((await k.start(b, sb, 'APPROVAL', { code: '000000' })).kind);
      expect(tries).toEqual(['CODE_INVALID', 'CODE_INVALID', 'CODE_INVALID', 'CODE_INVALID', 'LOCKED']);
      expect(await k.start(b, sb, 'APPROVAL')).toEqual({ kind: 'LOCKED', lock: 'PROTECT' });
      expect(await k.start(b, sb, 'APPROVAL', { password: '틀린 비밀번호입니다 정말로' })).toEqual({ kind: 'LOCKED', lock: 'PROTECT' });
    });

    test('재인증1단계는시간잠금중이면비밀번호를보지않고423이고_풀리면받는다', async () => {
      const k = await kitOf(await make());
      const a = await k.account('commander');
      const sid = await k.login(a);
      const now = k.clock.now();
      await k.store.updateLoginState(a.id, now, (cur) => ({ next: { ...cur, lockKind: 'TIMED', lockedUntil: now + 15 * 60_000, lockReason: 'FAILED_ATTEMPTS', lockedAt: now, recentLockAt: [now] }, notices: [] }));
      const r = await k.start(a, sid, 'OPS_COMMAND', { password: '틀린 비밀번호입니다 정말로' });
      expect(r).toMatchObject({ kind: 'LOCKED', lock: 'TIMED' });
      expect((r as { retryAfterSeconds: number }).retryAfterSeconds).toBeGreaterThan(14 * 60);
      // 잠긴 동안 거절한 시도는 세지 않는다
      expect((await k.store.findLoginById(a.id))!.state).toMatchObject({ failedAttempts: 0, passwordFailureTotal: 0 });
      expect(k.seen.failures).toContain('locked');
      k.clock.advance(15 * 60_000);
      expect((await k.start(a, sid, 'OPS_COMMAND')).kind).toBe('DONE');
    });

    test('내패스키등록·지우기는ACCOUNT_SECURITY재인증토큰을한번만받고_패스키가있으면passkey요소가있어야한다 [ASVS v5.0.0-7.5.1]', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_member');
      const sid = await k.login(a);
      const begin = (reauthToken: string) => k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, reauthToken });
      expect(await begin('')).toEqual({ kind: 'REAUTH_REQUIRED' });
      expect(await begin(await k.token(a, sid, 'PAYOUT_ACCOUNT'))).toEqual({ kind: 'REAUTH_REQUIRED' });
      const t1 = await k.token(a, sid, 'ACCOUNT_SECURITY');
      const other = await k.login(a, '203.0.113.22');
      expect(await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: other, reauthToken: t1 })).toEqual({ kind: 'REAUTH_REQUIRED' });
      expect((await begin(t1)).kind).toBe('OK');
      expect(await begin(t1)).toEqual({ kind: 'REAUTH_REQUIRED' });
      expect((await k.reauthRows(a.id)).find((r) => r.act === 'ACCOUNT_SECURITY' && r.usedAt !== null)).toBeDefined();
      const first = new SoftAuthenticator();
      expect((await k.register(a, sid, first)).kind).toBe('OK');
      // 패스키가 생긴 뒤에는 비밀번호·TOTP만 한 토큰으로 더하지 못한다
      expect(await begin(await k.token(a, sid, 'ACCOUNT_SECURITY'))).toEqual({ kind: 'REAUTH_REQUIRED' });
      const second = await k.register(a, sid, new SoftAuthenticator(), first, '휴대폰');
      if (second.kind !== 'OK') throw new Error(second.kind);
      expect((await k.passkeys.list(a.id)).map((p) => p.name)).toEqual(['패스키', '휴대폰']);
      expect(await k.notices(a.id)).toEqual(['PASSKEY_ADDED', 'PASSKEY_ADDED']);
      // 지우기도 같다: passkey 없는 토큰은 403, 쓴 토큰은 403
      const del = (reauthToken: string, passkeyId = second.passkey.passkeyId) => k.passkeys.remove({ aud: 'partner', accountId: a.id, sessionId: sid, passkeyId, reauthToken });
      expect(await del(await k.token(a, sid, 'ACCOUNT_SECURITY'))).toEqual({ kind: 'REAUTH_REQUIRED' });
      const t2 = await k.token(a, sid, 'ACCOUNT_SECURITY', first);
      expect(await del(t2)).toEqual({ kind: 'OK' });
      expect(await del(t2)).toEqual({ kind: 'REAUTH_REQUIRED' });
      expect(await k.notices(a.id)).toEqual(['PASSKEY_ADDED', 'PASSKEY_ADDED', 'PASSKEY_REMOVED']);
      // 실무자는 마지막 하나도 지울 수 있다
      expect(await del(await k.token(a, sid, 'ACCOUNT_SECURITY', first), (await k.passkeys.list(a.id))[0]!.passkeyId)).toEqual({ kind: 'OK' });
      expect(await k.passkeys.list(a.id)).toEqual([]);
    });

    test('필수역할의마지막패스키는지울수없고_남은패스키로재인증하면잃은패스키를지운다_남의패스키는404 [ASVS v5.0.0-6.4.4]', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_admin');
      const b = await k.account('partner_admin');
      const sid = await k.login(a);
      const sb = await k.login(b);
      const lost = new SoftAuthenticator();
      const kept = new SoftAuthenticator();
      await k.register(a, sid, lost);
      await k.register(a, sid, kept, lost);
      const theirs = new SoftAuthenticator();
      const rb = await k.register(b, sb, theirs);
      if (rb.kind !== 'OK') throw new Error(rb.kind);
      const [lostRow, keptRow] = await k.passkeys.list(a.id);
      expect(await k.passkeys.remove({ aud: 'partner', accountId: a.id, sessionId: sid, passkeyId: rb.passkey.passkeyId, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY', kept) })).toEqual({ kind: 'NOT_FOUND' });
      expect(await k.passkeys.remove({ aud: 'partner', accountId: a.id, sessionId: sid, passkeyId: lostRow!.passkeyId, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY', kept) })).toEqual({ kind: 'OK' });
      expect(await k.passkeys.remove({ aud: 'partner', accountId: a.id, sessionId: sid, passkeyId: keptRow!.passkeyId, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY', kept) })).toEqual({ kind: 'LAST' });
      // 지운 패스키로는 재인증하지 못한다
      expect((await k.start(a, sid, 'PAYOUT_ACCOUNT', { withPasskey: true })).kind).toBe('PASSKEY');
      const p = k.passkeyStep(await k.start(a, sid, 'PAYOUT_ACCOUNT', { withPasskey: true }));
      expect(p.publicKey.allowCredentials.map((c) => c.id)).toEqual([kept.credentialId.toString('base64url')]);
      expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: p.reauthStep, credential: lost.assert(p.publicKey) })).toEqual({ kind: 'ASSERTION_INVALID' });
    });

    test('재초대CREDENTIAL_LOST·PROTECT_LOCK과삭제는패스키를모두지우고_passkey_count는그계정의패스키수다 [ASVS v5.0.0-6.4.4]', async () => {
      const k = await kitOf(await make());
      const cmd = await k.account('commander');
      const lostOwner = await k.account('partner_admin');
      const removed = await k.account('partner_member');
      const protectedOwner = await k.account('partner_admin');
      for (const x of [lostOwner, removed, protectedOwner]) {
        const s = await k.login(x);
        const one = new SoftAuthenticator();
        await k.register(x, s, one);
        await k.register(x, s, new SoftAuthenticator(), one);
      }
      expect((await k.manage.get(lostOwner.id))!.account.passkeyCount).toBe(2);
      const ri = await k.manage.reinvite({ requestId: randomUUID(), actedBy: cmd.id, accountId: lostOwner.id, reason: 'CREDENTIAL_LOST' });
      expect(ri.result).toBe('OK');
      expect(ri.account!.passkeyCount).toBe(0);
      expect(await k.passkeys.list(lostOwner.id)).toEqual([]);
      // 보호 잠금 해제 재초대(PROTECT_LOCK)도 패스키를 모두 지운다
      const now = k.clock.now();
      await k.store.updateLoginState(protectedOwner.id, now, (cur) => ({ next: { ...cur, lockKind: 'PROTECT', lockReason: 'SECOND_FACTOR_FAILURES', lockedAt: now }, notices: [] }));
      const pl = await k.manage.reinvite({ requestId: randomUUID(), actedBy: cmd.id, accountId: protectedOwner.id, reason: 'PROTECT_LOCK' });
      expect(pl.result).toBe('OK');
      expect(pl.account!.passkeyCount).toBe(0);
      expect(await k.passkeys.list(protectedOwner.id)).toEqual([]);
      // 같은 파트너사에 활성 partner_admin이 남지 않아도 실무자는 지운다(마지막 관리자 규칙은 partner_admin만)
      const rm = await k.manage.remove({ requestId: randomUUID(), actedBy: cmd.id, accountId: removed.id });
      expect(rm.result).toBe('OK');
      expect(await k.passkeys.list(removed.id)).toEqual([]);
      expect((await k.manage.get(removed.id))!.account.passkeyCount).toBe(0);
    });

    test('재인증기록은발급에서90일[가정]뒤정비가지운다(admin-reauth-expired)', async () => {
      const k = await kitOf(await make());
      const a = await k.account('viewer');
      const sid = await k.login(a);
      k.done(await k.start(a, sid, 'ACCOUNT_SECURITY'));
      const keep = 90 * 86_400_000;
      expect(await k.store.purgeReauths(k.clock.now() - keep)).toBe(0);
      expect(await k.reauthRows(a.id)).toHaveLength(1);
      k.clock.advance(keep + 60_000);
      expect(await k.store.purgeReauths(k.clock.now() - keep)).toBeGreaterThanOrEqual(1);
      expect(await k.reauthRows(a.id)).toHaveLength(0);
    });

    test('자격ID가1023바이트를넘거나_응답의rawId와인증기데이터의자격ID가다르면등록하지않는다(WebAuthn §7.1)', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_member');
      const sid = await k.login(a);
      const finish = async (x: { credentialId?: Buffer; responseId?: Buffer }) => {
        const begin = await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY') });
        if (begin.kind !== 'OK') throw new Error(begin.kind);
        return k.passkeys.finishRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, registrationId: begin.registrationId, credential: new SoftAuthenticator().register(begin.publicKey as never, x) });
      };
      // 본문 id·rawId는 짧고 인증기 데이터 안의 자격 ID만 1,100바이트
      expect(await finish({ credentialId: randomBytes(1100), responseId: randomBytes(32) })).toEqual({ kind: 'ATTESTATION_INVALID' });
      // 둘 다 1,100바이트(받는 층은 1,366자 상한으로 먼저 막지만, 유스케이스도 막는다)
      const long = randomBytes(1100);
      expect(await finish({ credentialId: long, responseId: long })).toEqual({ kind: 'ATTESTATION_INVALID' });
      // 길이는 맞지만 서로 다른 자격 ID
      expect(await finish({ credentialId: randomBytes(32), responseId: randomBytes(32) })).toEqual({ kind: 'ATTESTATION_INVALID' });
      expect(await k.passkeys.list(a.id)).toEqual([]);
      // 1,023바이트는 받는다
      expect((await finish({ credentialId: randomBytes(1023) })).kind).toBe('OK');
    });

    test('clientDataJSON의crossOrigin이참이면(다른사이트안의iframe)등록도재인증도받지않는다', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_admin');
      const sid = await k.login(a);
      const begin = await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY') });
      if (begin.kind !== 'OK') throw new Error(begin.kind);
      const authn = new SoftAuthenticator();
      expect(await k.passkeys.finishRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, registrationId: begin.registrationId, credential: authn.register(begin.publicKey as never, { crossOrigin: true }) })).toEqual({ kind: 'ATTESTATION_INVALID' });
      await k.register(a, sid, authn);
      // 참으로 읽히는 불리언 아닌 값도 거절한다(라이브러리는 참으로 읽히면 다른 사이트 분기로 간다, 재검토 2026-11-05)
      for (const x of [{ crossOrigin: true }, { crossOrigin: true, topOrigin: 'https://partner.peaket.example' }, { crossOrigin: 'yes' as never }, { crossOrigin: 1 as never }]) {
        const p = k.passkeyStep(await k.start(a, sid, 'PAYOUT_ACCOUNT', { withPasskey: true }));
        expect(await k.reauth.finish({ aud: 'partner', accountId: a.id, sessionId: sid, reauthStep: p.reauthStep, credential: authn.assert(p.publicKey, x) })).toEqual({ kind: 'ASSERTION_INVALID' });
      }
    });

    test('지우기의passkeyId는대소문자를가리지않고_꼴이틀리면토큰을쓰지않고NOT_FOUND다', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_member');
      const sid = await k.login(a);
      const first = new SoftAuthenticator();
      await k.register(a, sid, first);
      const second = await k.register(a, sid, new SoftAuthenticator(), first);
      if (second.kind !== 'OK') throw new Error(second.kind);
      const t = await k.token(a, sid, 'ACCOUNT_SECURITY', first);
      expect(await k.passkeys.remove({ aud: 'partner', accountId: a.id, sessionId: sid, passkeyId: 'not-a-uuid', reauthToken: t })).toEqual({ kind: 'NOT_FOUND' });
      expect(await k.passkeys.remove({ aud: 'partner', accountId: a.id, sessionId: sid, passkeyId: second.passkey.passkeyId.toUpperCase(), reauthToken: t })).toEqual({ kind: 'OK' });
      expect((await k.passkeys.list(a.id)).map((p) => p.passkeyId)).not.toContain(second.passkey.passkeyId);
      // 저장소는 없는 계정에 NOT_FOUND로 답한다(메모리·PostgreSQL 같게)
      expect(await k.store.removePasskey(randomUUID(), (await k.passkeys.list(a.id))[0]!.passkeyId, [], k.clock.now())).toBe('NOT_FOUND');
    });

    test('다른콘솔(aud)로서명한ACCOUNT_SECURITY토큰은기록이있어도받지않는다', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_admin');
      const sid = await k.login(a);
      const now = k.clock.now();
      const forged = await k.signer.reauth({ accountId: a.id, sessionId: sid, aud: 'ops', act: 'ACCOUNT_SECURITY', factors: ['password', 'totp'] }, now);
      await k.store.recordReauth({ jti: forged.jti, accountId: a.id, sessionId: sid, aud: 'ops', act: 'ACCOUNT_SECURITY', factors: ['password', 'totp'], passkeyId: null, issuedAt: now, expiresAt: forged.expiresAt });
      expect(await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, reauthToken: forged.token })).toEqual({ kind: 'REAUTH_REQUIRED' });
      // 기록도 쓰지 않았다
      expect((await k.reauthRows(a.id)).find((r) => r.act === 'ACCOUNT_SECURITY')?.usedAt).toBeNull();
    });

    test('토큰하나로등록시작과지우기를동시에부르면하나만받고_필수역할의마지막두패스키를동시에지우면하나만지운다(docs/data.md §5)', async () => {
      const k = await kitOf(await make());
      const a = await k.account('operator');
      const sid = await k.login(a);
      const first = new SoftAuthenticator({ origin: ORIGINS.ops });
      await k.register(a, sid, first);
      const second = await k.register(a, sid, new SoftAuthenticator({ origin: ORIGINS.ops }), first);
      if (second.kind !== 'OK') throw new Error(second.kind);
      const t = await k.token(a, sid, 'ACCOUNT_SECURITY', first);
      const [b, r] = await Promise.all([
        k.passkeys.beginRegistration({ aud: 'ops', accountId: a.id, sessionId: sid, reauthToken: t }),
        k.passkeys.remove({ aud: 'ops', accountId: a.id, sessionId: sid, passkeyId: second.passkey.passkeyId, reauthToken: t }),
      ]);
      // 한 토큰은 하나만 받는다: 하나는 REAUTH_REQUIRED, 다른 하나는 성공한다(재검토 2026-11-05)
      expect([b.kind, r.kind].sort()).toEqual(['OK', 'REAUTH_REQUIRED']);
      // 두 패스키를 서로 다른 토큰으로 동시에 지운다: operator는 하나가 남아야 한다
      if (r.kind === 'OK') await k.register(a, sid, new SoftAuthenticator({ origin: ORIGINS.ops }), first);
      const [p1, p2] = await k.passkeys.list(a.id);
      const t1 = await k.token(a, sid, 'ACCOUNT_SECURITY', first);
      const t2 = await k.token(a, sid, 'ACCOUNT_SECURITY', first);
      const both = await Promise.all([
        k.passkeys.remove({ aud: 'ops', accountId: a.id, sessionId: sid, passkeyId: p1!.passkeyId, reauthToken: t1 }),
        k.passkeys.remove({ aud: 'ops', accountId: a.id, sessionId: sid, passkeyId: p2!.passkeyId, reauthToken: t2 }),
      ]);
      expect(both.map((x) => x.kind).sort()).toEqual(['LAST', 'OK']);
      expect(await k.passkeys.list(a.id)).toHaveLength(1);
    });

    test('패스키는한계정에10개[가정]까지이고_넘으면등록시작이409다', async () => {
      const k = await kitOf(await make());
      const a = await k.account('partner_member');
      const sid = await k.login(a);
      const first = new SoftAuthenticator();
      await k.register(a, sid, first);
      for (let i = 1; i < 10; i++) expect((await k.register(a, sid, new SoftAuthenticator(), first)).kind).toBe('OK');
      expect(await k.passkeys.beginRegistration({ aud: 'partner', accountId: a.id, sessionId: sid, reauthToken: await k.token(a, sid, 'ACCOUNT_SECURITY', first) })).toEqual({ kind: 'LIMIT' });
    });
  });
}

/** RP ID·출처 설정(시작 검사) */
export function relyingPartyCases() {
  describe('RP ID와 허용 출처(BOT-122)', () => {
    test('RP ID는콘솔출처의호스트이고_경로가있거나https가아닌출처는시작하지않는다(local·ci는localhost http만)', () => {
      expect(relyingPartiesOf(ORIGINS, { env: 'prod' })).toEqual({
        partner: { rpId: 'partner.peaket.example', origin: 'https://partner.peaket.example', rpName: 'PEAKET 파트너' },
        ops: { rpId: 'console.peaket.example', origin: 'https://console.peaket.example', rpName: 'PEAKET 관제' },
      });
      expect(() => relyingPartiesOf({ ...ORIGINS, partner: 'https://partner.peaket.example/login' }, { env: 'prod' })).toThrow(/PEAKET_PARTNER_CONSOLE_ORIGIN/);
      expect(() => relyingPartiesOf({ ...ORIGINS, ops: 'http://console.peaket.example' }, { env: 'prod' })).toThrow(/PEAKET_OPS_CONSOLE_ORIGIN/);
      expect(() => relyingPartiesOf({ ...ORIGINS, ops: 'http://localhost:3001' }, { env: 'prod' })).toThrow(/PEAKET_OPS_CONSOLE_ORIGIN/);
      // 환경 이름이 비면 운영처럼 닫힌 쪽이다(main.ts는 없으면 'prod'를 넘긴다)
      expect(() => relyingPartiesOf({ ...ORIGINS, ops: 'http://localhost:3001' }, { env: '' })).toThrow(/PEAKET_OPS_CONSOLE_ORIGIN/);
      expect(relyingPartiesOf({ ...ORIGINS, ops: 'http://localhost:3001' }, { env: 'local' }).ops).toEqual({ rpId: 'localhost', origin: 'http://localhost:3001', rpName: 'PEAKET 관제' });
      // 두 콘솔이 같은 RP ID면 패스키가 섞이므로 시작하지 않는다
      expect(() => relyingPartiesOf({ partner: 'https://peaket.example', ops: 'https://peaket.example' }, { env: 'prod' })).toThrow(/RP ID/);
    });
  });
}
