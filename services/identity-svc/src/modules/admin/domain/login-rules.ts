// 관리 계정 로그인 잠금 규칙의 순수 함수(docs/security/auth-controls.md §2.3·§3.1·§3.2, identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// 계정에 묶인 값(계정 실패 수·누계·잠금)을 다룬다. 있는 계정은 admin_account 행에, 없는 계정은 Redis 가짜 상태에 같은 꼴로 둔다(같은 응답, §2.2).
import type { AdminAuthConfig } from './auth-config.js';

export type LockKind = 'NONE' | 'TIMED' | 'PROTECT';
export type LockReason = 'FAILED_ATTEMPTS' | 'SECOND_FACTOR_FAILURES' | 'PASSWORD_FAILURE_TOTAL';
export type NoticeKind = 'TIMED_LOCK' | 'PASSWORD_FAILURE_NOTICE' | 'MULTI_SOURCE_ALERT' | 'PROTECT_LOCK' | 'SESSION_LIMIT' | 'UNLOCK_LINK' | 'UNLOCKED' | 'PASSWORD_ONLY_LOGIN' | 'INVITATION';

export interface AccountLoginState {
  failedAttempts: number;
  passwordFailureTotal: number;
  /** 2단계 실패 수(로그인 2단계와 해제 링크의 코드, 로그인 성공만 0, BOT-121) */
  secondFactorFailures: number;
  lockKind: LockKind;
  /** TIMED만. 잠금이 풀리는 시각 ms */
  lockedUntil: number | null;
  /** 24시간 안의 잠금 시각 ms */
  recentLockAt: number[];
  lockReason: LockReason | null;
  lockedAt: number | null;
}

export const FRESH_LOGIN_STATE: AccountLoginState = { failedAttempts: 0, passwordFailureTotal: 0, secondFactorFailures: 0, lockKind: 'NONE', lockedUntil: null, recentLockAt: [], lockReason: null, lockedAt: null };

type Cfg = Pick<
  AdminAuthConfig,
  'captchaAfterFailures' | 'lockAfterFailures' | 'timedLockFirstMs' | 'timedLockRepeatMs' | 'timedLockRepeatWindowMs' | 'passwordFailureCap' | 'passwordFailureNotice' | 'protectAfterSecondFactorFailures'
>;

/** 지금 걸린 잠금. 시간 잠금은 끝 시각이 지나면 없다 */
export function activeLock(s: AccountLoginState, now: number): { kind: 'TIMED'; until: number } | { kind: 'PROTECT' } | null {
  if (s.lockKind === 'PROTECT') return { kind: 'PROTECT' };
  if (s.lockKind === 'TIMED' && s.lockedUntil !== null && s.lockedUntil > now) return { kind: 'TIMED', until: s.lockedUntil };
  return null;
}

const recentLocks = (s: AccountLoginState, now: number, cfg: Cfg) => s.recentLockAt.filter((t) => t > now - cfg.timedLockRepeatWindowMs && t <= now);

/** 다음 시간 잠금의 길이: 마지막 시간 잠금이 풀린 뒤 24시간 [가정] 안이면 1시간, 아니면 15분(§3.2 '풀린 뒤 24시간 안에 다시 걸리면', 재리뷰 2026-11-05) */
export function nextTimedLockMs(s: AccountLoginState, now: number, cfg: Cfg): number {
  return s.lockedUntil !== null && now - s.lockedUntil < cfg.timedLockRepeatWindowMs ? cfg.timedLockRepeatMs : cfg.timedLockFirstMs;
}

/** 계정 쪽 사람 확인 조건(§2.3 1·2): 계정 실패 수 3 [가정] 이상이거나 24시간 안에 시간 잠금이 걸린 적이 있다 */
export function accountNeedsHumanCheck(s: AccountLoginState, now: number, cfg: Cfg): boolean {
  return s.failedAttempts >= cfg.captchaAfterFailures || recentLocks(s, now, cfg).length > 0;
}

type FailureResult = { next: AccountLoginState; notices: NoticeKind[]; locked: { kind: 'TIMED'; until: number } | { kind: 'PROTECT' } | null };

/** 2단계(인증 앱 코드·복구 코드)가 틀렸을 때: 계정 실패 수와 2단계 실패 수에 세고 비밀번호 연속 실패 누계에는 세지 않는다(§3.1). 2단계 실패 수 5 [가정]면 보호 잠금(BOT-121) */
export function onSecondFactorFailure(s: AccountLoginState, now: number, cfg: Cfg): FailureResult {
  return failure(s, now, cfg, false);
}

