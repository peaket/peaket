// 이 모듈의 공개 파일. 다른 컨텍스트는 층 폴더가 아니라 이 파일로만 가져온다(층 규칙).
export { CatalogModule } from './catalog.module.js';
export { MemoryCatalogRepository } from './adapters/memory-catalog-repository.js';
export { GrpcAdminAuthz } from './adapters/identity-admin-authz.js';
export { cardSaleStatus, isPublic, opensAsScheduled, representativeEvent, sameVenue } from './domain/production.js';
export type { CardSaleStatus, CatalogEvent, EventSaleState, Production, SaleReview } from './domain/production.js';
export { assertDatabaseRole } from './adapters/db/database-role.js';
