// 관리 계정 본인 해제 링크와 2단계 보호 잠금(docs/features/identity.md §6 '관리 계정 본인 해제 링크와 2단계 보호 잠금의 첫 구현', docs/security/auth-controls.md §3.1~§3.4, BUILD_ORDER BOT-121).
// 시험: AC-T5 ①~⑥, I-T11 ①의 해제 링크 메일·②·③·⑤, 알림 발송 고리. 메모리 저장소·메모리 셈·메일 대역·로컬 키로 본다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { MemoryAdminMailer } from '../src/modules/admin/adapters/memory-admin-mailer.js';
import { MemoryLoginCounters } from '../src/modules/admin/adapters/memory-login-counters.js';
import { Pbkdf2AdminPasswords, RECOVERY_CODE_ITERATIONS } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { DispatchAdminNotices } from '../src/modules/admin/application/dispatch-admin-notices.js';
import { LoginPasswordStep } from '../src/modules/admin/application/login-password-step.js';
import { LoginSecondStep } from '../src/modules/admin/application/login-second-step.js';
import { RecordAdminLoginSuccess } from '../src/modules/admin/application/record-login-success.js';
import { BeginTotpEnrollment, ConfirmTotpEnrollment } from '../src/modules/admin/application/totp-enrollment.js';
import { RequestUnlockLink, UnlockWithLink } from '../src/modules/admin/application/unlock-account.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { base32Decode, totpAt } from '../src/modules/admin/domain/totp.js';
import { TokenKeyRing } from '../src/modules/session/index.js';
import { fanKey } from './support.js';

const M = 60_000;
const H = 60 * M;
const PARTNER = '0190f3a1-7c2e-7a00-8000-0000000006a1';
const EMAIL = 'minji.kim@haeoreum.example';
const PW = '봄비내리는월요일아침의커피한잔';
const cfg = DEFAULT_ADMIN_AUTH_CONFIG;
const ORIGINS = { partner: 'https://partner.peaket.example', ops: 'https://console.peaket.example' };

async function harness() {
  const clock = fakeClock({ now: Date.parse('2026-11-05T06:00:00Z') });
  const store = new MemoryAdminAccountStore();
  const counters = new MemoryLoginCounters();
  const pepper = new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1);
  const passwords = new Pbkdf2AdminPasswords(pepper, { iterations: 1_000 });
  const recovery = new Pbkdf2AdminPasswords(pepper, { iterations: RECOVERY_CODE_ITERATIONS, context: 'admin-rc-v1' });
  const cipher = new LocalTotpSeedCipher(Buffer.alloc(32, 3));
  const alerts: string[] = [];
  const signals = { failure: () => {}, alert: (k: string) => alerts.push(k) };
  const fan = await fanKey();
  const admin = await fanKey();
  const ring = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-u' }) });
  store.create({ id: PARTNER, role: 'partner_admin', email: EMAIL, status: 'ACTIVE', promoterId: '0190f3a1-7c2e-7a00-8000-000000000001', now: clock.now() });
  await store.setPassword({ id: PARTNER, phc: await passwords.hash(PARTNER, PW), breachCheckedAt: clock.now(), now: clock.now() });
  const human = { verify: async (t: string) => (t === 'ok' ? ('OK' as const) : ('FAILED' as const)) };
  const step1 = new LoginPasswordStep(store, counters, passwords, { isBreached: async () => false }, human, signals, cfg, clock);
  const success = new RecordAdminLoginSuccess(store, counters, clock);
  const step2 = new LoginSecondStep(store, counters, cipher, recovery, success, new JoseAdminTokenSigner(ring, 'https://identity.peaket.test'), signals, cfg, clock);
  const mailer = new MemoryAdminMailer();
  const dispatch = new DispatchAdminNotices(store, mailer, ORIGINS, cfg, clock);
  const unlock = new UnlockWithLink(store, counters, cipher, recovery, signals, cfg, clock);
  const resend = new RequestUnlockLink(store, counters, cfg, clock);
  const { otpauthUri } = await new BeginTotpEnrollment(store, cipher).run({ accountId: PARTNER });
  const seed = base32Decode(new URL(otpauthUri).searchParams.get('secret')!);
  await new ConfirmTotpEnrollment(store, cipher, recovery, clock).run({ accountId: PARTNER, code: totpAt(seed, Math.floor(clock.now() / 30_000)) });
  clock.advance(30_000);
  const code = () => totpAt(seed, Math.floor(clock.now() / 30_000));
  const wrong = () => (code() === '000000' ? '111111' : '000000');
  /** 한 출발지에서 비밀번호를 5번 틀려 시간 잠금을 건다 */
  const lockOut = async (ip = '203.0.113.10') => {
    for (let i = 0; i < 5; i++) await step1.run({ aud: 'partner', email: EMAIL, password: `x${i}`, ip, deviceId: 'dev-a', humanCheckToken: 'ok' });
  };
  /** 메일함의 마지막 해제 링크 토큰 */
  const lastLinkToken = () => {
    const m = mailer.sent.filter((x) => x.link).at(-1);
    return m ? new URL(m.link!).hash.replace(/^#token=/, '') : null;
  };
  return { clock, store, counters, step1, step2, mailer, dispatch, unlock, resend, code, wrong, lockOut, lastLinkToken, alerts };
}

