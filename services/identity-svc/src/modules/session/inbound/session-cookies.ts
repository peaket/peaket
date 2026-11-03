// identity-svc가 갱신 응답으로 주는 팬 쿠키(docs/features/identity.md §3 '쿠키 이름과 속성', asvs/auth.md 3.3.1·3.3.4).
// 로그인 때 소비자 웹 앱 서버가 주는 쿠키와 이름·Domain·Path·속성이 같아야 한다(apps/web social-login/server/cookies.ts).
// 액세스 토큰 쿠키의 수명은 리프레시 토큰 쿠키와 같다(토큰의 exp 15분은 게이트웨이가 본다, identity §3).
export const ACCESS_COOKIE = '__Secure-peaket_at';
export const REFRESH_COOKIE = '__Secure-peaket_rt';
export const REFRESH_PATH = '/v1/identity/access-tokens';

const BASE = 'HttpOnly; Secure; SameSite=Strict';
const domain = (d: string | undefined) => (d ? `; Domain=${d}` : '');
const maxAge = (ms: number) => Math.max(0, Math.floor(ms / 1000));

export function sessionCookies(s: { accessToken: string; refreshToken: string; refreshTokenExpiresAt: number }, now: number, cookieDomain: string | undefined): string[] {
  const age = maxAge(s.refreshTokenExpiresAt - now);
  return [
    `${ACCESS_COOKIE}=${s.accessToken}; Path=/${domain(cookieDomain)}; Max-Age=${age}; ${BASE}`,
    `${REFRESH_COOKIE}=${s.refreshToken}; Path=${REFRESH_PATH}${domain(cookieDomain)}; Max-Age=${age}; ${BASE}`,
  ];
}

export const clearSessionCookies = (cookieDomain: string | undefined): string[] => [
  `${ACCESS_COOKIE}=; Path=/${domain(cookieDomain)}; Max-Age=0; ${BASE}`,
  `${REFRESH_COOKIE}=; Path=${REFRESH_PATH}${domain(cookieDomain)}; Max-Age=0; ${BASE}`,
];

export function cookieOf(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const s = part.trim();
    if (s.startsWith(`${name}=`)) return s.slice(name.length + 1);
  }
  return undefined;
}
