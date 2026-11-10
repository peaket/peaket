// 위험 판정·라벨 반영 업무 오류. 받는 층이 gRPC 상태 코드로 바꾼다. 문구에는 받은 값을 싣지 않는다.
export type TrustErrorCode = 'INVALID_ARGUMENT' | 'UNAVAILABLE' | 'ALREADY_EXISTS';

export class TrustError extends Error {
  constructor(
    readonly code: TrustErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TrustError';
  }
}