describe('본인 해제 링크(auth-controls §3.3, AC-T5, I-T11)', () => {
  test('I-T11①②③_5회실패의시간잠금은업무이메일로URL조각해제링크를보내고_링크에서코드가맞으면시간잠금만풀리며_같은출발지의묶음잠금은남는다 [ASVS v5.0.0-6.3.1]', async () => {
    const t = await harness();
    await t.lockOut();
    expect(t.store.peek(PARTNER)!.lockKind).toBe('TIMED');
    await t.dispatch.run();
    const [mail] = t.mailer.sent;
    expect(mail).toMatchObject({ to: EMAIL, kind: 'UNLOCK_LINK' });
    expect(mail!.link).toMatch(/^https:\/\/partner\.peaket\.example\/unlock#token=[A-Za-z0-9_-]{43}$/);
    expect(t.store.allNotices().every((n) => n.sentAt !== null)).toBe(true);
    // 링크 토큰은 해시만 둔다
    expect(JSON.stringify(t.store.unlockLinks(PARTNER))).not.toContain(t.lastLinkToken()!);
    expect(await t.unlock.run({ aud: 'partner', unlockToken: t.lastLinkToken()!, code: t.code() })).toEqual({ kind: 'UNLOCKED' });
    // 푼 시각을 locked_until에 남겨 '풀린 뒤 24시간 안' 반복 잠금(§3.2)을 센다
    expect(t.store.peek(PARTNER)).toMatchObject({ lockKind: 'NONE', lockedUntil: t.clock.now(), failedAttempts: 0, passwordFailureTotal: 5 });
    expect(t.store.notices(PARTNER)).toContain('UNLOCKED');
    // ③ 같은 출발지는 묶음 잠금으로 거절되고 계정은 다시 잠기지 않는다
    expect(await t.step1.run({ aud: 'partner', email: EMAIL, password: 'again', ip: '203.0.113.10', deviceId: 'dev-a', humanCheckToken: 'ok' })).toMatchObject({ kind: 'LOCKED', lock: 'TIMED' });
    expect(t.store.peek(PARTNER)!.lockKind).toBe('NONE');
    // 다른 출발지에서는 바로 로그인된다
    expect(await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '198.51.100.30', deviceId: 'dev-b', humanCheckToken: 'ok' })).toMatchObject({ kind: 'PASSED' });
  });

  test('AC-T5②③④_한링크에서코드를3번틀리면무효이고_쓴링크·31분지난링크는거절된다', async () => {
    const t = await harness();
    await t.lockOut();
    await t.dispatch.run();
    const token = t.lastLinkToken()!;
    expect(await t.unlock.run({ aud: 'partner', unlockToken: token, code: t.wrong() })).toEqual({ kind: 'CODE_INVALID', remainingAttempts: 2 });
    expect(await t.unlock.run({ aud: 'partner', unlockToken: token, code: t.wrong() })).toEqual({ kind: 'CODE_INVALID', remainingAttempts: 1 });
    expect(await t.unlock.run({ aud: 'partner', unlockToken: token, code: t.wrong() })).toEqual({ kind: 'CODE_INVALID', remainingAttempts: 0 });
    expect(await t.unlock.run({ aud: 'partner', unlockToken: token, code: t.code() })).toEqual({ kind: 'LINK_INVALID' });
    expect(t.store.peek(PARTNER)).toMatchObject({ secondFactorFailures: 3, lockKind: 'TIMED' });
    // ③ 새 링크로 풀고 다시 열면 거절
    t.clock.advance(1_000);
    await t.resend.run({ aud: 'partner', email: EMAIL });
    await t.dispatch.run();
    const second = t.lastLinkToken()!;
    t.clock.advance(30_000);
    expect(await t.unlock.run({ aud: 'partner', unlockToken: second, code: t.code() })).toEqual({ kind: 'UNLOCKED' });
    expect(await t.unlock.run({ aud: 'partner', unlockToken: second, code: t.code() })).toEqual({ kind: 'LINK_INVALID' });
    // ④ 31분 지난 링크
    t.clock.advance(H);
    await t.lockOut('192.0.2.40');
    await t.dispatch.run();
    const third = t.lastLinkToken()!;
    t.clock.advance(31 * M);
    expect(await t.unlock.run({ aud: 'partner', unlockToken: third, code: t.code() })).toEqual({ kind: 'LINK_INVALID' });
    // 본인 해제 뒤 24시간 안의 잠금은 1시간이다(§3.2)
    expect(t.store.peek(PARTNER)!.lockedUntil! - (t.clock.now() - 31 * M)).toBe(H);
    // 다른 콘솔 경로로는 쓸 수 없다
    await t.resend.run({ aud: 'partner', email: EMAIL });
    await t.dispatch.run();
    const fourth = t.lastLinkToken()!;
    expect(fourth).not.toBe(third);
    expect(await t.unlock.run({ aud: 'ops', unlockToken: fourth, code: t.code() })).toEqual({ kind: 'LINK_INVALID' });
  });

  test('AC-T5⑤_다시받기는이메일마다1시간에3번이고_넷째는거절되어메일이나가지않으며_없는이메일도같은수로센다_새링크를보내면옛링크는무효다', async () => {
    const t = await harness();
    await t.lockOut();
    await t.dispatch.run();
    const first = t.lastLinkToken()!;
    for (let i = 0; i < 3; i++) expect(await t.resend.run({ aud: 'partner', email: EMAIL })).toEqual({ kind: 'ACCEPTED' });
    const r4 = await t.resend.run({ aud: 'partner', email: EMAIL });
    expect(r4).toMatchObject({ kind: 'RATE_LIMITED' });
    await t.dispatch.run();
    expect(t.mailer.sent.filter((m) => m.kind === 'UNLOCK_LINK')).toHaveLength(4);
    expect(await t.unlock.run({ aud: 'partner', unlockToken: first, code: t.code() })).toEqual({ kind: 'LINK_INVALID' });
    for (let i = 0; i < 3; i++) expect(await t.resend.run({ aud: 'partner', email: 'nobody@haeoreum.example' })).toEqual({ kind: 'ACCEPTED' });
    expect(await t.resend.run({ aud: 'partner', email: 'nobody@haeoreum.example' })).toMatchObject({ kind: 'RATE_LIMITED' });
    t.clock.advance(H + M);
    expect(await t.resend.run({ aud: 'partner', email: EMAIL })).toEqual({ kind: 'ACCEPTED' });
  });

  test('AC-T5⑥_링크코드를두링크에걸쳐5번틀리면보호잠금이고_보호잠금중에는링크로풀수없고새링크도보내지않는다', async () => {
    const t = await harness();
    await t.lockOut();
    await t.dispatch.run();
    const a = t.lastLinkToken()!;
    for (let i = 0; i < 3; i++) await t.unlock.run({ aud: 'partner', unlockToken: a, code: t.wrong() });
    await t.resend.run({ aud: 'partner', email: EMAIL });
    await t.dispatch.run();
    const b = t.lastLinkToken()!;
    // 남은 수는 링크의 남은 수와 보호 잠금까지 남은 수 가운데 작은 쪽이다(새 맥락 리뷰 2026-11-05)
    expect(await t.unlock.run({ aud: 'partner', unlockToken: b, code: t.wrong() })).toEqual({ kind: 'CODE_INVALID', remainingAttempts: 1 });
    expect(await t.unlock.run({ aud: 'partner', unlockToken: b, code: t.wrong() })).toEqual({ kind: 'PROTECTED' });
    expect(t.store.peek(PARTNER)).toMatchObject({ lockKind: 'PROTECT', lockReason: 'SECOND_FACTOR_FAILURES', secondFactorFailures: 5 });
    expect(t.store.notices(PARTNER)).toContain('PROTECT_LOCK');
    expect(await t.unlock.run({ aud: 'partner', unlockToken: b, code: t.code() })).toEqual({ kind: 'PROTECTED' });
    const before = t.mailer.sent.length;
    await t.resend.run({ aud: 'partner', email: EMAIL });
    await t.dispatch.run();
    expect(t.mailer.sent.slice(before).some((m) => m.kind === 'UNLOCK_LINK')).toBe(false);
  });
});

