// DPoP 증명의 htu와 견줄 요청 주소(offline-gate §6.1, RFC 9449 §4.3).
// 게이트웨이 공개 출처(PEAKET_PUBLIC_ORIGIN)가 있으면 forwarded 머리를 보지 않는다(C2-09).
import type { FastifyRequest } from 'fastify';

export const PUBLIC_ORIGIN_ENV = 'PEAKET_PUBLIC_ORIGIN';

const single = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined);

/**
 * 서비스가 신뢰하는 게이트웨이 공개 출처. 없으면 undefined이고 호출자는 forwarded/Host로 내려간다(개발·시험).
 * 경로·질의·조각·사용자 정보가 붙은 값은 시작 때 오류로 닫는다.
 */
export function publicOriginFromEnv(env: Record<string, string | undefined> = process.env): string | undefined {
  const raw = env[PUBLIC_ORIGIN_ENV];
  if (raw === undefined || raw.trim() === '') return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`${PUBLIC_ORIGIN_ENV}가 절대 주소가 아니다: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${PUBLIC_ORIGIN_ENV}는 http·https 주소여야 한다: ${raw}`);
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new Error(`${PUBLIC_ORIGIN_ENV}에는 경로·질의·조각·사용자 정보를 붙일 수 없다: ${raw}`);
  }
  return url.origin;
}

/**
 * 증명의 `htu`와 견줄 절대 주소. `publicOrigin`이 있으면 그 출처 + 요청 경로이고,
 * 없으면 게이트웨이가 넘긴 forwarded 머리를 먼저 쓰고 Host로 내려간다(개발·시험).
 */
export function requestUrlOf(request: FastifyRequest, publicOrigin?: string): string {
  const path = request.url.split(/[?#]/)[0];
  if (publicOrigin !== undefined) return `${publicOrigin.replace(/\/$/, '')}${path}`;
  const proto = single(request.headers['x-forwarded-proto']) ?? request.protocol;
  const host = single(request.headers['x-forwarded-host']) ?? single(request.headers.host);
  if (!host) throw new Error('요청 Host가 없다(DPoP htu를 만들 수 없다)');
  return `${proto}://${host}${path}`;
}
