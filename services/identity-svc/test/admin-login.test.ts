// 관리 계정 로그인 1단계와 실패 제한(docs/features/identity.md §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', docs/security/auth-controls.md §2·§3, BUILD_ORDER BOT-111).
// 시험: I-T11 ①(해제 링크 메일 뺌)④⑥, AC-T1·AC-T2·AC-T3·AC-T7 ③④·AC-T9. 메모리 저장소·메모리 셈·사람 확인 대역·로컬 페퍼로 본다.
import { createHash } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { LocalPepper } from '../src/modules/admin/adapters/local-pepper.js';
import { MemoryAdminAccountStore } from '../src/modules/admin/adapters/memory-admin-account-store.js';
import { MemoryLoginCounters } from '../src/modules/admin/adapters/memory-login-counters.js';
import { Pbkdf2AdminPasswords } from '../src/modules/admin/adapters/pbkdf2-admin-passwords.js';
import { LoginPasswordStep, type LoginStepOutcome, sourceAddressOf } from '../src/modules/admin/application/login-password-step.js';
import { RecordAdminLoginSuccess } from '../src/modules/admin/application/record-login-success.js';
import { DEFAULT_ADMIN_AUTH_CONFIG } from '../src/modules/admin/domain/auth-config.js';
import { type AdminLoginSignals, type BreachList, BreachListUnavailable, type HumanCheck, LoginCountersUnavailable } from '../src/modules/admin/domain/ports.js';

const M = 60_000;
const H = 60 * M;
const D = 24 * H;
const PARTNER = '0190f3a1-7c2e-7a00-8000-0000000001a1';
const OPS = '0190f3a1-7c2e-7a00-8000-0000000001a2';
const PW = '봄비내리는월요일아침의커피한잔';
const cfg = DEFAULT_ADMIN_AUTH_CONFIG;

/** 사람 확인 대역: 'ok'만 통과, down이면 닿지 못함 */
function fakeHuman(): HumanCheck & { down: boolean; seen: string[] } {
  const h = {
    down: false,
    seen: [] as string[],
    async verify(token: string) {
      h.seen.push(token);
      if (h.down) return 'UNAVAILABLE' as const;
      return token === 'ok' ? ('OK' as const) : ('FAILED' as const);
    },
  };
  return h;
}
function fakeBreaches(): BreachList & { breached: boolean; down: boolean; calls: number } {
  const b = {
    breached: false,
    down: false,
    calls: 0,
    async isBreached() {
      b.calls++;
      if (b.down) throw new BreachListUnavailable('test');
      return b.breached;
    },
  };
  return b;
}
function recordingLoginSignals(): AdminLoginSignals & { failures: string[]; alerts: string[] } {
  const s = { failures: [] as string[], alerts: [] as string[], failure: (aud: string, reason: string) => s.failures.push(`${aud}:${reason}`), alert: (kind: string) => s.alerts.push(kind) };
  return s;
}

async function harness(o: { writeVersion?: number } = {}) {
  const clock = fakeClock({ now: Date.parse('2026-11-05T01:00:00Z') });
  const store = new MemoryAdminAccountStore();
  const counters = new MemoryLoginCounters();
  const human = fakeHuman();
  const breaches = fakeBreaches();
  const signals = recordingLoginSignals();
  const v1 = new Pbkdf2AdminPasswords(new LocalPepper(new Map([[1, Buffer.alloc(32, 8)]]), 1), { iterations: 1_000 });
  const passwords = o.writeVersion === 2 ? new Pbkdf2AdminPasswords(new LocalPepper(new Map([[1, Buffer.alloc(32, 8)], [2, Buffer.alloc(32, 9)]]), 2), { iterations: 1_000 }) : v1;
  for (const [id, role, email] of [
    [PARTNER, 'partner_admin', 'minji.kim@haeoreum.example'],
    [OPS, 'operator', 'ops.lee@peaket.example'],
  ] as const) {
    store.create({ id, role, email, status: 'ACTIVE', promoterId: role === 'partner_admin' ? '0190f3a1-7c2e-7a00-8000-000000000001' : null, now: clock.now() });
    await store.setPassword({ id, phc: await v1.hash(id, PW), breachCheckedAt: clock.now(), now: clock.now() });
  }
  const step = new LoginPasswordStep(store, counters, passwords, breaches, human, signals, cfg, clock);
  const success = new RecordAdminLoginSuccess(store, counters, clock);
  let n = 0;
  const attempt = (i: { aud?: 'partner' | 'ops'; email?: string; password?: string; ip?: string; deviceId?: string; token?: string } = {}): Promise<LoginStepOutcome> =>
    step.run({ aud: i.aud ?? 'partner', email: i.email ?? 'minji.kim@haeoreum.example', password: i.password ?? `틀린비밀번호${++n}`, ip: i.ip ?? '203.0.113.10', deviceId: i.deviceId ?? 'dev-a', humanCheckToken: i.token });
  return { clock, store, counters, human, breaches, signals, step, success, attempt };
}