describe('2단계 보호 잠금(I-T11 ⑤)', () => {
  test('I-T11⑤_맞는비밀번호뒤인증앱코드를5번틀리면보호잠금이고_해제링크를보내지않으며_시간이지나도풀리지않는다 [ASVS v5.0.0-6.3.1]', async () => {
    const t = await harness();
    for (let i = 0; i < 5; i++) {
      const s1 = await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '203.0.113.20', deviceId: 'dev-c', humanCheckToken: 'ok' });
      if (s1.kind !== 'PASSED') throw new Error(s1.kind);
      await t.step2.run({ aud: 'partner', loginStep: s1.loginStep, code: t.wrong(), ip: '203.0.113.20', deviceId: 'dev-c' });
    }
    expect(t.store.peek(PARTNER)).toMatchObject({ lockKind: 'PROTECT', lockReason: 'SECOND_FACTOR_FAILURES', secondFactorFailures: 5, passwordFailureTotal: 0 });
    expect(t.store.notices(PARTNER)).toEqual(['PROTECT_LOCK']);
    await t.dispatch.run();
    expect(t.mailer.sent.map((m) => m.kind)).toEqual(['PROTECT_LOCK']);
    expect(t.mailer.sent[0]!.link).toBeUndefined();
    t.clock.advance(7 * 24 * H);
    expect(await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '198.51.100.31', deviceId: 'dev-d', humanCheckToken: 'ok' })).toEqual({ kind: 'LOCKED', lock: 'PROTECT' });
  });
});

