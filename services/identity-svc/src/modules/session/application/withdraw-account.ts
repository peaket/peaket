// 팬 탈퇴(openapi DELETE /v1/identity/account, docs/features/identity.md §8 '탈퇴의 첫 구현', BUILD_ORDER BOT-030, FR-017, POL-033, I-T16·I-T27).
// 재인증 토큰(세션·FAN_SENSITIVE에 묶임)을 확인하고 jti를 한 번 쓴 뒤, 계정 트랜잭션 하나에서 계정을 파기하고 살아 있는 세션을 모두 끝낸다(DELETE).
// 본인확인 기록(연계정보 HMAC·pid) 파기는 다음 트랜잭션이고, 실패해도 탈퇴는 끝난 것으로 답한다(정비 withdrawal-finish가 다시 지운다).
// 탈퇴 참여자와 탈퇴 미룸(identity §8 '탈퇴 참여자와 탈퇴 미룸의 첫 구현', ADR-0284, BUILD_ORDER PRF-169, I-T84): 참여자가 있으면
// 재인증 토큰을 쓰는 트랜잭션에서 계정을 WITHDRAWAL_PENDING(WITHDRAWAL)으로 먼저 커밋하고, 트랜잭션 밖에서 참여자를 부른다.
// 모두 DONE이면 끝내기 트랜잭션 뒤 204, 하나라도 PENDING이거나 답하지 못하면 202다(다시 하기 고리 retry-pending-withdrawals.ts가 끝낸다).
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, PLATFORM_LOGGER, type PlatformLogger } from '@peaket/platform';
import { ACCOUNT_ERASER, type AccountEraser, FRAUD_HOLDS, type FraudHolds, REAUTH_VERIFIER, ReauthRejected, type ReauthVerifier, SESSION_STORE, type SessionStore, type SessionTx } from '../domain/ports.js';
import { STAFF_ASSIGNMENT_STORE, type StaffAssignmentStore } from '../domain/staff.js';
import { WITHDRAWAL_REAUTH_ACT } from '../domain/session.js';
import {
  WITHDRAWAL_NEXT_CHECK_MS,
  WITHDRAWAL_PARTICIPANTS,
  WITHDRAWAL_REQUEST_DEADLINE_MS,
  WITHDRAWAL_SIGNALS,
  type WithdrawalParticipant,
  type WithdrawalPath,
  type WithdrawalSignals,
} from '../domain/withdrawal.js';
import { AccountError } from './account-error.js';
import { checkIds } from './end-session.js';

export interface WithdrawInput {
  accountId: string;
  sessionId: string;
  /** X-Reauth-Token */
  reauthToken: string;
  /** confirmCancelUnusedTickets·acknowledgeFraudHold·refundAccount는 탈퇴 참여자와 대조값 보관이 생기면 쓴다(BOT-035). 계좌는 받아도 저장하지 않는다 */
  body: { confirmCancelUnusedTickets?: boolean; acknowledgeFraudHold?: boolean };
}

/** 탈퇴 요청의 결과: 끝냄(204) 또는 미룸(202, 본문 없음) */
export interface WithdrawResult {
  outcome: 'WITHDRAWN' | 'DEFERRED';
}

/**
 * 계정 트랜잭션 안의 탈퇴 끝내기(재인증 탈퇴와 만 14세 미만 정리 마무리가 함께 쓴다).
 * pids가 있으면(본인확인한 계정) 마지막에 탈퇴 사건을 적는다. 본인확인 기록을 지우는 둘째 트랜잭션이 실패해도 사건은 늘 탈퇴 시각에 나간다(BOT-037)
 */
export async function completeWithdrawal(tx: SessionTx, accountId: string, now: number, pids: readonly string[] = []): Promise<void> {
  await tx.lockAccount(accountId);
  // 만료와 상관없이 끝나지 않은 세션을 모두 잠그고 끝낸다: 만료 경계에서 갱신이 더 이른 시각으로 출발해 겹쳐도 세션이 남지 않는다(다시 보기 낮음)
  const open = await tx.unterminatedSessions(accountId);
  await tx.eraseAccount(accountId, now);
  await tx.terminateSessions(open, 'DELETE', now);
  if (pids.length > 0) await tx.recordWithdrawn({ accountId, pids, withdrawnAt: now });
}

