// 본인확인 유스케이스가 요청을 처리하지 못한 까닭. 받는 층이 Problem으로 바꾼다(openapi /v1/identity/verifications*).
export type VerificationErrorCode = 'NEXT_INVALID' | 'ALREADY_VERIFIED' | 'NOT_FOUND' | 'DUPLICATE_ACCOUNT' | 'PROVIDER_DOWN' | 'PURPOSE_UNSUPPORTED';

export class VerificationError extends Error {
  constructor(
    readonly code: VerificationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'VerificationError';
  }
}