describe('알림 발송 고리', () => {
  test('보내지못하면행을남겨다시하고_시간잠금이이미풀렸으면링크없이닫으며_한번보낸행은다시보내지않는다', async () => {
    const t = await harness();
    await t.lockOut();
    t.mailer.failNext = true;
    await t.dispatch.run();
    expect(t.mailer.sent).toHaveLength(0);
    expect(t.store.allNotices().filter((n) => n.sentAt === null)).toHaveLength(1);
    // 보내지 못한 행은 1분 뒤로 미룬다(앞의 실패 행이 뒤의 알림을 막지 않게)
    await t.dispatch.run();
    expect(t.mailer.sent).toHaveLength(0);
    t.clock.advance(60_000);
    await t.dispatch.run();
    expect(t.mailer.sent).toHaveLength(1);
    await t.dispatch.run();
    expect(t.mailer.sent).toHaveLength(1);
    // 시간 잠금이 이미 끝난 뒤에 처음 보내게 되면 링크를 만들지 않는다
    const u = await harness();
    await u.lockOut();
    u.clock.advance(16 * M);
    await u.dispatch.run();
    expect(u.mailer.sent).toHaveLength(0);
    expect(u.store.unlockLinks(PARTNER)).toHaveLength(0);
    expect(u.store.allNotices().every((n) => n.sentAt !== null)).toBe(true);
  });
});

