// 운영 회차·공연 읽기(core DB의 event·production). 후기 모듈은 이 두 표만 읽는다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { ReviewEvent, ReviewEventDirectory } from '../../domain/ports.js';

type Row = { event_id: string; production_id: string; starts_at: Date; ends_at: Date; status: string; sale_review: string; sale_approved_at: Date | null };

export class DrizzleReviewEventDirectory implements ReviewEventDirectory {
  constructor(private readonly database: Database) {}

  async find(eventId: string): Promise<ReviewEvent | undefined> {
    const result = await this.database.db.execute(sql`
      select e.id as event_id, e.production_id, e.starts_at, e.ends_at, e.status, p.sale_review, p.sale_approved_at
      from event e join production p on p.id = e.production_id
      where e.id = ${eventId}::uuid limit 1`);
    const rows = ((result as unknown as { rows?: Row[] }).rows ?? (result as unknown as Row[])) as Row[];
    const r = rows[0];
    if (!r) return undefined;
    const roundsResult = await this.database.db.execute(sql`select id as event_id, starts_at from event where production_id = ${r.production_id}::uuid`);
    const rounds = ((roundsResult as unknown as { rows?: { event_id: string; starts_at: Date }[] }).rows ?? (roundsResult as unknown as { event_id: string; starts_at: Date }[])) as { event_id: string; starts_at: Date }[];
    return {
      eventId: r.event_id,
      productionId: r.production_id,
      startsAtMs: new Date(r.starts_at).getTime(),
      endsAtMs: new Date(r.ends_at).getTime(),
      cancelled: r.status === 'CANCELLED',
      saleReview: r.sale_review,
      saleApprovedAtMs: r.sale_approved_at ? new Date(r.sale_approved_at).getTime() : null,
      rounds: rounds.map((x) => ({ eventId: x.event_id, startsAtMs: new Date(x.starts_at).getTime() })),
    };
  }
}
