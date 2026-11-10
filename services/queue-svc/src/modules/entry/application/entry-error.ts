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
  | 'LOBBY_PARTICIPANT_NOT_FOUND'
  | 'ENTRY_CANCELLED'
  /** 창 안인데 판매 자격 명단 밖이거나 사본·설정이 없다(ADR-0265 결정 5·8) */
  | 'SALE_ELIGIBILITY_REQUIRED'
  /** 위험 판정을 받지 못할 때 파드 메모리 한도를 넘었다(docs/features/bot-defense.md §11.2) */
  | 'DEGRADED_LIMITED'
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