// 새 맥락 리뷰(2026-11-05) 재현
describe('리뷰 재현(BOT-121)', () => {
  test('링크에서틀린코드는2단계실패수에만세고계정실패수는그대로이며_로그인2단계의남은수도보호잠금문턱을본다', async () => {
    const t = await harness();
    await t.lockOut();
    await t.dispatch.run();
    const token = t.lastLinkToken()!;
    for (let i = 0; i < 3; i++) await t.unlock.run({ aud: 'partner', unlockToken: token, code: t.wrong() });
    expect(t.store.peek(PARTNER)).toMatchObject({ failedAttempts: 0, secondFactorFailures: 3 });
    await t.resend.run({ aud: 'partner', email: EMAIL });
    await t.dispatch.run();
    t.clock.advance(30_000);
    expect(await t.unlock.run({ aud: 'partner', unlockToken: t.lastLinkToken()!, code: t.code() })).toEqual({ kind: 'UNLOCKED' });
    const s1 = await t.step1.run({ aud: 'partner', email: EMAIL, password: PW, ip: '198.51.100.50', deviceId: 'dev-r', humanCheckToken: 'ok' });
    if (s1.kind !== 'PASSED') throw new Error(s1.kind);
    // 2단계 실패 수 3 → 4: 보호 잠금까지 1번 남았다
    expect(await t.step2.run({ aud: 'partner', loginStep: s1.loginStep, code: t.wrong(), ip: '198.51.100.50', deviceId: 'dev-r' })).toEqual({ kind: 'CODE_INVALID', remainingAttempts: 1 });
  });

  test('시간잠금이이미끝난계정의링크는쓸수없고_확정때보호잠금이면풀지않는다', async () => {
    const t = await harness();
    await t.lockOut();
    await t.dispatch.run();
    const token = t.lastLinkToken()!;
    t.clock.advance(20 * M);
    expect(await t.unlock.run({ aud: 'partner', unlockToken: token, code: t.code() })).toEqual({ kind: 'LINK_INVALID' });
    // 저장소의 확정 단계도 보호 잠금이면 풀지 않는다(앞의 검사와 확정 사이에 보호 잠금이 걸린 경우)
    const u = await harness();
    await u.lockOut();
    await u.dispatch.run();
    const link = u.store.unlockLinks(PARTNER).at(-1)!;
    await u.store.updateLoginState(PARTNER, u.clock.now(), (cur) => ({ next: { ...cur, lockKind: 'PROTECT', lockReason: 'SECOND_FACTOR_FAILURES' }, notices: [] }));
    const { onSelfUnlock } = await import('../src/modules/admin/domain/login-rules.js');
    expect(await u.store.useUnlockLink(link.id, PARTNER, u.clock.now(), (cur) => (cur.lockKind === 'PROTECT' ? null : onSelfUnlock(cur, u.clock.now())), 'UNLOCKED')).toBe(false);
    expect(u.store.peek(PARTNER)!.lockKind).toBe('PROTECT');
  });

  test('발송고리에서한행이예외를내도앞에서보낸행은다시보내지않고_뒤의행은계속보낸다', async () => {
    const t = await harness();
    for (let i = 0; i < 3; i++) await t.store.addNotice(PARTNER, 'PASSWORD_FAILURE_NOTICE', t.clock.now() + i);
    let calls = 0;
    const realFind = t.store.findLoginById.bind(t.store);
    t.store.findLoginById = async (id: string) => {
      calls++;
      if (calls === 2) throw new Error('DB 일시 오류');
      return realFind(id);
    };
    expect(await t.dispatch.run()).toEqual({ done: 2, failed: 1 });
    expect(t.mailer.sent).toHaveLength(2);
    t.store.findLoginById = realFind;
    t.clock.advance(60_000);
    await t.dispatch.run();
    expect(t.mailer.sent).toHaveLength(3);
    await t.dispatch.run();
    expect(t.mailer.sent).toHaveLength(3);
  });
});
