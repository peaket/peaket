// F-06-8 notice-view 어댑터: purchase DB에서 예매번호·주문 상태·알림 허용 여부·번호·회차·등급 ID를 읽는다.
// 응답의 phoneE164는 내부 HTTP에만 있고 알림 작업·기록·로그에는 넣지 않는다(notify §4.9.1).
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { noticeAllowedOf, type OrderStatus } from '../../domain/order.js';
import type { BookingNoticeReader, BookingNoticeView } from '../../domain/ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface NoticeRow {
  booking_no: string | null;
  status: string;
  event_id: string;
  buyer_phone: string | null;
  order_cancellation_active: boolean;
  event_cancellation_approval_pending: boolean;
}

export class DrizzleBookingNoticeReader implements BookingNoticeReader {
  constructor(private readonly db: Database) {}

  async get(orderId: string): Promise<BookingNoticeView | undefined> {
    if (!UUID.test(orderId)) return undefined;
    const head = await this.db.db.execute(sql`
      select o.booking_no, o.status, o.event_id, o.buyer_phone,
        exists(
          select 1 from order_cancellation c
          where c.order_id = o.id and c.status not in ('CANCELLED', 'VOIDED')
        ) as order_cancellation_active,
        exists(
          select 1 from event_cancellation_request r
          where r.event_id = o.event_id and r.status not in ('COMPLETED', 'REJECTED')
        ) as event_cancellation_approval_pending
      from purchase_order o
      where o.id = ${orderId}::uuid`);
    const row = (head as unknown as { rows: NoticeRow[] }).rows[0];
    if (!row) return undefined;
    const items = await this.db.db.execute(sql`select distinct tier from order_item where order_id = ${orderId}::uuid order by tier`);
    const tierIds = (items as unknown as { rows: { tier: string }[] }).rows.map((r) => r.tier);
    return {
      bookingNo: row.booking_no,
      status: row.status as OrderStatus,
      noticeAllowed: noticeAllowedOf({
        status: row.status as OrderStatus,
        orderCancellationActive: row.order_cancellation_active,
        eventCancellationApprovalPending: row.event_cancellation_approval_pending,
      }),
      phoneE164: row.buyer_phone,
      eventId: row.event_id,
      tierIds,
    };
  }
}
