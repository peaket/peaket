// 탈퇴 미룸 다시 하기 고리 withdrawal-pending-retry(docs/features/identity.md §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현' '다시 하기 고리'·'지표', ADR-0284 결정 4,
// docs/data.md §5.1 '탈퇴 미룸 다시 하기 고리', BUILD_ORDER PRF-169, I-T84 ①④⑦)를 메모리 저장소로 본다(BAT-010 시험 담당).
// PostgreSQL의 잡기 문장(SKIP LOCKED·두 파드)은 test-int/withdrawal-participant.int.test.ts가 본다.
// 값은 정본에서 적는다: 간격·다음 확인 60초, 한 바퀴 20개, 고리 데드라인 10초, 요청 경로 데드라인 3초. 코드 상수를 가져오지 않는다.
import { fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { JoseReauthVerifier } from '../src/modules/session/adapters/jose-reauth-verifier.js';
import { MemorySessionStore } from '../src/modules/session/adapters/memory-session-store.js';
import { MemoryStaffAssignmentStore } from '../src/modules/session/adapters/memory-staff-assignment-store.js';
import { CloseAccount } from '../src/modules/session/application/close-account.js';
import { RetryPendingWithdrawals } from '../src/modules/session/application/retry-pending-withdrawals.js';
import { WithdrawAccount } from '../src/modules/session/application/withdraw-account.js';
import type { SessionStore } from '../src/modules/session/domain/ports.js';
import { WithdrawalParticipantUnavailable, type WithdrawalParticipant, type WithdrawalParticipantAnswer, type WithdrawalSignals } from '../src/modules/session/domain/withdrawal.js';
import { HmacIdentityHashers } from '../src/modules/verification/adapters/hmac-identity-hashers.js';
import { MemoryVerificationStore } from '../src/modules/verification/adapters/memory-verification-store.js';
import { VerificationClaims } from '../src/modules/verification/adapters/verification-claims.js';
import { VerificationEraser } from '../src/modules/verification/adapters/verification-eraser.js';
import { ConfirmVerification } from '../src/modules/verification/application/confirm-verification.js';
import { StartVerification } from '../src/modules/verification/application/start-verification.js';
import { agencyResult, ISSUER, kit, newKey, testAgency } from './support.js';

const START = Date.parse('2026-11-18T10:41:05.287Z');
const NEXT_CHECK_MS = 60_000;
const RETRY_DEADLINE_MS = 10_000;
const REQUEST_DEADLINE_MS = 3_000;
const BATCH = 20;

type Answer = WithdrawalParticipantAnswer;
interface Call {
  accountId: string;
  deadlineMs: number;
}

/** 계정마다 답을 정하는 참여자 대역(정하지 않은 계정은 fallback) */
function scriptedParticipant(fallback: (accountId: string) => Promise<Answer>) {
  const calls: Call[] = [];
  const byAccount = new Map<string, (accountId: string) => Promise<Answer>>();
  const participant: WithdrawalParticipant = {
    name: 'purchase',
    process: async (accountId, o) => {
      calls.push({ accountId, deadlineMs: o.deadlineMs });
      return (byAccount.get(accountId) ?? fallback)(accountId);
    },
  };
  return { participant, calls, byAccount };
}

function recordingWithdrawalSignals(): WithdrawalSignals & { seen: string[]; oldest: number[] } {
  const seen: string[] = [];
  const oldest: number[] = [];
  return { seen, oldest, participant: (p, path, outcome) => void seen.push(`${p}:${path}:${outcome}`), pendingOldest: (s) => void oldest.push(s) };
}

const DONE = async (): Promise<Answer> => ({ state: 'DONE' });
const PENDING = async (): Promise<Answer> => ({ state: 'PENDING', reasons: ['DEPOSIT_CANCEL_PENDING'] });
const UNAVAILABLE = async (): Promise<Answer> => {
  throw new WithdrawalParticipantUnavailable('purchase', new Error('주입한 장애'));
};

async function setup(o: { fallback?: (accountId: string) => Promise<Answer>; store?: (s: MemorySessionStore) => SessionStore } = {}) {
  const clock = fakeClock({ now: START });
  const sessions = new MemorySessionStore();
  const verifications = new MemoryVerificationStore();
  const closure = new CloseAccount(sessions, clock);
  const claims = new VerificationClaims(verifications, closure);
  const k = await kit(sessions, { claims, clock, reverifications: claims });
  const provider = testAgency(clock);
  const hashers = HmacIdentityHashers.single(Buffer.alloc(32, 6), Buffer.alloc(32, 7));
  const eraser = new VerificationEraser(verifications);
  const staff = new MemoryStaffAssignmentStore();
  const p = scriptedParticipant(o.fallback ?? PENDING);
  const signals = recordingWithdrawalSignals();
  const store = o.store ? o.store(sessions) : sessions;
  const withdraw = new WithdrawAccount(store, new JoseReauthVerifier(k.keys, ISSUER, clock), eraser, clock, undefined, staff, undefined, [p.participant], signals);
  const retry = new RetryPendingWithdrawals(sessions, eraser, clock, [p.participant], staff, undefined, signals);
  const login = (id: string) => k.create.run({ idempotencyKey: newKey(), provider: 'kakao', providerUserId: id, email: null, deviceId: null });
  const verify = async (accountId: string, person: string, birth = '2000-01-01') => {
    const st = await new StartVerification(verifications, provider, closure, clock).run({ accountId, sessionId: null, purpose: 'FIRST', next: '/' });
    return new ConfirmVerification(verifications, provider, hashers, closure, clock)
      .run({ accountId, verificationId: st.verificationId, providerResult: agencyResult(clock, st.verificationId, { person, birth }) })
      .catch((e: unknown) => e);
  };
  const reauth = async (s: { accountId: string; sessionId: string }) => (await k.signer.reauth({ accountId: s.accountId, sessionId: s.sessionId, provider: 'kakao', strength: 'verified', purpose: 'sensitive' }, clock.now())).token;
  /** 로그인·본인확인한 계정을 요청 경로로 미룬다(지금 시각에 미룸 표시) */
  const deferred = async (id: string) => {
    const s = await login(id);
    await verify(s.accountId, `${id}-person`);
    p.byAccount.set(s.accountId, PENDING);
    expect(await withdraw.run({ accountId: s.accountId, sessionId: s.sessionId, reauthToken: await reauth(s), body: {} })).toEqual({ outcome: 'DEFERRED' });
    p.byAccount.delete(s.accountId);
    return s;
  };
  return { clock, sessions, verifications, k, withdraw, retry, login, verify, reauth, deferred, p, signals };
}

describe('다시 하기 고리 한 바퀴(I-T84 ④)', () => {
  test('I-T84④_다음확인−1ms에는잡지않고그시각에잡으며_잡으면다음확인=잡은시각+60초이고_고리는데드라인10초로부른다_PENDING이면그대로둔다', async () => {
    const t = await setup();
    const a = await t.deferred('r-1');
    t.p.calls.length = 0;
    t.clock.advance(NEXT_CHECK_MS - 1);
    expect(await t.retry.run()).toEqual({ claimed: 0, withdrawn: 0, deferred: 0, failed: 0 });
    expect(t.p.calls).toEqual([]);
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ closureNextCheckAt: START + NEXT_CHECK_MS });
    t.clock.advance(1);
    const claimedAt = t.clock.now();
    t.p.byAccount.set(a.accountId, PENDING);
    expect(await t.retry.run()).toEqual({ claimed: 1, withdrawn: 0, deferred: 1, failed: 0 });
    expect(t.p.calls).toEqual([{ accountId: a.accountId, deadlineMs: RETRY_DEADLINE_MS }]);
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL', closureStartedAt: START, closureNextCheckAt: claimedAt + NEXT_CHECK_MS });
    expect(t.sessions.activeCount(a.accountId)).toBe(1);
    expect(t.sessions.withdrawnMessages()).toEqual([]);
    // 같은 시각에 다시 돌면 잡지 않는다(다음 확인이 밀렸다)
    expect(await t.retry.run()).toMatchObject({ claimed: 0 });
  });

  test('I-T84④_참여자가DONE이면①과같은끝내기(DELETED·세션DELETE·탈퇴사건한건)를하고_실패면상태를그대로둔다', async () => {
    const t = await setup();
    const ok = await t.deferred('r-2-ok');
    const bad = await t.deferred('r-2-bad');
    await t.login('r-2-ok');
    t.p.byAccount.set(ok.accountId, DONE);
    t.p.byAccount.set(bad.accountId, UNAVAILABLE);
    t.clock.advance(NEXT_CHECK_MS);
    expect(await t.retry.run()).toEqual({ claimed: 2, withdrawn: 1, deferred: 0, failed: 1 });
    expect(t.sessions.accountOf(ok.accountId)).toMatchObject({ status: 'DELETED', deletedAt: t.clock.now() });
    expect(t.sessions.activeCount(ok.accountId)).toBe(0);
    expect(t.sessions.terminations(ok.accountId).map(([, r]) => r)).toEqual(['DELETE', 'DELETE']);
    expect(t.sessions.withdrawnMessages().map((m) => m.key)).toEqual([ok.accountId]);
    expect(await t.verifications.recordOf(ok.accountId)).toBeNull();
    expect(t.sessions.accountOf(bad.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL', closureStartedAt: START, closureNextCheckAt: t.clock.now() + NEXT_CHECK_MS });
    expect(t.sessions.activeCount(bad.accountId)).toBe(1);
    expect(await t.verifications.recordOf(bad.accountId)).not.toBeNull();
  });

  test('I-T84④_장애주입_한계정의참여자실패가다른계정의끝내기를막지않는다(다음확인순으로첫계정이실패)', async () => {
    const t = await setup();
    const first = await t.deferred('r-3-first');
    t.clock.advance(5);
    const second = await t.deferred('r-3-second');
    let failedFirst = 0;
    t.p.byAccount.set(first.accountId, async () => {
      failedFirst++;
      throw new Error('주입한 장애(첫 계정)');
    });
    t.p.byAccount.set(second.accountId, DONE);
    t.clock.advance(NEXT_CHECK_MS);
    t.p.calls.length = 0;
    expect(await t.retry.run()).toEqual({ claimed: 2, withdrawn: 1, deferred: 0, failed: 1 });
    // 끊긴 사례가 실제로 있었고 차례가 다음 확인 시각 순이다
    expect(failedFirst).toBe(1);
    expect(t.p.calls.map((c) => c.accountId)).toEqual([first.accountId, second.accountId]);
    expect(t.sessions.accountOf(second.accountId)?.status).toBe('DELETED');
    expect(t.sessions.accountOf(first.accountId)?.status).toBe('WITHDRAWAL_PENDING');
  });

  test('I-T84④_정리사유UNDER_14인계정과ACTIVE·DELETED계정은잡지않는다', async () => {
    const t = await setup({ fallback: DONE });
    const kid = await t.login('r-4-kid');
    expect(await t.verify(kid.accountId, 'r-4-kid', '2014-03-03')).toMatchObject({ code: 'UNDER_14' });
    expect(t.sessions.accountOf(kid.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'UNDER_14' });
    const active = await t.login('r-4-active');
    const gone = await t.login('r-4-gone');
    expect(await t.withdraw.run({ accountId: gone.accountId, sessionId: gone.sessionId, reauthToken: await t.reauth(gone), body: {} })).toEqual({ outcome: 'WITHDRAWN' });
    t.p.calls.length = 0;
    t.clock.advance(30 * 86_400_000);
    expect(await t.retry.run()).toEqual({ claimed: 0, withdrawn: 0, deferred: 0, failed: 0 });
    expect(t.p.calls).toEqual([]);
    expect(t.sessions.accountOf(kid.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'UNDER_14' });
    expect(t.sessions.accountOf(active.accountId)?.status).toBe('ACTIVE');
  });

  test('I-T84④_한바퀴는20개까지잡는다(21개면20개·다음확인이이른차례)_남은하나는다음바퀴가잡는다', async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < BATCH + 1; i++) {
      ids.push((await t.deferred(`r-5-${i}`)).accountId);
      t.clock.advance(3);
    }
    t.p.calls.length = 0;
    t.clock.advance(NEXT_CHECK_MS);
    expect(await t.retry.run()).toMatchObject({ claimed: BATCH, deferred: BATCH });
    expect(t.p.calls.map((c) => c.accountId).sort()).toEqual(ids.slice(0, BATCH).sort());
    t.p.calls.length = 0;
    expect(await t.retry.run()).toMatchObject({ claimed: 1 });
    expect(t.p.calls.map((c) => c.accountId)).toEqual([ids[BATCH]]);
  });

  test('I-T84④_장애주입_잡기를커밋한뒤그파드가죽어참여자를부르지못해도_다음확인시각뒤다른파드가잡는다(영구표시를남기지않는다)', async () => {
    const t = await setup({ fallback: DONE });
    const a = await t.deferred('r-6');
    t.clock.advance(NEXT_CHECK_MS);
    // 파드 A: 잡기만 커밋하고 죽는다(참여자를 부르지 않는다)
    const claimed = await t.sessions.transaction((tx) => tx.claimPendingWithdrawals(t.clock.now(), t.clock.now() + NEXT_CHECK_MS, BATCH));
    expect(claimed).toEqual([a.accountId]);
    t.p.calls.length = 0;
    // 그사이 파드 B는 잡지 않는다
    expect(await t.retry.run()).toMatchObject({ claimed: 0 });
    t.clock.advance(NEXT_CHECK_MS - 1);
    expect(await t.retry.run()).toMatchObject({ claimed: 0 });
    // 다음 확인 시각에 파드 B가 잡아 끝낸다
    t.clock.advance(1);
    expect(await t.retry.run()).toEqual({ claimed: 1, withdrawn: 1, deferred: 0, failed: 0 });
    expect(t.p.calls).toEqual([{ accountId: a.accountId, deadlineMs: RETRY_DEADLINE_MS }]);
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
  });

  test('I-T84④_지표:참여자호출은path별outcome으로세고_고리가돌때마다가장오래미룬계정의시작부터지금까지의초를낸다(없으면0)', async () => {
    const t = await setup();
    expect(await t.retry.run()).toMatchObject({ claimed: 0 });
    expect(t.signals.oldest.at(-1)).toBe(0);
    const a = await t.deferred('r-7-a');
    t.clock.advance(12_000);
    await t.deferred('r-7-b');
    expect(t.signals.seen).toEqual(['purchase:request:pending', 'purchase:request:pending']);
    // 아무도 잡히지 않는 바퀴(30초 뒤): 가장 오래 미룬 a의 시작부터 42초
    t.clock.advance(30_000);
    t.signals.oldest.length = 0;
    expect(await t.retry.run()).toMatchObject({ claimed: 0 });
    expect(t.signals.oldest).toEqual([42]);
    t.clock.advance(NEXT_CHECK_MS);
    t.p.byAccount.set(a.accountId, DONE);
    t.signals.seen.length = 0;
    await t.retry.run();
    expect(t.signals.seen.sort()).toEqual(['purchase:retry:done', 'purchase:retry:pending']);
    const c = await t.login('r-7-c');
    t.p.byAccount.set(c.accountId, UNAVAILABLE);
    t.signals.seen.length = 0;
    expect(await t.withdraw.run({ accountId: c.accountId, sessionId: c.sessionId, reauthToken: await t.reauth(c), body: {} })).toEqual({ outcome: 'DEFERRED' });
    expect(t.signals.seen).toEqual(['purchase:request:failed']);
  });
});

