// 입장 확정 업무 오류. 받는 층이 문제 상세(RFC 9457)로 바꾼다(openapi 입장 확정, ADR-0183 결정 7).
export type AdmissionErrorCode =
  | 'NOT_FOUND'
  | 'TICKET_INVALID'
  | 'PRIORITY_GRANT_NOT_FOUND'
  | 'IDENTITY_VERIFICATION_REQUIRED'
  | 'DUPLICATE_ADMISSION'
  | 'SALE_ENDED'
  | 'SOLD_OUT'
  | 'EXPIRED'
  | 'REMOVED'
  /** 셔플 결과 키를 잃은 참가자: repair:lobby를 썼고 다시 쓰기를 기다린다(503) */
  | 'LOBBY_REPAIRING';

export class AdmissionError extends Error {
  constructor(
    readonly code: AdmissionErrorCode,
    message: string,
    /** 410 만료의 다시 줄 서기 가능 여부(ADR-0062) */
    readonly rejoinAllowed?: boolean,
  ) {
    super(message);
    this.name = 'AdmissionError';
  }
}
