// 키 판·만 14세·다른 계정 시도·재통과(docs/features/identity.md §5 '키 판·만 14세·다른 계정 시도·재통과의 첫 구현', BUILD_ORDER BOT-020,
// I-T42, I-T55 ④, I-T65, ADR-0050 결정 5, ADR-0062, ADR-0171).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import type { AccountClosure } from '../src/modules/session/domain/ports.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { GetVerificationResult } from '../src/modules/verification/application/get-verification-result.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { VerificationError } from '../src/modules/verification/application/verification-error.js';
import type { IdentityHashers } from '../src/modules/verification/domain/ports.js';
import { KeyServiceUnavailable } from '../src/modules/verification/domain/verification.js';
import { agencyResult, kit, newKey, testAgency } from './support.js';

const K = (n: number) => Buffer.alloc(32, n);
const PID = K(50);

function hashers(versions: Record<number, Buffer>) {
  return new HmacIdentityHashers({ ciKeys: new Map(Object.entries(versions).map(([v, k]) => [Number(v), k])), pidKey: PID, pidVersion: 1 });
}

async function setup(o: { now?: string; hashers?: IdentityHashers } = {}) {
  const verifications = new MemoryVerificationStore();
  const sessions = new MemorySessionStore();
  const clock = fakeClock({ now: Date.parse(o.now ?? '2026-11-03T03:00:00.000Z') });
  const closures: string[] = [];
  const closing = new Set<string>();
  const closure: AccountClosure = {
    start: async (accountId, reason) => void closures.push(`${accountId}:${reason}`),
    closureReasonOf: async (accountId) => (closing.has(accountId) ? 'UNDER_14' : null),
  };
  const k = await kit(sessions, { claims: new VerificationClaims(verifications), clock, reverifications: new VerificationClaims(verifications) });
  const provider = testAgency(clock);
  let h = o.hashers ?? hashers({ 1: K(1) });
  const confirm = () => new ConfirmVerification(verifications, provider, h, closure, clock);
  return {
    k,
    clock,
    verifications,
    sessions,
    closures,
    markClosing: (accountId: string) => closing.add(accountId),
    useHashers: (x: IdentityHashers) => (h = x),
    start: (accountId: string, purpose: 'FIRST' | 'REVERIFY' = 'FIRST', sessionId: string | null = null) =>
      new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId, purpose, next: '/' }),
    confirm: (accountId: string, verificationId: string, r: Parameters<typeof agencyResult>[2]) =>
      confirm().run({ accountId, verificationId, providerResult: agencyResult(clock, verificationId, { birth: '2000-01-01', ...r }) }),
    result: (accountId: string, verificationId: string) => new GetVerificationResult(verifications, clock).run({ accountId, verificationId }),
    login: (id: string, provider: 'kakao' | 'naver' = 'kakao') => k.create.run({ idempotencyKey: newKey(), provider, providerUserId: id, email: null, deviceId: null }),
  };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof VerificationError) return e.code;
    throw e;
  }
};