describe('잠금 규칙(auth-controls §3, I-T11)', () => {
  test('I-T11①_한출발지에서5회틀리면계정과묶음이15분잠기고_3회뒤부터사람확인이며_잠긴동안은비밀번호를보지않고세지않는다 [ASVS v5.0.0-6.3.1]', async () => {
    const t = await harness();
    expect(await t.attempt()).toMatchObject({ kind: 'FAILED', remainingAttempts: 4, humanCheckRequired: false });
    expect(await t.attempt()).toMatchObject({ kind: 'FAILED', remainingAttempts: 3, humanCheckRequired: false });
    expect(await t.attempt()).toMatchObject({ kind: 'FAILED', remainingAttempts: 2, humanCheckRequired: true });
    // 사람 확인 없이 보내면 세지 않는다
    expect(await t.attempt()).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
    expect(await t.attempt({ token: 'bad' })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
    expect(t.store.peek(PARTNER)!.failedAttempts).toBe(3);
    expect(await t.attempt({ token: 'ok' })).toMatchObject({ kind: 'FAILED', remainingAttempts: 1, humanCheckRequired: true });
    expect(await t.attempt({ token: 'ok' })).toEqual({ kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: 15 * 60 });
    const row = t.store.peek(PARTNER)!;
    expect(row).toMatchObject({ lockKind: 'TIMED', lockedUntil: t.clock.now() + 15 * M, failedAttempts: 0, passwordFailureTotal: 5, lockReason: 'FAILED_ATTEMPTS' });
    expect(t.store.notices(PARTNER)).toEqual(['TIMED_LOCK']);
    // 잠긴 동안은 맞는 비밀번호도 거절하고 세지 않는다
    t.clock.advance(5 * M);
    expect(await t.attempt({ password: PW, token: 'ok' })).toEqual({ kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: 10 * 60 });
    expect(t.store.peek(PARTNER)!.passwordFailureTotal).toBe(5);
    // 15분 뒤에는 풀린다(24시간 안에 잠긴 적이 있어 사람 확인은 필요하다)
    t.clock.advance(10 * M);
    expect(await t.attempt({ password: PW })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
    expect(await t.attempt({ password: PW, token: 'ok' })).toMatchObject({ kind: 'PASSED' });
    expect(t.signals.failures.filter((f) => f === 'partner:password')).toHaveLength(5);
  });

  test('I-T11④_24시간안에다른출발지에서다시5회틀리면1시간잠금이다', async () => {
    const t = await harness();
    for (let i = 0; i < 5; i++) await t.attempt({ token: 'ok' });
    t.clock.advance(16 * M);
    let last: LoginStepOutcome | undefined;
    for (let i = 0; i < 5; i++) last = await t.attempt({ ip: '198.51.100.7', deviceId: 'dev-b', token: 'ok' });
    expect(last).toEqual({ kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: 60 * 60 });
    expect(t.store.peek(PARTNER)!.recentLockAt).toHaveLength(2);
    // 반복 잠금은 '풀린 뒤 24시간 안'으로 센다(§3.2): 잠금을 건 때부터 24시간이 지났어도 풀린 때부터는 안이면 1시간(재리뷰 2026-11-05)
    const u = await harness();
    for (let i = 0; i < 5; i++) await u.attempt({ token: 'ok' });
    u.clock.advance(D + 5 * M);
    for (let i = 0; i < 5; i++) last = await u.attempt({ ip: '198.51.100.8', token: 'ok' });
    expect(last).toEqual({ kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: 60 * 60 });
    // 풀린 때부터 24시간이 지난 뒤의 잠금은 다시 15분이다
    t.clock.advance(D + H);
    for (let i = 0; i < 5; i++) last = await t.attempt({ ip: '192.0.2.9', token: 'ok' });
    expect(last).toEqual({ kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: 15 * 60 });
  });

  test('묶음잠금은그출발지만막고_다른출발지는계정잠금이풀리면들어온다', async () => {
    const t = await harness();
    for (let i = 0; i < 5; i++) await t.attempt({ token: 'ok' });
    t.clock.advance(15 * M);
    // 같은 길이로 걸린 묶음 잠금도 함께 풀린다. 묶음 실패 수는 잠금을 걸 때 0으로 돌아간다
    expect(await t.attempt({ password: PW, token: 'ok' })).toMatchObject({ kind: 'PASSED' });
    // 계정이 잠기기 전에 한 출발지에서만 5번(다른 출발지의 성공이 계정 수를 0으로 돌린 경우): 그 묶음만 잠긴다
    const u = await harness();
    for (let i = 0; i < 4; i++) await u.attempt({ token: 'ok' });
    await u.success.run({ accountId: PARTNER, pair: { ip: '198.51.100.7', deviceId: 'dev-b' } });
    expect(u.store.peek(PARTNER)!.failedAttempts).toBe(0);
    expect(await u.attempt({ token: 'ok' })).toEqual({ kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: 15 * 60 });
    expect(u.store.peek(PARTNER)!.lockKind).toBe('NONE');
    expect(await u.attempt({ password: PW, token: 'ok' })).toEqual({ kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: 15 * 60 });
    expect(await u.attempt({ password: PW, ip: '198.51.100.7', deviceId: 'dev-b', token: 'ok' })).toMatchObject({ kind: 'PASSED' });
  });

  test('I-T11⑥_1시간에서로다른IP다섯곳에서틀리면여러출발지경보와계정주인알림이고_그계정은1시간사람확인이며_보호잠금은걸지않는다 [ASVS v5.0.0-6.3.1]', async () => {
    const t = await harness();
    for (let i = 1; i <= 5; i++) await t.attempt({ ip: `203.0.113.${i}`, token: i >= 4 ? 'ok' : undefined });
    expect(t.store.notices(PARTNER)).toContain('MULTI_SOURCE_ALERT');
    expect(t.signals.alerts).toContain('multi_source');
    expect(t.store.peek(PARTNER)!.lockKind).not.toBe('PROTECT');
    expect((await t.counters.peek({ subject: PARTNER, pair: 'x', ipHash: 'y', now: t.clock.now() })).accountAlert).toBe(true);
    t.clock.advance(H + M);
    expect((await t.counters.peek({ subject: PARTNER, pair: 'x', ipHash: 'y', now: t.clock.now() })).accountAlert).toBe(false);
  });
});

describe('크리덴셜 스터핑(auth-controls §2, AC-T1·AC-T2·AC-T9)', () => {
  test('AC-T1_한IP에서서로다른이메일5개(없는이메일2개)로한번씩틀리면여섯번째부터사람확인이고_다섯계정모두잠기지않으며_1시간뒤풀린다 [ASVS v5.0.0-6.1.1]', async () => {
    const t = await harness();
    const emails = ['minji.kim@haeoreum.example', 'ops.lee@peaket.example', 'ghost1@haeoreum.example', 'ghost2@haeoreum.example'];
    await t.attempt({ email: emails[0] });
    await t.attempt({ aud: 'ops', email: emails[1] });
    await t.attempt({ email: emails[2] });
    await t.attempt({ email: emails[3] });
    t.store.create({ id: '0190f3a1-7c2e-7a00-8000-0000000001a3', role: 'partner_member', email: 'fifth@haeoreum.example', status: 'ACTIVE', promoterId: '0190f3a1-7c2e-7a00-8000-000000000001', now: t.clock.now() });
    await t.attempt({ email: 'fifth@haeoreum.example' });
    expect(await t.attempt({ email: 'sixth@haeoreum.example' })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
    expect(t.signals.alerts).toContain('source');
    expect(t.store.peek(PARTNER)!.lockKind).toBe('NONE');
    expect(t.store.peek(OPS)!.lockKind).toBe('NONE');
    // 다른 IP는 영향이 없다
    expect(await t.attempt({ email: 'sixth@haeoreum.example', ip: '198.51.100.20' })).toMatchObject({ kind: 'FAILED' });
    t.clock.advance(H + M);
    expect(await t.attempt({ email: 'seventh@haeoreum.example' })).toMatchObject({ kind: 'FAILED', humanCheckRequired: false });
  });

  test('AC-T2_없는이메일과있는계정은5번까지응답이같고_없는이메일에는알림을적지않는다', async () => {
    const t = await harness();
    const real: LoginStepOutcome[] = [];
    const ghost: LoginStepOutcome[] = [];
    for (let i = 0; i < 5; i++) {
      real.push(await t.attempt({ ip: '203.0.113.50', token: i >= 3 ? 'ok' : undefined }));
      ghost.push(await t.attempt({ email: 'nobody@haeoreum.example', ip: '203.0.113.51', token: i >= 3 ? 'ok' : undefined }));
    }
    expect(ghost).toEqual(real);
    expect(real.at(-1)).toEqual({ kind: 'LOCKED', lock: 'TIMED', retryAfterSeconds: 15 * 60 });
    // 사람 확인 요구도 같다
    expect(await t.attempt({ ip: '203.0.113.50' })).toEqual(await t.attempt({ email: 'nobody@haeoreum.example', ip: '203.0.113.51' }));
    expect(t.store.allNotices().every((n) => n.accountId === PARTNER)).toBe(true);
    // 다른 콘솔 역할의 계정·초대 중 계정도 없는 계정과 같고, 진짜 계정 수에 세지 않는다
    expect(await t.attempt({ aud: 'ops', email: 'minji.kim@haeoreum.example', password: PW, ip: '198.51.100.30' })).toMatchObject({ kind: 'FAILED', remainingAttempts: 4 });
    t.store.create({ id: '0190f3a1-7c2e-7a00-8000-0000000001a9', role: 'operator', email: 'invited@peaket.example', status: 'INVITED', now: t.clock.now() });
    expect(await t.attempt({ aud: 'ops', email: 'invited@peaket.example', ip: '198.51.100.31' })).toMatchObject({ kind: 'FAILED', remainingAttempts: 4 });
    expect(t.store.peek('0190f3a1-7c2e-7a00-8000-0000000001a9')!.failedAttempts).toBe(0);
  });

  // 새 맥락 리뷰(2026-11-05) 재현: 콘솔을 건너거나 동시에 보내거나 기다려도 있는 계정과 없는 계정이 갈리지 않는다(§2.2)
  test('AC-T2_콘솔을건너도있는계정과없는계정의응답이같다(가짜상태는콘솔마다따로)', async () => {
    const t = await harness();
    const real = [await t.attempt({ ip: '203.0.113.90' }), await t.attempt({ aud: 'ops', ip: '203.0.113.90' })];
    const ghost = [await t.attempt({ email: 'nobody2@haeoreum.example', ip: '203.0.113.91' }), await t.attempt({ aud: 'ops', email: 'nobody2@haeoreum.example', ip: '203.0.113.91' })];
    expect(ghost).toEqual(real);
    for (let i = 0; i < 4; i++) {
      await t.attempt({ ip: '203.0.113.90', token: 'ok' });
      await t.attempt({ email: 'nobody2@haeoreum.example', ip: '203.0.113.91', token: 'ok' });
    }
    expect(await t.attempt({ aud: 'ops', email: 'nobody2@haeoreum.example', ip: '203.0.113.91' })).toEqual(await t.attempt({ aud: 'ops', ip: '203.0.113.90' }));
  });

  test('AC-T2_한대상에동시에온시도는하나만처리하고나머지는BUSY로세지않으며_있는계정과없는계정이같다_잠긴뒤동시의맞는비밀번호도통과하지않는다', async () => {
    const t = await harness();
    const real = await Promise.all(Array.from({ length: 6 }, (_, i) => t.attempt({ ip: '203.0.113.95', deviceId: `d${i}` })));
    const ghost = await Promise.all(Array.from({ length: 6 }, (_, i) => t.attempt({ email: 'nobody3@haeoreum.example', ip: '203.0.113.96', deviceId: `d${i}` })));
    const shape = (xs: LoginStepOutcome[]) => xs.map((x) => x.kind).sort();
    expect(shape(ghost)).toEqual(shape(real));
    expect(real.filter((x) => x.kind === 'BUSY')).toHaveLength(5);
    expect(t.store.peek(PARTNER)!.failedAttempts).toBe(1);
    // 잠근 뒤 맞는 비밀번호를 동시에 넣어도 통과하지 않는다
    for (let i = 0; i < 4; i++) await t.attempt({ ip: '203.0.113.95', token: 'ok' });
    expect(t.store.peek(PARTNER)!.lockKind).toBe('TIMED');
    const burst = await Promise.all(Array.from({ length: 10 }, (_, i) => t.attempt({ password: PW, ip: '198.51.100.99', deviceId: `z${i}`, token: 'ok' })));
    expect(burst.some((x) => x.kind === 'PASSED')).toBe(false);
    expect(t.store.loginSteps(PARTNER)).toHaveLength(0);
  });

  test('AC-T2_25시간뒤에도없는이메일의셈이남아있는계정과같다', async () => {
    const t = await harness();
    for (let i = 0; i < 2; i++) {
      await t.attempt({ ip: '203.0.113.97' });
      await t.attempt({ email: 'nobody4@haeoreum.example', ip: '203.0.113.98' });
    }
    t.clock.advance(25 * H + M);
    expect(await t.attempt({ email: 'nobody4@haeoreum.example', ip: '203.0.113.98' })).toEqual(await t.attempt({ ip: '203.0.113.97' }));
  });

  test('AC-T2_있는계정과없는이메일의응답시간중앙값차이를기록한다(페퍼확인몫은남는차이)', async () => {
    const t = await harness();
    const time = async (email: string, ip: string) => {
      const s = performance.now();
      await t.attempt({ email, ip });
      return performance.now() - s;
    };
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const real: number[] = [];
    const ghost: number[] = [];
    for (let i = 0; i < 2; i++) {
      real.push(await time('minji.kim@haeoreum.example', `203.0.113.${110 + i}`));
      ghost.push(await time('nobody5@haeoreum.example', `203.0.113.${120 + i}`));
    }
    const diff = median(real) - median(ghost);
    console.info(`AC-T2 응답 시간 중앙값 차이(있는 계정 - 없는 이메일, 로컬 페퍼, PBKDF2 1,000회): ${diff.toFixed(2)}ms`);
    expect(Number.isFinite(diff)).toBe(true);
  });

  // 재리뷰(2026-11-05) 재현: 사람 확인 검증을 임대 밖에서 해야, 틀린 토큰을 이어 보내 임대를 쥐고 주인을 막지 못한다
  test('사람확인검증은임대밖에서하므로_틀린토큰검증이늦어도주인의로그인은BUSY가아니다', async () => {
    const t = await harness();
    for (let i = 0; i < 3; i++) await t.attempt();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const human = t.human.verify.bind(t.human);
    t.human.verify = async (token: string, ctx) => {
      if (token === 'slow-bad') await gate;
      return human(token, ctx);
    };
    const attacker = t.attempt({ token: 'slow-bad', ip: '198.51.100.150' });
    const owner = await t.attempt({ password: PW, token: 'ok', ip: '203.0.113.150' });
    expect(owner).toMatchObject({ kind: 'PASSED' });
    release();
    expect(await attacker).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
  });

  test('임대밖에서는사람확인이필요없었는데임대를쥐는사이필요해지면_검증하지않은토큰으로는비밀번호확인까지가지않고세지않는다', async () => {
    const t = await harness();
    const acquire = t.counters.acquire.bind(t.counters);
    let once = true;
    // 임대를 쥐기 직전에 다른 시도가 계정 실패 수를 3으로 올리고 끝났다
    t.counters.acquire = async (s, now, ttl) => {
      if (once) {
        once = false;
        await t.store.updateLoginState(PARTNER, now, (cur) => ({ next: { ...cur, failedAttempts: 3 }, notices: [] }));
      }
      return acquire(s, now, ttl);
    };
    expect(await t.attempt({ password: PW, token: 'garbage' })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
    expect(t.human.seen).toEqual([]);
    expect(t.store.peek(PARTNER)).toMatchObject({ failedAttempts: 3, passwordFailureTotal: 0 });
    expect(t.store.loginSteps(PARTNER)).toHaveLength(0);
  });

  test('성공처리는1단계와같은출발지주소맞추기로묶음을지운다(IPv4를적은IPv6·/64)', async () => {
    const t = await harness();
    for (let i = 0; i < 4; i++) await t.attempt({ ip: '::ffff:198.51.100.7', deviceId: 'dev-6', token: 'ok' });
    await t.success.run({ accountId: PARTNER, pair: { ip: '198.51.100.7', deviceId: 'dev-6' } });
    expect(await t.attempt({ ip: '::ffff:198.51.100.7', deviceId: 'dev-6' })).toMatchObject({ kind: 'FAILED', remainingAttempts: 4 });
    expect(sourceAddressOf('0:0:0:0:0:ffff:198.51.100.7')).toBe('198.51.100.7');
    expect(sourceAddressOf('::ffff:c633:6407')).toBe('198.51.100.7');
    expect(sourceAddressOf('2001:db8:1:2:3:4:1.2.3.4')).toBe(sourceAddressOf('2001:db8:1:2::1'));
    expect(sourceAddressOf('::1')).not.toBe(sourceAddressOf('::ffff:c633:6407'));
    expect(sourceAddressOf('not-an-ip')).toBe('not-an-ip');
  });

  test('IPv6는/64로세고_IPv4를적은IPv6주소는그IPv4와같은출발지다', async () => {
    const t = await harness();
    for (let i = 0; i < 5; i++) await t.attempt({ email: `v6-${i}@haeoreum.example`, ip: `2001:db8:1:2::${(i + 1).toString(16)}` });
    expect(await t.attempt({ email: 'v6-9@haeoreum.example', ip: '2001:db8:1:2:ffff::9' })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
    expect(await t.attempt({ email: 'v6-9@haeoreum.example', ip: '2001:db8:1:3::1' })).toMatchObject({ kind: 'FAILED' });
    for (let i = 0; i < 5; i++) await t.attempt({ email: `v4m-${i}@haeoreum.example`, ip: i % 2 ? '::ffff:198.51.100.200' : '198.51.100.200' });
    expect(await t.attempt({ email: 'v4m-9@haeoreum.example', ip: '198.51.100.200' })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
  });

  test('AC-T9_5분에관리계정로그인실패120건이면SEV3경보와1시간동안모든로그인에사람확인이고_1시간뒤풀린다', async () => {
    const t = await harness();
    for (let i = 0; i < 120; i++) {
      await t.attempt({ email: `bulk${i % 40}@haeoreum.example`, ip: `198.18.${Math.floor(i / 4)}.${i % 4}`, token: 'ok' });
      if (i % 30 === 29) t.clock.advance(M);
    }
    expect(t.signals.alerts.filter((a) => a === 'global')).toHaveLength(1);
    expect(await t.attempt({ email: 'fresh@haeoreum.example', ip: '192.0.2.200' })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
    expect(await t.attempt({ password: PW, ip: '192.0.2.201' })).toEqual({ kind: 'HUMAN_CHECK_REQUIRED' });
    t.clock.advance(H + M);
    expect(await t.attempt({ password: PW, ip: '192.0.2.201' })).toMatchObject({ kind: 'PASSED' });
  });

  test('사람확인이필요한데사람확인서비스에닿지못하면받지않고_필요없는로그인은그대로한다', async () => {
    const t = await harness();
    t.human.down = true;
    expect(await t.attempt({ password: PW })).toMatchObject({ kind: 'PASSED' });
    for (let i = 0; i < 3; i++) await t.attempt();
    expect(await t.attempt({ token: 'ok' })).toEqual({ kind: 'HUMAN_CHECK_UNAVAILABLE' });
    expect(t.store.peek(PARTNER)!.failedAttempts).toBe(3);
  });

  test('실패셈저장소에닿지못하면그시도를받지않는다', async () => {
    const t = await harness();
    t.counters.down = true;
    await expect(t.attempt()).rejects.toBeInstanceOf(LoginCountersUnavailable);
    expect(t.store.peek(PARTNER)!.failedAttempts).toBe(0);
  });
});

describe('비밀번호 연속 실패 누계(AC-T3, NIST SP 800-63B-4 §3.2.2)', () => {
  test('AC-T3_로그인성공없이100번틀리면50번째에알림·경보이고100번째에보호잠금이며_해제링크(시간잠금알림)는나가지않는다 [ASVS v5.0.0-6.1.1]', async () => {
    const t = await harness();
    let last: LoginStepOutcome | undefined;
    for (let i = 1; i <= 100; i++) {
      last = await t.attempt({ token: 'ok' });
      const notice = t.store.notices(PARTNER).filter((k) => k === 'PASSWORD_FAILURE_NOTICE').length;
      expect([i, notice]).toEqual([i, i >= 50 ? 1 : 0]);
      if (i === 50) expect(t.signals.alerts).toContain('password_failure_notice');
      // 시간 잠금(5번마다)이 풀릴 때까지 시계를 보낸다(24시간 안이면 1시간)
      if (i % 5 === 0 && i < 100) t.clock.advance(H + M);
    }
    expect(last).toEqual({ kind: 'LOCKED', lock: 'PROTECT' });
    const row = t.store.peek(PARTNER)!;
    expect(row).toMatchObject({ lockKind: 'PROTECT', lockReason: 'PASSWORD_FAILURE_TOTAL', passwordFailureTotal: 100 });
    const notices = t.store.notices(PARTNER);
    expect(notices.at(-1)).toBe('PROTECT_LOCK');
    expect(notices.filter((k) => k === 'TIMED_LOCK')).toHaveLength(19);
    expect(t.signals.alerts).toContain('protect_lock');
    // 보호 잠금은 시간이 지나도 풀리지 않는다(운영자 재초대)
    t.clock.advance(7 * D);
    expect(await t.attempt({ password: PW, token: 'ok' })).toEqual({ kind: 'LOCKED', lock: 'PROTECT' });
  });

  test('AC-T3_99번틀린뒤로그인에성공하면누계가0으로돌아가다음실패는1이다', async () => {
    const t = await harness();
    for (let i = 1; i <= 99; i++) {
      await t.attempt({ token: 'ok' });
      if (i % 5 === 0) t.clock.advance(H + M);
    }
    expect(t.store.peek(PARTNER)!.passwordFailureTotal).toBe(99);
    expect(await t.attempt({ password: PW, token: 'ok' })).toMatchObject({ kind: 'PASSED' });
    // 2단계(BOT-120)까지 통과한 로그인의 성공 처리
    await t.success.run({ accountId: PARTNER, pair: { ip: '203.0.113.10', deviceId: 'dev-a' } });
    expect(t.store.peek(PARTNER)).toMatchObject({ passwordFailureTotal: 0, failedAttempts: 0, secondFactorFailures: 0, lastLoginAt: t.clock.now() });
    await t.attempt({ token: 'ok' });
    expect(t.store.peek(PARTNER)!.passwordFailureTotal).toBe(1);
  });
});

describe('1단계 통과(로그인 단계, 다시 저장, 유출 다시 보기)', () => {
  test('맞으면로그인단계토큰을주고해시만5분짜리로저장하며_대상과출발지묶음을적는다', async () => {
    const t = await harness();
    const r = await t.attempt({ password: PW, ip: '203.0.113.77', deviceId: 'dev-z' });
    expect(r).toMatchObject({ kind: 'PASSED', expiresInSeconds: 300 });
    if (r.kind !== 'PASSED') throw new Error('통과해야 한다');
    expect(r.loginStep).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const [s] = t.store.loginSteps(PARTNER);
    expect(s).toMatchObject({ aud: 'partner', tokenHash: createHash('sha256').update(r.loginStep).digest('hex'), createdAt: t.clock.now(), expiresAt: t.clock.now() + 5 * M, usedAt: null });
    expect(s!.pairRef).toMatch(/^[0-9a-f]{32}$/);
    expect(JSON.stringify(s)).not.toContain(r.loginStep);
    // 관제 계정은 관제 경로로만
    expect(await t.attempt({ aud: 'ops', email: 'ops.lee@peaket.example', password: PW })).toMatchObject({ kind: 'PASSED' });
    expect(await t.attempt({ aud: 'partner', email: 'ops.lee@peaket.example', password: PW, ip: '198.51.100.40' })).toMatchObject({ kind: 'FAILED' });
  });

  test('페퍼판이쓰기판이아니면맞은비밀번호로새판에다시저장하고_비밀번호바꾸기필요표시는그대로다', async () => {
    const t = await harness({ writeVersion: 2 });
    t.store.setPasswordChangeRequired(PARTNER, true);
    expect(t.store.peek(PARTNER)!.passwordPhc).toMatch(/,k=1\$/);
    expect(await t.attempt({ password: PW })).toMatchObject({ kind: 'PASSED' });
    expect(t.store.peek(PARTNER)!.passwordPhc).toMatch(/,k=2\$/);
    expect(t.store.peek(PARTNER)!.passwordChangeRequired).toBe(true);
    expect(await t.attempt({ password: PW })).toMatchObject({ kind: 'PASSED' });
  });

  test('AC-T7③④_로그인때마지막유출대조가30일지났으면다시보고_닿지못하면건너뛰어다음에보며_걸리면비밀번호바꾸기필요를켠다 [ASVS v5.0.0-6.2.12]', async () => {
    const t = await harness();
    // 30일 안이면 보지 않는다
    expect(await t.attempt({ password: PW })).toMatchObject({ kind: 'PASSED' });
    expect(t.breaches.calls).toBe(0);
    t.clock.advance(31 * D);
    const before = t.store.peek(PARTNER)!.breachCheckedAt;
    t.breaches.down = true;
    expect(await t.attempt({ password: PW })).toMatchObject({ kind: 'PASSED' });
    expect(t.breaches.calls).toBe(1);
    expect(t.store.peek(PARTNER)!.breachCheckedAt).toBe(before);
    t.breaches.down = false;
    t.breaches.breached = true;
    expect(await t.attempt({ password: PW })).toMatchObject({ kind: 'PASSED' });
    expect(t.breaches.calls).toBe(2);
    expect(t.store.peek(PARTNER)).toMatchObject({ breachCheckedAt: t.clock.now(), passwordChangeRequired: true });
    // 막 본 뒤에는 다시 부르지 않는다
    expect(await t.attempt({ password: PW })).toMatchObject({ kind: 'PASSED' });
    expect(t.breaches.calls).toBe(2);
  });
});