// 리뷰 RV-03(BAT-010 리뷰 반영, identity §8 '다시 하기 고리' 573행 · I-T84 ④ 끝): 한 바퀴는 잡은 시각 + 50초 [가정]부터 남은 계정을 부르지 않는다.
// 참여자 대역이 부를 때마다 가짜 시계를 민다(느린 참여자). 값은 정본의 50초·60초를 적는다.
describe('바퀴 마감: 잡은 시각 + 50초(I-T84 ④, 리뷰 RV-03)', () => {
  const ROUND_CUTOFF_MS = 50_000;

  async function slowRound(firstCallMs: number) {
    const t = await setup();
    const a = await t.deferred('cut-a');
    t.clock.advance(3);
    const b = await t.deferred('cut-b');
    t.clock.advance(3);
    const c = await t.deferred('cut-c');
    t.clock.advance(NEXT_CHECK_MS);
    const claimedAt = t.clock.now();
    // a는 PENDING으로 답하며 firstCallMs를 쓰고, b는 DONE으로 답하며 1ms를 쓴다. c는 PENDING이다
    t.p.byAccount.set(a.accountId, async () => {
      t.clock.advance(firstCallMs);
      return { state: 'PENDING', reasons: ['PAYMENT_PENDING_ORDER'] };
    });
    t.p.byAccount.set(b.accountId, async () => {
      t.clock.advance(1);
      return { state: 'DONE' };
    });
    t.p.byAccount.set(c.accountId, PENDING);
    t.p.calls.length = 0;
    const report = await t.retry.run();
    return { t, a, b, c, claimedAt, report };
  }

  test('I-T84④_RV-03_앞계정이49,999ms를써서잡은시각+50초−1ms면다음계정을부르고_그계정이1ms를써서+50초에닿으면남은계정은부르지않으며상태·다음확인시각(잡은시각+60초)그대로다', async () => {
    const { t, a, b, c, claimedAt, report } = await slowRound(ROUND_CUTOFF_MS - 1);
    expect(t.p.calls.map((x) => x.accountId)).toEqual([a.accountId, b.accountId]);
    // 부르지 않은 계정은 끝냄·미룸·실패 어디에도 세지 않는다
    expect(report).toEqual({ claimed: 3, withdrawn: 1, deferred: 1, failed: 0 });
    expect(t.sessions.accountOf(b.accountId)?.status).toBe('DELETED');
    expect(t.sessions.accountOf(c.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL', closureStartedAt: START + 6, closureNextCheckAt: claimedAt + NEXT_CHECK_MS });
    expect(t.sessions.activeCount(c.accountId)).toBe(1);
    expect(t.sessions.withdrawnMessages().map((m) => m.key)).toEqual([b.accountId]);
  });

  test('I-T84④_RV-03_앞계정이50초를써서잡은시각+50초에닿으면_남은두계정을부르지않고상태·다음확인시각(잡은시각+60초)그대로다', async () => {
    const { t, a, b, c, claimedAt, report } = await slowRound(ROUND_CUTOFF_MS);
    expect(t.p.calls.map((x) => x.accountId)).toEqual([a.accountId]);
    expect(report).toEqual({ claimed: 3, withdrawn: 0, deferred: 1, failed: 0 });
    for (const x of [b, c]) {
      expect(t.sessions.accountOf(x.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL', closureNextCheckAt: claimedAt + NEXT_CHECK_MS });
      expect(t.sessions.activeCount(x.accountId)).toBe(1);
    }
    expect(t.sessions.withdrawnMessages()).toEqual([]);
    // 다음 확인 시각에 다시 잡힌다
    t.p.byAccount.set(b.accountId, DONE);
    t.p.byAccount.set(c.accountId, DONE);
    t.p.byAccount.set(a.accountId, PENDING);
    t.clock.advance(claimedAt + NEXT_CHECK_MS - t.clock.now());
    t.p.calls.length = 0;
    expect(await t.retry.run()).toMatchObject({ claimed: 3, withdrawn: 2 });
    expect(t.p.calls.map((x) => x.accountId).sort()).toEqual([a.accountId, b.accountId, c.accountId].sort());
  });
});

describe('요청 경로와 고리의 끝내기(I-T84 ①⑦)', () => {
  test('I-T84⑦_요청경로의끝내기와고리의끝내기가겹쳐도_계정은한번끝나고탈퇴사건은한건·세션종료사건도한번이다', async () => {
    const t = await setup();
    const a = await t.login('o-1');
    await t.verify(a.accountId, 'o-1-person');
    // 요청 경로의 참여자 답을 늦춘다. 그사이 고리가 같은 계정을 잡아 DONE으로 끝낸다
    let release!: (x: Answer) => void;
    const held = new Promise<Answer>((r) => (release = r));
    let calls = 0;
    t.p.byAccount.set(a.accountId, async () => (++calls === 1 ? held : { state: 'DONE' }));
    const request = t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauth(a), body: {} });
    // 요청 경로가 참여자를 부를 때까지 기다린다(재인증 확인이 비동기라 한 틱으로는 모자랄 수 있다, 부하 아래 흔들림 고침)
    for (let i = 0; i < 500 && calls === 0; i++) await new Promise((r) => setTimeout(r, 2));
    expect(calls).toBe(1);
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('WITHDRAWAL_PENDING');
    t.clock.advance(NEXT_CHECK_MS);
    expect(await t.retry.run()).toMatchObject({ claimed: 1, withdrawn: 1 });
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
    release({ state: 'DONE' });
    await expect(request).resolves.toBeDefined();
    expect(calls).toBe(2);
    expect(t.sessions.withdrawnMessages()).toHaveLength(1);
    expect(t.sessions.terminations(a.accountId).map(([, r]) => r)).toEqual(['DELETE']);
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'DELETED' });
  });

  test('I-T84①_장애주입_요청경로에서참여자DONE뒤끝내기트랜잭션이실패해202로미룬계정은_다음확인시각에고리가끝낸다', async () => {
    let failNext = false;
    let injected = 0;
    const flaky = (s: MemorySessionStore): SessionStore =>
      new Proxy(s, {
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
    const t = await setup({ store: flaky, fallback: DONE });
    const a = await t.login('m13-1');
    await t.verify(a.accountId, 'm13-person');
    t.p.byAccount.set(a.accountId, async () => {
      failNext = true;
      return { state: 'DONE' };
    });
    expect(await t.withdraw.run({ accountId: a.accountId, sessionId: a.sessionId, reauthToken: await t.reauth(a), body: {} })).toEqual({ outcome: 'DEFERRED' });
    expect(injected).toBe(1);
    expect(t.p.calls).toEqual([{ accountId: a.accountId, deadlineMs: REQUEST_DEADLINE_MS }]);
    expect(t.sessions.accountOf(a.accountId)).toMatchObject({ status: 'WITHDRAWAL_PENDING', closureReason: 'WITHDRAWAL' });
    t.p.byAccount.set(a.accountId, DONE);
    t.clock.advance(NEXT_CHECK_MS);
    expect(await t.retry.run()).toEqual({ claimed: 1, withdrawn: 1, deferred: 0, failed: 0 });
    expect(t.sessions.accountOf(a.accountId)?.status).toBe('DELETED');
    expect(t.sessions.withdrawnMessages()).toHaveLength(1);
  });
});
