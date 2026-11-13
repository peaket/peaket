// 입장 기록 마감 뒤 환급 실행기(GAT-080, docs/features/payment.md §4.1).
// REQUESTED·refundAfterEntryClose로 접수한 취소 가운데 환급 시각(refund_due_at)이 지난 것을 결제사 취소로 이어 간다.
// 카드 결제는 계좌가 필요 없고, 가상계좌는 환불 계좌를 저장하지 않으므로(POL-014) 이 실행기가 처리하지 못한다(CS 알림 대상).
import type { MaintenanceTask } from '@peaket/platform';
import type { CancellationWrites, PaymentCancellations } from '../domain/ports.js';

export interface RefundAfterEntryDeps {
  writes: CancellationWrites;
  payments: PaymentCancellations;
  nowMs(): number;
}

/** 한 번에 처리하는 취소 수 [가정] */
export const REFUND_AFTER_ENTRY_BATCH = 100;

export class RefundAfterEntry {
  constructor(private readonly deps: RefundAfterEntryDeps) {}

  async run(limit = REFUND_AFTER_ENTRY_BATCH): Promise<{ refunded: number; pending: number }> {
    const due = await this.deps.writes.dueRefunds(this.deps.nowMs(), limit);
    let refunded = 0;
    let pending = 0;
    for (const c of due) {
      const r = await this.deps.payments.cancel({ cancellationId: c.cancellationId, orderId: c.orderId, amount: c.amount, reason: c.reason, deadlineMs: 5_000 });
      if (r === 'CANCELLED') {
        await this.deps.writes.updateStatus({ cancellationId: c.cancellationId, status: 'REFUNDED', nowMs: this.deps.nowMs() });
        refunded++;
      } else {
        pending++;
      }
    }
    return { refunded, pending };
  }
}

export function refundAfterEntryTask(refund: Pick<RefundAfterEntry, 'run'>, logger?: { warn(o: object, msg: string): void }): MaintenanceTask {
  return {
    name: 'cancellation-refund-after-entry',
    when: 'daily',
    run: async () => {
      try {
        return await refund.run();
      } catch (err) {
        logger?.warn({ event: 'cancellation_refund_after_entry_failed', err: (err as Error).name }, '입장 기록 마감 뒤 환급 실행이 실패했다(다음 정비가 다시 한다)');
        throw err;
      }
    },
  };
}
