// 활성 판매 행 대조(GAT-135). purchase DB seat_sale의 PENDING·SOLD 행이 있는 좌석은 이미 팔렸거나 결제 중이다.
// 권리 발급·사용 때 이 좌석을 다시 잡지 않게 한다(팔린 좌석을 PRIORITY 보류로 덮지 않는다).
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { PrioritySeatSales } from '../../domain/ports.js';

export class DrizzlePrioritySeatSales implements PrioritySeatSales {
  constructor(private readonly database: Database) {}

  async active(eventId: string, seatIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (seatIds.length === 0) return new Set();
    const ids = sql.join(
      seatIds.map((id) => sql`${id}::uuid`),
      sql`, `,
    );
    const r = await this.database.db.execute(sql`
      select distinct seat_id from seat_sale
      where event_id = ${eventId}::uuid and seat_id in (${ids}) and status in ('PENDING', 'SOLD')`);
    return new Set((r.rows as { seat_id: string }[]).map((x) => x.seat_id));
  }
}
