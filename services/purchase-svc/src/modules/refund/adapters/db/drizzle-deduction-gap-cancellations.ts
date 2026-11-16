// 회차 취소 확정 전에 공제하고 보낸 입장 시작 뒤 취소(차액 CS 건 대상) 읽기(BAT-420 몫 D, OPEN[45] 결정, R-T38 ④,
// docs/features/transfer-refund.md §5 '회차 취소 요청 중 보류 취소의 환급 미룸'). 그 회차에서 입장 시작 시각(정각 포함) 뒤에 접수된
// 사용자 취소(reason USER) 가운데 공제가 있고(deduction_amount > 0) 결제사로 보낸(REFUND_PENDING·REFUNDED) 행이다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { DeductionGapCancellations } from '../../domain/event-refund-ports.js';

export class DrizzleDeductionGapCancellations implements DeductionGapCancellations {
  constructor(private readonly database: Database) {}

  /**
   * 그 표의 결제사로 보낸(REFUND_PENDING·REFUNDED) 사용자 취소(USER) 하나(BAT-420 리뷰 D5, transfer-refund §5 '확정 뒤 팬 취소').
   * 표마다 무효가 아닌 취소는 하나뿐이다(order_cancellation_active_key). 공제 > 0인지는 부르는 쪽이 본다
   */
  async forTicket(ticketId: string): Promise<{ cancellationId: string; orderId: string; ticketId: string; deductionAmount: number } | undefined> {
    const r = await this.database.db.execute(sql`
      select id, order_id, ticket_id, deduction_amount
        from order_cancellation
       where ticket_id = ${ticketId}::uuid and reason = 'USER' and status in ('REFUND_PENDING', 'REFUNDED')
       order by created_at desc, id
       limit 1`);
    const row = r.rows[0] as { id: string; order_id: string; ticket_id: string; deduction_amount: number | string } | undefined;
    return row ? { cancellationId: row.id, orderId: row.order_id, ticketId: row.ticket_id, deductionAmount: Number(row.deduction_amount) } : undefined;
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
