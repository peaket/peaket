// pid 키 전환(docs/features/identity.md §5 'pid 키 전환의 첫 구현', BUILD_ORDER BOT-025, I-T49, ADR-0050 결정 5, ADR-0127).
// 메모리 저장소로 전환 명령(시작·이어 하기·끝내기)과 토큰·GetVerificationStatus의 옛 pid를 본다. PostgreSQL은 test-int/pid-rotation.int.test.ts.
import { createHmac } from 'node:crypto';
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { GetVerificationStatus } from '../src/modules/session/application/get-verification-status.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { assertKeyVersions } from '../src/modules/verification/application/key-versions.js';
import { parsePidRotationArgs, PidRotation, PidRotationError } from '../src/modules/verification/application/pid-rotation.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import type { IdentityHashers } from '../src/modules/verification/domain/ports.js';
import { KeyServiceUnavailable } from '../src/modules/verification/domain/verification.js';
import { agencyResult, kit, newKey, noClosure, testAgency } from './support.js';

const K = (n: number) => Buffer.alloc(32, n);
const DAY = 86_400_000;

const hashers = (pidVersion: number, ci: Record<number, number> = { 1: 1 }, writeVersion?: number) =>
  new HmacIdentityHashers({
    ciKeys: new Map(Object.entries(ci).map(([v, b]) => [Number(v), K(b)])),
    ...(writeVersion ? { writeVersion } : {}),
    pidKey: K(40 + pidVersion),
    pidVersion,
  });

/** 키 호출을 센다. failAfter번째 pid 계산부터 KeyServiceUnavailable을 던진다 */
function counting(h: IdentityHashers, o: { failAfter?: number } = {}): IdentityHashers & { calls: number } {
  let pids = 0;
  const c = {
    calls: 0,
    ciAll: async (ci: string) => {
      c.calls++;
      return h.ciAll(ci);
    },
    pid: async (x: Buffer) => {
      c.calls++;
      pids++;
      if (o.failAfter !== undefined && pids > o.failAfter) throw new KeyServiceUnavailable('pid');
      return h.pid(x);
    },
    versions: () => h.versions(),
    pidVersion: () => h.pidVersion(),
  };
  return c;
}

const payload = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

async function setup() {
  const verifications = new MemoryVerificationStore();
  const sessions = new MemorySessionStore();
  const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });
  const claims = new VerificationClaims(verifications);
  const k = await kit(sessions, { claims, clock, reverifications: claims });
  const provider = testAgency(clock);
  let h: IdentityHashers = hashers(1);
  const login = (id: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: id, email: null, deviceId: null });
  const verify = async (accountId: string, person: string, purpose: 'FIRST' | 'REVERIFY' = 'FIRST', sessionId: string | null = null) => {
    const st = await new StartVerification(verifications, provider, noClosure, clock).run({ accountId, sessionId, purpose, next: '/' });
    return new ConfirmVerification(verifications, provider, h, noClosure, clock).run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person }) });
  };
  return {
    k,
    clock,
    verifications,
    login,
    verify,
    use: (x: IdentityHashers) => (h = x),
    rotation: (x: IdentityHashers = h) => new PidRotation(verifications, x, clock, { batch: 2 }),
    status: new GetVerificationStatus(sessions, claims, clock),
  };
}

const failure = async (p: Promise<unknown>): Promise<PidRotationError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(PidRotationError);
  return e as PidRotationError;
};

