// 관리 계정 비밀번호만 맞은 로그인 알림과 비밀번호 바꾸기(docs/features/identity.md §6 '관리 계정 비밀번호만 맞은 로그인 알림과 비밀번호 바꾸기의 첫 구현', docs/security/auth-controls.md §2.1 C7·§3.5, BUILD_ORDER BOT-123).
// 시험: AC-T4, AC-T7 ④의 세션 쪽, GetAdminAuthz(ADR-0172). 메모리 저장소·메모리 셈·로컬 키로 본다.
import { fakeClock } from '@peaket/platform';
import { decodeJwt } from 'jose';
import { vi, describe, expect, test } from 'vitest';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { MemoryLoginCounters } from '../src/modules/admin/adapters/memory-login-counters.js';
import { Pbkdf2AdminPasswords, RECOVERY_CODE_ITERATIONS } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { loadPolicyLists } from '../src/modules/admin/adapters/word-list-files.js';
import { ChangeAdminPassword } from '../src/modules/admin/application/change-admin-password.js';
import { CheckPasswordOnlyLogins } from '../src/modules/admin/application/check-password-only-logins.js';
import { GetAdminAuthz } from '../src/modules/admin/application/get-admin-authz.js';
import { LoginPasswordStep } from '../src/modules/admin/application/login-password-step.js';
import { LoginSecondStep } from '../src/modules/admin/application/login-second-step.js';
import { RecordAdminLoginSuccess } from '../src/modules/admin/application/record-login-success.js';
import { SetAdminPassword } from '../src/modules/admin/application/set-admin-password.js';
import { BeginTotpEnrollment, ConfirmTotpEnrollment } from '../src/modules/admin/application/totp-enrollment.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { base32Decode, totpAt } from '../src/modules/admin/domain/totp.js';
import { TokenKeyRing } from '../src/modules/session/index.js';
import { fanKey } from './support.js';

// 비밀번호 해시를 실제로 여러 번 돌려 몰리는 러너에서 기본 5초를 넘긴다(CI 66c9a912)
vi.setConfig({ testTimeout: 30_000 });

const M = 60_000;
const PARTNER = '0190f3a1-7c2e-7a00-8000-0000000008a1';
const OTHER = '0190f3a1-7c2e-7a00-8000-0000000008a2';
const EMAIL = 'minji.kim@haeoreum.example';
const PW = '봄비내리는월요일아침의커피한잔';
const NEW_PW = '바다건너온편지를천천히읽는저녁';
const cfg = DEFAULT_ADMIN_AUTH_CONFIG;

