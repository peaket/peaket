// 관리 계정 TOTP와 로그인 2단계(docs/features/identity.md §6 '관리 계정 TOTP와 로그인 2단계의 첫 구현', BUILD_ORDER BOT-120).
// 시험: I-T10(TOTP 없이 세션 없음), I-T41(시드 암호문 계정 결속), RFC 6238 시험 값, 재사용 막기, 복구 코드, 관리 세션 2개 제한, 쿠키.
import { createHash } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { describe, expect, test } from 'vitest';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { LocalTotpSeedCipher } from '../src/modules/admin/adapters/local-totp-seed-cipher.js';
import { JoseAdminTokenSigner } from '../src/modules/admin/adapters/jose-admin-token-signer.js';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { MemoryLoginCounters } from '../src/modules/admin/adapters/memory-login-counters.js';
import { Pbkdf2AdminPasswords, RECOVERY_CODE_ITERATIONS } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { LoginPasswordStep } from '../src/modules/admin/application/login-password-step.js';
import { LoginSecondStep, type SecondStepOutcome } from '../src/modules/admin/application/login-second-step.js';
import { RecordAdminLoginSuccess } from '../src/modules/admin/application/record-login-success.js';
import { BeginTotpEnrollment, ConfirmTotpEnrollment } from '../src/modules/admin/application/totp-enrollment.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { TotpKeyUnavailable } from '../src/modules/admin/domain/ports.js';
import { base32Decode, totpAt } from '../src/modules/admin/domain/totp.js';
import { TokenKeyRing } from '../src/modules/session/index.js';
import { fanKey } from './support.js';

const M = 60_000;
const PARTNER = '0190f3a1-7c2e-7a00-8000-0000000004a1';
const OTHER = '0190f3a1-7c2e-7a00-8000-0000000004a2';
const PW = '봄비내리는월요일아침의커피한잔';
const cfg = DEFAULT_ADMIN_AUTH_CONFIG;

describe('TOTP 계산(RFC 6238)', () => {
  test('RFC6238부록B의SHA1시험값과같다', () => {
    const seed = Buffer.from('12345678901234567890', 'ascii');
    expect(totpAt(seed, Math.floor(59 / 30), 8)).toBe('94287082');
    expect(totpAt(seed, Math.floor(1111111109 / 30), 8)).toBe('07081804');
    expect(totpAt(seed, Math.floor(1234567890 / 30), 8)).toBe('89005924');
    expect(totpAt(seed, Math.floor(2000000000 / 30), 8)).toBe('69279037');
    expect(totpAt(seed, Math.floor(59 / 30))).toBe('287082');
  });
});

async function harness() {
  const clock = fakeClock({ now: Date.parse('2026-11-05T04:00:00Z') });
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
  const ring = await TokenKeyRing.fromEnv({ PEAKET_ENV: 'ci', PEAKET_FAN_TOKEN_KEY: JSON.stringify(fan.privateJwk), PEAKET_ADMIN_TOKEN_KEY: JSON.stringify({ ...admin.privateJwk, kid: 'admin-1' }) });
  const signer = new JoseAdminTokenSigner(ring, 'https://identity.peaket.test');
  for (const id of [PARTNER, OTHER]) {
    store.create({ id, role: 'partner_admin', email: id === PARTNER ? 'minji.kim@haeoreum.example' : 'other@haeoreum.example', status: 'ACTIVE', promoterId: '0190f3a1-7c2e-7a00-8000-000000000001', now: clock.now() });
    await store.setPassword({ id, phc: await passwords.hash(id, PW), breachCheckedAt: clock.now(), now: clock.now() });
  }
  const human = { verify: async (t: string) => (t === 'ok' ? ('OK' as const) : ('FAILED' as const)) };
  const step1 = new LoginPasswordStep(store, counters, passwords, { isBreached: async () => false }, human, signals, cfg, clock);
  const success = new RecordAdminLoginSuccess(store, counters, clock);
  const step2 = new LoginSecondStep(store, counters, cipher, recovery, success, signer, signals, cfg, clock);
  const begin = new BeginTotpEnrollment(store, cipher);
  const confirm = new ConfirmTotpEnrollment(store, cipher, recovery, clock);
  // 등록: 시드를 만들고 지금 코드로 확정한다
  const enroll = async (id: string) => {
    const { otpauthUri } = await begin.run({ accountId: id });
    const secret = new URL(otpauthUri).searchParams.get('secret')!;
    const seed = base32Decode(secret);
    const { recoveryCodes } = await confirm.run({ accountId: id, code: totpAt(seed, Math.floor(clock.now() / 30_000)) });
    return { seed, recoveryCodes, otpauthUri };
  };
  const code = (seed: Buffer, offsetSteps = 0) => totpAt(seed, Math.floor(clock.now() / 30_000) + offsetSteps);
  const pass1 = async (o: { ip?: string; aud?: 'partner' | 'ops'; email?: string } = {}) => {
    const r = await step1.run({ aud: o.aud ?? 'partner', email: o.email ?? 'minji.kim@haeoreum.example', password: PW, ip: o.ip ?? '203.0.113.10', deviceId: 'dev-a', humanCheckToken: 'ok' });
    if (r.kind !== 'PASSED') throw new Error(`1단계가 통과해야 한다: ${r.kind}`);
    return r.loginStep;
  };
  return { clock, store, counters, cipher, step1, step2, begin, confirm, enroll, code, pass1, alerts, ring, recovery, success, signer, signals };
}

