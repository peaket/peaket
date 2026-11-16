// 보류 취소 전환(BAT-420 GAT-110 E, R-T24, docs/data.md §5, docs/features/transfer-refund.md §5 '대상 선택과 보류 취소 전환').
// 입장 시작 뒤 취소로 마감 뒤 환급을 기다리던 행(REQUESTED)을 회차 취소 환급으로 이어 쓴다: 사유 EVENT_CANCELLED·공제 0·환급 = 권면 전액·
// 회차 취소 요청 ID·마감 뒤 환급 시각 비움·REFUND_PENDING. 주문 행을 먼저 잠그고(취소 쓰기와 같은 차례) REQUESTED인 그 행만 바꾼다.
// 그사이 환급 실행기가 집었으면(REFUND_PENDING) 바꾸지 않고 NOT_REQUESTED다.
import type { Database } from '@peaket/platform';
import { and, eq } from 'drizzle-orm';
import { orderCancellation, purchaseOrder } from '../../../booking/index.js';
import type { PendingCancellationConversions } from '../../domain/event-refund-ports.js';

export class DrizzlePendingCancellationConversions implements PendingCancellationConversions {
  constructor(private readonly database: Database) {}

  async convert(q: Parameters<PendingCancellationConversions['convert']>[0]): Promise<'CONVERTED' | 'NOT_REQUESTED'> {
    return this.database.transaction(async (tx) => {
      const [row] = await tx.select({ orderId: orderCancellation.orderId }).from(orderCancellation).where(eq(orderCancellation.id, q.cancellationId)).limit(1);
      if (!row) return 'NOT_REQUESTED';
      await tx.select({ id: purchaseOrder.id }).from(purchaseOrder).where(eq(purchaseOrder.id, row.orderId)).for('no key update');
      const updated = await tx
        .update(orderCancellation)
        .set({
          reason: 'EVENT_CANCELLED',
          deductionBp: 0,
          deductionAmount: 0,
          refundAmount: q.refundAmount,
          eventCancellationRequestId: q.eventCancellationRequestId,
          refundDueAt: null,
          nextRefundAt: null,
          status: 'REFUND_PENDING',
          statusChangedAt: new Date(q.nowMs),
        })
        .where(and(eq(orderCancellation.id, q.cancellationId), eq(orderCancellation.status, 'REQUESTED')))
        .returning({ id: orderCancellation.id });
      return updated.length > 0 ? 'CONVERTED' : 'NOT_REQUESTED';
    });
  }
}
