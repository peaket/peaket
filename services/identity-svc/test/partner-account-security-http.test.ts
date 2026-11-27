// F-07-13 SCR-020 '내 계정'의 파트너 보안 경로 HTTP 시험(계획 §4·§6, identity §6·§8, ASVS 6.3.3·6.4.4·7.4.3·7.5.1·7.5.2·8.2.2).
// 서비스 뼈대를 실제로 띄워 계약 Zod 본문, Problem 이름과 상태, X-Reauth-Token, 캐시 금지, 세션 종료 사건을 본다.
// 저장소는 메모리, TOTP는 시험 계산, 패스키는 소프트웨어 인증기다. Docker·Redis·PostgreSQL·브라우저는 쓰지 않는다(계획 §12).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createService, fakeClock } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { JoseAdminReauthVerifier } from '../src/modules/admin/adapters/jose-admin-reauth-verifier.js';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import type { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { loadPolicyLists } from '../src/modules/admin/adapters/word-list-files.js';
import { GetAdminAuthz } from '../src/modules/admin/application/get-admin-authz.js';
import { LoginPasswordStep } from '../src/modules/admin/application/login-password-step.js';
import { LoginSecondStep } from '../src/modules/admin/application/login-second-step.js';
import { SetAdminPassword } from '../src/modules/admin/application/set-admin-password.js';
import { BeginTotpEnrollment, ConfirmTotpEnrollment } from '../src/modules/admin/application/totp-enrollment.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { ADMIN_LOGIN_STORE, type AdminPasswords, RECOVERY_CODE_HASHER, TotpKeyUnavailable } from '../src/modules/admin/domain/ports.js';
import { base32Decode, base32Encode, totpAt } from '../src/modules/admin/domain/totp.js';
import { JoseTokenSigner, TokenKeyRing } from '../src/modules/session/index.js';
import { HmacIdentityHashers } from '../src/modules/verification/index.js';
import { SoftAuthenticator } from './soft-authenticator.js';
import { fanKey, ISSUER, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const PROMOTER = '0190f3a1-7c2e-7a00-8000-00000000f131';
const PW = '봄비내리는월요일아침의커피한잔';
const AT = '__Secure-peaket_partner_at';
const clock = fakeClock({ now: Date.parse('2026-11-27T10:00:00+09:00') });
const UA = {
  chromeWindows: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  safariIpad: 'Mozilla/5.0 (iPad; CPU OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
};

let svc: Awaited<ReturnType<typeof createService>>;
let store: MemoryAdminAccountStore;
let guard: GetAdminAuthz;
let totpCipher: LocalTotpSeedCipher;
let seq = 0;

interface Account {
  id: string;
  email: string;
  seed: Buffer;
  recoveryCodes: string[];
  code: () => string;
}

type Res = Awaited<ReturnType<typeof svc.http.inject>>;
const json = (r: { payload: string }): Record<string, unknown> => JSON.parse(r.payload) as Record<string, unknown>;
const problemOf = (r: { statusCode: number; payload: string }) => ({ status: r.statusCode, type: String(json(r).type ?? '').replace(/^.*\//, '') });

function cookieValue(r: { headers: Record<string, unknown> }, name: string): string | undefined {
  const raw = r.headers['set-cookie'];
  const list = Array.isArray(raw) ? raw.map(String) : raw === undefined ? [] : [String(raw)];
  for (const whole of list) {
    for (const one of whole.split(/,(?=\s*__Secure-)/)) {
      const t = one.trim();
      if (t.startsWith(`${name}=`)) return t.slice(name.length + 1).split(';')[0];
    }
  }
  return undefined;
}

function sidOf(accessToken: string): string {
  const part = accessToken.split('.')[1];
  if (!part) throw new Error('액세스 토큰 꼴이 아니다');
  const payload = JSON.parse(Buffer.from(part, 'base64url').toString('utf8')) as { sid?: unknown };
  if (typeof payload.sid !== 'string') throw new Error('sid가 없다');
  return payload.sid;
}

async function makeAccount(label: string, role: 'partner_admin' | 'operator' = 'partner_admin'): Promise<Account> {
  const id = randomUUID();
  const email = `${label}-${++seq}@stella.example`;
  store.create({ id, role, email, status: 'ACTIVE', promoterId: role === 'partner_admin' ? PROMOTER : null, displayName: label, now: clock.now() });
  await svc.app.get(SetAdminPassword).run({ accountId: id, password: PW, partner: { names: [], numbers: [] } });
  const { otpauthUri } = await svc.app.get(BeginTotpEnrollment).run({ accountId: id, now: clock.now() });
  const secret = new URL(otpauthUri).searchParams.get('secret');
  if (!secret) throw new Error('otpauth 주소에 secret이 없다');
  const seed = base32Decode(secret);
  const confirmed = await svc.app.get(ConfirmTotpEnrollment).run({ accountId: id, code: totpAt(seed, Math.floor(clock.now() / 30_000)) });
  return {
    id,
    email,
    seed,
    recoveryCodes: confirmed.recoveryCodes,
    code: () => {
      clock.advance(30_000);
      return totpAt(seed, Math.floor(clock.now() / 30_000));
    },
  };
}

interface Attempt {
  first: Res;
  second: Res;
  sid: string;
  token: string;
}

async function tryLogin(a: Account, deviceId: string, ip: string, ua: string, code: string): Promise<Attempt> {
  const first = await svc.http.inject({
    method: 'POST',
    url: '/v1/partner/auth/sessions',
    headers: { 'x-forwarded-for': ip, 'user-agent': ua },
    payload: { email: a.email, password: PW, deviceId },
  });
  const step = json(first).loginStep;
  const second = await svc.http.inject({
    method: 'POST',
    url: '/v1/partner/auth/sessions',
    headers: { 'x-forwarded-for': ip, 'user-agent': ua },
    payload: { loginStep: String(step ?? ''), code },
  });
  const token = cookieValue(second, AT) ?? '';
  return { first, second, sid: token ? sidOf(token) : '', token };
}

async function login(a: Account, deviceId: string, ip: string, ua: string): Promise<Attempt> {
  const out = await tryLogin(a, deviceId, ip, ua, a.code());
  expect(out.first.statusCode, out.first.payload).toBe(200);
  expect([200, 204], out.second.payload).toContain(out.second.statusCode);
  expect(out.sid).not.toBe('');
  return out;
}

const headers = (a: Account, sid: string, extra: Record<string, string> = {}) => ({ 'x-user-id': a.id, 'x-session-id': sid, 'x-user-aud': 'partner', ...extra });
const get = (a: Account, sid: string, url: string, extra: Record<string, string> = {}) => svc.http.inject({ method: 'GET', url, headers: headers(a, sid, extra) });
const post = (a: Account, sid: string, url: string, payload?: object, extra: Record<string, string> = {}) =>
  svc.http.inject({ method: 'POST', url, headers: headers(a, sid, extra), ...(payload ? { payload } : {}) });
const del = (a: Account, sid: string, url: string, extra: Record<string, string> = {}) => svc.http.inject({ method: 'DELETE', url, headers: headers(a, sid, extra) });

async function reauth(a: Account, sid: string, act: 'ACCOUNT_SECURITY' | 'PAYOUT_ACCOUNT', opts: { withPasskey?: boolean; authn?: SoftAuthenticator } = {}): Promise<string> {
  const first = await post(a, sid, '/v1/partner/auth/reauthentications', { act, password: PW, code: a.code(), ...(opts.withPasskey ? { withPasskey: true } : {}) });
  expect(first.statusCode, first.payload).toBe(200);
  const b = json(first);
  if (b.next === 'DONE') return String(b.reauthToken);
  expect(b.next).toBe('PASSKEY');
  if (!opts.authn) throw new Error('패스키 인증기가 필요하다');
  const second = await post(a, sid, '/v1/partner/auth/reauthentications', { reauthStep: String(b.reauthStep), credential: opts.authn.assert(b.publicKey as Parameters<SoftAuthenticator['assert']>[0]) });
  expect(second.statusCode, second.payload).toBe(200);
  expect(json(second).factors).toContain('passkey');
  return String(json(second).reauthToken);
}

const beginTotp = (a: Account, sid: string, token: string) => post(a, sid, '/v1/partner/auth/totp-enrollments', undefined, { 'x-reauth-token': token });
const confirmTotp = (a: Account, sid: string, code: string) => post(a, sid, '/v1/partner/auth/totp-confirmations', { code });
const recreateCodes = (a: Account, sid: string, token: string) => post(a, sid, '/v1/partner/auth/recovery-codes', undefined, { 'x-reauth-token': token });
const settings = (a: Account, sid: string) => get(a, sid, '/v1/partner/auth/security-settings');
const listSessions = (a: Account, sid: string) => get(a, sid, '/v1/partner/auth/sessions');
const endSession = (a: Account, sid: string, target: string, token: string) => del(a, sid, `/v1/partner/auth/sessions/${target}`, { 'x-reauth-token': token });

const rowOf = (id: string): Record<string, unknown> => store.rowForTest(id) as unknown as Record<string, unknown>;
const liveCount = (id: string): number => store.sessions(id).filter((s) => s.terminatedAt === null).length;

/** 2단계 실패 수·잠금을 시험 사이에 되돌린다. 옛 복구 코드 10개를 차례로 넣을 때 5번 보호 잠금에 닿지 않게 하려는 시험 장치다 */
function resetSecondFactor(id: string): void {
  const r = store.rowForTest(id);
  if (!r) throw new Error('계정 행이 없다');
  r.secondFactorFailures = 0;
  r.lockKind = 'NONE';
  r.lockedUntil = null;
  r.failedAttempts = 0;
}

/** 메모리 저장소의 한 메서드를 시험 동안만 바꾼다(장애 주입). 되돌리는 함수를 준다 */
function patchStore(name: string, fn: (...args: unknown[]) => unknown): () => void {
  const o = store as unknown as Record<string, unknown>;
  const old = o[name];
  o[name] = fn;
  return () => {
    o[name] = old;
  };
}

beforeAll(async () => {
  const fan = await fanKey();
  const admin = await fanKey();
  const keys = await TokenKeyRing.fromEnv({
    PEAKET_ENV: 'ci',
    PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk),
    PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-f0713-pk' }),
  });
  totpCipher = new LocalTotpSeedCipher(Buffer.alloc(32, 6));
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
        totpCipher,
        signer: new JoseAdminTokenSigner(keys, ISSUER),
        reauthVerifier: new JoseAdminReauthVerifier(keys, ISSUER, clock),
      },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    adminAuthz: { getAdminAuthz: async (q) => (guard ? guard.getAdminAuthz(q) : { valid: false, role: '' }) },
  });
  store = svc.app.get<MemoryAdminAccountStore>(ADMIN_LOGIN_STORE);
  guard = new GetAdminAuthz(store, store, clock);
});