async function harness() {
  const clock = fakeClock({ now: Date.parse('2026-11-05T08:00:00Z') });
  const store = new MemoryAdminAccountStore();
  const counters = new MemoryLoginCounters();
  const pepper = new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1);
  const passwords = new Pbkdf2AdminPasswords(pepper, { iterations: 1_000 });
  const recovery = new Pbkdf2AdminPasswords(pepper, { iterations: RECOVERY_CODE_ITERATIONS, context: 'admin-rc-v1' });
  const cipher = new LocalTotpSeedCipher(Buffer.alloc(32, 3));
  const seen = { failures: [] as string[], alerts: [] as string[] };
  const signals = { failure: (_a: string, r: string) => void seen.failures.push(r), alert: (k: string) => void seen.alerts.push(k) };
  const fan = await fanKey();
  const admin = await fanKey();
  const ring = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-c' }) });
  const signer = new JoseAdminTokenSigner(ring, 'https://identity.peaket.test');
  const breaches = { breached: false, async isBreached() { return breaches.breached; } };
  store.create({ id: PARTNER, role: 'partner_admin', email: EMAIL, status: 'ACTIVE', promoterId: '0190f3a1-7c2e-7a00-8000-000000000001', now: clock.now() });
  await store.setPassword({ id: PARTNER, phc: await passwords.hash(PARTNER, PW), breachCheckedAt: clock.now(), now: clock.now() });
  const human = { verify: async (t: string) => (t === 'ok' ? ('OK' as const) : ('FAILED' as const)) };
  const step1 = new LoginPasswordStep(store, counters, passwords, breaches, human, signals, cfg, clock);
  const success = new RecordAdminLoginSuccess(store, counters, clock);
  const step2 = new LoginSecondStep(store, counters, cipher, recovery, success, signer, signals, cfg, clock);
  const passwordOnly = new CheckPasswordOnlyLogins(store, cfg, clock);
  const setPassword = new SetAdminPassword(store, passwords, breaches, loadPolicyLists({}), cfg, clock);
  const securityLog: { line: Record<string, unknown>; msg: string }[] = [];
  const logger = { warn: ((line: Record<string, unknown>, msg: string) => void securityLog.push({ line, msg })) as never };
  const change = new ChangeAdminPassword(store, counters, passwords, new SetAdminPassword(store, passwords, breaches, loadPolicyLists({}), cfg, clock, logger), signer, signals, cfg, clock, logger);
  const authz = new GetAdminAuthz(store, store, clock);
  const { otpauthUri } = await new BeginTotpEnrollment(store, cipher).run({ accountId: PARTNER });
  const seed = base32Decode(new URL(otpauthUri).searchParams.get('secret')!);
  await new ConfirmTotpEnrollment(store, cipher, recovery, clock).run({ accountId: PARTNER, code: totpAt(seed, Math.floor(clock.now() / 30_000)) });
  clock.advance(30_000);
  /** 비밀번호와 TOTP까지 로그인한다(30초씩 시계를 넘겨 새 코드를 쓴다) */
  const login = async (ip = '203.0.113.10', deviceId = 'dev-a') => {
    clock.advance(30_000);
    const s1 = await step1.run({ aud: 'partner', email: EMAIL, password: PW, ip, deviceId, humanCheckToken: 'ok' });
    if (s1.kind !== 'PASSED') throw new Error(s1.kind);
    const s2 = await step2.run({ aud: 'partner', loginStep: s1.loginStep, code: totpAt(seed, Math.floor(clock.now() / 30_000)), ip, deviceId });
    if (s2.kind !== 'DONE') throw new Error(s2.kind);
    return s2;
  };
  return { clock, store, counters, step1, step2, passwordOnly, change, authz, login, breaches, seen, seed, securityLog };
}

