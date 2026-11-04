// 소셜 로그인 세션의 업무 규칙(docs/features/identity.md §2·§4·§7.1, POL-019, ADR-0011·0119).
// 값은 정본의 초기값이다. 바꿀 때는 정본(identity §1·§4)을 먼저 고친다.

export const PROVIDERS = ['kakao', 'naver', 'google'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** 재인증 강도(identity §7.1): 확인됨·요청만 함 */
export const REAUTH_STRENGTHS = ['verified', 'requested'] as const;
export type ReauthStrength = (typeof REAUTH_STRENGTHS)[number];

/** 팬 액세스 토큰 15분(identity §1) */
export const ACCESS_TOKEN_TTL_MS = 15 * 60_000;
/** 팬 세션 절대 만료 30일·유휴 만료 14일(POL-019) */
export const SESSION_ABSOLUTE_MS = 30 * 24 * 3_600_000;
export const SESSION_IDLE_MS = 14 * 24 * 3_600_000;
/** 동시 활성 기기 5대(POL-019) */
export const DEVICE_LIMIT = 5;
/** CreateSession 멱등 키를 기억하는 시간 10분 [가정](identity §2) */
export const CREATE_KEY_TTL_MS = 10 * 60_000;
/** 재인증 토큰 5분(identity §13) */
export const REAUTH_TOKEN_TTL_MS = 5 * 60_000;
/** 팬 재인증의 목적: 고위험(양도 요청·환급·배상 계좌 입력)과 그 밖의 민감 작업(identity §7.1 ③) */
export type ReauthPurpose = 'sensitive' | 'high-risk';
/** 팬 재인증 토큰의 작업 묶음(docs/security/authz-matrix.md §6) */
export const FAN_REAUTH_ACT: Readonly<Record<ReauthPurpose, string>> = Object.freeze({ sensitive: 'FAN_SENSITIVE', 'high-risk': 'FAN_HIGH_RISK' });

export type LoginVerdict = 'ALLOW' | 'CHALLENGE' | 'UNKNOWN';

/**
 * 고위험 재인증에 본인확인 재통과가 필요한가(identity §7 '로그인 판정의 처리', §7.1 ③): 요청만 함 + 로그인 판정 CHALLENGE·UNKNOWN.
 * UNKNOWN을 CHALLENGE와 같게 다루는 것은 이 작업들에서만이다
 */
/** 고위험 재인증이 받는 본인확인 재통과: 같은 세션의 REVERIFY VERIFIED가 확정된 지 10분 [가정] 안(identity §5) */
export const REVERIFY_WINDOW_MS = 10 * 60_000;

export function needsReverification(purpose: ReauthPurpose, strength: ReauthStrength, verdict: LoginVerdict): boolean {
  return purpose === 'high-risk' && strength === 'requested' && verdict !== 'ALLOW';
}

/** 세션이 끝나는 까닭(asyncapi SessionTerminated.reason 가운데 이 단계가 쓰는 것) */
/** DELETE: 계정이 없어져 끝냄(팬 탈퇴, asyncapi control.sessions-terminated) */
export type TerminationReason = 'LOGOUT' | 'DEVICE_LIMIT' | 'REFRESH_REUSE' | 'DELETE';

/** 만 14세 미만 정리를 시작하고 끝내기까지 두는 틈 [가정](결과 대화상자를 보일 틈, identity §8 '탈퇴의 첫 구현') */
export const CLOSURE_GRACE_MS = 10 * 60_000;
/** 탈퇴 뒤 남은 본인확인 기록을 정비가 다시 지우는 기간 [가정](늦어도 5일 안, identity §8) */
export const WITHDRAWAL_SWEEP_MS = 7 * 86_400_000;
/** 팬 탈퇴의 재인증 작업 묶음(docs/security/authz-matrix.md §6) */
export const WITHDRAWAL_REAUTH_ACT = 'FAN_SENSITIVE';

export interface ActiveSession {
  sessionId: string;
  /** 기기 행 ID. 기기 가명을 못 구해 기기 행이 없으면 null(그 세션 혼자 한 대로 센다) */
  deviceId: string | null;
  /** 마지막 활동의 기준(유휴 만료 시각, ms) */
  idleExpiresAt: number;
}

/**
 * 새 세션을 더했을 때 기기 한도를 넘으면 끝낼 세션 ID(identity §2 '기기 한도', POL-019).
 * 기기는 기기 행이 같은 세션 묶음이다. 마지막 활동이 가장 이른 기기부터 그 기기의 세션을 모두 끝낸다. 새 세션의 기기는 끝내지 않는다.
 */
export function sessionsOverDeviceLimit(active: readonly ActiveSession[], newDeviceId: string | null): string[] {
  const groups = new Map<string, { last: number; ids: string[] }>();
  for (const s of active) {
    const key = s.deviceId ?? `session:${s.sessionId}`;
    const g = groups.get(key) ?? { last: Number.NEGATIVE_INFINITY, ids: [] };
    g.ids.push(s.sessionId);
    g.last = Math.max(g.last, s.idleExpiresAt);
    groups.set(key, g);
  }
  const devices = groups.size + (newDeviceId !== null && groups.has(newDeviceId) ? 0 : 1);
  if (devices <= DEVICE_LIMIT) return [];
  return [...groups.entries()]
    .filter(([key]) => key !== newDeviceId)
    .sort(([ka, a], [kb, b]) => a.last - b.last || (ka < kb ? -1 : ka > kb ? 1 : 0))
    .slice(0, devices - DEVICE_LIMIT)
    .flatMap(([, g]) => g.ids.sort());
}

/** 세션이 지금 살아 있는가(끝나지 않았고 절대·유휴 만료 전) */
export function sessionAlive(s: { terminatedAt: number | null; absoluteExpiresAt: number; idleExpiresAt: number }, now: number): boolean {
  return s.terminatedAt === null && now < s.absoluteExpiresAt && now < s.idleExpiresAt;
}

/** 응답을 잃은 갱신의 재시도를 받아 주는 유예 30초 [가정](identity §3) */
export const REFRESH_RETRY_GRACE_MS = 30_000;

/** 갱신 판정(identity §3 '토큰 수명주기 구현' ①~④) */
export type RefreshDecision = 'rotate' | 'retry' | 'reuse' | 'invalid';

export interface RefreshState {
  /** 그 토큰이 세션의 무엇과 맞았나: 지금 토큰, 바로 앞 토큰, 그 패밀리가 예전에 받았던 토큰 */
  match: 'current' | 'previous' | 'history';
  rotatedAt: number | null;
  refreshUsed: boolean;
  alive: boolean;
}

export function decideRefresh(s: RefreshState, now: number): RefreshDecision {
  if (!s.alive) return 'invalid';
  if (s.match === 'current') return 'rotate';
  if (s.match === 'previous' && s.rotatedAt !== null && now - s.rotatedAt <= REFRESH_RETRY_GRACE_MS && !s.refreshUsed) return 'retry';
  return 'reuse';
}
