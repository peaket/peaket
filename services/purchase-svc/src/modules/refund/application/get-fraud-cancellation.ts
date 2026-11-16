// 부정 예매 운영자 취소의 진행 읽기(fraud_cancellation.proto GetFraudCancellation, docs/features/transfer-refund.md §7.4, BUILD_ORDER GAT-080).
// 없는 승인은 NOT_FOUND다. 환급 진행은 받은 표의 order_cancellation 상태를 저장소가 세 값(PENDING·REFUNDED·NEEDS_CS)으로 읽는다.
import { FraudCancellationError, type FraudRefundProgress, type FraudTicketResult } from '../domain/fraud-cancellation.js';
import type { FraudCancellationStore } from '../domain/ports.js';

export class GetFraudCancellation {
  constructor(readonly store: FraudCancellationStore) {}

  /** @throws FraudCancellationError NOT_FOUND */
  async execute(approvalId: string): Promise<{ readonly results: readonly FraudTicketResult[]; readonly refunds: readonly FraudRefundProgress[] }> {
    const request = await this.store.find(approvalId);
    if (!request) throw new FraudCancellationError('NOT_FOUND', '그 승인의 운영자 취소 기록이 없다');
    const [results, refunds] = await Promise.all([this.store.results(approvalId), this.store.refunds(approvalId)]);
    return { results, refunds };
  }
}