describe('만 14세 재확인(I-T42)', () => {
  test('I-T42_만14세미만이면_연계정보를계산·저장하지않고UNDER_14·403이며_계정정리를시작한다', async () => {
    const t = await setup();
    const s = await t.login('age-1');
    const st = await t.start(s.accountId);
    // 2026-11-03 KST에 만 13세(생일이 하루 남음)
    expect(await code(t.confirm(s.accountId, st.verificationId, { person: 'kid', birth: '2012-11-04' }))).toBe('UNDER_14');
    expect((await t.result(s.accountId, st.verificationId)).status).toBe('UNDER_14');
    expect(await t.verifications.claimsOf(s.accountId)).toBeNull();
    expect(t.closures).toEqual([`${s.accountId}:UNDER_14`]);
    // 같은 건을 다시 보내도 같은 403이고, 정리 시작은 멱등이다(정리가 실패했어도 다시 보내면 다시 부른다)
    expect(await code(t.confirm(s.accountId, st.verificationId, { person: 'kid', birth: '2012-11-04' }))).toBe('UNDER_14');
    expect(t.closures).toEqual([`${s.accountId}:UNDER_14`, `${s.accountId}:UNDER_14`]);
    // 미성년자로 확인된 사람은 다른 계정으로도 연계정보가 남지 않았다(같은 이름표로 다른 계정이 본인확인할 수 있다)
    const other = await t.login('age-2', 'naver');
    const st2 = await t.start(other.accountId);
    expect(await code(t.confirm(other.accountId, st2.verificationId, { person: 'kid', birth: '2012-11-04' }))).toBe('UNDER_14');
  });

  test('I-T42_만나이는_KST날짜로센다_생일당일은만14세다', async () => {
    // 2026-11-03T16:00Z = KST 2026-11-04 01:00: KST로는 생일, UTC로는 하루 전
    const t = await setup({ now: '2026-11-03T16:00:00.000Z' });
    const s = await t.login('age-3');
    expect((await t.confirm(s.accountId, (await t.start(s.accountId)).verificationId, { person: 'turning14', birth: '2012-11-04' })).status).toBe('VERIFIED');
    const u = await t.login('age-4', 'naver');
    expect(await code(t.confirm(u.accountId, (await t.start(u.accountId)).verificationId, { person: 'not-yet', birth: '2012-11-05' }))).toBe('UNDER_14');
  });

  test('I-T42_생년월일이없거나있을수없는날이면_FAILED다(나이를확인할수없으면통과시키지않는다)', async () => {
    const t = await setup();
    for (const birth of [undefined, '2010-02-30', '1800-01-01', '2999-01-01']) {
      const s = await t.login(`age-b-${birth}`);
      const st = await t.start(s.accountId);
      const r = await t.confirm(s.accountId, st.verificationId, { person: `p-${birth}`, birth: birth as string });
      expect(r.status).toBe('FAILED');
    }
  });

  test('I-T42_이미본인확인한계정의REVERIFY가만14세미만이면_다른사람이므로FAILED이고_계정을정리하지않는다(새맥락리뷰높음1)', async () => {
    const t = await setup();
    const s = await t.login('age-re');
    await t.confirm(s.accountId, (await t.start(s.accountId)).verificationId, { person: 'adult', birth: '2000-01-01' });
    const re = await t.start(s.accountId, 'REVERIFY');
    expect((await t.confirm(s.accountId, re.verificationId, { person: 'kid-elsewhere', birth: '2013-01-01' })).status).toBe('FAILED');
    expect(t.closures).toEqual([]);
    expect(await t.verifications.claimsOf(s.accountId)).not.toBeNull();
  });

  test('I-T42_정리중인계정은_다시본인확인을시작·확정하지못한다(새맥락리뷰중간2)', async () => {
    const t = await setup();
    const s = await t.login('age-closing');
    const first = await t.start(s.accountId);
    const second = await t.start(s.accountId);
    expect(await code(t.confirm(s.accountId, first.verificationId, { person: 'kid-2', birth: '2013-01-01' }))).toBe('UNDER_14');
    t.markClosing(s.accountId);
    // 아이가 같은 계정에서 어른의 휴대폰으로 다시 하더라도 ticket:buy를 받지 못한다
    expect(await code(t.start(s.accountId))).toBe('UNDER_14');
    expect(await code(t.confirm(s.accountId, second.verificationId, { person: 'parent', birth: '1980-01-01' }))).toBe('UNDER_14');
    expect(await t.verifications.claimsOf(s.accountId)).toBeNull();
  });
});

