// 본인확인 컨텍스트 gRPC 받는 층의 오류 다루기(docs/api/proto/README.md §2 'gRPC 상태 코드').
import { DrizzleQueryError } from 'drizzle-orm';

/** DB 오류는 쿼리 틀과 오류 코드만 남긴다(값에 연계정보 HMAC·계정 ID·pid가 있다, ASVS v5.0.0-16.2.5, 새 맥락 리뷰 L5) */
export function safeError(err: unknown): unknown {
  if (!(err instanceof DrizzleQueryError)) return err;
  const code = (err.cause as { code?: unknown } | undefined)?.code;
  const e = new Error(`Failed query: ${err.query}${typeof code === 'string' ? ` (${code})` : ''}`);
  e.name = 'DrizzleQueryError';
  if (err.stack) e.stack = err.stack.replace(err.message, () => e.message);
  return e;
}

/**
 * 저장소에 닿지 못한 오류(연결 거부·끊김, PostgreSQL 연결 예외 08xxx·관리자 종료 57P0x). 원인 고리를 네 단계까지 본다.
 * 세션 컨텍스트의 받는 층(session.grpc.ts)과 같은 규칙이다. 부르는 쪽은 UNAVAILABLE을 보고 통과시키지 않는다
 */
const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENOTFOUND', '57P01', '57P02', '57P03']);
export function unreachable(err: unknown): boolean {
  let e = err as { code?: unknown; cause?: unknown } | undefined;
  for (let n = 0; e && n < 4; n++) {
    const c = typeof e.code === 'string' ? e.code : '';
    if (UNREACHABLE.has(c) || c.startsWith('08')) return true;
    e = e.cause as typeof e;
  }
  return false;
}