describe('비밀번호만 맞은 로그인(auth-controls §2.1 C7, AC-T4)', () => {
  test('AC-T4_30일성공기록이없는출발지에서비밀번호만맞고2단계에서멈추면10분뒤알림과비밀번호바꾸기필요이고_익숙한출발지는알림이없다 [ASVS v5.0.0-6.3.1]', async () => {
    const t = await harness();
    await t.login('203.0.113.10', 'dev-a');
    // 익숙한 출발지에서 멈춘다
    await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '203.0.113.10', deviceId: 'dev-a', humanCheckToken: 'ok' });
    // 새 출발지에서 멈춘다
    await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '198.51.100.70', deviceId: 'dev-x', humanCheckToken: 'ok' });
    t.clock.advance(9 * M);
    expect(await t.passwordOnly.run()).toBe(0);
    t.clock.advance(2 * M);
    expect(await t.passwordOnly.run()).toBe(1);
    expect(t.store.notices(PARTNER)).toEqual(['PASSWORD_ONLY_LOGIN']);
    expect(t.store.peek(PARTNER)!.passwordChangeRequired).toBe(true);
    // 한 행에 한 번
    expect(await t.passwordOnly.run()).toBe(0);
  });

  test('AC-T4_비밀번호만맞은로그인찾기는만든지1일10분안의행만보고_그보다옛행(0020전에만든행)은알리지않는다(BOT-123이넘긴것)', async () => {
    const t = await harness();
    await t.login('203.0.113.10', 'dev-a');
    await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '198.51.100.71', deviceId: 'dev-y', humanCheckToken: 'ok' });
    // 찾기가 1일 10분 넘게 돌지 않았다
    t.clock.advance(24 * 60 * M + 11 * M);
    expect(await t.passwordOnly.run()).toBe(0);
    expect(t.store.notices(PARTNER)).toEqual([]);
    // 정비는 만든 지 2일 지난 단계 행을 지운다
    expect(await t.store.purgeLoginSteps(t.clock.now() - 48 * 60 * M)).toBe(0);
    t.clock.advance(24 * 60 * M);
    expect(await t.store.purgeLoginSteps(t.clock.now() - 48 * 60 * M)).toBeGreaterThan(0);
  });

  test('AC-T4_다음로그인세션은password_change스코프하나이고_비밀번호를바꾸면다른세션이모두끝나고스코프없는새토큰을준다', async () => {
    const t = await harness();
    const before = await t.login('203.0.113.10', 'dev-a');
    t.store.setPasswordChangeRequired(PARTNER, true);
    const restricted = await t.login('203.0.113.11', 'dev-b');
    expect(decodeJwt(restricted.accessToken)).toMatchObject({ scope: 'password:change' });
    expect(decodeJwt(before.accessToken).scope).toBeUndefined();
    const r = await t.change.run({ aud: 'partner', accountId: PARTNER, sessionId: restricted.sessionId, scopes: ['password:change'], currentPassword: PW, newPassword: NEW_PW, ip: '203.0.113.11' });
    expect(r.kind).toBe('CHANGED');
    if (r.kind !== 'CHANGED') throw new Error(r.kind);
    expect(r.accessToken).toBeDefined();
    expect(decodeJwt(r.accessToken!).scope).toBeUndefined();
    expect(decodeJwt(r.accessToken!)).toMatchObject({ sid: restricted.sessionId, sub: PARTNER, aud: 'partner' });
    expect(t.store.peek(PARTNER)!.passwordChangeRequired).toBe(false);
    expect(t.store.terminatedEvents()).toContainEqual({ accountId: PARTNER, sessionId: before.sessionId, reason: 'PASSWORD_CHANGED' });
    expect(t.store.sessions(PARTNER).find((s) => s.id === restricted.sessionId)!.terminatedAt).toBeNull();
    // 새 비밀번호로 로그인된다
    expect(await t.step1.run({ aud: 'partner', email: EMAIL, password: NEW_PW, ip: '203.0.113.12', deviceId: 'dev-c', humanCheckToken: 'ok' })).toMatchObject({ kind: 'PASSED' });
  });

  test('AC-T7④_로그인때유출목록에걸리면다음세션은비밀번호바꾸기만이다 [ASVS v5.0.0-6.2.12]', async () => {
    const t = await harness();
    t.clock.advance(31 * 24 * 60 * M);
    t.breaches.breached = true;
    const s = await t.login();
    expect(decodeJwt(s.accessToken)).toMatchObject({ scope: 'password:change' });
  });
});

