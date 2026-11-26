// 이 모듈의 공개 파일. 다른 컨텍스트는 층 폴더가 아니라 이 파일로만 가져온다(층 규칙).
export { CatalogModule, SEARCH_DATABASE, type MediaWiring } from './catalog.module.js';
export { tenantOf } from './inbound/partner-production.controller.js';
export { MemoryCatalogRepository } from './adapters/memory-catalog-repository.js';
export { DrizzleCatalogRepository } from './adapters/db/drizzle-catalog-repository.js';
export { GrpcAdminAuthz } from './adapters/identity-admin-authz.js';
export { GrpcMemberCodeDirectory } from './adapters/identity-member-codes.js';
export { SaleEligibilityMetrics } from './application/sale-eligibility-metrics.js';
export { MemorySaleEligibilityCopy, SaleEligibilityCopyUnwired, UnwiredSaleEligibilityCopy } from './adapters/sale-eligibility-copy.js';
export { DrizzleSaleMaintenanceStore, DrizzleSaleStore } from './adapters/db/drizzle-sale-store.js';
export { DrizzlePromoterStore } from './adapters/db/drizzle-promoter-store.js';
export { MemoryPromoterStore } from './adapters/memory-promoter-store.js';
export { DrizzleCommissionRate } from './adapters/db/drizzle-commission-rate.js';
export { HttpOpsApprovals, MemoryOpsApprovals, UnavailableOpsApprovals } from './adapters/http-ops-approvals.js';
export { ApplyContractApproval, Promoters } from './application/promoters.js';
export { OPS_APPROVAL_CLIENT, PROMOTER_STORE, type OpsApprovalClient, type PromoterStore } from './domain/promoter-ports.js';
export type { ContractTerms, ContractTermsChange, GuaranteeKind, PromoterContractPeriod, PromoterDetail, PromoterPage, PromoterSummary, SellerInfo } from './domain/promoter-contract.js';
export { saleEligibilityMaintenanceTasks } from './application/eligibility-maintenance.js';
export type { EligibilityCopyPut, MemberCodeDirectory, SaleEligibilityCopy } from './domain/eligibility-ports.js';
export { MemberCodeLookupFailed } from './domain/eligibility-ports.js';
export { GrpcImageProcessing } from './adapters/image-processing-client.js';
export { GrpcSeatmapParser, hostPort } from './adapters/seatmap-worker-client.js';
export { LocalFolderImageStore, MemoryImageObjectStore } from './adapters/image-store.js';
export { LocalFolderPublicFileStore, MemoryPublicFileStore } from './adapters/public-file-store.js';
export type { PublicFileStore, PublishLimits } from './domain/seatmap-ports.js';
export { MemoryCdnInvalidation } from './adapters/cdn-invalidation.js';
export { StaticTemplateCatalog } from './adapters/static-template-catalog.js';
export { QueueSaleEligibilityCopy } from './adapters/queue-sale-eligibility-copy.js';
export { MemorySearchDictionarySource, MemorySearchIndex } from './adapters/memory-search-index.js';
export { DrizzleSearchIndex, registerSearchPoolWaiting, SEARCH_STATEMENT_TIMEOUT_MS } from './adapters/db/drizzle-search-index.js';
export { SearchCatalog } from './application/search.js';
export { SEARCH_INDEX, type SearchDocument, type SearchIndex } from './domain/search.js';
export { DrizzleSearchReadModel } from './adapters/db/drizzle-search-read-model.js';
export { SearchReadModelTimers, withSearchSync } from './application/search-maintenance.js';
export {
  maskSearchQuery,
  SEARCH_DICTIONARY,
  SEARCH_DICTIONARY_SOURCE,
  SEARCH_READ_MODEL_SYNC,
  SearchUnavailable,
  SuggestionDictionary,
  zeroResultQueries,
  type DictionarySnapshot,
  type SearchDictionarySource,
  type SearchReadModelSync,
  type SearchTermRow,
} from './domain/search.js';
export { cardSaleStatus, isPublic, opensAsScheduled, representativeEvent, sameVenue } from './domain/production.js';
export { buildEventSaleConfigs, eligibleListKeys, type EventSaleConfig, type EventSaleConfigFacts, type SaleEligibilityGate } from './domain/event-sale-config.js';
export { OPS_DATABASE, SALE_CONFIG_FACTS, SALE_CONFIG_MAINTENANCE_STORE, SALE_CONFIG_READER, SALE_CONFIG_STORE, type ApprovedProduction, type SaleConfigFactsSource, type SaleConfigMaintenanceStore, type SaleConfigReader, type SaleConfigStore } from './domain/sale-config-ports.js';
export { PublishSaleConfigs } from './application/publish-sale-configs.js';
export { saleConfigMaintenanceTasks } from './application/sale-config-maintenance.js';
export { MemorySaleConfigStore } from './adapters/memory-sale-config-store.js';
export { QueueSaleConfigStore, SALE_CONFIG_LUA, saleEpochKey } from './adapters/queue-sale-config-store.js';
export { CompositeSaleConfigStore } from './adapters/composite-sale-config-store.js';
export { HttpPurchaseSaleOpen, MemorySaleOpen, SALE_OPEN_TIMEOUT_MS, UnwiredSaleOpen } from './adapters/http-purchase-sale-open.js';
export { SALE_OPEN, type SaleOpen, type SaleOpenInput, type SaleOpenResult } from './domain/sale-open-port.js';
export { SALE_CONFIG_METRICS, SaleConfigMetrics, type SaleOpenMetricResult } from './application/sale-config-metrics.js';
export { OpsSaleReviews, RequestSaleReview } from './application/request-sale-review.js';
export { assemblePayoutRegistration, HttpPayoutRegistration, PAYOUT_REGISTRATION_TIMEOUT_MS, UnavailablePayoutRegistration } from './adapters/http-payout-registration.js';
export {
  missingPayoutConditions,
  PAYOUT_REGISTRATION,
  PAYOUT_REGISTRATION_OFF,
  PAYOUT_REGISTRATION_UNWIRED,
  type PayoutRegistrationCompany,
  type PayoutRegistrationInput,
  type PayoutRegistrationMissing,
  type PayoutRegistrationPort,
  type PayoutRegistrationView,
  type PayoutTossSellerStatus,
} from './domain/payout-registration-port.js';
export { NoopSaleConfigFacts } from './adapters/noop-sale-config-facts.js';
export { DrizzleSaleConfigReader, DrizzleSaleConfigStore } from './adapters/db/drizzle-sale-config-store.js';
export { DrizzleSaleConfigMaintenanceStore } from './adapters/db/drizzle-sale-config-maintenance-store.js';
export type { CardSaleStatus, CatalogEvent, EventSaleState, Production, SaleReview } from './domain/production.js';
export { CATALOG_REPOSITORY, type CatalogRepository } from './domain/ports.js';
export { GetDemandForecast } from './application/demand-forecast.js';
export { ChangeEventScale } from './application/change-event-scale.js';
export { forecastDemand, medianAndUpper, suggestedScaleOf, DEFAULT_RATIO_MEDIAN, DEFAULT_RATIO_UPPER, MIN_FORECAST_SAMPLE, type DemandForecast as DemandForecastView, type ForecastHistoryRow, type ForecastTrigger, type ShowScale } from './domain/demand-forecast.js';
export { checkScaleChange, SCALE_CHANGE_CLOSE_MS, LARGE_INTERVAL_MS } from './domain/scale-change.js';
export { EmptyDemandForecastSource } from './adapters/empty-demand-forecast-source.js';
export { DEMAND_FORECAST_SOURCE, type DemandForecastSource } from './domain/demand-ports.js';
export { assertDatabaseRole } from './adapters/db/database-role.js';
