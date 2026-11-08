// 계정 받는 층의 업무 오류(탈퇴 §8, 로그인 수단 해제 §2.1, 로그인한 기기 §8). 받는 층이 문제 상세(RFC 9457)로 바꾼다.
// NOT_FOUND: 해제할 종류가 연결돼 있지 않음, LAST_LOGIN_METHOD: 마지막 로그인 수단(I-T33, BOT-041)
// SESSION_ENDED: 부른 세션이 이미 끝남(목록 401), SESSION_NOT_FOUND: 이 계정의 살아 있는 세션이 아니거나 끝낼 다른 로그인이 없음(404, BOT-044)
// ALREADY_COMPLETED: 가입을 이미 마친 계정의 가입 취소(409, ADR-0235 결정 6)
export type AccountErrorCode = 'REAUTH_REQUIRED' | 'CONFIRMATION_REQUIRED' | 'NOT_FOUND' | 'LAST_LOGIN_METHOD' | 'SESSION_ENDED' | 'SESSION_NOT_FOUND' | 'ALREADY_COMPLETED';

export class AccountError extends Error {
  constructor(
    readonly code: AccountErrorCode,
    message: string,
    /** CONFIRMATION_REQUIRED: 대조값 보관 안내(409 fraudHold, identity §8 '대조값 보관의 첫 구현') */
    readonly fraudHold?: { state: 'CASE_OPEN' | 'RESTRICTED'; until: number },
  ) {
    super(message);
    this.name = 'AccountError';
  }
}