describe('비밀번호 바꾸기(auth-controls §3.5·§4)', () => {
  test('지금비밀번호가틀리면로그인실패처럼세고_새비밀번호가정책에걸리면이유를주며_보호잠금이면막는다', async () => {
    const t = await harness();
    const s = await t.login();
    const wrong = await t.change.run({ aud: 'partner', accountId: PARTNER, sessionId: s.sessionId, scopes: [], currentPassword: 'nope', newPassword: NEW_PW, ip: '203.0.113.10' });
    expect(wrong).toEqual({ kind: 'CURRENT_INVALID' });
    expect(t.store.peek(PARTNER)).toMatchObject({ failedAttempts: 1, passwordFailureTotal: 1 });
    const weak = await t.change.run({ aud: 'partner', accountId: PARTNER, sessionId: s.sessionId, scopes: [], currentPassword: PW, newPassword: 'Peaket2026!!!!!!', ip: '203.0.113.10' });
    expect(weak).toEqual({ kind: 'REJECTED', reason: 'CONTEXT' });
    // 거절 이유의 종류와 계정 ID만 보안 이벤트로 남긴다(auth-controls §4.3 10, BOT-110이 넘긴 것). 비밀번호·사본은 싣지 않는다
    const same = await t.change.run({ aud: 'partner', accountId: PARTNER, sessionId: s.sessionId, scopes: [], currentPassword: PW, newPassword: PW, ip: '203.0.113.10' });
    expect(same).toEqual({ kind: 'REJECTED', reason: 'SAME_AS_CURRENT' });
    expect(t.securityLog.map((x) => x.line)).toEqual([
      { kind: 'security', event: 'admin_password_rejected', accountId: PARTNER, reason: 'CONTEXT' },
      { kind: 'security', event: 'admin_password_rejected', accountId: PARTNER, reason: 'SAME_AS_CURRENT' },
    ]);
    expect(JSON.stringify(t.securityLog)).not.toContain('Peaket2026');
    // 스코프 없는 보통 세션은 새 토큰을 주지 않는다
    const ok = await t.change.run({ aud: 'partner', accountId: PARTNER, sessionId: s.sessionId, scopes: [], currentPassword: PW, newPassword: NEW_PW, ip: '203.0.113.10' });
    expect(ok).toEqual({ kind: 'CHANGED' });
    await t.store.updateLoginState(PARTNER, t.clock.now(), (cur) => ({ next: { ...cur, lockKind: 'PROTECT' }, notices: [] }));
    expect(await t.change.run({ aud: 'partner', accountId: PARTNER, sessionId: s.sessionId, scopes: [], currentPassword: NEW_PW, newPassword: PW + '하나', ip: '203.0.113.10' })).toEqual({ kind: 'PROTECTED' });
  });
});

describe('비밀번호 바꾸기의 잠김·경보·같은 비밀번호(새 맥락 리뷰 2026-11-05)', () => {
  const run = (t: Awaited<ReturnType<typeof harness>>, sessionId: string, currentPassword: string, newPassword = NEW_PW, scopes: string[] = []) =>
    t.change.run({ aud: 'partner', accountId: PARTNER, sessionId, scopes, currentPassword, newPassword, ip: '203.0.113.10' });

  test('시간잠금중에는맞는지금비밀번호여도보지않고423이며세지않는다_실패는그세션이로그인한묶음에세고잠기면423이다 [ASVS v5.0.0-6.3.1]', async () => {
    const t = await harness();
    const s = await t.login('203.0.113.10', 'dev-a');
    const outs = [];
    for (let k = 0; k < cfg.lockAfterFailures; k++) outs.push(await run(t, s.sessionId, `틀린비밀번호${k}`));
    expect(outs.slice(0, -1).every((o) => o.kind === 'CURRENT_INVALID')).toBe(true);
    expect(outs.at(-1)).toMatchObject({ kind: 'LOCKED' });
    const failed = t.store.peek(PARTNER)!.failedAttempts;
    // 잠긴 동안은 맞는 비밀번호로도 바꾸지 못하고 세지 않는다
    expect(await run(t, s.sessionId, PW)).toMatchObject({ kind: 'LOCKED' });
    expect(t.store.peek(PARTNER)!.failedAttempts).toBe(failed);
    expect(t.seen.failures).toContain('locked');
    // 같은 묶음(세션이 로그인한 IP·기기)의 1단계도 잠겼다
    expect(await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '203.0.113.10', deviceId: 'dev-a', humanCheckToken: 'ok' })).toMatchObject({ kind: 'LOCKED' });
  });

  test('묶음잠금만걸려도423이다', async () => {
    const t = await harness();
    const s = await t.login('203.0.113.10', 'dev-a');
    // 그 세션의 묶음에 묶음 잠금(계정은 잠기지 않음)
    for (let k = 0; k < cfg.pairLockAfterFailures; k++) {
      await t.counters.recordFailure({ subject: PARTNER, pair: t.store.sessions(PARTNER).find((x) => x.id === s.sessionId)!.pairRef, ipHash: 'h', emailHash: 'e', now: t.clock.now(), accountLockedUntil: null, pairLockMs: 15 * M, limits: { pairLockAfter: cfg.pairLockAfterFailures, multiSourceIps: 99, sourceAccounts: 99, windowMs: 60 * M, accountAlertMs: M, sourceAlertMs: M, globalFailures: 9999, globalWindowMs: 5 * M, globalAlertMs: M } });
    }
    expect(await run(t, s.sessionId, PW)).toMatchObject({ kind: 'LOCKED' });
  });

  test('지금비밀번호실패도1단계와같은경보를낸다_누계알림의SEV3', async () => {
    const t = await harness();
    const s = await t.login();
    await t.store.updateLoginState(PARTNER, t.clock.now(), (cur) => ({ next: { ...cur, passwordFailureTotal: cfg.passwordFailureNotice - 1 }, notices: [] }));
    expect(await run(t, s.sessionId, '틀린비밀번호')).toEqual({ kind: 'CURRENT_INVALID' });
    expect(t.seen.alerts).toContain('password_failure_notice');
    expect(t.store.notices(PARTNER)).toContain('PASSWORD_FAILURE_NOTICE');
  });

  test('새비밀번호가지금것과같으면거절하고_비밀번호바꾸기필요표시가남는다(§3.5)', async () => {
    const t = await harness();
    t.store.setPasswordChangeRequired(PARTNER, true);
    const s = await t.login();
    expect(await run(t, s.sessionId, PW, PW.normalize('NFD'), ['password:change'])).toEqual({ kind: 'REJECTED', reason: 'SAME_AS_CURRENT' });
    expect(t.store.peek(PARTNER)!.passwordChangeRequired).toBe(true);
  });
});

