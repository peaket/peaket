// purchase DB 기록에서 최근 5분 홀드 성공·결제 접수 수를 세는 어댑터(F-02-5, ADR-0365 결정 11·16).
// seat_hold.held_at(성공한 홀드), payment_attempt.accepted_at(결제 접수)을 회차·시각 범위로 센다.
// 원천 칸이 없는 DB(구 판)에서는 그 칸을 undefined로 남겨 호출 쪽이 no-source로 답하게 한다.
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { SaleRecordCounter } from '../domain/preview.js';

@Injectable()
export class DrizzleSaleRecordCounter implements SaleRecordCounter {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async count(eventId: string, sinceMs: number): Promise<{ holds?: number; accepts?: number }> {
    const since = new Date(sinceMs);
    const [holds] = (await this.database.db.execute(sql`select count(*)::int as n from seat_hold where event_id = ${eventId} and held_at > ${since}::timestamptz`)).rows as { n: number }[];
    const [accepts] = (
      await this.database.db.execute(sql`
        select count(*)::int as n from payment_attempt a join purchase_order o on o.id = a.order_id
        where o.event_id = ${eventId} and a.accepted_at > ${since}::timestamptz`)
    ).rows as { n: number }[];
    return { ...(holds ? { holds: Number(holds.n) } : {}), ...(accepts ? { accepts: Number(accepts.n) } : {}) };
  }
}