describe('다른 계정 시도 기록(I-T65)', () => {
  test('I-T65_다른계정에서같은본인확인을하면_시도마다한줄이고_같은건다시보내기는줄을더하지않으며_1년뒤지운다', async () => {
    const t = await setup();
    const a = await t.login('dup-a');
    const b = await t.login('dup-b', 'naver');
    await t.confirm(a.accountId, (await t.start(a.accountId)).verificationId, { person: 'same' });
    const tries: string[] = [];
    for (let i = 0; i < 3; i++) {
      const st = await t.start(b.accountId);
      tries.push(st.verificationId);
      expect(await code(t.confirm(b.accountId, st.verificationId, { person: 'same' }))).toBe('DUPLICATE_ACCOUNT');
    }
    expect(await code(t.confirm(b.accountId, tries[0]!, { person: 'same' }))).toBe('DUPLICATE_ACCOUNT');
    const rows = await t.verifications.conflictAttempts(b.accountId);
    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(['attemptedAccountId', 'attemptedAt', 'existingAccountId', 'id']);
      expect(r).toMatchObject({ attemptedAccountId: b.accountId, existingAccountId: a.accountId, attemptedAt: t.clock.now() });
    }
    // B의 상태·토큰은 바뀌지 않는다
    expect(await t.verifications.claimsOf(b.accountId)).toBeNull();
    t.clock.advance(365 * 24 * 3_600_000);
    expect(await t.verifications.purgeConflictAttempts(t.clock.now() - 365 * 24 * 3_600_000)).toBe(0);
    t.clock.advance(1);
    expect(await t.verifications.purgeConflictAttempts(t.clock.now() - 365 * 24 * 3_600_000)).toBe(3);
    expect(await t.verifications.conflictAttempts(b.accountId)).toHaveLength(0);
  });
});

