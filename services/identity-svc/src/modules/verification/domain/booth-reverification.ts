// 부스 재발급의 본인확인 대조 값(openapi createIdentityBoothReverification, docs/features/identity.md §6.1,
// docs/features/offline-gate.md §9.1 '부스 재발급', docs/review/plans/F-05-12.md §3 결정 1).
// 토큰은 32바이트 불투명 값(URL-safe base64 43자)이고 서버에는 SHA-256 해시만 남긴다.
import { createHash, randomBytes } from 'node:crypto';

/** 부스 대조 토큰 수명 5분 [가정](openapi, d5 §5.13). ticket-svc가 이 토큰으로 부스 코드를 만든다 */
export const BOOTH_TOKEN_TTL_MS = 5 * 60_000;

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function newBoothToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashBoothToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export const isBoothToken = (v: unknown): v is string => typeof v === 'string' && TOKEN.test(v);

/** openapi createIdentityBoothReverification의 ticketId. ticket 논리 DB라 존재·소유는 ticket-svc가 본다 */
export const isBoothTicketId = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);
