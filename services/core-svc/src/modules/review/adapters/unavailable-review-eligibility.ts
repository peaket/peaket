// ticket-svc 주소가 없을 때의 후기 자격 어댑터. 조용히 '자격 없음'으로 답하지 않고 503으로 미룬다.
import { ReviewEligibilityUnavailable, type ReviewEligibility } from '../domain/ports.js';

export class UnavailableReviewEligibility implements ReviewEligibility {
  async check(): Promise<never> {
    throw new ReviewEligibilityUnavailable('UNWIRED');
  }
}
