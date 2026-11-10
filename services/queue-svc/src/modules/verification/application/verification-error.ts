// 추가 검증 유스케이스의 업무 오류. 받는 층이 Problem(REST)이나 gRPC 상태로 바꾼다.

export type VerificationErrorCode =
  /** 이 회차의 대기열이 열리지 않았다(404 queue-not-found) */
  | 'NOT_FOUND'
  /** 이 계정의 이 회차 대기 참여가 없다(404 queue-entry-not-found) */
  | 'ENTRY_NOT_FOUND'
  /** 추가 검증 중인 대기 참여가 아니다(409 not-verifying) */
  | 'NOT_VERIFYING'
  /** 판매 종료 뒤(410 sale-ended) */
  | 'SALE_ENDED'
  /** 이의 기각으로 끝난 대기 참여(410 queue-ticket-removed, removeReason BLOCKED) */
  | 'BLOCKED'
  /** 한 대기 참여의 제출 한도를 넘었다(429 verification-submit-limited) */
  | 'SUBMIT_LIMITED'
  /** trust-svc·identity-svc가 답하지 않았다(503, 통과로 보지 않는다) */
  | 'UNAVAILABLE'
  /** 건 요청 발행에 실패했거나 확인이 상한 안에 오지 않았다(503) */
  | 'PUBLISH_FAILED'
  /** 본인확인 전이라 pid가 없다(403 identity-verification-required) */
  | 'IDENTITY_VERIFICATION_REQUIRED'
  /** 본문 형식이 틀렸다(400) */
  | 'INVALID'
  /** gRPC: 이의가 없다(NOT_FOUND) */
  | 'APPEAL_NOT_FOUND'
  /** gRPC: 같은 건 ID에 다른 이의가 묶였다(ALREADY_EXISTS) */
  | 'CASE_CONFLICT';

export class VerificationError extends Error {
  constructor(
    readonly code: VerificationErrorCode,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'VerificationError';
  }
}