describe('연계정보 HMAC 키 판(ADR-0050 결정 5)', () => {
  test('ADR0050_보존중인모든판으로중복을찾고_옛판기록은새판값으로바꾸며_pid는그대로다', async () => {
    const t = await setup({ hashers: hashers({ 1: K(1) }) });
    const a = await t.login('ver-a');
    await t.confirm(a.accountId, (await t.start(a.accountId)).verificationId, { person: 'park' });
    const before = await t.verifications.recordOf(a.accountId);
    expect(before).toMatchObject({ ciHmacKeyVersion: 1 });
    // 판 2를 만든다(옛 판 1은 그 판 기록이 남은 동안 조회용으로 둔다)
    t.useHashers(hashers({ 1: K(1), 2: K(2) }));
    const b = await t.login('ver-b', 'naver');
    expect(await code(t.confirm(b.accountId, (await t.start(b.accountId)).verificationId, { person: 'park' }))).toBe('DUPLICATE_ACCOUNT');
    // A가 다시 본인확인하면 같은 사람으로 VERIFIED이고, 기록이 판 2 값으로 바뀐다. pid는 그대로다
    expect((await t.confirm(a.accountId, (await t.start(a.accountId, 'REVERIFY')).verificationId, { person: 'park' })).status).toBe('VERIFIED');
    const after = await t.verifications.recordOf(a.accountId);
    expect(after).toMatchObject({ ciHmacKeyVersion: 2, pid: before!.pid });
    expect(after!.ciHmac.equals(before!.ciHmac)).toBe(false);
    // 바뀐 뒤에도 B는 막힌다(이번엔 판 2 값으로 만난다)
    expect(await code(t.confirm(b.accountId, (await t.start(b.accountId)).verificationId, { person: 'park' }))).toBe('DUPLICATE_ACCOUNT');
    // 새 계정의 새 기록은 가장 큰 판이다
    const c = await t.login('ver-c');
    await t.confirm(c.accountId, (await t.start(c.accountId)).verificationId, { person: 'choi' });
    expect(await t.verifications.recordOf(c.accountId)).toMatchObject({ ciHmacKeyVersion: 2 });
  });

  test('ADR0050_판이다른데같은사람이아니면_FAILED이고기록을바꾸지않는다', async () => {
    const t = await setup({ hashers: hashers({ 1: K(1) }) });
    const a = await t.login('ver-x');
    await t.confirm(a.accountId, (await t.start(a.accountId)).verificationId, { person: 'han' });
    t.useHashers(hashers({ 1: K(1), 2: K(2) }));
    expect((await t.confirm(a.accountId, (await t.start(a.accountId, 'REVERIFY')).verificationId, { person: 'oh' })).status).toBe('FAILED');
    expect(await t.verifications.recordOf(a.accountId)).toMatchObject({ ciHmacKeyVersion: 1 });
  });

  test('identity§10_연계정보키(KMS)를쓸수없으면_그건을PROVIDER_DOWN으로마치고503이다', async () => {
    const down: IdentityHashers = {
      ciAll: async () => {
        throw new KeyServiceUnavailable('ThrottlingException');
      },
      pid: async () => {
        throw new KeyServiceUnavailable('ThrottlingException');
      },
      versions: () => [1],
      pidVersion: () => 1,
    };
    const t = await setup({ hashers: down });
    const s = await t.login('kms-down');
    const st = await t.start(s.accountId);
    expect(await code(t.confirm(s.accountId, st.verificationId, { person: 'p' }))).toBe('PROVIDER_DOWN');
    expect((await t.result(s.accountId, st.verificationId)).status).toBe('PROVIDER_DOWN');
  });

  test('ADR0050_새판은모든파드에둔뒤에쓰기판으로올린다_쓰기판보다큰판은조회에만쓴다(새맥락리뷰중간3)', async () => {
    const writes1 = () => new HmacIdentityHashers({ ciKeys: new Map([[1, K(1)], [2, K(2)]]), writeVersion: 1, pidKey: PID, pidVersion: 1 });
    const t = await setup({ hashers: writes1() });
    const a = await t.login('wv-a');
    await t.confirm(a.accountId, (await t.start(a.accountId)).verificationId, { person: 'wv' });
    expect(await t.verifications.recordOf(a.accountId)).toMatchObject({ ciHmacKeyVersion: 1 });
    // 쓰기 판을 올린 파드가 쓴 판 2 기록도, 아직 판 1로 쓰는 파드가 판 2까지 조회해 막는다
    t.useHashers(hashers({ 1: K(1), 2: K(2) }));
    const b = await t.login('wv-b', 'naver');
    await t.confirm(b.accountId, (await t.start(b.accountId)).verificationId, { person: 'wv-other' });
    expect(await t.verifications.recordOf(b.accountId)).toMatchObject({ ciHmacKeyVersion: 2 });
    t.useHashers(writes1());
    const c = await t.login('wv-c');
    expect(await code(t.confirm(c.accountId, (await t.start(c.accountId)).verificationId, { person: 'wv-other' }))).toBe('DUPLICATE_ACCOUNT');
    expect(() => new HmacIdentityHashers({ ciKeys: new Map([[1, K(1)]]), writeVersion: 2, pidKey: PID, pidVersion: 1 })).toThrow();
  });

  test('ADR0050_DB에있는판을설정이모두갖지않으면_시작하지않는다(새맥락리뷰중간3)', async () => {
    const t = await setup({ hashers: hashers({ 1: K(1), 2: K(2) }) });
    const a = await t.login('kv-a');
    await t.confirm(a.accountId, (await t.start(a.accountId)).verificationId, { person: 'kv' });
    const { assertKeyVersions } = await import('../src/modules/verification/application/key-versions.js');
    await expect(assertKeyVersions(t.verifications, hashers({ 1: K(1), 2: K(2) }))).resolves.toBeUndefined();
    await expect(assertKeyVersions(t.verifications, hashers({ 1: K(1) }))).rejects.toThrow(/판 2/);
  });

  test('ADR0050_자기계정과다른계정이같은사람값을함께가져도_다른계정을찾는다(새맥락리뷰낮음5)', async () => {
    const t = await setup({ hashers: hashers({ 1: K(1) }) });
    const a = await t.login('ex-a');
    await t.confirm(a.accountId, (await t.start(a.accountId)).verificationId, { person: 'ex' });
    // 깨진 상태 흉내: B가 같은 사람의 판 2 값을 가졌다(판 설정이 어긋났던 동안)
    t.useHashers(hashers({ 2: K(2), 9: K(9) }));
    const b = await t.login('ex-b', 'naver');
    await t.confirm(b.accountId, (await t.start(b.accountId)).verificationId, { person: 'ex' });
    t.useHashers(hashers({ 1: K(1), 2: K(2), 9: K(9) }));
    expect(await code(t.confirm(a.accountId, (await t.start(a.accountId, 'REVERIFY')).verificationId, { person: 'ex' }))).toBe('DUPLICATE_ACCOUNT');
  });

  test('ADR0050_pid는새로저장할때만계산한다_pid키장애는다시본인확인을막지않는다(새맥락리뷰낮음7)', async () => {
    const base = hashers({ 1: K(1) });
    let pidCalls = 0;
    const counting: IdentityHashers = { ciAll: (ci) => base.ciAll(ci), pid: async (x) => (pidCalls++, base.pid(x)), versions: () => base.versions(), pidVersion: () => base.pidVersion() };
    const t = await setup({ hashers: counting });
    const a = await t.login('pid-a');
    await t.confirm(a.accountId, (await t.start(a.accountId)).verificationId, { person: 'pid' });
    expect(pidCalls).toBe(1);
    t.useHashers({
      versions: () => base.versions(),
      pidVersion: () => base.pidVersion(),
      ciAll: (ci) => base.ciAll(ci),
      pid: async () => {
        throw new KeyServiceUnavailable('down');
      },
    });
    expect((await t.confirm(a.accountId, (await t.start(a.accountId, 'REVERIFY')).verificationId, { person: 'pid' })).status).toBe('VERIFIED');
    const b = await t.login('pid-b', 'naver');
    expect(await code(t.confirm(b.accountId, (await t.start(b.accountId)).verificationId, { person: 'pid' }))).toBe('DUPLICATE_ACCOUNT');
  });

  test('identity§10_새계정의첫본인확인에서pid키(KMS)만쓸수없어도_PROVIDER_DOWN으로마치고503이다(다시보기중간1)', async () => {
    const base = hashers({ 1: K(1) });
    const t = await setup({
      hashers: {
        versions: () => base.versions(),
      pidVersion: () => base.pidVersion(),
        ciAll: (ci) => base.ciAll(ci),
        pid: async () => {
          throw new KeyServiceUnavailable('ThrottlingException');
        },
      },
    });
    const s = await t.login('pid-down-new');
    const st = await t.start(s.accountId);
    expect(await code(t.confirm(s.accountId, st.verificationId, { person: 'pd' }))).toBe('PROVIDER_DOWN');
    expect((await t.result(s.accountId, st.verificationId)).status).toBe('PROVIDER_DOWN');
  });

  test('ADR0050_이계정기록의판을이파드설정이갖지않으면_FAILED가아니라PROVIDER_DOWN이다(다시보기낮음4)', async () => {
    const t = await setup({ hashers: hashers({ 1: K(1), 2: K(2) }) });
    const a = await t.login('kv-pod');
    await t.confirm(a.accountId, (await t.start(a.accountId)).verificationId, { person: 'kvp' });
    expect(await t.verifications.recordOf(a.accountId)).toMatchObject({ ciHmacKeyVersion: 2 });
    t.useHashers(hashers({ 1: K(1) }));
    const re = await t.start(a.accountId, 'REVERIFY');
    expect(await code(t.confirm(a.accountId, re.verificationId, { person: 'kvp' }))).toBe('PROVIDER_DOWN');
  });

  test('ADR0050_설정값키는_판번호·길이가맞아야하고_연계정보키와pid키는달라야한다', () => {
    expect(() => HmacIdentityHashers.fromEnv({ PEAKET_ENV: 'ci', PEAKET_CI_HMAC_KEYS: JSON.stringify({ 1: K(1).toString('base64'), 3: K(3).toString('base64') }), PEAKET_PID_HMAC_KEY: PID.toString('base64') })).not.toThrow();
    expect(() => HmacIdentityHashers.fromEnv({ PEAKET_ENV: 'ci', PEAKET_CI_HMAC_KEY: K(1).toString('base64'), PEAKET_PID_HMAC_KEY: PID.toString('base64') })).not.toThrow();
    for (const env of [
      { PEAKET_CI_HMAC_KEYS: JSON.stringify({ 0: K(1).toString('base64') }), PEAKET_PID_HMAC_KEY: PID.toString('base64') },
      { PEAKET_CI_HMAC_KEYS: JSON.stringify({ 1: Buffer.alloc(16).toString('base64') }), PEAKET_PID_HMAC_KEY: PID.toString('base64') },
      { PEAKET_CI_HMAC_KEYS: JSON.stringify({ 1: PID.toString('base64') }), PEAKET_PID_HMAC_KEY: PID.toString('base64') },
      { PEAKET_CI_HMAC_KEYS: '{}', PEAKET_PID_HMAC_KEY: PID.toString('base64') },
      // 판끼리 같은 키, 두 이름을 함께 줌(새 맥락 리뷰 낮음 9)
      { PEAKET_CI_HMAC_KEYS: JSON.stringify({ 1: K(1).toString('base64'), 2: K(1).toString('base64') }), PEAKET_PID_HMAC_KEY: PID.toString('base64') },
      { PEAKET_CI_HMAC_KEYS: JSON.stringify({ 1: K(1).toString('base64') }), PEAKET_CI_HMAC_KEY: K(1).toString('base64'), PEAKET_PID_HMAC_KEY: PID.toString('base64') },
    ])
      expect(() => HmacIdentityHashers.fromEnv({ PEAKET_ENV: 'ci', ...env })).toThrow();
    // 설정값 키는 운영 쪽 환경에서 쓰지 않는다(운영은 KMS)
    expect(() => HmacIdentityHashers.fromEnv({ PEAKET_ENV: 'prod', PEAKET_CI_HMAC_KEY: K(1).toString('base64'), PEAKET_PID_HMAC_KEY: PID.toString('base64') })).toThrow(/local·ci·demo/);
  });
});