afterAll(async () => {
  await svc?.close();
});

describe('F-07-13 파트너 내 계정 보안', () => {
  test('I-T53 ③ [ASVS v5.0.0-6.3.3] 인증 앱 다시 등록은 ACCOUNT_SECURITY 재인증과 같은 세션을 요구하고 새 시드는 확인 전까지 기존 인증 앱을 바꾸지 않는다', async () => {
    const a = await makeAccount('totp-start');
    const s = await login(a, 'dev-start', '203.0.113.10', UA.chromeWindows);
    const before = await store.getTotp(a.id);
    expect(before?.seedEnc).not.toBeNull();

    expect(problemOf(await post(a, s.sid, '/v1/partner/auth/totp-enrollments'))).toEqual({ status: 403, type: 'reauth-required' });
    const payout = await reauth(a, s.sid, 'PAYOUT_ACCOUNT');
    expect(problemOf(await beginTotp(a, s.sid, payout))).toEqual({ status: 403, type: 'reauth-required' });

    const token = await reauth(a, s.sid, 'ACCOUNT_SECURITY');
    const r = await beginTotp(a, s.sid, token);
    expect(r.statusCode, r.payload).toBe(201);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Object.keys(json(r)).sort()).toEqual(['otpauthUri']);
    expect(r.payload).not.toContain('totpSeedEnc');
    expect(r.payload).not.toContain('pairRef');
    expect(r.payload).not.toContain('203.0.113.10');
    const uri = new URL(String(json(r).otpauthUri));
    expect(uri.protocol).toBe('otpauth:');
    const secret = uri.searchParams.get('secret');
    expect(secret).toBeTruthy();
    expect(base32Decode(secret!)).toHaveLength(20);
    expect(secret).not.toBe(base32Encode(a.seed));

    const after = await store.getTotp(a.id);
    expect(after?.seedEnc?.equals(before!.seedEnc!)).toBe(true);
    expect(after?.pendingEnc).not.toBeNull();
    const row = store.rowForTest(a.id) as unknown as Record<string, unknown>;
    expect(row['totpPendingSessionId']).toBe(s.sid);
    expect(row['totpPendingFailures']).toBe(0);

    // 확인 전에는 옛 인증 앱 코드가 그대로 로그인 2단계에 쓰인다
    const again = await login(a, 'dev-start-2', '203.0.113.11', UA.chromeWindows);
    expect(again.sid).not.toBe('');
  });

  test('I-T53 ③ [ASVS v5.0.0-6.3.3] 인증 앱 확인 코드는 5번까지 422 reauth-code-invalid(남은 수)이고 6번째 410 totp-enrollment-invalid이며 다시 시작하면 앞선 대기 시드를 덮어쓰고 실패 수를 0으로 되돌린다', async () => {
    const a = await makeAccount('totp-fail');
    const s1 = await login(a, 'dev-fail-1', '203.0.113.20', UA.chromeWindows);
    const s2 = await login(a, 'dev-fail-2', '203.0.113.21', UA.safariIpad);
    const token = await reauth(a, s1.sid, 'ACCOUNT_SECURITY');
    const firstBegin = await beginTotp(a, s1.sid, token);
    expect(firstBegin.statusCode).toBe(201);
    const oldSecret = new URL(String(json(firstBegin).otpauthUri)).searchParams.get('secret');
    if (!oldSecret) throw new Error('첫 대기 시드가 없다');
    const oldSeed = base32Decode(oldSecret);
    const oldPending = (await store.getTotp(a.id))?.pendingEnc;

    const valid = totpAt(a.seed, Math.floor(clock.now() / 30_000));
    const wrong = valid === '000001' ? '000002' : '000001';

    // 다른 세션은 대기 시드를 확인하지 못하고, 이 실패는 세지 않는다
    expect(problemOf(await confirmTotp(a, s2.sid, wrong))).toEqual({ status: 410, type: 'totp-enrollment-invalid' });

    // 2번 실패한 뒤 다시 시작하면 앞선 대기 시드를 덮어쓰고 실패 수를 0으로 되돌린다
    expect(json(await confirmTotp(a, s1.sid, wrong)).remainingAttempts).toBe(4);
    expect(json(await confirmTotp(a, s1.sid, wrong)).remainingAttempts).toBe(3);
    const secondBegin = await beginTotp(a, s1.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY'));
    expect(secondBegin.statusCode).toBe(201);
    expect(rowOf(a.id)['totpPendingFailures']).toBe(0);
    const newSecret = new URL(String(json(secondBegin).otpauthUri)).searchParams.get('secret');
    if (!newSecret) throw new Error('새 대기 시드가 없다');
    const newSeed = base32Decode(newSecret);
    expect((await store.getTotp(a.id))?.pendingEnc?.equals(oldPending!)).toBe(false);
    // 앞선 대기 시드의 코드는 새 대기 시드에 쓰이지 못한다(옛 코드는 틀린 코드다)
    const newValid = totpAt(newSeed, Math.floor(clock.now() / 30_000));
    const oldCodeRaw = totpAt(oldSeed, Math.floor(clock.now() / 30_000));
    const oldCode = oldCodeRaw === newValid ? (newValid === '000001' ? '000002' : '000001') : oldCodeRaw;
    const oldAttempt = await confirmTotp(a, s1.sid, oldCode);
    expect(problemOf(oldAttempt)).toEqual({ status: 422, type: 'reauth-code-invalid' });
    expect(json(oldAttempt).remainingAttempts).toBe(4);

    // 새 대기 시드에서 5번 실패하면 6번째에 대기 시드를 버린다
    const newWrong = newValid === '000001' ? '000002' : '000001';
    // 옛 대기 코드도 틀린 코드라 실패 수가 이미 1이다: 남은 4에서 시작해 4번 더 틀리면 0, 그다음은 410
    expect(json(await confirmTotp(a, s1.sid, newWrong)).remainingAttempts).toBe(3);
    for (const remaining of [2, 1, 0]) {
      const r = await confirmTotp(a, s1.sid, newWrong);
      expect(problemOf(r)).toEqual({ status: 422, type: 'reauth-code-invalid' });
      expect(json(r).remainingAttempts).toBe(remaining);
    }
    expect(problemOf(await confirmTotp(a, s1.sid, newWrong))).toEqual({ status: 410, type: 'totp-enrollment-invalid' });

    const row = store.rowForTest(a.id)!;
    expect(row.secondFactorFailures).toBe(0);
    expect(row.lockKind).toBe('NONE');
    expect(row.failedAttempts).toBe(0);
    expect(rowOf(a.id)['totpPendingSessionId']).toBeNull();
    expect(rowOf(a.id)['totpPendingFailures']).toBe(0);
    expect((await store.getTotp(a.id))?.pendingEnc).toBeNull();

    // 다시 시작하면 실패 수는 0에서 다시 센다
    expect((await beginTotp(a, s1.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY'))).statusCode).toBe(201);
    expect(rowOf(a.id)['totpPendingFailures']).toBe(0);

    // 5번 실패 뒤에도 옛 인증 앱은 살아 있다
    const again = await login(a, 'dev-fail-3', '203.0.113.22', UA.chromeWindows);
    expect(again.sid).not.toBe('');
  });

  test('I-T53 ③ [ASVS v5.0.0-6.4.4] 인증 앱 다시 등록을 마치면 새 시드·복구 코드 10개로 바뀌고 같은 칸 재사용·옛 TOTP·옛 복구 코드 10개가 모두 로그인에 쓰이지 못한다', async () => {
    const a = await makeAccount('totp-ok');
    const s = await login(a, 'dev-ok', '203.0.113.30', UA.chromeWindows);
    const sessionsBefore = liveCount(a.id);
    const token = await reauth(a, s.sid, 'ACCOUNT_SECURITY');
    const begin = await beginTotp(a, s.sid, token);
    expect(begin.statusCode).toBe(201);
    const secret = new URL(String(json(begin).otpauthUri)).searchParams.get('secret');
    if (!secret) throw new Error('새 시드가 없다');
    const newSeed = base32Decode(secret);
    const step = Math.floor(clock.now() / 30_000);
    const newCode = totpAt(newSeed, step);

    const confirmed = await confirmTotp(a, s.sid, newCode);
    expect(confirmed.statusCode, confirmed.payload).toBe(200);
    expect(confirmed.headers['cache-control']).toBe('no-store');
    expect(Object.keys(json(confirmed))).toEqual(['recoveryCodes']);
    const codes = json(confirmed).recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);
    expect((await store.getTotp(a.id))?.pendingEnc).toBeNull();
    expect((await store.getTotp(a.id))?.seedEnc?.equals(a.seed)).toBe(false);
    expect(rowOf(a.id)['totpPendingSessionId']).toBeNull();
    // 확인한 시간 칸을 적고, 세션은 만들거나 끝내지 않는다
    expect(rowOf(a.id)['totpLastStep']).toBe(step);
    expect(liveCount(a.id)).toBe(sessionsBefore);
    expect(json(confirmed)).not.toHaveProperty('totpSeedEnc');
    expect(confirmed.payload).not.toContain('pairRef');

    // 확인에 쓴 코드를 같은 30초 칸에서 로그인 2단계에 다시 쓰지 못한다
    resetSecondFactor(a.id);
    const sameStep = await tryLogin(a, 'dev-same-step', '203.0.113.35', UA.chromeWindows, newCode);
    expect(problemOf(sameStep.second)).toEqual({ status: 401, type: 'admin-login-code-invalid' });
    resetSecondFactor(a.id);

    // 새 복구 코드는 10개이고, 옛 복구 코드 10개는 모두 틀리다
    const ok = await settings(a, s.sid);
    expect(json(ok)).toMatchObject({ totpRegistered: true, recoveryCodesRemaining: 10 });
    expect(store.recoveryCodes(a.id)).toHaveLength(10);
    for (const [i, oldCode] of a.recoveryCodes.entries()) {
      resetSecondFactor(a.id);
      // 같은 IP라도 기기 ID가 다르면 출발지 묶음이 달라 5번째에 423이 되지 않는다.
      // IP를 여러 개 쓰면 계정 경보(여러 출발지)가 켜져 사람 확인 428이 되므로 IP는 하나로 둔다
      const oldRecovery = await tryLogin(a, `dev-old-rc-${i}`, '203.0.113.33', UA.chromeWindows, oldCode);
      expect(problemOf(oldRecovery.second)).toEqual({ status: 401, type: 'admin-login-code-invalid' });
    }
    resetSecondFactor(a.id);

    // 옛 인증 앱 코드는 이제 틀리다
    const oldTotp = await tryLogin(a, 'dev-old-totp', '203.0.113.32', UA.chromeWindows, a.code());
    expect(problemOf(oldTotp.second)).toEqual({ status: 401, type: 'admin-login-code-invalid' });
    resetSecondFactor(a.id);

    // 새 인증 앱 코드로 로그인한다
    clock.advance(30_000);
    const newTotp = totpAt(newSeed, Math.floor(clock.now() / 30_000));
    const newTotpLogin = await tryLogin(a, 'dev-new', '203.0.113.31', UA.chromeWindows, newTotp);
    expect(newTotpLogin.second.statusCode).toBe(200);

    // 새 복구 코드는 한 번 쓸 수 있고, 쓰면 남은 수가 9가 된다
    expect((await tryLogin(a, 'dev-new-rc', '203.0.113.34', UA.chromeWindows, codes[0]!)).second.statusCode).toBe(200);
    expect(json(await settings(a, newTotpLogin.sid)).recoveryCodesRemaining).toBe(9);
  });

  test('I-T53 ③ [ASVS v5.0.0-6.4.4] 복구 코드 다시 만들기는 재인증 뒤 새 10개를 한 번만 주고 옛 코드를 모두 무효로 하며 남은 수를 준다', async () => {
    const a = await makeAccount('rc-recreate');
    const s = await login(a, 'dev-rc', '203.0.113.40', UA.chromeWindows);
    const before = await settings(a, s.sid);
    expect(before.statusCode, before.payload).toBe(200);
    expect(before.headers['cache-control']).toBe('no-store');
    expect(Object.keys(json(before)).sort()).toEqual(['passkeyCount', 'recoveryCodesRemaining', 'sessionLimit', 'totpRegistered']);
    expect(json(before)).toMatchObject({ totpRegistered: true, recoveryCodesRemaining: 10, passkeyCount: 0, sessionLimit: 2 });
    expect(before.payload).not.toContain('totpSeedEnc');
    expect(before.payload).not.toContain('pairRef');

    const liveBefore = store.sessions(a.id).filter((x) => x.terminatedAt === null).length;
    const token = await reauth(a, s.sid, 'ACCOUNT_SECURITY');
    const r = await recreateCodes(a, s.sid, token);
    expect(r.statusCode, r.payload).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(Object.keys(json(r))).toEqual(['recoveryCodes']);
    expect(r.payload).not.toContain('totpSeedEnc');
    expect(r.payload).not.toContain('pairRef');
    const codes = json(r).recoveryCodes as string[];
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    for (const code of codes) expect(code).toMatch(/^[0-9A-Z]{4}(-[0-9A-Z]{4}){3}$/);

    const after = await settings(a, s.sid);
    expect(json(after).recoveryCodesRemaining).toBe(10);
    expect(store.sessions(a.id).filter((x) => x.terminatedAt === null).length).toBe(liveBefore);

    expect(problemOf((await tryLogin(a, 'dev-rc-old', '203.0.113.41', UA.chromeWindows, a.recoveryCodes[0]!)).second)).toEqual({ status: 401, type: 'admin-login-code-invalid' });
    expect((await tryLogin(a, 'dev-rc-new', '203.0.113.42', UA.chromeWindows, codes[0]!)).second.statusCode).toBe(200);
  });

  test('I-T53 ③ [ASVS v5.0.0-7.5.2] 로그인 기기 목록은 살아 있는 세션을 기기마다 한 줄로 주고 지금 기기가 맨 앞이며 원문 User-Agent·출처 묶음·토큰을 싣지 않는다', async () => {
    const a = await makeAccount('devices');
    const s1 = await login(a, 'dev-a', '203.0.113.50', UA.chromeWindows);
    const s1At = clock.now();
    const s2 = await login(a, 'dev-b', '203.0.113.51', UA.safariIpad);

    const r = await listSessions(a, s1.sid);
    expect(r.statusCode, r.payload).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    const items = json(r).items as { sessionId: string; deviceName: string | null; lastActiveAt: string; current: boolean; otherSessions: number }[];
    expect(items).toHaveLength(2);
    expect(items[0]).toMatchObject({ sessionId: s1.sid, current: true, otherSessions: 0, deviceName: 'Chrome · Windows' });
    expect(Date.parse(items[0]!.lastActiveAt)).toBe(s1At);
    expect(items[1]).toMatchObject({ current: false, otherSessions: 0, deviceName: 'Safari · iPad' });
    for (const item of items) expect(Object.keys(item).sort()).toEqual(['current', 'deviceName', 'lastActiveAt', 'otherSessions', 'sessionId']);

    const text = r.payload;
    expect(text).not.toContain('pairRef');
    expect(text).not.toContain('deviceRef');
    expect(text).not.toContain('203.0.113.50');
    expect(text).not.toContain('Mozilla/');
    expect(text).not.toContain(s1.token);
    expect(text).not.toContain(s2.token);
    expect(text).not.toContain(a.seed.toString('base64url'));

    // 저장소에도 원문 User-Agent가 아니라 화면용 이름만 둔다(40자 이하)
    const stored = store.sessions(a.id).find((x) => x.id === s1.sid) as unknown as Record<string, unknown>;
    expect(stored['deviceLabel']).toBe('Chrome · Windows');
    expect(String(stored['deviceLabel'])).not.toContain('Mozilla/');
    expect(String(stored['deviceLabel']).length).toBeLessThanOrEqual(40);
  });

  test('I-T53 ③ [ASVS v5.0.0-7.4.3] [ASVS v5.0.0-7.5.2] 다른 기기 로그아웃은 재인증 토큰으로 그 기기 세션을 모두 끝내고 다른 로그인이 없는 지금 세션은 404로 남긴다', async () => {
    const a = await makeAccount('revoke');
    const s1 = await login(a, 'dev-r1', '203.0.113.60', UA.chromeWindows);
    const s2 = await login(a, 'dev-r2', '203.0.113.61', UA.safariIpad);

    const token = await reauth(a, s1.sid, 'ACCOUNT_SECURITY');
    const r = await endSession(a, s1.sid, s2.sid, token);
    expect(r.statusCode).toBe(204);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(await guard.getAdminAuthz({ adminAccountId: a.id, sessionId: s2.sid })).toMatchObject({ valid: false });
    expect(store.terminatedEvents().filter((e) => e.accountId === a.id)).toEqual([{ accountId: a.id, sessionId: s2.sid, reason: 'LOGOUT' }]);
    expect((store.sessions(a.id).find((x) => x.id === s2.sid) as unknown as Record<string, unknown>)['deviceLabel']).toBeNull();

    const list = await listSessions(a, s1.sid);
    expect((json(list).items as unknown[]).length).toBe(1);
    expect((json(list).items as { current: boolean; sessionId: string }[])[0]).toMatchObject({ current: true, sessionId: s1.sid });

    // 다른 로그인이 없는 지금 세션은 404이고 그대로 살아 있다
    const current = await endSession(a, s1.sid, s1.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY'));
    expect(problemOf(current)).toEqual({ status: 404, type: 'session-not-found' });
    expect(await guard.getAdminAuthz({ adminAccountId: a.id, sessionId: s1.sid })).toMatchObject({ valid: true });

    expect(problemOf(await endSession(a, s1.sid, s2.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY')))).toEqual({ status: 404, type: 'session-not-found' });

    const other = await makeAccount('revoke-other');
    const so = await login(other, 'dev-o', '203.0.113.62', UA.chromeWindows);
    expect(problemOf(await endSession(a, s1.sid, so.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY')))).toEqual({ status: 404, type: 'session-not-found' });
    expect(await guard.getAdminAuthz({ adminAccountId: other.id, sessionId: so.sid })).toMatchObject({ valid: true });
  });

  test('I-T53 ③ [ASVS v5.0.0-7.5.2] 404 session-not-found는 없는 ID·다른 계정·모양 틀린 ID·끝난 세션 모두에서 재인증 토큰을 쓰지 않는다', async () => {
    const pair = async (label: string, ip: string) => {
      const a = await makeAccount(label);
      const s1 = await login(a, `${label}-1`, `${ip}.1`, UA.chromeWindows);
      const s2 = await login(a, `${label}-2`, `${ip}.2`, UA.safariIpad);
      return { a, s1, s2 };
    };

    // 없는 ID
    const c1 = await pair('404-unknown', '203.0.113.70');
    const t1 = await reauth(c1.a, c1.s1.sid, 'ACCOUNT_SECURITY');
    const r1 = await endSession(c1.a, c1.s1.sid, randomUUID(), t1);
    expect(problemOf(r1)).toEqual({ status: 404, type: 'session-not-found' });
    expect(r1.headers['cache-control']).toBe('no-store');
    expect(store.terminatedEvents().filter((e) => e.accountId === c1.a.id)).toEqual([]);
    expect((await endSession(c1.a, c1.s1.sid, c1.s2.sid, t1)).statusCode).toBe(204);

    // 다른 계정의 세션
    const c2 = await pair('404-other', '203.0.113.72');
    const other = await makeAccount('404-other-target');
    const so = await login(other, '404-other-dev', '203.0.113.74', UA.chromeWindows);
    const t2 = await reauth(c2.a, c2.s1.sid, 'ACCOUNT_SECURITY');
    expect(problemOf(await endSession(c2.a, c2.s1.sid, so.sid, t2))).toEqual({ status: 404, type: 'session-not-found' });
    expect(await guard.getAdminAuthz({ adminAccountId: other.id, sessionId: so.sid })).toMatchObject({ valid: true });
    expect((await endSession(c2.a, c2.s1.sid, c2.s2.sid, t2)).statusCode).toBe(204);

    // 모양이 틀린 ID
    const c3 = await pair('404-shape', '203.0.113.75');
    const t3 = await reauth(c3.a, c3.s1.sid, 'ACCOUNT_SECURITY');
    expect(problemOf(await endSession(c3.a, c3.s1.sid, 'not-a-uuid', t3))).toEqual({ status: 404, type: 'session-not-found' });
    expect((await endSession(c3.a, c3.s1.sid, c3.s2.sid, t3)).statusCode).toBe(204);

    // 끝난 세션
    const c4 = await pair('404-ended', '203.0.113.76');
    expect((await del(c4.a, c4.s2.sid, '/v1/partner/auth/sessions/me')).statusCode).toBe(204);
    const s3 = await login(c4.a, '404-ended-3', '203.0.113.78', UA.chromeWindows);
    const t4 = await reauth(c4.a, c4.s1.sid, 'ACCOUNT_SECURITY');
    expect(problemOf(await endSession(c4.a, c4.s1.sid, c4.s2.sid, t4))).toEqual({ status: 404, type: 'session-not-found' });
    expect((await endSession(c4.a, c4.s1.sid, s3.sid, t4)).statusCode).toBe(204);

    // 사전 확인 뒤 대상이 사라진 경쟁(IR13-03): 저장소가 NOT_FOUND를 돌려도 재인증 토큰을 쓰지 않는다
    const c5 = await pair('404-race', '203.0.113.79');
    const t5 = await reauth(c5.a, c5.s1.sid, 'ACCOUNT_SECURITY');
    const restore = patchStore('endDeviceSessions', async () => ({ kind: 'NOT_FOUND' }));
    try {
      const raced = await endSession(c5.a, c5.s1.sid, c5.s2.sid, t5);
      expect(problemOf(raced)).toEqual({ status: 404, type: 'session-not-found' });
    } finally {
      restore();
    }
    expect((await endSession(c5.a, c5.s1.sid, c5.s2.sid, t5)).statusCode).toBe(204);
  });

  test('I-T53 ②③ [ASVS v5.0.0-7.5.1] 재인증 토큰이 없거나 다른 작업 묶음·다른 세션·이미 쓴 것이면 세 경로 모두 403 reauth-required이고 상태를 바꾸지 않는다', async () => {
    const a = await makeAccount('reauth-gate');
    const s1 = await login(a, 'dev-g1', '203.0.113.80', UA.chromeWindows);
    const s2 = await login(a, 'dev-g2', '203.0.113.81', UA.safariIpad);
    const codesBefore = store.recoveryCodes(a.id).length;

    expect(problemOf(await post(a, s1.sid, '/v1/partner/auth/totp-enrollments'))).toEqual({ status: 403, type: 'reauth-required' });
    expect(problemOf(await post(a, s1.sid, '/v1/partner/auth/recovery-codes'))).toEqual({ status: 403, type: 'reauth-required' });
    expect(problemOf(await endSession(a, s1.sid, s2.sid, ''))).toEqual({ status: 403, type: 'reauth-required' });

    const payout = await reauth(a, s1.sid, 'PAYOUT_ACCOUNT');
    expect(problemOf(await beginTotp(a, s1.sid, payout))).toEqual({ status: 403, type: 'reauth-required' });
    expect(problemOf(await recreateCodes(a, s1.sid, payout))).toEqual({ status: 403, type: 'reauth-required' });
    expect(problemOf(await endSession(a, s1.sid, s2.sid, payout))).toEqual({ status: 403, type: 'reauth-required' });

    const otherSession = await reauth(a, s2.sid, 'ACCOUNT_SECURITY');
    expect(problemOf(await beginTotp(a, s1.sid, otherSession))).toEqual({ status: 403, type: 'reauth-required' });
    expect(problemOf(await recreateCodes(a, s1.sid, otherSession))).toEqual({ status: 403, type: 'reauth-required' });
    expect(problemOf(await endSession(a, s1.sid, s2.sid, otherSession))).toEqual({ status: 403, type: 'reauth-required' });

    // 거절된 시작들은 대기 칸을 만들지 않는다
    expect((await store.getTotp(a.id))?.pendingEnc).toBeNull();
    const once = await reauth(a, s1.sid, 'ACCOUNT_SECURITY');
    expect((await beginTotp(a, s1.sid, once)).statusCode).toBe(201);
    expect(problemOf(await recreateCodes(a, s1.sid, once))).toEqual({ status: 403, type: 'reauth-required' });

    expect(store.recoveryCodes(a.id).length).toBe(codesBefore);
    expect(await guard.getAdminAuthz({ adminAccountId: a.id, sessionId: s2.sid })).toMatchObject({ valid: true });
  });

  test('I-T53 ③ [ASVS v5.0.0-6.3.3] 패스키가 있는 계정은 패스키 요소 없는 재인증 토큰으로 인증 앱·복구 코드·기기 끊기를 하지 못한다', async () => {
    const a = await makeAccount('passkey-factor');
    const s1 = await login(a, 'dev-p1', '203.0.113.90', UA.chromeWindows);
    const s2 = await login(a, 'dev-p2', '203.0.113.91', UA.safariIpad);

    const firstToken = await reauth(a, s1.sid, 'ACCOUNT_SECURITY');
    const begin = await post(a, s1.sid, '/v1/partner/auth/passkey-registrations', undefined, { 'x-reauth-token': firstToken });
    expect(begin.statusCode, begin.payload).toBe(201);
    const authn = new SoftAuthenticator();
    const b = json(begin);
    const created = await post(a, s1.sid, '/v1/partner/auth/passkeys', { registrationId: String(b.registrationId), credential: authn.register(b.publicKey as Parameters<SoftAuthenticator['register']>[0]), name: '보조 기기' });
    expect(created.statusCode, created.payload).toBe(201);
    expect(json(await settings(a, s1.sid)).passkeyCount).toBe(1);

    // 패스키가 생긴 뒤 비밀번호·TOTP만 거친 토큰은 세 경로 모두 403
    const plain = await reauth(a, s1.sid, 'ACCOUNT_SECURITY');
    expect(problemOf(await beginTotp(a, s1.sid, plain))).toEqual({ status: 403, type: 'reauth-required' });
    expect(problemOf(await recreateCodes(a, s1.sid, plain))).toEqual({ status: 403, type: 'reauth-required' });
    expect(problemOf(await endSession(a, s1.sid, s2.sid, plain))).toEqual({ status: 403, type: 'reauth-required' });
    expect(await guard.getAdminAuthz({ adminAccountId: a.id, sessionId: s2.sid })).toMatchObject({ valid: true });

    // 패스키까지 거친 토큰은 통과한다
    expect((await beginTotp(a, s1.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY', { withPasskey: true, authn }))).statusCode).toBe(201);
    expect((await recreateCodes(a, s1.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY', { withPasskey: true, authn }))).statusCode).toBe(200);
    expect((await endSession(a, s1.sid, s2.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY', { withPasskey: true, authn }))).statusCode).toBe(204);
  });

  test('I-T53 ③ [ASVS v5.0.0-6.3.3] 파트너 경로는 다른 콘솔 세션을 401로, 비밀번호 바꾸기 필요 파트너 세션을 403으로 거절하고 처리 층 오류는 no-store다', async () => {
    const a = await makeAccount('boundary');
    const s = await login(a, 'dev-bound', '203.0.113.100', UA.chromeWindows);

    // 실제 관제 세션으로는 파트너 경로를 부르지 못한다
    const ops = await makeAccount('boundary-ops', 'operator');
    const first = await svc.app.get(LoginPasswordStep).run({ aud: 'ops', email: ops.email, password: PW, ip: '203.0.113.101', deviceId: 'dev-ops', humanCheckToken: 'ok' });
    if (first.kind !== 'PASSED') throw new Error(first.kind);
    const done = await svc.app.get(LoginSecondStep).run({ aud: 'ops', loginStep: first.loginStep, code: ops.code(), ip: '203.0.113.101', deviceId: 'dev-ops' });
    if (done.kind !== 'DONE') throw new Error(done.kind);
    const opsHeaders = { 'x-user-id': ops.id, 'x-session-id': done.sessionId, 'x-user-aud': 'ops' };
    // 다른 콘솔의 세션은 역할을 보기 전에 401이다(플랫폼 가드의 AUDIENCE_OF)
    expect((await svc.http.inject({ method: 'GET', url: '/v1/partner/auth/security-settings', headers: opsHeaders })).statusCode).toBe(401);
    expect((await svc.http.inject({ method: 'GET', url: '/v1/partner/auth/sessions', headers: opsHeaders })).statusCode).toBe(401);

    const limited = { 'x-user-scope': 'password:change' };
    expect(problemOf(await get(a, s.sid, '/v1/partner/auth/security-settings', limited))).toEqual({ status: 403, type: 'password-change-required' });
    expect(problemOf(await get(a, s.sid, '/v1/partner/auth/sessions', limited))).toEqual({ status: 403, type: 'password-change-required' });
    expect(problemOf(await post(a, s.sid, '/v1/partner/auth/totp-enrollments', undefined, { ...limited, 'x-reauth-token': await reauth(a, s.sid, 'ACCOUNT_SECURITY') }))).toEqual({ status: 403, type: 'password-change-required' });
    expect(problemOf(await post(a, s.sid, '/v1/partner/auth/recovery-codes', undefined, { ...limited, 'x-reauth-token': await reauth(a, s.sid, 'ACCOUNT_SECURITY') }))).toEqual({ status: 403, type: 'password-change-required' });

    // 처리 층이 내는 오류는 캐시하지 않는다
    const noToken = await post(a, s.sid, '/v1/partner/auth/totp-enrollments');
    expect(problemOf(noToken)).toEqual({ status: 403, type: 'reauth-required' });
    expect(noToken.headers['cache-control']).toBe('no-store');
    const invalidBody = await post(a, s.sid, '/v1/partner/auth/totp-enrollments', { unexpected: 1 }, { 'x-reauth-token': await reauth(a, s.sid, 'ACCOUNT_SECURITY') });
    expect(problemOf(invalidBody)).toEqual({ status: 400, type: 'invalid-body' });
    expect(invalidBody.headers['cache-control']).toBe('no-store');
    const bad = await confirmTotp(a, s.sid, '000000');
    expect(problemOf(bad)).toEqual({ status: 410, type: 'totp-enrollment-invalid' });
    expect(bad.headers['cache-control']).toBe('no-store');
  });

  test('I-T53 ③ [ASVS v5.0.0-8.2.2] 다른 계정의 세션 ID·없는 ID·끝난 세션은 모두 404이고 그 세션은 살아 있다', async () => {
    const a = await makeAccount('idor-a');
    const s1 = await login(a, 'dev-i1', '203.0.113.110', UA.chromeWindows);
    const s2 = await login(a, 'dev-i2', '203.0.113.111', UA.safariIpad);
    const b = await makeAccount('idor-b');
    const sb = await login(b, 'dev-ib', '203.0.113.112', UA.chromeWindows);

    const token = await reauth(a, s1.sid, 'ACCOUNT_SECURITY');
    expect(problemOf(await endSession(a, s1.sid, sb.sid, token))).toEqual({ status: 404, type: 'session-not-found' });
    expect(await guard.getAdminAuthz({ adminAccountId: b.id, sessionId: sb.sid })).toMatchObject({ valid: true });

    expect(problemOf(await endSession(a, s1.sid, randomUUID(), token))).toEqual({ status: 404, type: 'session-not-found' });
    expect(problemOf(await endSession(a, s1.sid, 'not-a-uuid', token))).toEqual({ status: 404, type: 'session-not-found' });

    // 스스로 로그아웃한 세션은 목록·끊기에서 404이고 기기 이름도 비운다
    expect((await del(a, s2.sid, '/v1/partner/auth/sessions/me')).statusCode).toBe(204);
    expect(await guard.getAdminAuthz({ adminAccountId: a.id, sessionId: s2.sid })).toMatchObject({ valid: false });
    expect((store.sessions(a.id).find((x) => x.id === s2.sid) as unknown as Record<string, unknown>)['deviceLabel']).toBeNull();
    expect(problemOf(await endSession(a, s1.sid, s2.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY')))).toEqual({ status: 404, type: 'session-not-found' });
  });

  test('I-T53 ③ [ASVS v5.0.0-6.3.3] [ASVS v5.0.0-7.4.3] 같은 기기에서 두 번 로그인하면 목록은 한 줄 otherSessions 1이고 그 줄을 끊으면 현재 세션만 남는다', async () => {
    const a = await makeAccount('same-device');
    const s1 = await login(a, 'same-dev', '203.0.113.120', UA.chromeWindows);
    const s2 = await login(a, 'same-dev', '203.0.113.120', UA.chromeWindows);

    const list = await listSessions(a, s2.sid);
    const items = json(list).items as { sessionId: string; current: boolean; otherSessions: number; deviceName: string | null }[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ current: true, otherSessions: 1, deviceName: 'Chrome · Windows' });
    expect(items[0]?.sessionId).toBe(s2.sid);

    const r = await endSession(a, s2.sid, String(items[0]?.sessionId), await reauth(a, s2.sid, 'ACCOUNT_SECURITY'));
    expect(r.statusCode).toBe(204);
    expect(await guard.getAdminAuthz({ adminAccountId: a.id, sessionId: s1.sid })).toMatchObject({ valid: false });
    expect(await guard.getAdminAuthz({ adminAccountId: a.id, sessionId: s2.sid })).toMatchObject({ valid: true });
    expect(store.terminatedEvents().filter((e) => e.accountId === a.id)).toEqual([{ accountId: a.id, sessionId: s1.sid, reason: 'LOGOUT' }]);
    expect((store.sessions(a.id).find((x) => x.id === s1.sid) as unknown as Record<string, unknown>)['deviceLabel']).toBeNull();

    const after = await listSessions(a, s2.sid);
    expect((json(after).items as { current: boolean; otherSessions: number }[])[0]).toMatchObject({ current: true, otherSessions: 0 });
    expect(problemOf(await endSession(a, s2.sid, s2.sid, await reauth(a, s2.sid, 'ACCOUNT_SECURITY')))).toEqual({ status: 404, type: 'session-not-found' });
  });

  test('I-T53 ③ [ASVS v5.0.0-6.4.4] 인증 앱이 등록되지 않은 계정의 복구 코드 다시 만들기는 409 totp-not-registered다', async () => {
    const a = await makeAccount('no-totp');
    const s = await login(a, 'dev-nt', '203.0.113.130', UA.chromeWindows);
    const token = await reauth(a, s.sid, 'ACCOUNT_SECURITY');
    const row = store.rowForTest(a.id)!;
    row.totpSeedEnc = null;
    row.totpLastStep = null;
    const codesBefore = store.recoveryCodes(a.id).length;
    const sessionsBefore = store.sessions(a.id).filter((x) => x.terminatedAt === null).length;
    // 계획 B1은 '남은 행 수'다. 시드는 지웠지만 makeAccount가 만든 복구 코드 행 10개는 그대로다
    expect(json(await settings(a, s.sid))).toMatchObject({ totpRegistered: false, recoveryCodesRemaining: 10 });

    const r = await recreateCodes(a, s.sid, token);
    expect(problemOf(r)).toEqual({ status: 409, type: 'totp-not-registered' });
    expect(r.headers['cache-control']).toBe('no-store');
    expect(store.recoveryCodes(a.id).length).toBe(codesBefore);
    expect(store.sessions(a.id).filter((x) => x.terminatedAt === null).length).toBe(sessionsBefore);
  });

  test('I-T53 ③ [ASVS v5.0.0-6.3.3] 시드 키·저장소·해셔·세션 종료 사건이 실패하면 503이고 시드·대기 칸·옛 코드·세션·사건을 바꾸지 않는다', async () => {
    // 시드 키 서비스 실패
    {
      const a = await makeAccount('key-down');
      const s = await login(a, 'dev-kd', '203.0.113.140', UA.chromeWindows);
      const token = await reauth(a, s.sid, 'ACCOUNT_SECURITY');
      const before = await store.getTotp(a.id);
      const original = totpCipher.encrypt.bind(totpCipher);
      totpCipher.encrypt = async () => {
        throw new TotpKeyUnavailable('시험 주입');
      };
      try {
        const r = await beginTotp(a, s.sid, token);
        expect(problemOf(r)).toEqual({ status: 503, type: 'admin-login-unavailable' });
        expect(r.headers['retry-after']).toBe('5');
        expect(r.headers['cache-control']).toBe('no-store');
      } finally {
        totpCipher.encrypt = original;
      }
      const after = await store.getTotp(a.id);
      expect(after?.pendingEnc).toBeNull();
      expect(after?.seedEnc?.equals(before!.seedEnc!)).toBe(true);
      expect(rowOf(a.id)['totpPendingSessionId']).toBeNull();
    }

    // 시작·확인의 저장소 쓰기 실패
    {
      const a = await makeAccount('store-down');
      const s = await login(a, 'dev-sd', '203.0.113.150', UA.chromeWindows);
      const before = await store.getTotp(a.id);
      const token = await reauth(a, s.sid, 'ACCOUNT_SECURITY');
      const restoreBegin = patchStore('setTotpPending', async () => {
        throw new Error('저장소 쓰기 실패');
      });
      try {
        const r = await beginTotp(a, s.sid, token);
        expect(problemOf(r)).toEqual({ status: 503, type: 'admin-login-unavailable' });
        expect(r.headers['retry-after']).toBe('5');
        expect(r.headers['cache-control']).toBe('no-store');
      } finally {
        restoreBegin();
      }
      expect((await store.getTotp(a.id))?.pendingEnc).toBeNull();
      expect((await store.getTotp(a.id))?.seedEnc?.equals(before!.seedEnc!)).toBe(true);

      const begin = await beginTotp(a, s.sid, await reauth(a, s.sid, 'ACCOUNT_SECURITY'));
      const secret = new URL(String(json(begin).otpauthUri)).searchParams.get('secret');
      if (!secret) throw new Error('대기 시드가 없다');
      const code = totpAt(base32Decode(secret), Math.floor(clock.now() / 30_000));
      const restoreConfirm = patchStore('confirmTotpForSession', async () => {
        throw new Error('저장소 쓰기 실패');
      });
      try {
        const r = await confirmTotp(a, s.sid, code);
        expect(problemOf(r)).toEqual({ status: 503, type: 'admin-login-unavailable' });
        expect(r.headers['retry-after']).toBe('5');
        expect(r.headers['cache-control']).toBe('no-store');
      } finally {
        restoreConfirm();
      }
      expect((await store.getTotp(a.id))?.pendingEnc).not.toBeNull();
      expect((await store.getTotp(a.id))?.seedEnc?.equals(before!.seedEnc!)).toBe(true);
    }

    // 복구 코드 해셔·세션 종료 사건 실패
    {
      const a = await makeAccount('hasher-down');
      const s1 = await login(a, 'dev-hd-1', '203.0.113.151', UA.chromeWindows);
      const s2 = await login(a, 'dev-hd-2', '203.0.113.152', UA.safariIpad);
      const codesBefore = store.recoveryCodes(a.id);
      const hasher = svc.app.get<AdminPasswords>(RECOVERY_CODE_HASHER);
      const oldHash = hasher.hash;
      hasher.hash = async () => {
        throw new Error('해셔 실패');
      };
      try {
        const r = await recreateCodes(a, s1.sid, await reauth(a, s1.sid, 'ACCOUNT_SECURITY'));
        expect(problemOf(r)).toEqual({ status: 503, type: 'admin-login-unavailable' });
        expect(r.headers['retry-after']).toBe('5');
        expect(r.headers['cache-control']).toBe('no-store');
      } finally {
        hasher.hash = oldHash;
      }
      expect(store.recoveryCodes(a.id)).toEqual(codesBefore);
      expect(liveCount(a.id)).toBe(2);

      const token = await reauth(a, s1.sid, 'ACCOUNT_SECURITY');
      const restoreEnd = patchStore('endDeviceSessions', async () => {
        throw new Error('사건 쓰기 실패');
      });
      try {
        const r = await endSession(a, s1.sid, s2.sid, token);
        expect(problemOf(r)).toEqual({ status: 503, type: 'admin-login-unavailable' });
        expect(r.headers['retry-after']).toBe('5');
        expect(r.headers['cache-control']).toBe('no-store');
      } finally {
        restoreEnd();
      }
      expect(await guard.getAdminAuthz({ adminAccountId: a.id, sessionId: s2.sid })).toMatchObject({ valid: true });
      expect(liveCount(a.id)).toBe(2);
      expect(store.terminatedEvents().filter((e) => e.accountId === a.id)).toEqual([]);
    }
  });
});
