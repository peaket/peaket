// 시험용 회차·공연 읽기. MemoryCatalogRepository.findEventSummary를 그대로 쓴다(카탈로그 모듈의 메모리 저장소).
import type { CatalogRepository } from '../../catalog/index.js';
import type { ReviewEvent, ReviewEventDirectory } from '../domain/ports.js';

export class MemoryReviewEventDirectory implements ReviewEventDirectory {
  constructor(private readonly catalog: CatalogRepository) {}

  async find(eventId: string): Promise<ReviewEvent | undefined> {
    const row = await this.catalog.findEventSummary(eventId);
    if (!row) return undefined;
    return {
      eventId: row.event.id,
      productionId: row.production.id,
      startsAtMs: row.event.startsAt.getTime(),
      endsAtMs: row.event.endsAt.getTime(),
      cancelled: row.event.status === 'CANCELLED',
      saleReview: row.production.saleReview,
      saleApprovedAtMs: row.production.saleApprovedAt?.getTime() ?? null,
      rounds: row.rounds.map((r) => ({ eventId: r.id, startsAtMs: r.startsAt.getTime() })),
    };
  }
}
