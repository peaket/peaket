// 탈퇴의 첫 구현(docs/features/identity.md §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030, I-T16·I-T27·I-T8, POL-033, [ASVS v5.0.0-7.4.2]).
// 메모리 저장소로 재인증 토큰 1회 사용, 계정·본인확인 기록 파기, 세션 종료, 만 14세 미만 정리 마무리, 리프레시 토큰 해시 지우기를 본다. PostgreSQL은 test-int/withdrawal.int.test.ts.
// 맨 아래 묶음은 탈퇴 참여자와 탈퇴 미룸(identity §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현', ADR-0284, BUILD_ORDER PRF-169, I-T84 ①②③⑤⑥⑦)의 응용 층이다(BAT-010 시험 담당).
// 그 묶음은 구현 전 트리에서도 읽히도록 새 모듈을 가져오지 않는다(참여자는 같은 모양의 객체다. 고리는 test/withdrawal-retry.test.ts, 어댑터는 test/withdrawal-participant.grpc.test.ts).
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { AccountError } from '../src/modules/session/application/account-error.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { FinishWithdrawals } from '../src/modules/session/application/finish-withdrawals.js';
import { GetVerificationStatus } from '../src/modules/session/application/get-verification-status.js';
import { completeWithdrawal, WithdrawAccount } from '../src/modules/session/application/withdraw-account.js';
import type { AccountEraser, SessionStore } from '../src/modules/session/domain/ports.js';
import { type UnusedTicketsQuote, WithdrawalParticipantUnavailable } from '../src/modules/session/domain/withdrawal.js';
import { CreateSession } from '../src/modules/session/application/create-session.js';
import { plusOneYear } from '../src/modules/verification/domain/verification.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { VerificationEraser } from '../src/modules/verification/adapters/verification-eraser.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { VerificationError } from '../src/modules/verification/application/verification-error.js';
import { AccountWithdrawn, SessionTerminated } from '@peaket/contracts/asyncapi';
import { VerificationHolds } from '../src/modules/verification/adapters/verification-holds.js';
import { SetRestrictedCiHold } from '../src/modules/verification/application/set-restricted-ci-hold.js';
import type { ReauthOperation } from '../src/modules/session/domain/session.js';
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
  const staff = new MemoryStaffAssignmentStore();
  const withdraw = new WithdrawAccount(sessions, reauth, eraser, clock, undefined, staff);
  const finish = new FinishWithdrawals(sessions, eraser, clock);
  const login = (id: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: id, email: `${id}@kakao.test`, deviceId: 'dev-1' });
  const verify = async (accountId: string, person: string, birth = '2000-01-01') => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    return new ConfirmVerification(verifications, provider, hashers, closure, clock).run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person, birth }) });
  };
  const reauthToken = async (s: { accountId: string; sessionId: string }, operation: ReauthOperation = 'ACCOUNT_WITHDRAW', o2: { now?: number } = {}) =>
    (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', operation }, o2.now ?? clock.now())).token;
  return { clock, sessions, verifications, staff, k, withdraw, finish, login, verify, reauthToken, closure, claims, provider, hashers, status: new GetVerificationStatus(sessions, claims, clock) };
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

  test('탈퇴하면 그 계정의 스태프 배정을 끝내고 스태너 세션 종료 사건을 남긴다', async () => {
    const t = await setup();
    const a = await t.login('w-staff');
    await t.verify(a.accountId, 'staff-person');
    const HOUR = 60 * 60_000;
    t.staff.assignments.set('a-staff', { id: 'a-staff', accountId: a.accountId, status: 'ASSIGNED', eventId: 'ev-1', validFromMs: t.clock.now() - HOUR, validUntilMs: t.clock.now() + HOUR, inviteExpiresAtMs: t.clock.now() + HOUR, invitedBy: 'admin' });
    t.staff.sessions.set('ss-staff', { scannerSessionId: 'ss-staff', assignmentId: 'a-staff', accountId: a.accountId, deviceId: 'dev-1', role: 'gate_staff', proxy: false, expiresAt: t.clock.now() + HOUR, terminatedAt: null, assignmentStatus: 'ASSIGNED', validFrom: t.clock.now() - HOUR, validUntil: t.clock.now() + HOUR, eventId: 'ev-1' });
    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(t.staff.assignments.get('a-staff')?.status).toBe('REVOKED');
    expect(t.staff.sessions.get('ss-staff')?.terminatedAt).toBe(t.clock.now());
    expect(t.staff.terminatedEvents).toEqual([{ accountId: a.accountId, sessionId: 'ss-staff', reason: 'STAFF_REVOKED', terminatedAt: new Date(t.clock.now()).toISOString() }]);
  });

  test('탈퇴는 그 계정의 살아 있는 스캐너 세션을 모두 끝내고 STAFF_REVOKED 사건을 계약대로 남기며 다른 계정은 건드리지 않는다(C2-01)', async () => {
    const t = await setup();
    const a = await t.login('w-staff-multi');
    await t.verify(a.accountId, 'staff-person');
    const HOUR = 60 * 60_000;
    const now = t.clock.now();
    const assignment = (id: string, accountId: string) => ({
      id,
      accountId,
      status: 'ASSIGNED' as const,
      eventId: `ev-${id}`,
      validFromMs: now - HOUR,
      validUntilMs: now + HOUR,
      inviteExpiresAtMs: now + HOUR,
      invitedBy: 'admin',
    });
    const session = (id: string, assignmentId: string, accountId: string) => ({
      scannerSessionId: id,
      assignmentId,
      accountId,
      deviceId: `dev-${id}`,
      role: 'gate_staff' as const,
      proxy: false,
      expiresAt: now + HOUR,
      terminatedAt: null,
      assignmentStatus: 'ASSIGNED' as const,
      validFrom: now - HOUR,
      validUntil: now + HOUR,
      eventId: `ev-${assignmentId}`,
    });
    t.staff.assignments.set('a-1', assignment('a-1', a.accountId));
    t.staff.assignments.set('a-2', assignment('a-2', a.accountId));
    t.staff.assignments.set('a-other', assignment('a-other', 'other-account'));
    t.staff.sessions.set('ss-1', session('ss-1', 'a-1', a.accountId));
    t.staff.sessions.set('ss-2', session('ss-2', 'a-2', a.accountId));
    t.staff.sessions.set('ss-other', session('ss-other', 'a-other', 'other-account'));

    await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });

    expect(t.staff.assignments.get('a-1')?.status).toBe('REVOKED');
    expect(t.staff.assignments.get('a-2')?.status).toBe('REVOKED');
    expect(t.staff.assignments.get('a-other')?.status).toBe('ASSIGNED');
    expect(t.staff.sessions.get('ss-1')?.terminatedAt).toBe(now);
    expect(t.staff.sessions.get('ss-2')?.terminatedAt).toBe(now);
    expect(t.staff.sessions.get('ss-other')?.terminatedAt).toBeNull();
    expect(t.staff.terminatedEvents.map((e) => e.sessionId).sort()).toEqual(['ss-1', 'ss-2']);
    for (const e of t.staff.terminatedEvents) expect(SessionTerminated.safeParse(e).success).toBe(true);
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
    expect(await code(run(await t.reauthToken(a, 'TRANSFER_REQUEST')))).toBe('REAUTH_REQUIRED');
    // 5분이 지난 토큰
    const old = await t.reauthToken(a, 'ACCOUNT_WITHDRAW', { now: t.clock.now() - 6 * 60_000 });
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
    expect(await t.status.run({ accountId: a.accountId, sessionId: a.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: false });
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

// ---- 탈퇴 참여자와 탈퇴 미룸(I-T84, BAT-010) ----
// 값은 정본에서 적는다: 다음 확인 = 요청 시각 + 60초, 요청 경로 데드라인 3초(identity §8 '미룸 표시'·'참여자 호출'). 코드 상수를 가져오지 않는다.
// 시계는 둥근 시각이 아닌 곳에서 시작해 '+ 60초'를 다른 값과 가린다.

type Answer = { state: 'DONE' } | { state: 'PENDING'; reasons: readonly string[] };
interface ParticipantCall {
  accountId: string;
  deadlineMs: number;
  /** 부른 때의 계정 상태(미룸 표시가 호출 앞에 커밋됐는지 본다) */
  statusAtCall: string | undefined;
  reasonAtCall: string | undefined;
}

/** 이름과 답을 정하는 참여자 대역. answer가 던지면 '답하지 않음'이다 */
function recordingParticipant(sessions: MemorySessionStore, answer: (accountId: string) => Promise<Answer>, name = 'purchase') {
  const calls: ParticipantCall[] = [];
  return {
    calls,
    participant: {
      name,
      process: async (accountId: string, o: { deadlineMs: number }): Promise<Answer> => {
        const a = sessions.accountOf(accountId);
        calls.push({ accountId, deadlineMs: o.deadlineMs, statusAtCall: a?.status, reasonAtCall: a?.closureReason });
        return answer(accountId);
      },
    },
  };
}

const START = Date.parse('2026-11-18T09:13:27.431Z');
const NEXT_CHECK_MS = 60_000;
const REQUEST_DEADLINE_MS = 3_000;

async function participantSetup(answers: Array<(accountId: string) => Promise<Answer>>) {
  const t = await setup();
  t.clock.advance(START - t.clock.now());
  const participants = answers.map((a, i) => recordingParticipant(t.sessions, a, i === 0 ? 'purchase' : `other-${i}`));
  const holds = new VerificationHolds(t.verifications);
  const reauth = new JoseReauthVerifier(t.k.keys, ISSUER, t.clock);
  const eraser = new VerificationEraser(t.verifications);
  // 생성자 뒤 두 칸(참여자 목록·지표)은 구현 전 트리에 없어도 넘겨진다(그 트리에서는 무시된다)
  const withdrawP = new (WithdrawAccount as unknown as new (...a: unknown[]) => WithdrawAccount)(t.sessions, reauth, eraser, t.clock, holds, t.staff, undefined, participants.map((p) => p.participant), undefined);
  return { ...t, participants, calls: participants[0]?.calls ?? [], withdrawP, hold: new SetRestrictedCiHold(t.verifications, t.clock) };
}

const DONE = async (): Promise<Answer> => ({ state: 'DONE' });
const PENDING = async (): Promise<Answer> => ({ state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER'] });
const NO_ANSWER = async (): Promise<Answer> => {
  throw new Error('참여자가 답하지 않았다(주입)');
};

describe('탈퇴 참여자와 탈퇴 미룸의 응용 층(I-T84, BAT-010)', () => {
  test('I-T84①_참여자가모두DONE이면_WITHDRAWN이고계정은DELETED·살아있던세션은모두DELETE로끝나며_본인확인한계정은탈퇴사건한건_참여자는그계정ID로요청경로데드라인3초에불린다 [ASVS v5.0.0-7.4.2]', async () => {
    const t = await participantSetup([DONE, DONE]);
    const a = await t.login('p84-1');
    await t.login('p84-1');
    await t.verify(a.accountId, 'p84-person-1');
    const r = await t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(r).toEqual({ outcome: 'WITHDRAWN' });
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'DELETED', deletedAt: START });
    expect(t.sessions.activeCount(a.accountId)).toBe(0);
    expect(t.sessions.terminations(a.accountId).map(([, why]) => why)).toEqual(['DELETE', 'DELETE']);
    expect(t.sessions.withdrawnMessages()).toHaveLength(1);
    expect(t.sessions.withdrawnMessages()[0]).toMatchObject({ topic: 'identity.accounts-withdrawn', key: a.accountId });
    for (const p of t.participants) expect(p.calls.map((c) => [c.accountId, c.deadlineMs])).toEqual([[a.accountId, REQUEST_DEADLINE_MS]]);
    expect(await t.verifications.recordOf(a.accountId)).toBeNull();
  });

  test('I-T84②_참여자하나라도PENDING이면_DEFERRED이고_WITHDRAWAL_PENDING·사유WITHDRAWAL·시작=요청시각·다음확인=요청시각+60초_프로필·세션·본인확인기록그대로·탈퇴사건없음_쓴재인증토큰은다시403', async () => {
    const t = await participantSetup([DONE, PENDING]);
    const a = await t.login('p84-2');
    const b = await t.login('p84-2');
    await t.verify(a.accountId, 'p84-person-2');
    const before = { ...t.sessions.accountOf(a.accountId)! };
    const token = await t.reauthToken(a);
    const r = await t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} });
    expect(r).toEqual({ outcome: 'DEFERRED' });
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL', closureStartedAt: START, closureNextCheckAt: START + NEXT_CHECK_MS });
    // 프로필(이메일)·로그인 수단·기기·세션·본인확인 기록은 그대로다
    expect(before.email).toBe('p84-2@kakao.test');
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ email: before.email, emailVerified: before.emailVerified });
    expect(t.sessions.accountOf(a.accountId)?.deletedAt).toBeUndefined();
    expect(t.sessions.providerCount(a.accountId)).toBe(1);
    expect(t.sessions.deviceCount(a.accountId)).toBe(1);
    expect(t.sessions.activeCount(a.accountId)).toBe(2);
    expect(t.sessions.terminations(a.accountId)).toEqual([]);
    expect(await t.verifications.recordOf(a.accountId)).not.toBeNull();
    expect(t.sessions.withdrawnMessages()).toEqual([]);
    // 미룸 표시는 참여자 호출보다 먼저 커밋된다(부른 때 이미 WITHDRAWAL_PENDING·WITHDRAWAL)
    for (const p of t.participants) expect(p.calls).toEqual([{ accountId: a.accountId, deadlineMs: REQUEST_DEADLINE_MS, statusAtCall: 'WITHDRAWAL_PENDING', reasonAtCall: 'WITHDRAWAL' }]);
    // 쓴 재인증 토큰은 다시 쓰지 못한다(참여자도 다시 부르지 않는다)
    expect(await code(t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} }))).toBe('REAUTH_REQUIRED');
    expect(t.calls).toHaveLength(1);
    // 다른 세션의 갱신은 된다(세션이 살아 있다)
    expect((await t.k.refresh.run({ refreshToken: b.refreshToken })).result).toBe('OK');
  });

  test('I-T84②_재인증이맞지않으면(없음·다른세션·다른계정의토큰)403이고_참여자를부르지않으며계정은ACTIVE그대로다', async () => {
    const t = await participantSetup([PENDING]);
    const a = await t.login('p84-3');
    const second = await t.login('p84-3');
    const other = await t.login('p84-3-other');
    const run = (token: string) => t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} });
    expect(await code(run(''))).toBe('REAUTH_REQUIRED');
    expect(await code(run(await t.reauthToken(second)))).toBe('REAUTH_REQUIRED');
    expect(await code(run(await t.reauthToken(other)))).toBe('REAUTH_REQUIRED');
    expect(t.calls).toEqual([]);
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'ACTIVE' });
    expect(t.sessions.accountOf(a.accountId)?.closureReason).toBeUndefined();
  });

  test('I-T84③_참여자가답하지않으면(던짐)_204가아니라②와같은DEFERRED·미룸상태이고_DONE·PENDING과섞여도DONE으로접지않는다', async () => {
    const cases: Array<[string, Array<(accountId: string) => Promise<Answer>>]> = [
      ['alone', [NO_ANSWER]],
      ['done-first', [DONE, NO_ANSWER]],
      ['done-last', [NO_ANSWER, DONE]],
      ['pending', [NO_ANSWER, PENDING]],
    ];
    for (const [name, answers] of cases) {
      const t = await participantSetup(answers);
      const a = await t.login(`p84-4-${name}`);
      await t.verify(a.accountId, `p84-person-4-${name}`);
      const r = await t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
      expect({ name, r }).toEqual({ name, r: { outcome: 'DEFERRED' } });
      expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL', closureStartedAt: START, closureNextCheckAt: START + NEXT_CHECK_MS });
      expect(t.sessions.activeCount(a.accountId)).toBe(1);
      expect(t.sessions.withdrawnMessages()).toEqual([]);
      expect(await t.verifications.recordOf(a.accountId)).not.toBeNull();
      for (const p of t.participants) expect(p.calls.map((c) => c.deadlineMs)).toEqual([REQUEST_DEADLINE_MS]);
    }
  });

  test('I-T84①_장애주입_참여자가모두DONE인데끝내기트랜잭션이실패하면_500(던짐)이아니라DEFERRED이고_계정은미룸으로남는다', async () => {
    const t = await participantSetup([]);
    let failNext = false;
    let injected = 0;
    const flaky = new Proxy(t.sessions, {
      get(target, prop) {
        if (prop === 'transaction')
          return (fn: Parameters<SessionStore['transaction']>[0]) => {
            if (failNext) {
              failNext = false;
              injected++;
              return Promise.reject(new Error('주입한 DB 장애(끝내기 트랜잭션)'));
            }
            return target.transaction(fn);
          };
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    // 참여자가 DONE으로 답하는 바로 그때 다음 트랜잭션(끝내기)을 실패시킨다
    const calls: string[] = [];
    const participant = {
      name: 'purchase',
      process: async (accountId: string) => {
        calls.push(accountId);
        failNext = true;
        return { state: 'DONE' as const };
      },
    };
    const withdraw = new (WithdrawAccount as unknown as new (...a: unknown[]) => WithdrawAccount)(flaky, new JoseReauthVerifier(t.k.keys, ISSUER, t.clock), new VerificationEraser(t.verifications), t.clock, undefined, t.staff, undefined, [participant], undefined);
    const a = await t.login('p84-5');
    await t.verify(a.accountId, 'p84-person-5');
    const r = await withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(calls).toEqual([a.accountId]);
    // 끊는 자리가 참여자 답 뒤의 끝내기 트랜잭션에 실제로 닿았다
    expect(injected).toBe(1);
    expect(r).toEqual({ outcome: 'DEFERRED' });
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL', closureNextCheckAt: START + NEXT_CHECK_MS });
    expect(t.sessions.withdrawnMessages()).toEqual([]);
  });

  test('I-T84⑤_미룬계정이새재인증토큰으로다시요청하면_참여자를다시부르고_PENDING이면DEFERRED·시작시각그대로·다음확인=다시요청시각+60초_DONE이면WITHDRAWN', async () => {
    let next: () => Promise<Answer> = PENDING;
    const t = await participantSetup([() => next()]);
    const a = await t.login('p84-6');
    await t.verify(a.accountId, 'p84-person-6');
    expect(await t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} })).toEqual({ outcome: 'DEFERRED' });
    // 37.5초 뒤 다시 요청(60초 고리보다 앞)
    t.clock.advance(37_500);
    const again = t.clock.now();
    expect(await t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} })).toEqual({ outcome: 'DEFERRED' });
    expect(t.calls.map((c) => [c.accountId, c.statusAtCall, c.reasonAtCall])).toEqual([
      [a.accountId, 'WITHDRAWAL_PENDING', 'WITHDRAWAL'],
      [a.accountId, 'WITHDRAWAL_PENDING', 'WITHDRAWAL'],
    ]);
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL', closureStartedAt: START, closureNextCheckAt: again + NEXT_CHECK_MS });
    // 셋째 요청에서 참여자가 DONE이면 끝낸다
    t.clock.advance(1_250);
    next = DONE;
    expect(await t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} })).toEqual({ outcome: 'WITHDRAWN' });
    expect(t.calls).toHaveLength(3);
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'DELETED', deletedAt: t.clock.now() });
    expect(t.sessions.withdrawnMessages()).toHaveLength(1);
  });

  test('I-T84⑤_미룬동안로그인·토큰갱신은되고_새액세스토큰에는ticket:buy와pid가없다', async () => {
    const t = await participantSetup([PENDING]);
    const a = await t.login('p84-7');
    await t.verify(a.accountId, 'p84-person-7');
    // 미루기 전에는 ticket:buy·pid가 실린다(대조)
    const pre = payload((await t.login('p84-7')).accessToken);
    expect(pre.scope).toBe('ticket:buy');
    expect(pre.pid).toEqual(expect.any(String));
    await t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('WITHDRAWAL_PENDING');
    const s = await t.login('p84-7');
    expect(s.accountId).toBe(a.accountId);
    const tok = payload(s.accessToken);
    expect(tok.scope).toBeUndefined();
    expect(tok.pid).toBeUndefined();
    const refreshed = await t.k.refresh.run({ refreshToken: s.refreshToken });
    expect(refreshed.result).toBe('OK');
    const rt = payload((refreshed as { accessToken: string }).accessToken);
    expect(rt.scope).toBeUndefined();
    expect(rt.pid).toBeUndefined();
  });

  test('I-T84⑥_GetVerificationStatus는살아있는세션의탈퇴미룸계정에verified거짓·withdrawalPending참이고_끝난세션·다른계정세션·UNDER_14정리중·ACTIVE계정은거짓이다', async () => {
    const t = await participantSetup([PENDING]);
    const a = await t.login('p84-8');
    const ended = await t.login('p84-8');
    await t.verify(a.accountId, 'p84-person-8');
    // 미루기 전(ACTIVE·본인확인함): verified 참·withdrawalPending 거짓
    expect(await t.status.run({ accountId: a.accountId, sessionId: a.sessionId })).toMatchObject({ verified: true, withdrawalPending: false });
    await t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(await t.status.run({ accountId: a.accountId, sessionId: a.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: true });
    // 끝난 세션은 거짓
    await t.k.end.run({ sessionId: ended.sessionId, accountId: ended.accountId });
    expect(await t.status.run({ accountId: a.accountId, sessionId: ended.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: false });
    // 다른 계정의 세션으로 물어도 거짓
    const other = await t.login('p84-8-other');
    expect(await t.status.run({ accountId: a.accountId, sessionId: other.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: false });
    // 만 14세 미만 정리 중(UNDER_14)은 거짓
    const kid = await t.login('p84-8-kid');
    expect(await code(t.verify(kid.accountId, 'p84-kid', '2014-05-05'))).toBe('UNDER_14');
    expect(t.sessions.accountOf(kid.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'UNDER_14' });
    expect(await t.status.run({ accountId: kid.accountId, sessionId: kid.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: false });
    // ACTIVE이고 본인확인 전인 계정도 거짓
    expect(await t.status.run({ accountId: other.accountId, sessionId: other.sessionId })).toEqual({ verified: false, pid: '', previousPid: '', withdrawalPending: false });
  });

  test('I-T84⑦_대조값보관행이있으면지금처럼409이고_계정은ACTIVE그대로이며참여자는불리지않는다_보관을확인하고다시보내면참여자를부른다', async () => {
    const t = await participantSetup([PENDING]);
    const a = await t.login('p84-9');
    await t.verify(a.accountId, 'p84-person-9');
    expect(await t.hold.run({ accountId: a.accountId, fraudCaseId: '0190f3a1-7c2e-7a00-8000-0000000084a9', state: 'CASE_OPEN', until: START + 30 * DAY, version: 1 })).toBe('OK');
    const token = await t.reauthToken(a);
    expect(await code(t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} }))).toBe('CONFIRMATION_REQUIRED');
    expect(t.calls).toEqual([]);
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'ACTIVE' });
    expect(t.sessions.accountOf(a.accountId)?.closureReason).toBeUndefined();
    // 409는 토큰을 쓰지 않는다: 같은 토큰에 acknowledgeFraudHold를 실으면 참여자에 간다
    expect(await t.withdrawP.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: { acknowledgeFraudHold: true } })).toEqual({ outcome: 'DEFERRED' });
    expect(t.calls.map((c) => c.accountId)).toEqual([a.accountId]);
  });

  test('I-T84⑦_만14세미만으로정리중인계정의재인증탈퇴는_참여자를부르지않고바로끝낸다', async () => {
    const t = await participantSetup([PENDING]);
    const kid = await t.login('p84-10');
    expect(await code(t.verify(kid.accountId, 'p84-kid-10', '2014-01-01'))).toBe('UNDER_14');
    const r = await t.withdrawP.run({ accountId: kid.accountId, sessionId: kid.sessionId, reauthToken: await t.reauthToken(kid), body: {} });
    expect(r).toEqual({ outcome: 'WITHDRAWN' });
    expect(t.calls).toEqual([]);
    expect(t.sessions.accountOf(kid.accountId)?.status).toBe('DELETED');
  });
});

