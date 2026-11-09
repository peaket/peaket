// 탈퇴의 첫 구현(docs/features/identity.md §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030, I-T16·I-T27·I-T8, POL-033, [ASVS v5.0.0-7.4.2]).
// 메모리 저장소로 재인증 토큰 1회 사용, 계정·본인확인 기록 파기, 세션 종료, 만 14세 미만 정리 마무리, 리프레시 토큰 해시 지우기를 본다. PostgreSQL은 test-int/withdrawal.int.test.ts.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { FinishWithdrawals } from '../src/modules/session/application/finish-withdrawals.js';
import { GetVerificationStatus } from '../src/modules/session/application/get-verification-status.js';
import { completeWithdrawal, WithdrawAccount } from '../src/modules/session/application/withdraw-account.js';
import type { AccountEraser, SessionStore } from '../src/modules/session/domain/ports.js';
import { CreateSession } from '../src/modules/session/application/create-session.js';
import { plusOneYear } from '../src/modules/verification/domain/verification.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { VerificationEraser } from '../src/modules/verification/adapters/verification-eraser.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { VerificationError } from '../src/modules/verification/application/verification-error.js';
import { AccountWithdrawn } from '@peaket/contracts/asyncapi';
import { agencyResult, ISSUER, kit, newKey, noClaims, recordingSignals, testAgency, testDeviceRefs } from './support.js';

const DAY = 86_400_000;
const payload = (jwt: string): Record<string, unknown> => JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString()) as Record<string, unknown>;

async function setup(o: { failErase?: number; failEraseFor?: (accountId: string) => boolean } = {}) {
  const clock = fakeClock({ now: Date.parse('2026-11-04T03:00:00.000Z') });
  const sessions = new MemorySessionStore();
  const verifications = new MemoryVerificationStore();
  const closure = new CloseAccount(sessions, clock);
  const claims = new VerificationClaims(verifications, closure);
  const k = await kit(sessions, { claims, clock, reverifications: claims });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 4), Buffer.alloc(32, 5));
  let failures = o.failErase ?? 0;
  const real = new VerificationEraser(verifications);
  const eraser: AccountEraser = {
    erase: async (accountId, now) => {
      if (failures > 0 || o.failEraseFor?.(accountId)) {
        if (failures > 0) failures--;
        throw new Error('주입한 DB 장애');
      }
      return real.erase(accountId, now);
    },
    pidsOf: (accountId) => real.pidsOf(accountId),
  };
  const reauth = new JoseReauthVerifier(k.keys, ISSUER, clock);
  const withdraw = new WithdrawAccount(sessions, reauth, eraser, clock);
  const finish = new FinishWithdrawals(sessions, eraser, clock);
  const login = (id: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: id, email: `${id}@kakao.test`, deviceId: 'dev-1' });
  const verify = async (accountId: string, person: string, birth = '2000-01-01') => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    return new ConfirmVerification(verifications, provider, hashers, closure, clock).run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person, birth }) });
  };
  const reauthToken = async (s: { accountId: string; sessionId: string }, purpose: 'sensitive' | 'high-risk' = 'sensitive', o2: { now?: number } = {}) =>
    (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose }, o2.now ?? clock.now())).token;
  return { clock, sessions, verifications, k, withdraw, finish, login, verify, reauthToken, closure, claims, provider, hashers, status: new GetVerificationStatus(sessions, claims, clock) };
}

const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof AccountError || e instanceof VerificationError) return e.code;
    throw e;
  }
};

