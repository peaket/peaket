// 소비자 웹 앱 서버가 주고 지우는 쿠키(docs/features/identity.md §3 '쿠키 이름과 속성', asvs/auth.md 3.3.1·3.3.3·3.3.4).
// 모두 Secure·HttpOnly이고 이름에 접두사를 붙인다. 지울 때는 같은 이름·Domain·Path에 Max-Age=0을 단다(Clear-Site-Data는 쓰지 않는다).

export const ACCESS_COOKIE = '__Secure-peaket_at';
export const REFRESH_COOKIE = '__Secure-peaket_rt';
export const REFRESH_PATH = '/v1/identity/access-tokens';
export const PROGRESS_COOKIE = '__Host-peaket_oidc';
export const REAUTH_COOKIE = '__Host-peaket_reauth';
/** 로그인 진행 쿠키 10분 [가정], 재인증 결과 쿠키 1분 [가정](identity §3·§7.1) */
export const PROGRESS_TTL_MS = 10 * 60_000;
export const REAUTH_RESULT_TTL_MS = 60_000;

const BASE = 'HttpOnly; Secure';
const maxAge = (ms: number) => Math.max(0, Math.floor(ms / 1000));
const domain = (d: string | undefined) => (d ? `; Domain=${d}` : '');

/**
 * 로그인 뒤 identity 세션의 두 쿠키. 여러 호스트가 읽는 공유 쿠키라 __Secure-와 Domain을 쓴다.
 * 액세스 토큰 쿠키의 수명은 리프레시 토큰 쿠키와 같다(토큰의 exp 15분은 게이트웨이가 본다). 15분에 지우면 쉬었다 온 브라우저의 로그아웃이
 * 끝낼 세션을 찾지 못한다(identity §3, 추천 적용 2026-11-03)
 */
export function sessionCookies(s: { accessToken: string; refreshToken: string; refreshExpiresAt: number }, now: number, cookieDomain: string | undefined): string[] {
  return [
    `${ACCESS_COOKIE}=${s.accessToken}; Path=/${domain(cookieDomain)}; Max-Age=${maxAge(s.refreshExpiresAt - now)}; ${BASE}; SameSite=Strict`,
    `${REFRESH_COOKIE}=${s.refreshToken}; Path=${REFRESH_PATH}${domain(cookieDomain)}; Max-Age=${maxAge(s.refreshExpiresAt - now)}; ${BASE}; SameSite=Strict`,
  ];
}

export const clearSessionCookies = (cookieDomain: string | undefined): string[] => [
  `${ACCESS_COOKIE}=; Path=/${domain(cookieDomain)}; Max-Age=0; ${BASE}; SameSite=Strict`,
  `${REFRESH_COOKIE}=; Path=${REFRESH_PATH}${domain(cookieDomain)}; Max-Age=0; ${BASE}; SameSite=Strict`,
];

/** 진행 쿠키: 제공자에서 돌아오는 최상위 GET에 실려야 해서 Lax다 */
export const progressCookie = (v: string) => `${PROGRESS_COOKIE}=${v}; Path=/; Max-Age=${maxAge(PROGRESS_TTL_MS)}; ${BASE}; SameSite=Lax`;
export const clearProgressCookie = () => `${PROGRESS_COOKIE}=; Path=/; Max-Age=0; ${BASE}; SameSite=Lax`;
/** 재인증 결과 쿠키: 화면 스크립트의 같은 출처 POST만 읽으면 되므로 Strict다 */
export const reauthCookie = (v: string) => `${REAUTH_COOKIE}=${v}; Path=/; Max-Age=${maxAge(REAUTH_RESULT_TTL_MS)}; ${BASE}; SameSite=Strict`;
export const clearReauthCookie = () => `${REAUTH_COOKIE}=; Path=/; Max-Age=0; ${BASE}; SameSite=Strict`;

export function cookieOf(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const s = part.trim();
    if (s.startsWith(`${name}=`)) return s.slice(name.length + 1);
  }
  return undefined;
}
