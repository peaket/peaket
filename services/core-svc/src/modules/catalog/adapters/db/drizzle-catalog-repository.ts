// Drizzle 저장소: 회차 → 공연 → 판매자를 한 번에 읽는다(같은 core 논리 DB, docs/data.md ②).
import { Inject, Injectable } from '@nestjs/common';
import { DATABASE, type Database } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import type { CatalogRepository, EventSummaryRow } from '../../domain/ports.js';
import type { EventStatus, Genre, SaleReview } from '../../domain/production.js';
import { event, production, promoter } from './schema.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class DrizzleCatalogRepository implements CatalogRepository {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async findEventSummary(eventId: string): Promise<EventSummaryRow | undefined> {
    // 회차 ID는 uuid 칸이다. 모양이 아닌 값은 DB 오류 대신 없음으로 답한다(없는 회차와 같은 404)
    if (!UUID.test(eventId)) return undefined;
    const rows = await this.db.db
      .select({ e: event, p: production, sellerName: promoter.legalName })
      .from(event)
      .innerJoin(production, eq(production.id, event.productionId))
      .innerJoin(promoter, eq(promoter.id, production.promoterId))
      .where(eq(event.id, eventId))
      .limit(1);
    const r = rows[0];
    if (!r) return undefined;
    return {
      event: { id: r.e.id, productionId: r.e.productionId, venueId: r.e.venueId, openAt: r.e.openAt, startsAt: r.e.startsAt, status: r.e.status as EventStatus },
      production: { id: r.p.id, promoterId: r.p.promoterId, placeId: r.p.placeId, title: r.p.title, genre: r.p.genre as Genre, saleReview: r.p.saleReview as SaleReview, saleApprovedAt: r.p.saleApprovedAt },
      sellerName: r.sellerName,
    };
  }
}