describe('탈퇴(I-T16·I-T27)', () => {
  test('I-T16_탈퇴하면_모든세션이끝나고(DELETE사건)·리프레시가안되며_프로필·로그인수단·기기와연계정보HMAC·pid가지워지고_연계정보처리기록만1년보존된다', async () => {
    const t = await setup();
    const a = await t.login('w-1');
    const b = await t.login('w-1');
    await t.verify(a.accountId, 'withdraw-person');
    expect(t.sessions.activeCount(a.accountId)).toBe(2);
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(t.sessions.activeCount(a.accountId)).toBe(0);
    expect(t.sessions.terminations(a.accountId).map(([, r]) => r)).toEqual(['DELETE', 'DELETE']);
    expect(t.sessions.refreshHashCount(a.accountId)).toBe(0);
    expect((await t.k.refresh.run({ refreshToken: b.refreshToken })).result).toBe('INVALID');
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'DELETED', email: null, deletedAt: t.clock.now() });
    expect(t.sessions.providerCount(a.accountId)).toBe(0);
    expect(t.sessions.deviceCount(a.accountId)).toBe(0);
    expect(await t.verifications.recordOf(a.accountId)).toBeNull();
    expect(await t.verifications.claimsOf(a.accountId)).toBeNull();
    // 연계정보 처리 기록(출처·시기)은 연계정보 없이 처리한 날 + 1년까지 남는다
    expect(t.verifications.retentionOf(a.accountId)).toMatchObject({ verifiedAt: t.clock.now(), deleteAt: t.clock.now() + 365 * DAY });
    expect(JSON.stringify(t.verifications.retentionOf(a.accountId))).not.toMatch(/ci|pid/i);
    expect(t.verifications.attemptsOf(a.accountId)).toEqual([]);
  });

  test('I-T16_재인증토큰이없거나·다른세션·다른작업묶음·다른계정·만료면403이고_한번쓴토큰은다시못쓴다', async () => {
    const t = await setup();
    const a = await t.login('r-1');
    const other = await t.login('r-2');
    const run = (token: string, s = a) => t.withdraw.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: token, body: {} });
    expect(await code(run(''))).toBe('REAUTH_REQUIRED');
    expect(await code(run('not-a-token'))).toBe('REAUTH_REQUIRED');
    // 다른 세션·다른 계정의 토큰, 고위험 묶음(FAN_HIGH_RISK) 토큰
    const second = await t.login('r-1');
    expect(await code(run(await t.reauthToken(second)))).toBe('REAUTH_REQUIRED');
    expect(await code(run(await t.reauthToken(other)))).toBe('REAUTH_REQUIRED');
    expect(await code(run(await t.reauthToken(a, 'high-risk')))).toBe('REAUTH_REQUIRED');
    // 5분이 지난 토큰
    const old = await t.reauthToken(a, 'sensitive', { now: t.clock.now() - 6 * 60_000 });
    expect(await code(run(old))).toBe('REAUTH_REQUIRED');
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('ACTIVE');
    // 맞는 토큰은 한 번만 쓴다: 두 번째 세션(살아 있음)에서 같은 토큰을 다시 보내면 403이다
    const token = await t.reauthToken(second);
    expect(await code(run(token, second))).toBe('OK');
    expect(await code(t.withdraw.run({ accountId: second.accountId, sessionId: second.sessionId, reauthToken: token, body: {} }))).toBe('REAUTH_REQUIRED');
  });

  test('I-T27_탈퇴뒤같은소셜계정으로로그인하면새계정이고_같은사람이다시본인확인하면VERIFIED이며pid가같다', async () => {
    const t = await setup();
    const a = await t.login('re-1');
    await t.verify(a.accountId, 'rejoin-person');
    const pid = (await t.verifications.claimsOf(a.accountId))!.pid;
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    const b = await t.login('re-1');
    expect(b.accountId).not.toBe(a.accountId);
    expect(b.newAccount).toBe(true);
    // 연계정보가 지워져 1인 1계정에 걸리지 않는다. 같은 키라 pid가 같아 진행 중인 회차의 1인 1순번 키에 걸린다(identity §8)
    expect((await t.verify(b.accountId, 'rejoin-person')).status).toBe('VERIFIED');
    expect((await t.verifications.claimsOf(b.accountId))!.pid).toBe(pid);
  });

  test('I-T8_정리·탈퇴유예중인계정의토큰에는ticket:buy와pid가없고_GetVerificationStatus는verified false다', async () => {
    const t = await setup();
    const a = await t.login('p-1');
    await t.verify(a.accountId, 'pending-person');
    expect(payload((await t.login('p-1')).accessToken).scope).toBe('ticket:buy');
    await t.sessions.transaction((tx) => tx.markClosure(a.accountId, 'UNDER_14', t.clock.now()));
    const tok = payload((await t.login('p-1')).accessToken);
    expect(tok.scope).toBeUndefined();
    expect(tok.pid).toBeUndefined();
    expect(await t.status.run({ accountId: a.accountId, sessionId: a.sessionId })).toEqual({ verified: false, pid: '', previousPid: '' });
  });

  test('BOT-020넘김_만14세미만으로정리중인계정은_정리를시작하고10분이지난뒤정비가재인증없이끝낸다', async () => {
    const t = await setup();
    const a = await t.login('u14-1');
    expect(await code(t.verify(a.accountId, 'kid', '2013-01-01'))).toBe('UNDER_14');
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureStartedAt: t.clock.now() });
    t.clock.advance(5 * 60_000);
    expect(await t.finish.run()).toMatchObject({ closed: 0 });
    expect(t.sessions.activeCount(a.accountId)).toBe(1);
    t.clock.advance(5 * 60_000);
    expect(await t.finish.run()).toMatchObject({ closed: 1 });
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
    expect(t.sessions.activeCount(a.accountId)).toBe(0);
    // 만 14세 미만 건(1년 보관)은 남는다. 본인확인 기록은 처음부터 없다
    expect(t.verifications.attemptsOf(a.accountId).map((x) => x.status)).toEqual(['UNDER_14']);
  });

  test('본인확인기록파기가실패해도_탈퇴는끝나고_정비(withdrawal-finish)가지난7일안에탈퇴한계정의남은기록을다시지운다', async () => {
    const t = await setup({ failErase: 1 });
    const a = await t.login('e-1');
    await t.verify(a.accountId, 'erase-person');
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
    expect(await t.verifications.recordOf(a.accountId)).not.toBeNull();
    t.clock.advance(DAY);
    expect(await t.finish.run()).toMatchObject({ erased: 1 });
    expect(await t.verifications.recordOf(a.accountId)).toBeNull();
  });

  test('처리한지1년이지난연계정보처리기록은_탈퇴때옮기지않고지운다', async () => {
    const t = await setup();
    const a = await t.login('o-1');
    await t.verify(a.accountId, 'old-person');
    t.clock.advance(366 * DAY);
    const s = await t.login('o-1');
    await t.withdraw.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: await t.reauthToken(s), body: {} });
    expect(t.verifications.retentionOf(a.accountId)).toBeNull();
  });
});

