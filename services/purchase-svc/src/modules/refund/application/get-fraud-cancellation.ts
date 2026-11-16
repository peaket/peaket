// 부정 예매 운영자 취소의 진행 읽기(fraud_cancellation.proto GetFraudCancellation, docs/features/transfer-refund.md §7.4, BUILD_ORDER GAT-080).
// BAT-415 시험 담당의 빈 뼈대다. 동작은 구현 담당이 채운다.
import type { FraudRefundProgress, FraudTicketResult } from '../domain/fraud-cancellation.js';
import type { FraudCancellationStore } from '../domain/ports.js';

export class GetFraudCancellation {
  constructor(readonly store: FraudCancellationStore) {}

  /** @throws FraudCancellationError NOT_FOUND */
  async execute(_approvalId: string): Promise<{ readonly results: readonly FraudTicketResult[]; readonly refunds: readonly FraudRefundProgress[] }> {
    throw new Error('아직 없음');
  }
}
