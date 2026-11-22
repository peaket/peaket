// BAT-455 Drizzle 회차 정보(core_app). 신청 받는 때를 가르는 값만 읽는다(catalog 경계의 작은 포트).
// 다른 바운디드 컨텍스트의 어댑터 파일을 가져오지 않고, 정본 표 이름으로 직접 읽는다(층 규칙).
import { sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { NotificationEventDirectory, NotifyEvent } from '../../domain/fan-notify-ports.js';

export class DrizzleNotificationEventDirectory implements NotificationEventDirectory {
  constructor(private readonly db: Database) {}

  async find(eventId: string): Promise<NotifyEvent | undefined> {
    const res = await this.db.db.execute(sql`
      select e.id as event_id, e.production_id, e.open_at, e.starts_at, p.sale_review, p.sale_approved_at
      from event e join production p on p.id = e.production_id
      where e.id = ${eventId} limit 1`);
    const r = (res.rows as { event_id: string; production_id: string; open_at: Date; starts_at: Date; sale_review: string; sale_approved_at: Date | null }[])[0];
    return r ? { eventId: r.event_id, productionId: r.production_id, openAt: new Date(r.open_at), startsAt: new Date(r.starts_at), saleReview: r.sale_review, saleApprovedAt: r.sale_approved_at ? new Date(r.sale_approved_at) : null } : undefined;
  }
}