describe('고위험 재인증의 본인확인 재통과(I-T55 ④)', () => {
  test('I-T55_④본인확인기록이없는계정의REVERIFY는_FAILED이고첫기록이되지않으며_재통과로세지않는다(새맥락리뷰낮음6)', async () => {
    const t = await setup();
    const s = await t.login('rv-none');
    expect((await t.confirm(s.accountId, (await t.start(s.accountId, 'REVERIFY', s.sessionId)).verificationId, { person: 'rv-none' })).status).toBe('FAILED');
    expect(await t.verifications.claimsOf(s.accountId)).toBeNull();
    const r = await t.k.reauth.run({ sessionId: s.sessionId, accountId: s.accountId, provider: 'kakao', providerUserId: 'rv-none', strength: 'requested', purpose: 'high-risk' });
    expect(r.result).toBe('REVERIFY_REQUIRED');
  });

  test('I-T55_④같은세션에서REVERIFY가10분안에확정되면_요청만함고위험재인증토큰을준다', async () => {
    const t = await setup();
    const s = await t.login('rv-1');
    await t.confirm(s.accountId, (await t.start(s.accountId, 'FIRST', s.sessionId)).verificationId, { person: 'rv' });
    const reauth = () => t.k.reauth.run({ sessionId: s.sessionId, accountId: s.accountId, provider: 'kakao', providerUserId: 'rv-1', strength: 'requested', purpose: 'high-risk' });
    // 판정 UNKNOWN(trust-svc 전) 세션: 재통과 전에는 주지 않는다
    expect((await reauth()).result).toBe('REVERIFY_REQUIRED');
    const re = await t.start(s.accountId, 'REVERIFY', s.sessionId);
    await t.confirm(s.accountId, re.verificationId, { person: 'rv' });
    expect((await reauth()).result).toBe('ISSUED');
    t.clock.advance(10 * 60_000);
    expect((await reauth()).result).toBe('ISSUED');
    t.clock.advance(1);
    expect((await reauth()).result).toBe('REVERIFY_REQUIRED');
  });

  test('I-T55_④다른세션의재통과·FIRST목적·실패한REVERIFY는_재통과로보지않는다', async () => {
    const t = await setup();
    const s = await t.login('rv-2');
    const other = await t.login('rv-2');
    await t.confirm(s.accountId, (await t.start(s.accountId, 'FIRST', s.sessionId)).verificationId, { person: 'rv2' });
    await t.confirm(s.accountId, (await t.start(s.accountId, 'REVERIFY', other.sessionId)).verificationId, { person: 'rv2' });
    await t.confirm(s.accountId, (await t.start(s.accountId, 'REVERIFY', s.sessionId)).verificationId, { person: 'someone-else' });
    const r = await t.k.reauth.run({ sessionId: s.sessionId, accountId: s.accountId, provider: 'kakao', providerUserId: 'rv-2', strength: 'requested', purpose: 'high-risk' });
    expect(r.result).toBe('REVERIFY_REQUIRED');
  });
});
