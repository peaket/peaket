// 관리 계정 비밀번호 정하기의 오류(BUILD_ORDER BOT-110). 받는 층(초대 수락 BOT-150·비밀번호 바꾸기 BOT-121)이 Problem으로 옮긴다:
// REJECTED는 422(걸린 이유 종류와 안내 문구, auth-controls §4.3 7), UNAVAILABLE은 503과 Retry-After(유출 목록·페퍼 키 서비스), NOT_FOUND는 404.
import type { PolicyReason } from '../domain/password-policy.js';

export type AdminPasswordRejection = PolicyReason | 'BREACHED';

export class AdminPasswordError extends Error {
  constructor(
    readonly code: 'REJECTED' | 'UNAVAILABLE' | 'NOT_FOUND',
    message: string,
    readonly reason?: AdminPasswordRejection,
  ) {
    super(message);
    this.name = 'AdminPasswordError';
  }
}

/** 거절 이유의 화면 문구와 함께 보일 안내(auth-controls §4.3 7. 유출 횟수는 보이지 않는다) */
export const REJECTION_TEXT: Record<AdminPasswordRejection, string> = {
  COMMON: '너무 흔한 비밀번호입니다',
  BREACHED: '유출된 적이 있는 비밀번호입니다',
  CONTEXT: '서비스·회사·계정 이름에 숫자나 기호만 붙인 비밀번호는 쓸 수 없습니다',
  TOO_SHORT: '15자 이상이어야 합니다',
  TOO_LONG: '비밀번호가 너무 깁니다',
};
export const PASSWORD_ADVICE = '서로 관계없는 낱말 여러 개를 이은 문장이나 비밀번호 관리자가 만든 값을 쓰세요';
