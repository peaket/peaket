// 유스케이스: 회차 공개 요약(openapi GET /v1/events/{eventId}, EventPublicSummary, BUILD_ORDER HOT-170 ①).
// 판매 승인되고 판매 중지가 아닌 공연의 회차만 답한다. 승인 이력이 없는 회차와 없는 회차는 같은 '없음'이고, 한 번 공개된 뒤 판매 중지된 회차는
// '판매 중지'다(사유는 싣지 않는다, docs/security/authz-matrix.md §3.5, ADR-0200 결정 3).
import { Inject, Injectable } from '@nestjs/common';
import { CATALOG_REPOSITORY, type CatalogRepository } from '../domain/ports.js';
import { isPublic } from '../domain/production.js';

export interface EventPublicSummary {
  eventId: string;
  productionId: string;
  title: string;
  startsAt: string;
  sellerName: string;
}

@Injectable()
export class GetEventSummary {
  constructor(@Inject(CATALOG_REPOSITORY) private readonly repo: CatalogRepository) {}

  async run(eventId: string): Promise<EventPublicSummary | 'suspended' | undefined> {
    const row = await this.repo.findEventSummary(eventId);
    if (!row) return undefined;
    if (!isPublic(row.production)) return row.production.saleReview === 'SUSPENDED' && row.production.saleApprovedAt !== null ? 'suspended' : undefined;
    return { eventId: row.event.id, productionId: row.production.id, title: row.production.title, startsAt: row.event.startsAt.toISOString(), sellerName: row.sellerName };
  }
}