describe('비밀번호만 맞은 로그인의 다시 시도(새 맥락 리뷰 2026-11-05)', () => {
  test('AC-T4_새출발지에서2단계를멈췄다가같은묶음에서다시로그인을끝냈으면알리지않고_다른묶음이면알린다', async () => {
    const t = await harness();
    // 새 출발지에서 1단계만(멈춤), 곧 같은 출발지에서 다시 끝까지
    await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '198.51.100.70', deviceId: 'dev-x', humanCheckToken: 'ok' });
    await t.login('198.51.100.70', 'dev-x');
    // 다른 새 출발지에서 멈춤
    await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '198.51.100.80', deviceId: 'dev-y', humanCheckToken: 'ok' });
    t.clock.advance(11 * M);
    expect(await t.passwordOnly.run()).toBe(1);
    expect(t.store.notices(PARTNER)).toEqual(['PASSWORD_ONLY_LOGIN']);
    // 다시 돌려도 앞의 단계는 본 것으로 적혀 다시 오지 않는다
    expect(await t.passwordOnly.run()).toBe(0);
  });
});

describe('저장소의 경계(재검토 2026-11-05)', () => {
  test('비밀번호만맞은로그인으로본단계는2단계에쓸수없고_지운계정의단계는본것으로적어다시잡히지않는다', async () => {
    const t = await harness();
    const now = t.clock.now();
    await t.store.createLoginStep({ id: '0190f3a1-7c2e-7a00-8000-0000000008e1', accountId: PARTNER, tokenHash: Buffer.alloc(32, 1), aud: 'partner', pairRef: 'p'.repeat(32), createdAt: now, expiresAt: now + 5 * M, knownSource: false });
    expect(await t.store.markPasswordOnly('0190f3a1-7c2e-7a00-8000-0000000008e1', PARTNER, now + M)).toBe(true);
    expect(await t.store.useLoginStep('0190f3a1-7c2e-7a00-8000-0000000008e1', now + M)).toBe(false);
    await t.store.createLoginStep({ id: '0190f3a1-7c2e-7a00-8000-0000000008e2', accountId: PARTNER, tokenHash: Buffer.alloc(32, 2), aud: 'partner', pairRef: 'q'.repeat(32), createdAt: now, expiresAt: now + 5 * M, knownSource: false });
    t.store.remove(PARTNER);
    expect(await t.store.markPasswordOnly('0190f3a1-7c2e-7a00-8000-0000000008e2', PARTNER, now + M)).toBe(false);
    expect(await t.store.findPasswordOnlySteps(now + M, now - M, 20)).toEqual([]);
  });

  test('비밀번호바꾸기는임대안에서세션을다시본다_끝난세션이면바꾸지않는다', async () => {
    const t = await harness();
    const a = await t.login('203.0.113.10', 'dev-a');
    const b = await t.login('203.0.113.11', 'dev-b');
    await t.store.terminateOtherSessions(PARTNER, b.sessionId, 'PASSWORD_CHANGED', t.clock.now());
    expect(await t.change.run({ aud: 'partner', accountId: PARTNER, sessionId: a.sessionId, scopes: ['password:change'], currentPassword: PW, newPassword: NEW_PW, ip: '203.0.113.10' })).toEqual({ kind: 'SESSION_INVALID' });
    expect(await t.change.run({ aud: 'partner', accountId: PARTNER, sessionId: '0190f3a1-7c2e-7a00-8000-0000000008ff', scopes: [], currentPassword: PW, newPassword: NEW_PW, ip: '203.0.113.10' })).toEqual({ kind: 'SESSION_INVALID' });
    expect(t.store.peek(PARTNER)!.failedAttempts).toBe(0);
  });
});

