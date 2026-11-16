// 회차 취소 확정 전에 공제하고 보낸 입장 시작 뒤 취소(차액 CS 건 대상) 읽기(BAT-420 몫 D, OPEN[45] 결정, R-T38 ④,
// docs/features/transfer-refund.md §5 '회차 취소 요청 중 보류 취소의 환급 미룸'). 그 회차에서 입장 시작 시각(정각 포함) 뒤에 접수된
// 사용자 취소(reason USER) 가운데 공제가 있고(deduction_amount > 0) 결제사로 보낸(REFUND_PENDING·REFUNDED) 행이다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { DeductionGapCancellations } from '../../domain/event-refund-ports.js';

export class DrizzleDeductionGapCancellations implements DeductionGapCancellations {
  constructor(private readonly database: Database) {}

  /** BAT-420 리뷰 D5(빈 뼈대) */
  async forTicket(_ticketId: string): Promise<{ cancellationId: string; orderId: string; ticketId: string; deductionAmount: number } | undefined> {
    throw new Error('아직 없음');
  }

  async list(eventId: string, entryOpensAtMs: number): ReturnType<DeductionGapCancellations['list']> {
    const r = await this.database.db.execute(sql`
      select c.id, c.order_id, c.ticket_id, c.deduction_amount
        from order_cancellation c
        join purchase_order o on o.id = c.order_id
       where o.event_id = ${eventId}::uuid
         and c.reason = 'USER'
         and c.deduction_amount > 0
         and c.created_at >= ${new Date(entryOpensAtMs)}::timestamptz
         and c.status in ('REFUND_PENDING', 'REFUNDED')
       order by c.created_at, c.id`);
    return (r.rows as { id: string; order_id: string; ticket_id: string; deduction_amount: number | string }[]).map((x) => ({
      cancellationId: x.id,
      orderId: x.order_id,
      ticketId: x.ticket_id,
      deductionAmount: Number(x.deduction_amount),
    }));
  }
}
