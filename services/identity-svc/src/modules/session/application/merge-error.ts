// 계정 병합의 업무 오류(identity §2.1 '계정 병합의 첫 구현', BOT-042). 받는 층이 문제 상세로 바꾼다.
// NOT_FOUND: 없음·만료·제안한 계정이 아님, REAUTH_REQUIRED: 재인증, BLOCKED: 막는 사유(blockers), INVARIANT: 흡수 계정의 티켓·후기(SEV3), UNAVAILABLE: 세 서비스 확인이 답하지 않음
import type { MergeBlocker } from '../domain/merge.js';

export type MergeErrorCode = 'NOT_FOUND' | 'REAUTH_REQUIRED' | 'BLOCKED' | 'INVARIANT' | 'UNAVAILABLE';

export class MergeError extends Error {
  constructor(
    readonly code: MergeErrorCode,
    message: string,
    readonly blockers?: MergeBlocker[],
  ) {
    super(message);
    this.name = 'MergeError';
  }
}