/** 탈퇴 끝내기 뒤의 일(요청 경로와 다시 하기 고리가 함께 쓴다) */
export interface WithdrawalFinishDeps {
  store: SessionStore;
  eraser: AccountEraser;
  staff?: StaffAssignmentStore;
  logger?: PlatformLogger;
}

/**
 * 계정이 이미 DELETED가 된 뒤의 정리: 스태프 배정·스캐너 세션 정리와 본인확인 기록 파기. 둘 다 실패해도 탈퇴는 끝난 것이다.
 * 계정은 이미 DELETED라 스캐너 세션 확인은 바로 false가 된다. 정리가 실패해도 계정 상태 확인이 안전을 지킨다
 */
export async function afterWithdrawal(d: WithdrawalFinishDeps, accountId: string, now: number): Promise<void> {
  if (d.staff) {
    try {
      await d.staff.terminateByAccount({ accountId, reason: 'STAFF_REVOKED', nowMs: now });
    } catch (err) {
      d.logger?.warn({ err, accountId }, '탈퇴 뒤 스태프 배정·스캐너 세션 정리에 실패했다');
    }
  }
  try {
    await d.eraser.erase(accountId, now);
  } catch (err) {
    // 계정은 이미 파기됐다. 남은 본인확인 기록은 정비가 지난 7일 [가정] 안에 탈퇴한 계정에서 다시 지운다(늦어도 5일 안, identity §8)
    d.logger?.warn({ err, accountId }, '탈퇴 뒤 본인확인 기록 파기 실패(정비가 다시 지운다)');
  }
}

/**
 * 미룬 탈퇴의 끝내기 트랜잭션(identity §8 '끝내기 트랜잭션'): 계정을 잠그고 아직 WITHDRAWAL_PENDING이면 끝내기와 탈퇴 사건을 하고 뒤의 정리를 한다.
 * 이미 DELETED면(다른 길이 먼저 끝냄) 아무것도 바꾸지 않는다. 요청 경로와 고리가 겹쳐도 끝내기와 탈퇴 사건은 한 번이다.
 * 돌려주는 값: 'WITHDRAWN'(이번에 끝냄), 'ALREADY'(이미 DELETED), 'NOT_PENDING'(그 밖의 상태라 두었다). 트랜잭션 실패는 던진다
 */
export async function finishPendingWithdrawal(d: WithdrawalFinishDeps, accountId: string, now: number): Promise<'WITHDRAWN' | 'ALREADY' | 'NOT_PENDING'> {
  // 탈퇴 사건에 실을 pid는 트랜잭션을 열기 전에 읽는다(잠근 채 DB 연결을 하나 더 빌리지 않게, BOT-037)
  const pids = await d.eraser.pidsOf(accountId);
  const r = await d.store.transaction(async (tx) => {
    await tx.lockAccount(accountId);
    const status = await tx.accountStatusOf(accountId);
    if (status === 'DELETED') return 'ALREADY' as const;
    if (status !== 'WITHDRAWAL_PENDING') return 'NOT_PENDING' as const;
    await completeWithdrawal(tx, accountId, now, pids);
    return 'WITHDRAWN' as const;
  });
  if (r === 'WITHDRAWN') await afterWithdrawal(d, accountId, now);
  return r;
}

/** 참여자 호출의 모은 결과: 모두 DONE, 하나라도 PENDING(실패 없음), 하나라도 실패 */
export type ParticipantsVerdict = 'DONE' | 'PENDING' | 'FAILED';

/**
 * 참여자를 모두 부른다(동시에). 답이 DONE·PENDING이 아니거나 던지면 실패로 센다(DONE으로 접지 않는다, ADR-0284 결정 3).
 * 참여자마다 지표 한 번, 실패는 경고 로그(계정 ID·참여자·까닭) 한 줄. 던지지 않는다
 */