describe('TOTP 등록과 시드 결속(I-T41)', () => {
  test('등록은otpauth주소를주고_맞는코드로확정하면복구코드10개를한번만주며해시만둔다', async () => {
    const t = await harness();
    const { otpauthUri, recoveryCodes } = await t.enroll(PARTNER);
    const u = new URL(otpauthUri);
    expect(u.protocol).toBe('otpauth:');
    expect(u.searchParams.get('issuer')).toBe('PEAKET');
    expect(u.searchParams.get('digits')).toBe('6');
    expect(u.searchParams.get('period')).toBe('30');
    expect(recoveryCodes).toHaveLength(10);
    for (const c of recoveryCodes) expect(c).toMatch(/^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){3}$/);
    const rows = t.store.recoveryCodes(PARTNER);
    expect(rows).toHaveLength(10);
    expect(JSON.stringify(rows)).not.toContain(recoveryCodes[0]!.replace(/-/g, ''));
    expect(t.store.peek(PARTNER)!.totpPendingEnc).toBeNull();
    expect(t.store.peek(PARTNER)!.totpSeedEnc).not.toBeNull();
  });

  test('등록확인의코드가틀리면확정하지않는다', async () => {
    const t = await harness();
    await t.begin.run({ accountId: PARTNER });
    await expect(t.confirm.run({ accountId: PARTNER, code: '000000' })).rejects.toMatchObject({ code: 'CODE_INVALID' });
    expect(t.store.peek(PARTNER)!.totpSeedEnc).toBeNull();
  });

  test('I-T41_한계정의TOTP시드암호문을다른계정행으로옮기면풀리지않고_로그인은거부되며보안경보가남는다 [ASVS v5.0.0-11.4.2]', async () => {
    const t = await harness();
    const a = await t.enroll(PARTNER);
    await t.enroll(OTHER);
    // A의 암호문을 B 행으로 옮긴다
    t.store.setTotpSeedEnc(OTHER, t.store.peek(PARTNER)!.totpSeedEnc!);
    await expect(t.cipher.decrypt(OTHER, t.store.peek(OTHER)!.totpSeedEnc!)).rejects.toThrow();
    const ls = await t.pass1({ email: 'other@haeoreum.example' });
    const r = await t.step2.run({ aud: 'partner', loginStep: ls, code: t.code(a.seed), ip: '203.0.113.10', deviceId: 'dev-a' });
    expect(r.kind).not.toBe('DONE');
    expect(t.alerts).toContain('totp_seed_unreadable');
    expect(t.store.sessions(OTHER)).toHaveLength(0);
    expect(t.store.peek(OTHER)).toMatchObject({ failedAttempts: 0, passwordFailureTotal: 0 });
  });
});

