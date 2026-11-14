// 파트너 회차 찾기(명단 내려받기·보유 기간). 소속 파트너의 회차만 준다.
import type { Database } from '@peaket/platform';
import type { PartnerEventDirectory } from '../domain/ports.js';

export class DrizzlePartnerEventDirectory implements PartnerEventDirectory {
  constructor(private readonly db: Database) {}
  async find(promoterId: string, eventId: string) {
    const r = await this.db.pool.query<{ id: string; title: string; ends_at: Date }>(
      'select e.id, p.title, e.ends_at from event e join production p on p.id = e.production_id where e.id = $1 and e.promoter_id = $2',
      [eventId, promoterId],
    );
    const row = r.rows[0];
    return row ? { eventId: row.id, title: row.title, endsAt: row.ends_at } : undefined;
  }
}

export class MemoryPartnerEventDirectory implements PartnerEventDirectory {
  readonly events = new Map<string, { eventId: string; title: string; endsAt: Date }>();
  add(promoterId: string, eventId: string, title: string, endsAt: Date): void {
    this.events.set(`${promoterId}/${eventId}`, { eventId, title, endsAt });
  }
  async find(promoterId: string, eventId: string) {
    return this.events.get(`${promoterId}/${eventId}`);
  }
}
