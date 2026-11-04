// 관리 계정 로그인 잠금 규칙의 순수 함수(docs/security/auth-controls.md §2.3·§3.1·§3.2, identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// 계정에 묶인 값(계정 실패 수·누계·잠금)을 다룬다. 있는 계정은 admin_account 행에, 없는 계정은 Redis 가짜 상태에 같은 꼴로 둔다(같은 응답, §2.2).
import type { AdminAuthConfig } from './auth-config.js';

export type LockKind = 'NONE' | 'TIMED' | 'PROTECT';
export type LockReason = 'FAILED_ATTEMPTS' | 'SECOND_FACTOR_FAILURES' | 'PASSWORD_FAILURE_TOTAL';
export type NoticeKind = 'TIMED_LOCK' | 'PASSWORD_FAILURE_NOTICE' | 'MULTI_SOURCE_ALERT' | 'PROTECT_LOCK' | 'SESSION_LIMIT';

export interface AccountLoginState {
  failedAttempts: number;
  passwordFailureTotal: number;
  lockKind: LockKind;
  /** TIMED만. 잠금이 풀리는 시각 ms */
  lockedUntil: number | null;
  /** 24시간 안의 잠금 시각 ms */
  recentLockAt: number[];
  lockReason: LockReason | null;
  lockedAt: number | null;
}

export const FRESH_LOGIN_STATE: AccountLoginState = { failedAttempts: 0, passwordFailureTotal: 0, lockKind: 'NONE', lockedUntil: null, recentLockAt: [], lockReason: null, lockedAt: null };

type Cfg = Pick<
  AdminAuthConfig,
  'captchaAfterFailures' | 'lockAfterFailures' | 'timedLockFirstMs' | 'timedLockRepeatMs' | 'timedLockRepeatWindowMs' | 'passwordFailureCap' | 'passwordFailureNotice'
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

/** 2단계(인증 앱 코드·복구 코드)가 틀렸을 때: 계정 실패 수에만 세고 비밀번호 연속 실패 누계에는 세지 않는다(§3.1). 2단계 실패 수와 보호 잠금은 BOT-121 */
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
  const recent = recentLocks(s, now, cfg);
  const notices: NoticeKind[] = [];
  if (password && passwordFailureTotal === cfg.passwordFailureNotice && passwordFailureTotal < cfg.passwordFailureCap) notices.push('PASSWORD_FAILURE_NOTICE');
  // 누계 상한(NIST §3.2.2)이면 보호 잠금. 시간 잠금과 겹쳐도 보호 잠금만 건다(해제 링크를 보내지 않는다)
  if (password && passwordFailureTotal >= cfg.passwordFailureCap) {
    notices.push('PROTECT_LOCK');
    return {
      next: { failedAttempts, passwordFailureTotal, lockKind: 'PROTECT', lockedUntil: null, recentLockAt: recent, lockReason: 'PASSWORD_FAILURE_TOTAL', lockedAt: now },
      notices,
      locked: { kind: 'PROTECT' },
    };
  }
  if (failedAttempts >= cfg.lockAfterFailures) {
    const until = now + nextTimedLockMs(s, now, cfg);
    notices.unshift('TIMED_LOCK');
    return {
      next: { failedAttempts: 0, passwordFailureTotal, lockKind: 'TIMED', lockedUntil: until, recentLockAt: [...recent, now], lockReason: 'FAILED_ATTEMPTS', lockedAt: now },
      notices,
      locked: { kind: 'TIMED', until },
    };
  }
  return { next: { ...s, failedAttempts, passwordFailureTotal, recentLockAt: recent }, notices, locked: null };
}
