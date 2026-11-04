// 관리 계정 세션 쿠키(docs/features/identity.md §3 쿠키 표, ADR-0065 결정 11, ADR-0119, BUILD_ORDER BOT-120).
// 파트너: __Secure-peaket_partner_at(Domain 설정값, Path=/)·__Secure-peaket_partner_rt(Path=/v1/partner/auth/access-tokens).
// 관제: __Host-peaket_ops_at·__Host-peaket_ops_rt(Path=/, Domain 없음). 모두 Secure·HttpOnly·SameSite=Strict, Max-Age는 세션 최대 수명까지 남은 초.
import type { AdminAud } from '../domain/ports.js';

export const ADMIN_COOKIE_DOMAIN = Symbol('identity.AdminCookieDomain');

export const ADMIN_COOKIES = {
  partner: { at: '__Secure-peaket_partner_at', rt: '__Secure-peaket_partner_rt', rtPath: '/v1/partner/auth/access-tokens' },
  ops: { at: '__Host-peaket_ops_at', rt: '__Host-peaket_ops_rt', rtPath: '/' },
} as const;

export function adminSessionCookies(aud: AdminAud, t: { accessToken: string; refreshToken: string; absoluteExpiresAt: number }, now: number, domain: string | undefined): string[] {
  const names = ADMIN_COOKIES[aud];
  const maxAge = Math.max(0, Math.floor((t.absoluteExpiresAt - now) / 1000));
  // __Host-는 Domain을 붙이면 안 된다(RFC 6265bis). 파트너 쿠키만 설정한 Domain을 붙인다
  const dom = aud === 'partner' && domain ? `; Domain=${domain}` : '';
  const tail = `; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Strict`;
  return [`${names.at}=${t.accessToken}${dom}; Path=/${tail}`, `${names.rt}=${t.refreshToken}${dom}; Path=${names.rtPath}${tail}`];
}
