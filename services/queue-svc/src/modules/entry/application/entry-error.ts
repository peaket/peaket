// 진입 컨텍스트 업무 오류. 받는 층이 문제 상세(RFC 9457)로 바꾼다.
export type EntryErrorCode =
  | 'NOT_FOUND'
  | 'NOT_OPEN'
  | 'SALE_ENDED'
  | 'SOLD_OUT'
  | 'BATCHING'
  | 'QUEUE_RECOVERING'
  | 'PREVERIFY_INVALID'
  | 'ALREADY_ADMITTED'
  | 'ALREADY_WAITING'
  | 'LOBBY_CLOSED'
  | 'IDENTITY_VERIFICATION_REQUIRED';

export class EntryError extends Error {
  constructor(
    readonly code: EntryErrorCode,
    message: string,
    /** 503의 Retry-After(초) */
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'EntryError';
  }
}
