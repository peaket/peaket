// 회차의 끝나지 않은 주문 수(BAT-420 GAT-110 H, R-T37 ⑥, ADR-0280 결정 5). 이 수가 0보다 크면 회차 취소 요청을 COMPLETED로 끝내지 않는다.
// 상태 목록은 도메인의 EVENT_OPEN_ORDER_STATUSES 하나다(CREATED·AUTHENTICATED·ACCEPTED·RESERVED·AWAITING_DEPOSIT·APPROVED·UNKNOWN).
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { EVENT_OPEN_ORDER_STATUSES } from '../../domain/event-refund.js';
import type { EventOpenOrders } from '../../domain/event-refund-ports.js';

export class DrizzleEventOpenOrders implements EventOpenOrders {
  constructor(private readonly database: Database) {}

  async count(eventId: string): Promise<number> {
    const statuses = sql.join(
      EVENT_OPEN_ORDER_STATUSES.map((s) => sql`${s}`),
      sql`, `,
    );
    const r = await this.database.db.execute(sql`select count(*)::int as n from purchase_order where event_id = ${eventId}::uuid and status in (${statuses})`);
    return Number((r.rows[0] as { n: number | string } | undefined)?.n ?? 0);
  }
}