/** 비밀번호가 틀렸을 때. 잠긴 동안 거절한 시도에는 부르지 않는다 */
export function onPasswordFailure(s: AccountLoginState, now: number, cfg: Cfg): FailureResult {
  return failure(s, now, cfg, true);
}

function failure(s: AccountLoginState, now: number, cfg: Cfg, password: boolean): FailureResult {
  const failedAttempts = s.failedAttempts + 1;
  const passwordFailureTotal = s.passwordFailureTotal + (password ? 1 : 0);
  const secondFactorFailures = s.secondFactorFailures + (password ? 0 : 1);
  const recent = recentLocks(s, now, cfg);
  const notices: NoticeKind[] = [];
  if (password && passwordFailureTotal === cfg.passwordFailureNotice && passwordFailureTotal < cfg.passwordFailureCap) notices.push('PASSWORD_FAILURE_NOTICE');
  // 누계 상한(NIST §3.2.2)이면 보호 잠금. 시간 잠금과 겹쳐도 보호 잠금만 건다(해제 링크를 보내지 않는다)
  // 2단계 실패 수 5 [가정]도 보호 잠금이다(비밀번호가 샌 신호, §3.2)
  const protectReason = password && passwordFailureTotal >= cfg.passwordFailureCap ? 'PASSWORD_FAILURE_TOTAL' : !password && secondFactorFailures >= cfg.protectAfterSecondFactorFailures ? 'SECOND_FACTOR_FAILURES' : null;
  if (protectReason) {
    notices.push('PROTECT_LOCK');
    return {
      next: { failedAttempts, passwordFailureTotal, secondFactorFailures, lockKind: 'PROTECT', lockedUntil: null, recentLockAt: recent, lockReason: protectReason, lockedAt: now },
      notices,
      locked: { kind: 'PROTECT' },
    };
  }
  if (failedAttempts >= cfg.lockAfterFailures) {
    const until = now + nextTimedLockMs(s, now, cfg);
    notices.unshift('TIMED_LOCK');
    return {
      next: { failedAttempts: 0, passwordFailureTotal, secondFactorFailures, lockKind: 'TIMED', lockedUntil: until, recentLockAt: [...recent, now], lockReason: 'FAILED_ATTEMPTS', lockedAt: now },
      notices,
      locked: { kind: 'TIMED', until },
    };
  }
  return { next: { ...s, failedAttempts, passwordFailureTotal, secondFactorFailures, recentLockAt: recent }, notices, locked: null };
}

/** 본인 해제(§3.3): 시간 잠금만 푼다. 계정 실패 수 0, 푼 시각을 locked_until에 남겨 '풀린 뒤 24시간 안' 반복 잠금을 센다. 2단계 실패 수·누계·24시간 안 잠금 기록은 그대로 */
export function onSelfUnlock(s: AccountLoginState, now: number): AccountLoginState {
  return { ...s, failedAttempts: 0, lockKind: 'NONE', lockedUntil: now, lockReason: null };
}

/** 해제 링크에서 코드가 틀렸을 때: 2단계 실패 수에만 센다(계정 실패 수·시간 잠금 칸은 그대로, §3.1·§3.3). 5 [가정]면 보호 잠금 */
export function onUnlockCodeFailure(s: AccountLoginState, now: number, cfg: Pick<AdminAuthConfig, 'protectAfterSecondFactorFailures'>): { next: AccountLoginState; protect: boolean } {
  const secondFactorFailures = s.secondFactorFailures + 1;
  if (secondFactorFailures >= cfg.protectAfterSecondFactorFailures) {
    return { next: { ...s, secondFactorFailures, lockKind: 'PROTECT', lockedUntil: null, lockReason: 'SECOND_FACTOR_FAILURES', lockedAt: now }, protect: true };
  }
  return { next: { ...s, secondFactorFailures }, protect: false };
}

/** 잠금까지 남은 수(시간 잠금·보호 잠금 가운데 가까운 쪽). 2단계는 2단계 실패 수 문턱도 본다(새 맥락 리뷰 2026-11-05) */
export function remainingBeforeLock(s: AccountLoginState, cfg: Pick<AdminAuthConfig, 'lockAfterFailures' | 'protectAfterSecondFactorFailures'>, secondFactor: boolean): number {
  const timed = cfg.lockAfterFailures - s.failedAttempts;
  return Math.max(0, secondFactor ? Math.min(timed, cfg.protectAfterSecondFactorFailures - s.secondFactorFailures) : timed);
}
