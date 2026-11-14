// DPoP 증명의 htu와 견줄 절대 주소. 게이트웨이가 넘긴 출처 머리를 먼저 쓴다(offline-gate §6.1).
import type { FastifyRequest } from 'fastify';

const single = (v: string | string[] | undefined): string | undefined => (typeof v === 'string' ? v : Array.isArray(v) ? v[0] : undefined);

export function requestUrlOf(request: FastifyRequest): string {
  const proto = single(request.headers['x-forwarded-proto']) ?? request.protocol;
  const host = single(request.headers['x-forwarded-host']) ?? single(request.headers.host);
  if (!host) throw new Error('요청 Host가 없다(DPoP htu를 만들 수 없다)');
  const path = request.url.split(/[?#]/)[0];
  return `${proto}://${host}${path}`;
}