describe('관리 경로 역할 확인(GetAdminAuthz, ADR-0172)', () => {
  test('끝난세션은valid가아니고_남긴세션은이어지며_운영자콘솔역할로판정하지않는다', async () => {
    const t = await harness();
    const a = await t.login('203.0.113.10', 'dev-a');
    const b = await t.login('203.0.113.11', 'dev-b');
    expect(await t.store.terminateOtherSessions(PARTNER, b.sessionId, 'PASSWORD_CHANGED', t.clock.now())).toEqual([a.sessionId]);
    expect((await t.authz.getAdminAuthz({ adminAccountId: PARTNER, sessionId: a.sessionId })).valid).toBe(false);
    expect(await t.authz.getAdminAuthz({ adminAccountId: PARTNER, sessionId: b.sessionId })).toMatchObject({ valid: true, role: 'partner_admin' });
    // 절대 만료(24시간): 유휴 시간을 늘리는 갱신은 BOT-130이라 여기서는 판정식만 본다(유휴 만료가 먼저 온다)
    t.clock.advance(24 * 60 * M);
    expect((await t.authz.getAdminAuthz({ adminAccountId: PARTNER, sessionId: b.sessionId })).valid).toBe(false);
  });

  test('살아있는그계정의관리세션이면역할과테넌트이고_끝났거나유휴·절대만료이거나다른계정의세션이면valid가아니다 [ASVS v5.0.0-8.2.1]', async () => {
    const t = await harness();
    const s = await t.login();
    expect(await t.authz.getAdminAuthz({ adminAccountId: PARTNER, sessionId: s.sessionId })).toEqual({ valid: true, role: 'partner_admin', tenantId: '0190f3a1-7c2e-7a00-8000-000000000001' });
    expect((await t.authz.getAdminAuthz({ adminAccountId: OTHER, sessionId: s.sessionId })).valid).toBe(false);
    expect((await t.authz.getAdminAuthz({ adminAccountId: PARTNER, sessionId: '0190f3a1-7c2e-7a00-8000-0000000008ff' })).valid).toBe(false);
    // 보호 잠금이어도 열린 세션은 이어진다(§3.2)
    await t.store.updateLoginState(PARTNER, t.clock.now(), (cur) => ({ next: { ...cur, lockKind: 'PROTECT' }, notices: [] }));
    expect((await t.authz.getAdminAuthz({ adminAccountId: PARTNER, sessionId: s.sessionId })).valid).toBe(true);
    t.clock.advance(61 * M);
    expect((await t.authz.getAdminAuthz({ adminAccountId: PARTNER, sessionId: s.sessionId })).valid).toBe(false);
    t.store.remove(PARTNER);
    expect((await t.authz.getAdminAuthz({ adminAccountId: PARTNER, sessionId: s.sessionId })).valid).toBe(false);
  });
});
