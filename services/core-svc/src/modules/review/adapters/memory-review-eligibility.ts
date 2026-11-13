// 시험용 후기 자격 어댑터. 시험이 계정·회차별 답을 정한다.
import type { ReviewEligibility } from '../domain/ports.js';

export interface EligibilityAnswer {
  readonly eligible: boolean;
  readonly basisOrderId?: string;
  readonly reason?: 'NOT_ENDED' | 'NOT_PURCHASER' | 'NO_VALID_TICKET';
}

export class MemoryReviewEligibility implements ReviewEligibility {
  readonly answers = new Map<string, EligibilityAnswer>();
  /** 답이 없을 때의 기본값. 시험은 보통 계정·회차를 넣는다 */
  fallback: EligibilityAnswer = { eligible: false, reason: 'NOT_PURCHASER' };

  set(accountId: string, eventId: string, answer: EligibilityAnswer): void {
    this.answers.set(`${accountId}/${eventId}`, answer);
  }

  async check(input: { accountId: string; eventId: string }): Promise<EligibilityAnswer> {
    return this.answers.get(`${input.accountId}/${input.eventId}`) ?? this.fallback;
  }
}