describe('리프레시 토큰 해시와 재인증 토큰 기록 지우기(R-255가 넘긴 것)', () => {
  test('R-255_세션이끝나면그세션의리프레시토큰해시를같은트랜잭션에서지우고_유휴·절대만료로끝난세션의행과지난재인증토큰기록은정비가지운다', async () => {
    const t = await setup();
    const a = await t.login('h-1');
    await t.k.refresh.run({ refreshToken: a.refreshToken });
    expect(t.sessions.refreshHashCount(a.accountId)).toBeGreaterThan(0);
    await t.k.end.run({ sessionId: a.sessionId, accountId: a.accountId });
    expect(t.sessions.refreshHashCount(a.accountId)).toBe(0);
    // 유휴 만료로 끝난 세션: 행이 남았다가 정비가 지운다
    const b = await t.login('h-2');
    expect(t.sessions.refreshHashCount(b.accountId)).toBeGreaterThan(0);
    t.clock.advance(31 * DAY);
    expect(await t.sessions.purgeExpiredRefreshHashes(t.clock.now())).toBeGreaterThan(0);
    expect(t.sessions.refreshHashCount(b.accountId)).toBe(0);
    // 쓴 재인증 토큰 기록은 토큰 만료가 지나면 지운다
    const c = await t.login('h-3');
    await t.withdraw.run({ accountId: c.accountId, sessionId: c.sessionId, reauthToken: await t.reauthToken(c), body: {} });
    expect(await t.sessions.purgeReauthUses(t.clock.now())).toBe(0);
    t.clock.advance(6 * 60_000);
    expect(await t.sessions.purgeReauthUses(t.clock.now())).toBe(1);
  });
});

