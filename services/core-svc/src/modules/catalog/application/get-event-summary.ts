// 유스케이스: 회차 공개 요약(openapi GET /v1/events/{eventId}, EventPublicSummary, BUILD_ORDER HOT-170 ①).
// 판매 승인되고 판매 중지가 아닌 공연의 회차만 답하고, 그 밖의 회차와 없는 회차는 같은 '없음'이다(docs/security/authz-matrix.md §3.5).
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

  async run(eventId: string): Promise<EventPublicSummary | undefined> {
    const row = await this.repo.findEventSummary(eventId);
    if (!row || !isPublic(row.production)) return undefined;
    return { eventId: row.event.id, productionId: row.production.id, title: row.production.title, startsAt: row.event.startsAt.toISOString(), sellerName: row.sellerName };
  }
}