// ---- 미사용 티켓 확인 409·503의 응용 층(I-T26 ①, identity §8 '미사용 티켓 확인과 취소', BAT-013) ----
// 값은 정본에서 적는다: 견적 데드라인 2초 [가정], POL-032 예(33,333원 20% = 6,666/26,667, 132,500원 10% = 13,250/119,250).
// 코드 상수를 가져오지 않는다.
const QUOTE_DEADLINE_MS = 2_000;
const TWO_TICKETS: UnusedTicketsQuote = {
  count: 2,
  ticketAmount: 165_833,
  deductionAmount: 19_916,
  refundAmount: 145_917,
  transferableCount: 1,
  deferredRefundCount: 1,
};

interface QuoteCall {
  accountId: string;
  deadlineMs: number;
}

/** 견적 대역(이름·답을 정한다. answer가 던지면 견적 실패) */
function quotingParticipant(name: string, answer: () => Promise<UnusedTicketsQuote | undefined>) {
  const quotes: QuoteCall[] = [];
  let processes = 0;
  const participant = {
    name,
    process: async () => {
      processes++;
      return { state: 'DONE' as const };
    },
    unusedTickets: async (accountId: string, o: { deadlineMs: number }): Promise<UnusedTicketsQuote | undefined> => {
      quotes.push({ accountId, deadlineMs: o.deadlineMs });
      return answer();
    },
  };
  return { participant, quotes, processes: () => processes };
}

