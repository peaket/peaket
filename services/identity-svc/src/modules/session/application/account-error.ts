// 계정 받는 층의 업무 오류(탈퇴, docs/features/identity.md §8 '탈퇴의 첫 구현'). 받는 층이 문제 상세(RFC 9457)로 바꾼다.
export type AccountErrorCode = 'REAUTH_REQUIRED';

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AccountError';
  }
}