export async function askParticipants(
  participants: readonly WithdrawalParticipant[],
  accountId: string,
  o: { path: WithdrawalPath; deadlineMs: number; signals?: WithdrawalSignals; logger?: PlatformLogger },
): Promise<ParticipantsVerdict> {
  const settled = await Promise.allSettled(participants.map((p) => p.process(accountId, { deadlineMs: o.deadlineMs })));
  let pending = false;
  let failed = false;
  settled.forEach((s, i) => {
    const name = participants[i]!.name;
    const state = s.status === 'fulfilled' ? (s.value as { state?: unknown } | undefined)?.state : undefined;
    if (state === 'DONE') {
      o.signals?.participant(name, o.path, 'done');
    } else if (state === 'PENDING') {
      pending = true;
      o.signals?.participant(name, o.path, 'pending');
    } else {
      failed = true;
      o.signals?.participant(name, o.path, 'failed');
      const why = s.status === 'rejected' ? s.reason : new Error(`모르는 답 ${String(state)}`);
      o.logger?.warn({ err: why, accountId, participant: name, path: o.path }, '탈퇴 참여자가 답하지 않아 탈퇴를 미룬다');
    }
  });
  return failed ? 'FAILED' : pending ? 'PENDING' : 'DONE';
}

@Injectable()
export class WithdrawAccount {
  constructor(
    @Inject(SESSION_STORE) private readonly store: SessionStore,
    @Inject(REAUTH_VERIFIER) private readonly reauth: ReauthVerifier,
    @Inject(ACCOUNT_ERASER) private readonly eraser: AccountEraser,
    @Inject(CLOCK) private readonly clock: Clock,
    /** 대조값 보관 안내(없으면 보지 않는다: 시험) */
    @Optional() @Inject(FRAUD_HOLDS) private readonly holds?: FraudHolds,
    /** 탈퇴 계정의 스태프 배정·스캐너 세션 정리(없으면 계정 상태 확인이 안전을 지킨다) */
    @Optional() @Inject(STAFF_ASSIGNMENT_STORE) private readonly staff?: StaffAssignmentStore,
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
    /** 탈퇴 참여자(없거나 비면 참여자 없이 한 트랜잭션에서 바로 끝낸다: 참여자가 생기기 전의 시험) */
    @Optional() @Inject(WITHDRAWAL_PARTICIPANTS) private readonly participants?: readonly WithdrawalParticipant[],
    @Optional() @Inject(WITHDRAWAL_SIGNALS) private readonly signals?: WithdrawalSignals,
  ) {}

