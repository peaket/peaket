// 도메인 층: 카탈로그 저장소 포트(어댑터가 구현한다).
import type { CatalogEvent, Production } from './production.js';

/** 회차 공개 요약에 쓰는 한 줄(회차·공연·판매자 상호) */
export interface EventSummaryRow {
  event: CatalogEvent;
  production: Production;
  sellerName: string;
}

export interface CatalogRepository {
  /** 회차와 그 공연·판매자 상호. 없으면 undefined */
  findEventSummary(eventId: string): Promise<EventSummaryRow | undefined>;
}

export const CATALOG_REPOSITORY = Symbol('CATALOG_REPOSITORY');