describe('로그인 2단계(I-T10)', () => {
  test('I-T10_비밀번호가맞아도TOTP를거치지않으면세션이없고_맞는코드면세션·토큰이생기며_같은loginStep은다시못쓴다 [ASVS v5.0.0-6.3.3]', async () => {
    const t = await harness();
    const { seed } = await t.enroll(PARTNER);
    // 등록 확인에 쓴 시간 칸의 코드는 다시 받지 않으므로 다음 칸으로
    t.clock.advance(30_000);
    const ls = await t.pass1();
    expect(t.store.sessions(PARTNER)).toHaveLength(0);
    const r = await t.step2.run({ aud: 'partner', loginStep: ls, code: t.code(seed), ip: '203.0.113.10', deviceId: 'dev-a' });
    expect(r.kind).toBe('DONE');
    if (r.kind !== 'DONE') throw new Error('통과해야 한다');
    const [s] = t.store.sessions(PARTNER);
    expect(s).toMatchObject({ aud: 'partner', absoluteExpiresAt: t.clock.now() + 24 * 60 * M, idleExpiresAt: t.clock.now() + 60 * M, terminatedAt: null });
    expect(s!.refreshHash).toBe(createHash('sha256').update(r.refreshToken).digest('hex'));
    const claims = decodeJwt(r.accessToken);
    expect(decodeProtectedHeader(r.accessToken)).toMatchObject({ alg: 'ES256', typ: 'at+jwt', kid: 'admin-1' });
    expect(claims).toMatchObject({ aud: 'partner', sub: PARTNER, sid: s!.id, iss: 'https://identity.peaket.test' });
    expect(claims.exp! - claims.iat!).toBe(15 * 60);
    expect(claims).not.toHaveProperty('role');
    // 같은 loginStep은 다시 못 쓴다
    expect(await t.step2.run({ aud: 'partner', loginStep: ls, code: t.code(seed, 1), ip: '203.0.113.10', deviceId: 'dev-a' })).toEqual({ kind: 'STEP_INVALID' });
  });

  test('loginStep이지났거나다른콘솔이면STEP_INVALID이고세지않는다', async () => {
    const t = await harness();
    const { seed } = await t.enroll(PARTNER);
    const ls = await t.pass1();
    expect(await t.step2.run({ aud: 'ops', loginStep: ls, code: t.code(seed), ip: '203.0.113.10', deviceId: 'dev-a' })).toEqual({ kind: 'STEP_INVALID' });
    t.clock.advance(5 * M + 1);
    expect(await t.step2.run({ aud: 'partner', loginStep: ls, code: t.code(seed), ip: '203.0.113.10', deviceId: 'dev-a' })).toEqual({ kind: 'STEP_INVALID' });
    expect(await t.step2.run({ aud: 'partner', loginStep: 'A'.repeat(43), code: '123456', ip: '203.0.113.10', deviceId: 'dev-a' })).toEqual({ kind: 'STEP_INVALID' });
    expect(t.store.peek(PARTNER)!.failedAttempts).toBe(0);
  });

  test('코드가틀리면계정실패수·묶음실패수·2단계실패수에세고비밀번호누계에는세지않으며_5번째면보호잠금이다(BOT-121)', async () => {
    const t = await harness();
    const { seed } = await t.enroll(PARTNER);
    const outs: SecondStepOutcome[] = [];
    for (let i = 0; i < 5; i++) {
      const ls = await t.pass1();
      outs.push(await t.step2.run({ aud: 'partner', loginStep: ls, code: '000000' === t.code(seed) ? '111111' : '000000', ip: '203.0.113.10', deviceId: 'dev-a' }));
      if (i === 2) t.clock.advance(1_000);
    }
    expect(outs[0]).toEqual({ kind: 'CODE_INVALID', remainingAttempts: 4 });
    expect(outs[4]).toEqual({ kind: 'LOCKED', lock: 'PROTECT' });
    expect(t.store.peek(PARTNER)).toMatchObject({ passwordFailureTotal: 0, secondFactorFailures: 5, lockKind: 'PROTECT' });
  });

  test('같은시간칸의코드는한번만받고_지금칸만받는다(앞칸·뒤칸은받지않는다) [ASVS v5.0.0-6.5.1] [ASVS v5.0.0-6.5.5]', async () => {
    const t = await harness();
    const { seed } = await t.enroll(PARTNER);
    t.clock.advance(30_000);
    const c = t.code(seed);
    expect((await t.step2.run({ aud: 'partner', loginStep: await t.pass1(), code: c, ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('DONE');
    expect((await t.step2.run({ aud: 'partner', loginStep: await t.pass1(), code: c, ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('CODE_INVALID');
    t.clock.advance(90_000);
    // 코드 하나는 그 30초 칸에서만 맞는다([ASVS v5.0.0-6.5.5] '최대 30초', 재리뷰 2026-11-05)
    expect((await t.step2.run({ aud: 'partner', loginStep: await t.pass1(), code: t.code(seed, 1), ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('CODE_INVALID');
    expect((await t.step2.run({ aud: 'partner', loginStep: await t.pass1(), code: t.code(seed, -1), ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('CODE_INVALID');
    // 인증 앱 화면대로 띄어 쓴 코드도 받는다
    const spaced = t.code(seed).replace(/^(\d{3})(\d{3})$/, '$1 $2');
    expect((await t.step2.run({ aud: 'partner', loginStep: await t.pass1(), code: spaced, ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('DONE');
  });

  test('복구코드는한번만쓰이고_쓰면그행을지운다', async () => {
    const t = await harness();
    const { recoveryCodes } = await t.enroll(PARTNER);
    const rc = recoveryCodes[3]!;
    expect((await t.step2.run({ aud: 'partner', loginStep: await t.pass1(), code: rc.toLowerCase(), ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('DONE');
    expect(t.store.recoveryCodes(PARTNER)).toHaveLength(9);
    expect((await t.step2.run({ aud: 'partner', loginStep: await t.pass1(), code: rc, ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('CODE_INVALID');
  });

  test('1단계뒤다른출발지가계정을잠그면2단계도423이다', async () => {
    const t = await harness();
    const { seed } = await t.enroll(PARTNER);
    const ls = await t.pass1();
    for (let i = 0; i < 5; i++) await t.step1.run({ aud: 'partner', email: 'minji.kim@haeoreum.example', password: `x${i}`, ip: '198.51.100.9', deviceId: '', humanCheckToken: 'ok' });
    expect(await t.step2.run({ aud: 'partner', loginStep: ls, code: t.code(seed), ip: '203.0.113.10', deviceId: 'dev-a' })).toMatchObject({ kind: 'LOCKED', lock: 'TIMED' });
  });

  test('2단계까지통과하면셈이0으로돌아가고_세번째세션은가장오래쓰지않은세션을DEVICE_LIMIT로끝내며알림을적는다', async () => {
    const t = await harness();
    const { seed } = await t.enroll(PARTNER);
    await t.step1.run({ aud: 'partner', email: 'minji.kim@haeoreum.example', password: 'wrong', ip: '203.0.113.10', deviceId: 'dev-a' });
    expect(t.store.peek(PARTNER)!.passwordFailureTotal).toBe(1);
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      t.clock.advance(31_000);
      const r = await t.step2.run({ aud: 'partner', loginStep: await t.pass1(), code: t.code(seed), ip: '203.0.113.10', deviceId: 'dev-a' });
      if (r.kind !== 'DONE') throw new Error(r.kind);
      ids.push(r.sessionId);
      if (i === 0) expect(t.store.peek(PARTNER)).toMatchObject({ passwordFailureTotal: 0, failedAttempts: 0 });
    }
    const live = t.store.sessions(PARTNER).filter((s) => s.terminatedAt === null);
    expect(live.map((s) => s.id).sort()).toEqual([ids[1], ids[2]].sort());
    expect(t.store.sessions(PARTNER).find((s) => s.id === ids[0])).toMatchObject({ terminationReason: 'DEVICE_LIMIT' });
    expect(t.store.terminatedEvents()).toEqual([{ accountId: PARTNER, sessionId: ids[0], reason: 'DEVICE_LIMIT' }]);
    expect(t.store.notices(PARTNER)).toContain('SESSION_LIMIT');
  });

  test('코드를확인한뒤그사이같은단계를다른요청이썼으면_복구코드를쓰지않고STEP_INVALID다(단계·코드·세션은한트랜잭션, BOT-120이넘긴것)', async () => {
    const t = await harness();
    const { recoveryCodes } = await t.enroll(PARTNER);
    const ls = await t.pass1();
    // 서명(코드 확인과 쓰기 사이)하는 동안 같은 단계를 다른 요청이 쓴다
    const racing = new LoginSecondStep(t.store, t.counters, t.cipher, t.recovery, t.success, {
      access: async (...x: Parameters<typeof t.signer.access>) => {
        for (const st of t.store.loginSteps(PARTNER)) await t.store.useLoginStep(st.id, t.clock.now());
        return t.signer.access(...x);
      },
    }, t.signals, cfg, t.clock);
    expect((await racing.run({ aud: 'partner', loginStep: ls, code: recoveryCodes[0]!, ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('STEP_INVALID');
    expect(t.store.recoveryCodes(PARTNER)).toHaveLength(10);
    expect(t.store.sessions(PARTNER)).toHaveLength(0);
  });

  test('코드를확인한뒤그사이계정이활성이아니게되면_코드도단계도쓰지않고STEP_INVALID다(재검토 2026-11-05)', async () => {
    const t = await harness();
    const { recoveryCodes } = await t.enroll(PARTNER);
    const ls = await t.pass1();
    const racing = new LoginSecondStep(t.store, t.counters, t.cipher, t.recovery, t.success, {
      access: async (...x: Parameters<typeof t.signer.access>) => {
        t.store.remove(PARTNER);
        return t.signer.access(...x);
      },
    }, t.signals, cfg, t.clock);
    expect((await racing.run({ aud: 'partner', loginStep: ls, code: recoveryCodes[0]!, ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('STEP_INVALID');
    expect(t.store.recoveryCodes(PARTNER)).toHaveLength(10);
    expect(t.store.loginSteps(PARTNER).every((x) => x.usedAt === null)).toBe(true);
  });

  // 새 맥락 리뷰(2026-11-05) 재현: 토큰 서명을 맨 끝에 하면 키가 없을 때 되돌릴 수 없는 일(단계·시간 칸 소비, 셈 0, 세션·종료 사건)이 먼저 일어났다
  test('관리토큰키가없으면503이고_로그인단계·시간칸·셈·세션을그대로두어같은loginStep으로다시할수있다', async () => {
    const t = await harness();
    const { seed } = await t.enroll(PARTNER);
    t.clock.advance(30_000);
    await t.step1.run({ aud: 'partner', email: 'minji.kim@haeoreum.example', password: 'wrong', ip: '203.0.113.10', deviceId: 'dev-a' });
    const ls = await t.pass1();
    const broken = new LoginSecondStep(t.store, t.counters, t.cipher, t.recovery, t.success, { access: async () => { throw new TotpKeyUnavailable('test'); } }, t.signals, cfg, t.clock);
    await expect(broken.run({ aud: 'partner', loginStep: ls, code: t.code(seed), ip: '203.0.113.10', deviceId: 'dev-a' })).rejects.toBeInstanceOf(TotpKeyUnavailable);
    expect(t.store.sessions(PARTNER)).toHaveLength(0);
    expect(t.store.peek(PARTNER)).toMatchObject({ passwordFailureTotal: 1, totpLastStep: Math.floor((t.clock.now() - 30_000) / 30_000) });
    expect(t.store.loginSteps(PARTNER).every((x) => x.usedAt === null)).toBe(true);
    expect((await t.step2.run({ aud: 'partner', loginStep: ls, code: t.code(seed), ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('DONE');
  });

  test('TOTP를등록하지않은계정은2단계를통과하지못한다', async () => {
    const t = await harness();
    expect((await t.step2.run({ aud: 'partner', loginStep: await t.pass1(), code: '123456', ip: '203.0.113.10', deviceId: 'dev-a' })).kind).toBe('CODE_INVALID');
    expect(t.store.sessions(PARTNER)).toHaveLength(0);
  });
});
