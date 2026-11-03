// 유스케이스가 요청을 처리하지 못한 까닭. 받는 층이 gRPC 상태 코드로 바꾼다(docs/api/proto/README.md §2 'gRPC 상태 코드').
// 정상적인 업무 결과(재인증 계정 불일치 등)는 이것이 아니라 응답의 결과 값이다.
export type SessionErrorCode = 'INVALID_ARGUMENT' | 'ALREADY_EXISTS' | 'FAILED_PRECONDITION' | 'NOT_FOUND';

export class SessionError extends Error {
  constructor(
    readonly code: SessionErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}
