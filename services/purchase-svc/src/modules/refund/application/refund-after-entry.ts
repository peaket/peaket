// 환급 실행기(GAT-080·GAT-090, docs/features/payment.md §4.1, docs/features/transfer-refund.md §7.1).
// ① 입장 기록 마감 뒤 환급할 REQUESTED(refund_due_at이 지난 것) ② 결제사 결과 모름·일시 실패로 남은 REFUND_PENDING(next_refund_at이 지난 것)을
// 같은 결제사 취소(cancel-{cancellationId})로 이어 간다. 성공하면 REFUNDED, 업무 거절·재시도 소진이면 refund_failed_at을 남겨 CS 처리함 대상으로 보낸다.
// 카드 결제는 계좌가 필요 없고, 가상계좌는 환불 계좌를 저장하지 않으므로(POL-014) 이 실행기가 처리하지 못한다(CS 알림 대상).
import type { MaintenanceTask } from '@peaket/platform';
import { REFUND_RETRY_MAX_ATTEMPTS, refundRetryDelayMs } from '../domain/cancellation.js';
import type { CancellationWrites, PaymentCancellations, RefundFailureNotice } from '../domain/ports.js';

export interface RefundAfterEntryDeps {
  writes: CancellationWrites;
  payments: PaymentCancellations;
  nowMs(): number;
  /** 재시도 소진·업무 거절을 CS 처리함에 잇는 포트. 없으면 refund_failed_at만 남긴다(ops-svc 계약 전) */
  failureNotice?: RefundFailureNotice;
}

/** 한 번에 처리하는 취소 수 [가정] */
export const REFUND_AFTER_ENTRY_BATCH = 100;

export class RefundAfterEntry {
  constructor(private readonly deps: RefundAfterEntryDeps) {}

  async run(limit = REFUND_AFTER_ENTRY_BATCH): Promise<{ refunded: number; pending: number; failed: number }> {
    const due = await this.deps.writes.dueRefunds(this.deps.nowMs(), limit);
    let refunded = 0;
    let pending = 0;
    let failed = 0;
    for (const c of due) {
      const r = await this.deps.payments.cancel({ cancellationId: c.cancellationId, orderId: c.orderId, amount: c.amount, reason: c.reason, deadlineMs: 5_000 });
      if (r === 'CANCELLED') {
        await this.deps.writes.updateStatus({ cancellationId: c.cancellationId, status: 'REFUNDED', nowMs: this.deps.nowMs() });
        refunded++;
        continue;
      }
      const attempts = c.attempts + 1;
      if (r === 'REJECTED' || attempts >= REFUND_RETRY_MAX_ATTEMPTS) {
        await this.deps.writes.markRefundFailed({ cancellationId: c.cancellationId, attempts, lastError: r, nowMs: this.deps.nowMs() });
        await this.deps.failureNotice?.open({ cancellationId: c.cancellationId, orderId: c.orderId, attempts, lastError: r, nowMs: this.deps.nowMs() });
        failed++;
        continue;
      }
      await this.deps.writes.scheduleRefundRetry({
        cancellationId: c.cancellationId,
        attempts,
        nextRetryAtMs: this.deps.nowMs() + refundRetryDelayMs(attempts),
        lastError: r,
        nowMs: this.deps.nowMs(),
      });
      pending++;
    }
    return { refunded, pending, failed };
  }
}

export function refundAfterEntryTask(refund: Pick<RefundAfterEntry, 'run'>, logger?: { warn(o: object, msg: string): void }): MaintenanceTask {
  return {
    name: 'cancellation-refund-retry',
    when: 'daily',
    run: async () => {
      try {
        return await refund.run();
      } catch (err) {
        logger?.warn({ event: 'cancellation_refund_retry_failed', err: (err as Error).name }, '환급 재시도 실행이 실패했다(다음 정비가 다시 한다)');
        throw err;
      }
    },
  };
}
