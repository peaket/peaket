// 판매 중지 확인의 PostgreSQL 어댑터(BAT-420 GAT-110 Q, transfer-refund §5 '요청 두 길'). core-svc 공연 판매 중지(LCH-090) 전까지
// ops_command의 그 회차 SALE_STOP·SALE_RESUME 가운데 마지막 SUCCEEDED(끝난 시각, 같으면 명령 ID 차례)가 SALE_STOP인지 본다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { SaleSuspensionLookup } from '../../domain/ports.js';

export class DrizzleSaleSuspensionLookup implements SaleSuspensionLookup {
  constructor(private readonly database: Database) {}

  async isSuspended(eventId: string): Promise<boolean> {
    const r = await this.database.db.execute(sql`
      select type from ops_command
      where event_id = ${eventId}::uuid and type in ('SALE_STOP', 'SALE_RESUME') and state = 'SUCCEEDED'
      order by updated_at desc, id desc
      limit 1`);
    return (r.rows[0] as { type: string } | undefined)?.type === 'SALE_STOP';
  }
}
