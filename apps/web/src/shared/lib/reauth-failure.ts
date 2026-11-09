// 재인증 결과 받기(POST /reauth/token)가 실패한 이유와 그 화면 문구(docs/features/identity.md §7.1 ②·§8 '탈퇴 화면 연결', I-T54 ②).
// 이유 이름은 앱 서버 REAUTH_PROBLEM(features/social-login/server/handlers.ts)의 문제 type과 짝이다.
// 이유마다 다르게 보여야 다시 묻지 않고 통과하는 제공자에서 사용자가 무엇을 할지 안다. 탈퇴(SCR-017)와 로그인 수단(SCR-040)이 함께 쓴다(BOT-041이 넘긴 것).

export type ReauthFailure = 'stale' | 'account-mismatch' | 'reverify-required' | 'failed' | 'missing';

const BY_TYPE: Readonly<Record<string, ReauthFailure>> = {
  'reauth-stale': 'stale',
  'reauth-account-mismatch': 'account-mismatch',
  'reauth-reverify-required': 'reverify-required',
  'reauth-failed': 'failed',
  'reauth-result-missing': 'missing',
};

/**
 * 재인증 토큰을 쓰는 요청의 403(reauth-required) 앞 문장. 팬 재인증 토큰은 5분 한 번이라 403은 5분이 지난 때 말고 이미 쓴 토큰에도 온다
 * (d5 §9.2 오류 응답별 화면 문구, 2026-11-05, BOT-036이 넘긴 것). 화면마다 뒤 문장('다시 로그인해 주세요'·'처음부터 다시 시도해 주세요')을 붙인다
 */
export const REAUTH_EXPIRED = '다시 로그인한 확인이 만료되었거나 이미 쓰였습니다';
/** 재인증으로 떠나기 전 토큰 갱신이 401이 아닌 이유(연결 끊김·5xx)로 실패했다(d5 §5.17, identity §8·§2.1) */
export const REAUTH_START_UNAVAILABLE = '지금은 다시 로그인을 시작할 수 없습니다. 잠시 뒤 다시 시도해 주세요';

/** 문제 type의 끝 이름(예: reauth-stale) → 이유. 모르는 이름은 failed */
export const reauthFailureOf = (type: string): ReauthFailure => BY_TYPE[type] ?? 'failed';

export function reauthFailureText(reason: ReauthFailure): string {
  switch (reason) {
    case 'stale':
      return '제공자 계정에서 로그아웃한 뒤 다시 시도해 주세요';
    case 'account-mismatch':
      return '지금 로그인한 계정과 다른 계정으로 다시 로그인했습니다. 지금 로그인한 계정으로 다시 로그인해 주세요';
    case 'reverify-required':
      return '휴대폰 본인확인을 다시 한 뒤 계속할 수 있습니다';
    case 'missing':
    case 'failed':
      return '다시 로그인하지 못했습니다. 다시 시도해 주세요';
  }
}