describe('탈퇴와 겹치는 로그인·갱신·본인확인(새 맥락 리뷰 M1·M2)', () => {
  test('I-T16_M1_로그인이계정을찾은뒤잠그기전에탈퇴가끝났으면_탈퇴한계정에세션·기기를만들지않고새계정으로간다', async () => {
    const t = await setup();
    const a = await t.login('race-1');
    // 로그인이 계정을 찾은 뒤 잠그는 사이에 탈퇴가 커밋된 것을 흉내 낸다(잠근 뒤에는 DELETED가 보이고 로그인 수단 연결이 지워져 있다)
    let fired = false;
    const racing: SessionStore = {
      transaction: (fn) =>
        t.sessions.transaction((tx) =>
          fn({
            ...tx,
            lockAccount: async (id) => {
              if (id === a.accountId && !fired) {
                fired = true;
                await tx.eraseAccount(id, t.clock.now());
              }
              return tx.lockAccount(id);
            },
          }),
        ),
      purgeExpiredRefreshHashes: (n) => t.sessions.purgeExpiredRefreshHashes(n),
      purgeReauthUses: (n) => t.sessions.purgeReauthUses(n),
      signupStateOf: (id) => t.sessions.signupStateOf(id),
      nicknameKeyTaken: (key) => t.sessions.nicknameKeyTaken(key),
      investigationRefsOf: (ids, since) => t.sessions.investigationRefsOf(ids, since),
      accountsMissingEmailRef: (after, n) => t.sessions.accountsMissingEmailRef(after, n),
      contactRefsToRotate: (after, prefix, n) => t.sessions.contactRefsToRotate(after, prefix, n),
      closeInvRefBridge: (label, prefix) => t.sessions.closeInvRefBridge(label, prefix),
      refreshOwner: (h) => t.sessions.refreshOwner(h),
      sessionOf: (id) => t.sessions.sessionOf(id),
      liveSessionsOf: (a, n) => t.sessions.liveSessionsOf(a, n),
      clearEndedDeviceLabels: (n) => t.sessions.clearEndedDeviceLabels(n),
    };
    const create = new CreateSession(racing, t.k.signer, testDeviceRefs(), recordingSignals(), noClaims, t.clock);
    const b = await create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: 'race-1', email: null, deviceId: 'dev-2' });
    expect(fired).toBe(true);
    expect(b.accountId).not.toBe(a.accountId);
    expect(b.newAccount).toBe(true);
    expect(t.sessions.activeCount(a.accountId)).toBe(1);
    expect(t.sessions.deviceCount(a.accountId)).toBe(0);
  });

  test('I-T16_M1_탈퇴한계정의세션이남아있으면_갱신은INVALID이고그세션을끝낸다', async () => {
    const t = await setup();
    const a = await t.login('race-2');
    // 계정만 파기되고 세션이 남은 상태(겹침으로 생긴 세션)를 만든다
    await t.sessions.transaction((tx) => tx.eraseAccount(a.accountId, t.clock.now()));
    expect((await t.k.refresh.run({ refreshToken: a.refreshToken })).result).toBe('INVALID');
    expect(t.sessions.activeCount(a.accountId)).toBe(0);
    expect(t.sessions.terminations(a.accountId).map(([, r]) => r)).toEqual(['DELETE']);
  });

  test('I-T27_M2_탈퇴뒤남은액세스토큰으로본인확인을마쳐도_연계정보를남기지않고FAILED이며_같은사람의새계정은바로본인확인된다', async () => {
    const t = await setup();
    const a = await t.login('race-3');
    const start = () => new StartVerification(t.verifications, t.provider, t.closure, t.clock).run({ accountId: a.accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    const confirm = (verificationId: string) =>
      new ConfirmVerification(t.verifications, t.provider, t.hashers, t.closure, t.clock).run({ accountId: a.accountId, verificationId, providerResult: agencyResult(t.clock, verificationId, { person: 'race-person' }) });
    const before = await start();
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    // 탈퇴 전에 시작한 건은 탈퇴 때 지워져 없는 건이다
    expect(await code(confirm(before.verificationId))).toBe('NOT_FOUND');
    // 탈퇴 뒤 남은 액세스 토큰(최대 15분)으로 새로 시작해 확정해도 FAILED이고 기록을 남기지 않는다
    const after = await start();
    expect((await confirm(after.verificationId)).status).toBe('FAILED');
    expect(await t.verifications.recordOf(a.accountId)).toBeNull();
    const b = await t.login('race-3');
    expect((await t.verify(b.accountId, 'race-person')).status).toBe('VERIFIED');
    expect(await t.verifications.conflictAttempts(b.accountId)).toEqual([]);
    // 탈퇴한 계정은 GetVerificationStatus도 false다(I-T8)
    expect((await t.status.run({ accountId: a.accountId, sessionId: a.sessionId })).verified).toBe(false);
  });

  test('I-T16_탈퇴는만료와상관없이끝나지않은세션을모두끝낸다(만료경계에서갱신과겹쳐도남지않게)', async () => {
    const t = await setup();
    const old = await t.login('exp-1');
    t.clock.advance(15 * DAY);
    const now = await t.login('exp-1');
    await t.withdraw.run({ accountId: now.accountId, sessionId: now.sessionId, reauthToken: await t.reauthToken(now), body: {} });
    expect(t.sessions.peekSession(old.sessionId)?.terminatedAt).toBe(t.clock.now());
    expect(t.sessions.terminations(now.accountId).map(([id, r]) => [id === old.sessionId || id === now.sessionId, r])).toEqual([
      [true, 'DELETE'],
      [true, 'DELETE'],
    ]);
  });

  test('L2_연계정보처리기록의보존끝은_처리한날의달력1년뒤다(윤년에도1년이상)', () => {
    expect(new Date(plusOneYear(Date.parse('2027-03-01T00:00:00Z'))).toISOString()).toBe('2028-03-01T00:00:00.000Z');
    expect(plusOneYear(Date.parse('2028-02-29T12:00:00Z')) - Date.parse('2028-02-29T12:00:00Z')).toBeGreaterThanOrEqual(365 * DAY);
    expect(plusOneYear(Date.parse('2027-03-01T00:00:00Z')) - Date.parse('2027-03-01T00:00:00Z')).toBe(366 * DAY);
  });

  test('L3_정비는한계정의파기가실패해도_나머지계정을끝까지다루고_끝에실패를알린다', async () => {
    let bad = '';
    const t = await setup({ failEraseFor: (id) => id === bad });
    const a = await t.login('sw-1');
    const b = await t.login('sw-2');
    await t.verify(a.accountId, 'sw-person-1');
    await t.verify(b.accountId, 'sw-person-2');
    bad = a.accountId;
    for (const s of [a, b]) await t.withdraw.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: await t.reauthToken(s), body: {} });
    // b도 처음 파기를 실패한 것으로 만든다(기록을 되살릴 수 없어, 처음부터 실패하는 a만 남는다)
    await expect(t.finish.run()).rejects.toThrow(/1/);
    expect(await t.verifications.recordOf(b.accountId)).toBeNull();
    expect(await t.verifications.recordOf(a.accountId)).not.toBeNull();
  });
});