/** 참여자 목록을 넣은 탈퇴(생성자 뒤 두 칸은 구현 전 트리에 없어도 넘겨진다) */
function withdrawWith(t: Awaited<ReturnType<typeof setup>>, participants: unknown[], holds?: VerificationHolds) {
  return new (WithdrawAccount as unknown as new (...a: unknown[]) => WithdrawAccount)(
    t.sessions,
    new JoseReauthVerifier(t.k.keys, ISSUER, t.clock),
    new VerificationEraser(t.verifications),
    t.clock,
    holds,
    t.staff,
    undefined,
    participants,
    undefined,
  );
}

const errorOf = async (p: Promise<unknown>): Promise<AccountError> => {
  const e = await p.then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(AccountError);
  return e as AccountError;
};

describe('미사용 티켓 확인의 응용 층(I-T26 ①, BAT-013)', () => {
  test('I-T26 ①_견적이0장(undefined)이면확인없이진행하고_견적은미룸표시전에2초데드라인으로부른다', async () => {
    const t = await setup();
    const p = quotingParticipant('purchase', async () => undefined);
    const withdraw = withdrawWith(t, [p.participant]);
    const a = await t.login('q26-1');
    const r = await withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauthToken(a), body: {} });
    expect(r).toEqual({ outcome: 'WITHDRAWN' });
    expect(p.quotes).toEqual([{ accountId: a.accountId, deadlineMs: QUOTE_DEADLINE_MS }]);
    expect(p.processes()).toBe(1);
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
  });

  test('I-T26 ①_견적에값이있으면CONFIRMATION_REQUIRED에값이실리고_재인증토큰을쓰지않으며_확인뒤같은토큰으로진행하고견적을다시부르지않는다', async () => {
    const t = await setup();
    const p = quotingParticipant('purchase', async () => TWO_TICKETS);
    const withdraw = withdrawWith(t, [p.participant]);
    const a = await t.login('q26-2');
    const token = await t.reauthToken(a);
    const e = await errorOf(withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} }));
    expect(e.code).toBe('CONFIRMATION_REQUIRED');
    expect(e.unusedTickets).toEqual(TWO_TICKETS);
    // 409는 토큰도 계정도 쓰지 않는다
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('ACTIVE');
    expect(p.processes()).toBe(0);
    // 같은 토큰에 확인을 실으면 진행한다. 확인을 지난 요청은 견적을 다시 부르지 않는다
    expect(await withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: { confirmCancelUnusedTickets: true } })).toEqual({ outcome: 'WITHDRAWN' });
    expect(p.quotes).toHaveLength(1);
    expect(p.processes()).toBe(1);
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
  });

  test('I-T26 ①_견적참여자가던지면DEPENDENCY_UNAVAILABLE이고_트랜잭션을열지않으며계정은ACTIVE그대로다', async () => {
    const t = await setup();
    let transactions = 0;
    const counting = new Proxy(t.sessions, {
      get(target, prop) {
        if (prop === 'transaction')
          return (fn: Parameters<SessionStore['transaction']>[0]) => {
            transactions++;
            return target.transaction(fn);
          };
        const v = Reflect.get(target, prop, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const p = quotingParticipant('purchase', async () => {
      throw new WithdrawalParticipantUnavailable('purchase', new Error('주입한 견적 실패'));
    });
    const withdraw = new (WithdrawAccount as unknown as new (...a: unknown[]) => WithdrawAccount)(counting, new JoseReauthVerifier(t.k.keys, ISSUER, t.clock), new VerificationEraser(t.verifications), t.clock, undefined, t.staff, undefined, [p.participant], undefined);
    const a = await t.login('q26-3');
    const token = await t.reauthToken(a);
    expect(await code(withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} }))).toBe('DEPENDENCY_UNAVAILABLE');
    expect(transactions).toBe(0);
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('ACTIVE');
    // 토큰을 쓰지 않았으므로 같은 토큰으로 다시 보낼 수 있다
    expect((await t.k.refresh.run({ refreshToken: a.refreshToken })).result).toBe('OK');
  });

  test('I-T26 ①_견적참여자가둘이면값을더한다(지금은purchase하나지만포트계약)', async () => {
    const t = await setup();
    const one = (n: number): UnusedTicketsQuote => ({ count: 1, ticketAmount: 33_333, deductionAmount: 6_666, refundAmount: 26_667, transferableCount: n === 1 ? 1 : 0, deferredRefundCount: n === 1 ? 0 : 1 });
    const a = quotingParticipant('purchase', async () => one(1));
    const b = quotingParticipant('other', async () => one(2));
    const withdraw = withdrawWith(t, [a.participant, b.participant]);
    const s = await t.login('q26-4');
    const e = await errorOf(withdraw.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: await t.reauthToken(s), body: {} }));
    expect(e.code).toBe('CONFIRMATION_REQUIRED');
    expect(e.unusedTickets).toEqual({ count: 2, ticketAmount: 66_666, deductionAmount: 13_332, refundAmount: 53_334, transferableCount: 1, deferredRefundCount: 1 });
    expect(a.processes()).toBe(0);
    expect(b.processes()).toBe(0);
  });

  test('I-T26 ①_보관409와견적409가겹치면보관안내가먼저이고_보관을확인하면견적409다_두값을함께실으면진행한다', async () => {
    const t = await setup();
    const holds = new VerificationHolds(t.verifications);
    const p = quotingParticipant('purchase', async () => TWO_TICKETS);
    const withdraw = withdrawWith(t, [p.participant], holds);
    const a = await t.login('q26-5');
    await t.verify(a.accountId, 'q26-5-person');
    expect(await new SetRestrictedCiHold(t.verifications, t.clock).run({ accountId: a.accountId, fraudCaseId: '0190f3a1-7c2e-7a00-8000-0000000026a1', state: 'CASE_OPEN', until: t.clock.now() + 30 * DAY, version: 1 })).toBe('OK');
    const token = await t.reauthToken(a);
    const first = await errorOf(withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: {} }));
    expect(first.code).toBe('CONFIRMATION_REQUIRED');
    expect(first.fraudHold).toBeDefined();
    expect(first.unusedTickets).toBeUndefined();
    // 보관을 확인하면 이번엔 견적 409다(같은 토큰, 토큰을 쓰지 않는다). 견적은 아직 부르지 않았다
    const second = await errorOf(withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: { acknowledgeFraudHold: true } }));
    expect(second.code).toBe('CONFIRMATION_REQUIRED');
    expect(second.fraudHold).toBeUndefined();
    expect(second.unusedTickets).toEqual(TWO_TICKETS);
    // 두 값을 함께 실으면 진행한다
    expect(await withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: token, body: { acknowledgeFraudHold: true, confirmCancelUnusedTickets: true } })).toEqual({ outcome: 'WITHDRAWN' });
  });
});
