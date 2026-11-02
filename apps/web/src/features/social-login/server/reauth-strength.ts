// 제공자 재인증의 강도와 최근성(docs/features/identity.md §7.1, I-T54, ASVS v5.0.0-6.8.4, ADR-0001).
// 서명·iss·aud·exp·nonce·state·PKCE 확인을 마친 ID 토큰의 클레임만 넣는다.
import type { Provider } from './providers.ts';

/** 시계 차이를 봐주는 폭 30초 [가정](identity §7.1) */
export const CLOCK_SKEW_MS = 30_000;
/** 구글 auth_time을 받아 주는 최근성 5분 [가정](identity §7.1) */
export const GOOGLE_MAX_AGE_MS = 5 * 60_000;

/** verified 확인됨, requested 요청만 함, stale 거부('제공자 계정에서 로그아웃한 뒤 다시 시도') */
export type ReauthOutcome = 'verified' | 'requested' | 'stale';

const ms = (seconds: unknown): number | undefined => (typeof seconds === 'number' && Number.isFinite(seconds) ? seconds * 1000 : undefined);

/**
 * @param startedAt 재인증을 시작한 시각(앱 서버가 로그인 진행 쿠키에 봉인한 값, ms)
 * @param now 콜백을 처리하는 시각(ms)
 */
export function reauthStrength(provider: Provider, claims: { auth_time?: unknown; iat?: unknown }, startedAt: number, now: number): ReauthOutcome {
  const authTime = ms(claims.auth_time);
  if (provider === 'kakao') {
    // prompt=login을 따랐다면 auth_time은 시작 뒤다. 없거나 이르면 다시 묻지 않고 통과시킨 것이다
    return authTime !== undefined && authTime >= startedAt - CLOCK_SKEW_MS ? 'verified' : 'stale';
  }
  if (provider === 'naver') {
    // 설정 정보의 claims_supported에 auth_time이 없다. nonce(앞에서 확인)와 iat로 이번 요청의 응답인지만 본다
    const iat = ms(claims.iat);
    return iat !== undefined && iat >= startedAt - CLOCK_SKEW_MS ? 'requested' : 'stale';
  }
  // 구글: 다시 로그인을 강제하지 못한다. claims로 요청한 auth_time이 있으면 최근성을 보고, 없으면 요청만 함이다
  if (authTime === undefined) return 'requested';
  return now - authTime <= GOOGLE_MAX_AGE_MS + CLOCK_SKEW_MS ? 'verified' : 'stale';
}

/** 재인증 때 인가 요청에 더하는 값(identity §7.1 표의 '다시 로그인 강제') */
export function reauthPrompt(provider: Provider): Record<string, string> {
  if (provider === 'google') return { prompt: 'select_account', claims: JSON.stringify({ id_token: { auth_time: { essential: true } } }) };
  return { prompt: 'login' };
}