describe('탈퇴 계정의 대기열 키 지우기(BOT-037, I-T27)', () => {
  const iso = (ms: number) => new Date(ms).toISOString();
  const withdrawn = (t: { sessions: MemorySessionStore }) => t.sessions.withdrawnMessages();
  const valueOf = (m: { payload: Uint8Array }) => JSON.parse(Buffer.from(m.payload).toString('utf8')) as Record<string, unknown>;

  test('I-T27_탈퇴하면계정트랜잭션이_pid를실은탈퇴사건을한번적고_purgeBy는탈퇴시각+5일이다', async () => {
    const t = await setup();
    const a = await t.login('q-1');
    await t.verify(a.accountId, 'queue-person');
    const pid = (await t.verifications.claimsOf(a.accountId))!.pid;
    const at = t.clock.now();
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    const ev = withdrawn(t);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ topic: 'identity.accounts-withdrawn', key: a.accountId });
    const v = valueOf(ev[0]!);
    expect(v).toEqual({ eventKey: expect.any(String), accountId: a.accountId, pids: [pid], withdrawnAt: iso(at), purgeBy: iso(at + 5 * DAY) });
    // 계약 모양(asyncapi AccountWithdrawn)
    expect(AccountWithdrawn.safeParse(v).success).toBe(true);
    // 정비가 다시 돌아도 또 적지 않는다
    t.clock.advance(DAY);
    await t.finish.run();
    expect(withdrawn(t)).toHaveLength(1);
  });

  test('I-T27_pid키전환기간에탈퇴하면_옛pid도지금pid뒤에싣는다', async () => {
    const t = await setup();
    const a = await t.login('q-2');
    await t.verify(a.accountId, 'queue-person-2');
    const old = (await t.verifications.claimsOf(a.accountId))!.pid;
    expect(await t.verifications.movePid(a.accountId, Buffer.alloc(32, 9), 2)).toBe(true);
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(valueOf(withdrawn(t)[0]!).pids).toEqual([Buffer.alloc(32, 9).toString('base64url'), old]);
  });

  test('I-T27_본인확인을하지않은계정의탈퇴는_대기열키가없어탈퇴사건을적지않는다', async () => {
    const t = await setup();
    const a = await t.login('q-3');
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
    expect(withdrawn(t)).toEqual([]);
  });

  test('I-T27_본인확인기록파기가실패해도_탈퇴사건은탈퇴트랜잭션에서이미나가고_정비가뒤에지워도다시적지않는다', async () => {
    const t = await setup({ failErase: 1 });
    const a = await t.login('q-4');
    await t.verify(a.accountId, 'queue-person-4');
    const at = t.clock.now();
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(await t.verifications.recordOf(a.accountId)).not.toBeNull();
    expect(withdrawn(t)).toHaveLength(1);
    expect(valueOf(withdrawn(t)[0]!)).toMatchObject({ withdrawnAt: iso(at), purgeBy: iso(at + 5 * DAY) });
    t.clock.advance(DAY);
    expect(await t.finish.run()).toMatchObject({ erased: 1 });
    expect(withdrawn(t)).toHaveLength(1);
  });

  test('I-T27_탈퇴사건을적은뒤트랜잭션이되돌려지면_사건도계정도남지않는다', async () => {
    const t = await setup();
    const a = await t.login('q-5');
    await t.verify(a.accountId, 'queue-person-5');
    const pids = await t.verifications.claimsOf(a.accountId).then((c) => [c!.pid]);
    const failed = await t.sessions
      .transaction(async (tx) => {
        await completeWithdrawal(tx, a.accountId, t.clock.now(), pids);
        throw new Error('사건을 적은 뒤 실패');
      })
      .catch((e: unknown) => e);
    expect(failed).toBeInstanceOf(Error);
    expect(withdrawn(t)).toEqual([]);
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('ACTIVE');
  });

  test('I-T27_만14세미만정리를정비가끝낼때도_본인확인한계정이면탈퇴사건을적는다', async () => {
    const t = await setup();
    const a = await t.login('q-6');
    await t.verify(a.accountId, 'queue-person-6');
    const pid = (await t.verifications.claimsOf(a.accountId))!.pid;
    await t.closure.start(a.accountId, 'UNDER_14');
    t.clock.advance(11 * 60_000);
    const at = t.clock.now();
    await t.finish.run();
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
    expect(withdrawn(t).map(valueOf)).toEqual([{ eventKey: expect.any(String), accountId: a.accountId, pids: [pid], withdrawnAt: iso(at), purgeBy: iso(at + 5 * DAY) }]);
  });
});
