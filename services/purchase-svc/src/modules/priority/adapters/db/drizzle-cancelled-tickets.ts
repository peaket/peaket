// 취소한 표의 원래 좌석·등급·가격을 purchase DB에서 읽는다(GAT-135, docs/features/seat-hold.md §5 '우선 구매 보류').
// 취소 기록 order_cancellation.ticket_id로 order_item을 잇는다(ticket_id는 발권 뒤 채워진다). 취소가 없거나 표 행이 없으면 undefined.
import { type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { CancelledTicketView } from '../../domain/priority-grant.js';
import type { CancelledTickets } from '../../domain/ports.js';

export class DrizzleCancelledTickets implements CancelledTickets {
  constructor(private readonly database: Database) {}

  async find(cancelledTicketId: string, fraudCaseId: string): Promise<CancelledTicketView | undefined> {
    const r = await this.database.db.execute(sql`
      select o.event_id, o.account_id, oc.order_id, oi.seat_id, oi.tier, oi.unit_price
      from order_cancellation oc
      join purchase_order o on o.id = oc.order_id
      join order_item oi on oi.order_id = oc.order_id and oi.ticket_id = oc.ticket_id
      where oc.ticket_id = ${cancelledTicketId}::uuid and oc.fraud_case_id = ${fraudCaseId}::uuid
      order by oc.created_at desc
      limit 1`);
    const row = r.rows[0] as { event_id: string; account_id: string; order_id: string; seat_id: string; tier: string; unit_price: number | string } | undefined;
    if (!row) return undefined;
    return {
      eventId: row.event_id,
      accountId: row.account_id,
      orderId: row.order_id,
      seatId: row.seat_id,
      tierId: row.tier,
      price: Number(row.unit_price),
      // 입장 시작 시각은 core-svc 일정 사본에서 읽는 몫이다(후속). 지금은 48시간만 쓴다
    };
  }
}