  async run(i: WithdrawInput): Promise<WithdrawResult> {
    checkIds(i.sessionId, i.accountId);
    const accountId = i.accountId.toLowerCase();
    const sessionId = i.sessionId.toLowerCase();
    let token: { jti: string; accountId: string; expiresAt: number };
    try {
      token = await this.reauth.verify(i.reauthToken, { sessionId, act: WITHDRAWAL_REAUTH_ACT });
    } catch (e) {
      if (e instanceof ReauthRejected) throw new AccountError('REAUTH_REQUIRED', e.message);
      throw e;
    }
    if (token.accountId.toLowerCase() !== accountId) throw new AccountError('REAUTH_REQUIRED', '재인증 토큰의 계정이 다르다');
    const now = this.clock.now();
    // 대조값 보관 행이 살아 있으면 첫 요청은 409로 안내를 보인다. 재인증 토큰은 쓰지 않아 같은 토큰으로 acknowledgeFraudHold를 실어 다시 보낸다(ADR-0173 결정 7).
    // 미룸 표시보다 먼저 본다(identity §8 '차례')
    const hold = this.holds ? await this.holds.activeHold(accountId, now) : null;
    if (hold && i.body.acknowledgeFraudHold !== true) throw new AccountError('CONFIRMATION_REQUIRED', '탈퇴 전 대조값 보관 안내', hold);
    // 탈퇴 사건에 실을 pid는 트랜잭션을 열기 전에 읽는다: 계정을 잠근 채 DB 연결을 하나 더 빌리지 않게(activeHoldOf와 같은 까닭, 재검토 낮음 1).
    // 그 사이에 끝난 첫 본인확인의 pid는 빠질 수 있지만, 그 pid로 받은 토큰이 없어 대기열 키도 아직 없다(BOT-037)
    const pids = await this.eraser.pidsOf(accountId);
    const participants = this.participants ?? [];
    const step = await this.store.transaction(async (tx) => {
      // jti를 쓰는 것과 파기(또는 미룸 표시)를 한 트랜잭션에: 둘 가운데 하나만 남지 않는다
      if (!(await tx.useReauth({ jti: token.jti, accountId, usedAt: now, expiresAt: token.expiresAt }))) {
        throw new AccountError('REAUTH_REQUIRED', '이미 쓴 재인증 토큰이다');
      }
      // 상태는 계정을 잠근 뒤에 본다(동시 탈퇴·정비와 겹쳐도 한 번만 끝낸다, 새 맥락 리뷰 L4)
      await tx.lockAccount(accountId);
      const status = await tx.accountStatusOf(accountId);
      if (status !== 'ACTIVE' && status !== 'WITHDRAWAL_PENDING') throw new AccountError('REAUTH_REQUIRED', '탈퇴할 수 있는 계정이 아니다');
      // 잠근 뒤 한 번 더 본다: 대조값 보관 호출은 계정을 공유 잠금으로 읽으므로, 그 호출이 먼저 끝났으면 여기서 보인다(되돌리면 토큰도 쓰지 않은 것이 된다, L4)
      if (i.body.acknowledgeFraudHold !== true) {
        const late = await tx.activeHoldOf(accountId, now);
        if (late) throw new AccountError('CONFIRMATION_REQUIRED', '탈퇴 전 대조값 보관 안내', late);
      }
      // 만 14세 미만 정리 중인 계정은 본인확인을 통과하지 못해 결제할 수 없으므로 참여자를 부르지 않고 바로 끝낸다(identity §8 '미룸 표시').
      // 참여자가 없으면(참여자가 생기기 전의 조립) 지금처럼 한 트랜잭션에서 끝낸다
      if (participants.length === 0 || (status === 'WITHDRAWAL_PENDING' && (await tx.closureReasonOf(accountId)) === 'UNDER_14')) {
        await completeWithdrawal(tx, accountId, now, pids);
        return 'WITHDRAWN' as const;
      }
      // 미룸 표시를 먼저 커밋한 뒤 트랜잭션 밖에서 참여자를 부른다: 되돌릴 수 없는 결제사 취소가 탈퇴 의사가 기록되기 전에 나가지 않게(ADR-0284 결정 2)
      await tx.markWithdrawalPending(accountId, now, now + WITHDRAWAL_NEXT_CHECK_MS);
      return 'MARKED' as const;
    });
    const deps: WithdrawalFinishDeps = { store: this.store, eraser: this.eraser, ...(this.staff ? { staff: this.staff } : {}), ...(this.logger ? { logger: this.logger } : {}) };
    if (step === 'WITHDRAWN') {
      await afterWithdrawal(deps, accountId, now);
      return { outcome: 'WITHDRAWN' };
    }
    const verdict = await askParticipants(participants, accountId, { path: 'request', deadlineMs: WITHDRAWAL_REQUEST_DEADLINE_MS, ...(this.signals ? { signals: this.signals } : {}), ...(this.logger ? { logger: this.logger } : {}) });
    if (verdict !== 'DONE') return { outcome: 'DEFERRED' };
    try {
      const r = await finishPendingWithdrawal(deps, accountId, this.clock.now());
      return { outcome: r === 'NOT_PENDING' ? 'DEFERRED' : 'WITHDRAWN' };
    } catch (err) {
      // 참여자는 모두 DONE인데 끝내기 트랜잭션이 실패했다: 500이 아니라 202로 답하고 고리가 끝낸다(identity §8 '끝내기 트랜잭션')
      this.logger?.warn({ err, accountId }, '탈퇴 끝내기 트랜잭션이 실패해 미뤘다(다시 하기 고리가 끝낸다)');
      return { outcome: 'DEFERRED' };
    }
  }
}
