// 원시 본문 바이트(openspec 변경 add-idempotency-and-outbox 결정 4). 플랫폼 본문 해석기가 해석 전 바이트를 요청에 남긴다.
// 요청 지문(docs/api/guidelines.md §4)과 구매 세션 요청 서명(X-Purchase-Mac의 SHA-256(본문 바이트))이 같은 바이트를 쓴다.
import type { FastifyRequest } from 'fastify';

const RAW_BODY = Symbol('peaket.rawBody');
const EMPTY = Buffer.alloc(0);

/** 해석기가 부른다 */
export function keepRawBody(request: FastifyRequest, body: Buffer): void {
  (request as unknown as Record<symbol, Buffer>)[RAW_BODY] = body;
}

/** 해석 전 본문 바이트. 본문이 없거나 플랫폼 해석기를 지나지 않았으면 빈 바이트 */
export function rawBodyOf(request: FastifyRequest): Buffer {
  return (request as unknown as Record<symbol, Buffer | undefined>)[RAW_BODY] ?? EMPTY;
}