describe('pid 키 전환(I-T49)', () => {
  test('I-T49②_전환을시작하면_모든기록의pid를새키로다시계산하고옛값을pid_prev로옮기며_새토큰에pid와pid_prev를함께싣는다', async () => {
    const t = await setup();
    const people = await Promise.all(['p-1', 'p-2', 'p-3'].map((id) => t.login(id)));
    for (const [i, s] of people.entries()) await t.verify(s.accountId, `person-${i}`);
    const before = await Promise.all(people.map(async (s) => (await t.verifications.recordOf(s.accountId))!));
    // ② 새 키·새 판을 배포했다(새 pid 키 판 2)
    const h2 = hashers(2);
    t.use(h2);
    const r = await t.rotation().start({ until: t.clock.now() + 2 * DAY });
    expect(r).toMatchObject({ toVersion: 2, moved: 3, remaining: 0 });
    expect(r.movedAt).toBe(t.clock.now());
    // 새 회차의 대기열을 열어도 되는 시각: 다 옮긴 뒤 액세스 토큰 수명(15분)이 지나 옛 pid만 실린 토큰이 사라진 때(새 맥락 리뷰 중간 1)
    expect(r.safeToOpenAt).toBe(r.movedAt! + 15 * 60_000);
    expect((await t.rotation().status()).safeToOpenAt).toBe(r.movedAt! + 15 * 60_000);
    for (const [i, s] of people.entries()) {
      const rec = (await t.verifications.recordOf(s.accountId))!;
      // 새 pid = HMAC(새 pid 키, 저장된 ci_hmac), 옛 값은 pid_prev
      expect(rec.pid.equals(createHmac('sha256', K(42)).update(before[i]!.ciHmac).digest())).toBe(true);
      expect(rec.pidPrev?.equals(before[i]!.pid)).toBe(true);
      expect(rec.pidKeyVersion).toBe(2);
    }
    const again = await t.login('p-1');
    expect(payload(again.accessToken)).toMatchObject({ pid: (await t.verifications.recordOf(people[0]!.accountId))!.pid.toString('base64url'), pid_prev: before[0]!.pid.toString('base64url') });
  });

  test('I-T49_전환중처음본인확인한계정은_새키로pid를받고옛값이없어_토큰에새pid만싣는다', async () => {
    const t = await setup();
    const a = await t.login('n-1');
    await t.verify(a.accountId, 'old-person');
    t.use(hashers(2));
    await t.rotation().start({ until: t.clock.now() + 2 * DAY });
    const b = await t.login('n-2');
    await t.verify(b.accountId, 'new-person');
    const rec = (await t.verifications.recordOf(b.accountId))!;
    expect(rec).toMatchObject({ pidKeyVersion: 2, pidPrev: null });
    const tok = payload((await t.login('n-2')).accessToken);
    expect(tok.pid).toBe(rec.pid.toString('base64url'));
    expect(tok.pid_prev).toBeUndefined();
  });

  test('I-T49③④_전환중추가검증재인증으로다시본인확인하거나_연계정보키새판을만든뒤다시본인확인해도_pid와pid_prev는바뀌지않는다', async () => {
    const t = await setup();
    const s = await t.login('r-1');
    await t.verify(s.accountId, 'same-person');
    t.use(hashers(2));
    await t.rotation().start({ until: t.clock.now() + 2 * DAY });
    const mid = (await t.verifications.recordOf(s.accountId))!;
    // ③ 추가 검증의 재인증(REVERIFY)
    expect((await t.verify(s.accountId, 'same-person', 'REVERIFY', s.sessionId)).status).toBe('VERIFIED');
    const r3 = (await t.verifications.recordOf(s.accountId))!;
    expect(r3.pid.equals(mid.pid) && r3.pidPrev!.equals(mid.pidPrev!)).toBe(true);
    // ④ 연계정보 키 판 2를 쓰기 판으로 올린 뒤 다시 본인확인: 연계정보 기록은 판 2로 바뀌고 pid는 그대로
    t.use(hashers(2, { 1: 1, 2: 2 }, 2));
    expect((await t.verify(s.accountId, 'same-person', 'REVERIFY', s.sessionId)).status).toBe('VERIFIED');
    const r4 = (await t.verifications.recordOf(s.accountId))!;
    expect(r4.ciHmacKeyVersion).toBe(2);
    expect(r4.pid.equals(mid.pid) && r4.pidPrev!.equals(mid.pidPrev!) && r4.pidKeyVersion === 2).toBe(true);
  });

  test('I-T49⑤_전환이끝나면_DB의pid_prev를지우고토큰에옛pid를싣지않으며_토큰발급경로의KMS호출은0건이다', async () => {
    const t = await setup();
    const s = await t.login('f-1');
    await t.verify(s.accountId, 'finish-person');
    const h2 = counting(hashers(2));
    t.use(h2);
    const until = t.clock.now() + 2 * DAY;
    await t.rotation().start({ until });
    const afterRotate = h2.calls;
    // 토큰 발급(로그인·갱신)은 저장값만 읽는다. 발급 경로는 키 계산기를 받지 않으니 구조로 0건이고, 여기서는 전환 뒤 로그인·갱신이 계산기를 부르지 않는 것을 함께 본다
    const s2 = await t.login('f-1');
    expect(payload(s2.accessToken).pid_prev).toBeDefined();
    await t.k.refresh.run({ refreshToken: s2.refreshToken });
    t.clock.advance(until - t.clock.now());
    expect(await t.rotation().finish()).toEqual({ toVersion: 2, cleared: 1 });
    const s3 = await t.login('f-1');
    expect(payload(s3.accessToken).pid_prev).toBeUndefined();
    expect(payload(s3.accessToken).pid).toBe((await t.verifications.recordOf(s.accountId))!.pid.toString('base64url'));
    expect((await t.verifications.recordOf(s.accountId))!.pidPrev).toBeNull();
    expect(h2.calls).toBe(afterRotate);
    // 닫은 뒤에는 새 전환을 시작할 수 있다(다음 판)
    expect((await t.rotation().status()).open).toBeNull();
  });

  test('I-T49①_GetVerificationStatus는_전환중에옛pid를previous_pid로주어_교체직전에받은토큰의pid와같고_끝나면비운다', async () => {
    const t = await setup();
    const s = await t.login('g-1');
    await t.verify(s.accountId, 'order-person');
    // 교체 직전에 받은 토큰(옛 pid만)
    const oldToken = payload((await t.login('g-1')).accessToken);
    expect(oldToken.pid_prev).toBeUndefined();
    t.use(hashers(2));
    const until = t.clock.now() + 2 * DAY;
    await t.rotation().start({ until });
    const st = await t.status.run({ accountId: s.accountId, sessionId: s.sessionId });
    expect(st.verified).toBe(true);
    expect(st.previousPid).toBe(oldToken.pid);
    expect(st.pid).not.toBe(oldToken.pid);
    // 부르는 쪽(주문 생성, PRF-160)은 토큰의 pid가 둘 가운데 하나와 같으면 통과시킨다
    expect([st.pid, st.previousPid]).toContain(oldToken.pid);
    t.clock.advance(until - t.clock.now());
    await t.rotation().finish();
    expect(await t.status.run({ accountId: s.accountId, sessionId: s.sessionId })).toEqual({ verified: true, pid: st.pid, previousPid: '' });
  });

  test('I-T49_GetVerificationStatus는_세션이끝났거나다른계정의세션이거나본인확인전이면_verified false와빈값이다', async () => {
    const t = await setup();
    const a = await t.login('s-1');
    const b = await t.login('s-2');
    await t.verify(a.accountId, 'status-person');
    const none = { verified: false, pid: '', previousPid: '' };
    expect(await t.status.run({ accountId: b.accountId, sessionId: b.sessionId })).toEqual(none);
    expect(await t.status.run({ accountId: a.accountId, sessionId: b.sessionId })).toEqual(none);
    expect((await t.status.run({ accountId: a.accountId, sessionId: a.sessionId })).verified).toBe(true);
    await t.k.end.run({ sessionId: a.sessionId, accountId: a.accountId });
    expect(await t.status.run({ accountId: a.accountId, sessionId: a.sessionId })).toEqual(none);
  });

  test('I-T49_닫지않은전환이있거나_옮길판이없거나설정판보다큰판이있거나_끝시각이하루안이면시작하지않고_끝시각전·옮기지못한줄이남으면끝내지않는다', async () => {
    const t = await setup();
    const s = await t.login('x-1');
    await t.verify(s.accountId, 'guard-person');
    // 설정 판이 기록 판과 같으면 옮길 것이 없다
    expect((await failure(t.rotation().start({ until: t.clock.now() + 2 * DAY }))).code).toBe('NOTHING_TO_MOVE');
    t.use(hashers(2));
    expect((await failure(t.rotation().start({}))).code).toBe('UNTIL_REQUIRED');
    expect((await failure(t.rotation().start({ until: t.clock.now() + DAY - 1 }))).code).toBe('UNTIL_TOO_SOON');
    expect((await failure(t.rotation().finish())).code).toBe('NOT_STARTED');
    const until = t.clock.now() + 2 * DAY;
    await t.rotation().start({ until });
    // 같은 전환을 다시 돌리면 이어 하기(끝 시각은 처음 값)이고, 다른 끝 시각이면 거절한다
    expect(await t.rotation().start({})).toMatchObject({ toVersion: 2, moved: 0, remaining: 0, transitionEndsAt: until });
    expect((await failure(t.rotation().start({ until: until + DAY }))).code).toBe('UNTIL_MISMATCH');
    // 닫기 전에 다음 판으로 새 전환을 시작하지 않는다(처음 옛 pid를 잃는다)
    expect((await failure(t.rotation(hashers(3)).start({ until: until + DAY }))).code).toBe('IN_PROGRESS');
    expect((await failure(t.rotation().finish())).code).toBe('TRANSITION_NOT_OVER');
    t.clock.advance(until - t.clock.now());
    expect((await t.rotation().finish()).cleared).toBe(1);
    // 설정을 옛 판으로 되돌린 채로는 시작하지 않는다(기록에 설정보다 큰 판이 있다)
    expect((await failure(t.rotation(hashers(1)).start({ until: t.clock.now() + 2 * DAY }))).code).toBe('VERSION_NOT_NEWER');
  });

  test('I-T49_KMS가도중에답하지않으면_옮긴줄과남은줄을남기고실패하며_끝내지못하고_다시돌리면남은줄부터이어한다', async () => {
    const t = await setup();
    const people = await Promise.all(['k-1', 'k-2', 'k-3', 'k-4', 'k-5'].map((id) => t.login(id)));
    for (const [i, s] of people.entries()) await t.verify(s.accountId, `kms-${i}`);
    const before = await Promise.all(people.map(async (s) => (await t.verifications.recordOf(s.accountId))!.pid));
    const until = t.clock.now() + 2 * DAY;
    const e = await failure(t.rotation(counting(hashers(2), { failAfter: 3 })).start({ until }));
    expect(e.code).toBe('KEY_SERVICE_DOWN');
    // 묶음 2건씩: 첫 묶음 2건은 옮겼고 둘째 묶음은 1건만 계산돼 그 1건만 옮겼다
    expect(e.moved).toBe(3);
    expect(e.remaining).toBe(2);
    expect((await t.rotation(hashers(2)).status()).remaining).toBe(2);
    t.clock.advance(until - t.clock.now());
    expect((await failure(t.rotation(hashers(2)).finish())).code).toBe('NOT_MOVED');
    expect(await t.rotation(hashers(2)).start({})).toMatchObject({ moved: 2, remaining: 0 });
    for (const [i, s] of people.entries()) expect((await t.verifications.recordOf(s.accountId))!.pidPrev?.equals(before[i]!)).toBe(true);
    expect((await t.rotation(hashers(2)).finish()).cleared).toBe(5);
  });

  test('I-T49_전환작업의명령줄은_start(--until 시간대있는ISO시각)·finish·status만받는다', () => {
    expect(parsePidRotationArgs(['start', '--until', '2026-12-01T00:00:00+09:00'])).toEqual({ command: 'start', until: Date.parse('2026-11-30T15:00:00Z') });
    expect(parsePidRotationArgs(['start'])).toEqual({ command: 'start' });
    expect(parsePidRotationArgs(['finish'])).toEqual({ command: 'finish' });
    expect(parsePidRotationArgs(['status'])).toEqual({ command: 'status' });
    for (const bad of [[], ['rotate'], ['start', '--until'], ['start', '--until', '2026-12-01'], ['start', '--until', '2026-12-01T00:00:00'], ['start', '--until', 'tomorrow'], ['finish', 'now']]) {
      expect(() => parsePidRotationArgs(bad)).toThrow();
    }
  });

  test('I-T49_다옮긴뒤옛설정파드가옛판pid를저장하면_남은줄이있는동안은열어도되는시각을주지않고_다시옮기면그시각이늦춰지며_닫지않은전환보다옛판설정으로는서비스가시작하지않는다', async () => {
    const t = await setup();
    const a = await t.login('m-1');
    await t.verify(a.accountId, 'moved-person');
    t.use(hashers(2));
    const until = t.clock.now() + 2 * DAY;
    const first = await t.rotation().start({ until });
    expect(first.safeToOpenAt).toBe(first.movedAt! + 15 * 60_000);
    // 새 설정으로 바뀌지 않은 파드가 처음 본인확인한 계정에 옛 판 pid를 저장했다(새 맥락 리뷰 다시 보기 중간)
    t.clock.advance(60_000);
    t.use(hashers(1));
    const b = await t.login('m-2');
    await t.verify(b.accountId, 'late-person');
    const st = await t.rotation(hashers(2)).status();
    expect(st.remaining).toBe(1);
    expect(st.safeToOpenAt).toBeNull();
    // 서비스는 닫지 않은 전환의 판보다 옛 pid 판 설정으로 시작하지 않는다
    await expect(assertKeyVersions(t.verifications, hashers(1))).rejects.toThrow(/pid 판 2/);
    await expect(assertKeyVersions(t.verifications, hashers(2))).resolves.toBeUndefined();
    // 다시 돌리면 남은 줄을 옮기고, 다 옮긴 시각과 열어도 되는 시각이 그때로 늦춰진다
    t.clock.advance(60_000);
    const again = await t.rotation(hashers(2)).start({});
    expect(again).toMatchObject({ moved: 1, remaining: 0, movedAt: t.clock.now(), safeToOpenAt: t.clock.now() + 15 * 60_000 });
    expect((await t.rotation(hashers(2)).status()).safeToOpenAt).toBe(t.clock.now() + 15 * 60_000);
  });
});
