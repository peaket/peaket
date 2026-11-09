// 위험 판정 업무 오류. 받는 층이 gRPC 상태 코드로 바꾼다.
export type TrustErrorCode = 'INVALID_ARGUMENT' | 'UNAVAILABLE';

export class TrustError extends Error {
  constructor(
    readonly code: TrustErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TrustError';
  }
}
