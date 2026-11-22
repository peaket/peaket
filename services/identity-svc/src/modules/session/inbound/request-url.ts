// DPoP 증명의 htu와 견줄 절대 주소(offline-gate §6.1). 게이트웨이 공개 출처(PEAKET_PUBLIC_ORIGIN)가 있으면
// forwarded 머리를 보지 않는다(C2-09). 없으면 개발·시험처럼 forwarded→Host로 내려간다.
import { publicOriginFromEnv, requestUrlOf as platformRequestUrlOf } from '@peaket/platform';
import type { FastifyRequest } from 'fastify';

export function requestUrlOf(request: FastifyRequest): string {
  return platformRequestUrlOf(request, publicOriginFromEnv());
}
