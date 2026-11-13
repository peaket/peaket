// 회차 취소 일괄 환불의 대상 조회(BAT-425). purchase DB에서 결제 완료·부분 환불 주문의 발권된 티켓을 고르고,
// 이미 진행 중인 예매 취소가 있는 티켓은 뺀다. 결제사는 주문의 마지막 결제 시도에서 읽는다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { CancellationConfigs } from '../../domain/ports.js';
import type { EventRefundTarget, RefundPgProvider } from '../../domain/event-refund.js';
import type { EventRefundTargets } from '../../domain/event-refund-ports.js';

interface Row {
  order_id: string;
  event_id: string;
  account_id: string;
  created_at: Date | string;
  ticket_id: string;
  seat_id: string;
  unit_price: number;
  pg: string | null;
}

@Injectable()
export class DrizzleEventRefundTargets implements EventRefundTargets {
  constructor(
    @Inject(DATABASE) private readonly database: Database,
    @Inject('REFUND_CANCELLATION_CONFIGS') private readonly configs: CancellationConfigs,
  ) {}

  async list(eventId: string): Promise<readonly EventRefundTarget[]> {
    const config = await this.configs.config(eventId);
    if (!config) throw new Error(`회차 판매 설정이 없다: ${eventId}`);
    const r = await this.database.db.execute(sql`
      select o.id as order_id, o.event_id, o.account_id, o.created_at, i.ticket_id, i.seat_id, i.unit_price,
             (select pa.pg from payment_attempt pa where pa.order_id = o.id order by pa.created_at desc limit 1) as pg
        from purchase_order o
        join order_item i on i.order_id = o.id
       where o.event_id = ${eventId}::uuid
         and o.status in ('CONFIRMED', 'PARTIALLY_REFUNDED')
         and i.ticket_id is not null
         and not exists (
           select 1 from order_cancellation c
            where c.order_id = o.id and c.ticket_id = i.ticket_id and c.status <> 'VOIDED')
       order by o.id, i.line_no`);
    return (r.rows as unknown as Row[]).map((row) => ({
      orderId: row.order_id,
      ticketId: row.ticket_id,
      seatId: row.seat_id,
      payerAccountId: row.account_id,
      ticketPrice: Number(row.unit_price),
      bookedAtMs: new Date(row.created_at).getTime(),
      saleEndsAtMs: config.saleEndsAtMs,
      ...(config.entryOpensAtMs !== undefined ? { entryOpensAtMs: config.entryOpensAtMs } : {}),
      pg: (row.pg ?? 'SIMULATOR') as RefundPgProvider,
    }));
  }
}
