// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다).
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule, type Provider, RequestMethod } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { type Clock, type Database, DATABASE, INTERNAL_TOKEN, LogPseudonymizer, CLOCK } from '@peaket/platform';
import { EmptyDemandForecastSource } from './adapters/empty-demand-forecast-source.js';
import { ChangeEventScale } from './application/change-event-scale.js';
import { GetDemandForecast } from './application/demand-forecast.js';
import { DEMAND_FORECAST_SOURCE, type DemandForecastSource } from './domain/demand-ports.js';
import { OpsEventController } from './inbound/ops-event.controller.js';
import { LogCdnInvalidation, MemoryCdnInvalidation, unavailableImageProcessing, unavailableSeatmapParser } from './adapters/cdn-invalidation.js';
import { DrizzleCatalogRepository, PARTNER_DATABASE } from './adapters/db/drizzle-catalog-repository.js';
import { DrizzleProductionMedia } from './adapters/db/drizzle-production-media.js';
import { DrizzleSaleStore } from './adapters/db/drizzle-sale-store.js';
import { DrizzleSeatmapLayoutStore } from './adapters/db/drizzle-seatmap-layout.js';
import { DrizzleSearchIndex } from './adapters/db/drizzle-search-index.js';
import { MemoryImageObjectStore } from './adapters/image-store.js';
import { MemoryCatalogRepository, MemoryProductionMedia } from './adapters/memory-catalog-repository.js';
import { MemorySaleStore } from './adapters/memory-sale-store.js';
import { MemorySeatmapLayoutStore } from './adapters/memory-seatmap-layout.js';
import { MemorySearchDictionarySource, MemorySearchIndex } from './adapters/memory-search-index.js';
import { DrizzleSearchReadModel } from './adapters/db/drizzle-search-read-model.js';
import { EmptyTemplateCatalog } from './adapters/static-template-catalog.js';
import { MemoryPublicFileStore } from './adapters/public-file-store.js';
import { MemorySaleEligibilityCopy, unavailableMemberCodes } from './adapters/sale-eligibility-copy.js';
import { AddProductionEvent } from './application/add-production-event.js';
import { CreateProduction } from './application/create-production.js';
import { FanSaleEligibility } from './application/fan-sale-eligibility.js';
import { FanFilePublisher } from './application/fan-file-publisher.js';
import { GetEventSummary } from './application/get-event-summary.js';
import { ImportSeatmap } from './application/import-seatmap.js';
import { PartnerDirectory } from './application/partner-directory.js';
import { PartnerHomeRead } from './application/partner-home.js';
import { PartnerHomeController } from './inbound/partner-home.controller.js';
import { ProductionImages } from './application/production-images.js';
import { SaleEligibilityLists } from './application/sale-eligibility-lists.js';
import { SalePolicies } from './application/sale-policy.js';
import { SearchCatalog } from './application/search.js';
import { ApproveSaleReview } from './application/approve-sale-review.js';
import { ChangeSaleSuspension } from './application/change-sale-suspension.js';
import { PublishSaleConfigs } from './application/publish-sale-configs.js';
import { RejectSaleReview } from './application/reject-sale-review.js';
import { OpsSaleReviewController } from './inbound/ops-sale-review.controller.js';
import { OPS_DATABASE, SALE_CONFIG_FACTS, SALE_CONFIG_READER, SALE_CONFIG_STORE, ENTRY_CLOSED_STORE, type SaleConfigStore } from './domain/sale-config-ports.js';
import { SALE_OPEN, type SaleOpen } from './domain/sale-open-port.js';
import { PAYOUT_REGISTRATION, type PayoutRegistrationPort } from './domain/payout-registration-port.js';
import { UnavailablePayoutRegistration } from './adapters/http-payout-registration.js';
import { MemorySaleOpen } from './adapters/http-purchase-sale-open.js';
import { SALE_CONFIG_METRICS, SaleConfigMetrics } from './application/sale-config-metrics.js';
import { OpsSaleReviews, RequestSaleReview } from './application/request-sale-review.js';
import { PartnerSaleReviewController } from './inbound/partner-sale-review.controller.js';
import { DrizzleSaleConfigReader, DrizzleSaleConfigStore } from './adapters/db/drizzle-sale-config-store.js';
import { DrizzleEntryClosedStore } from './adapters/db/drizzle-entry-closed-store.js';
import { MemoryEntryClosedStore } from './adapters/memory-entry-closed-store.js';
import { MemorySaleConfigStore } from './adapters/memory-sale-config-store.js';
import { NoopSaleConfigFacts } from './adapters/noop-sale-config-facts.js';
import { SeatmapLayouts } from './application/seatmap-layouts.js';
import { SEATMAP_TEMPLATES, SeatmapTemplates } from './application/seatmap-templates.js';
import { UpdateProductionEvent } from './application/update-production-event.js';
import { Wishes } from './application/wish.js';
import {
  CDN_INVALIDATION,
  type CdnInvalidation,
  IMAGE_OBJECT_STORE,
  IMAGE_ORIGIN,
  IMAGE_PROCESSING,
  type ImageObjectStore,
  type ImageProcessing,
  PARTNER_PRODUCTION_MEDIA,
  SEATMAP_PARSER,
  type SeatmapParser,
} from './domain/media-ports.js';
import { LOG_PSEUDONYM, type LogPseudonym, MEMBER_CODE_DIRECTORY, type MemberCodeDirectory, SALE_ELIGIBILITY_COPY, SALE_ELIGIBILITY_METRICS, type SaleEligibilityCopy } from './domain/eligibility-ports.js';
import { SaleEligibilityMetrics } from './application/sale-eligibility-metrics.js';
import { CATALOG_REPOSITORY } from './domain/ports.js';
import { SEARCH_DICTIONARY, SEARCH_DICTIONARY_SOURCE, SEARCH_INDEX, SEARCH_READ_MODEL_SYNC, type SearchDictionarySource, SuggestionDictionary } from './domain/search.js';
import type { TemplateCatalog } from './domain/seatmap-templates.js';
import { OPS_SALE_STORE, SALE_STORE } from './domain/sale-ports.js';
import { SALE_SUSPENSION_STORE } from './domain/sale-suspension.js';
import { DrizzleSaleSuspensionStore } from './adapters/db/drizzle-sale-suspension-store.js';
import { InternalSaleSuspensionController } from './inbound/internal-sale-suspension.controller.js';
import { DrizzlePromoterStore } from './adapters/db/drizzle-promoter-store.js';
import { MemoryPromoterStore } from './adapters/memory-promoter-store.js';
import { MemoryOpsApprovals, UnavailableOpsApprovals } from './adapters/http-ops-approvals.js';
import { OPS_APPROVAL_CLIENT, PROMOTER_STORE, type OpsApprovalClient } from './domain/promoter-ports.js';
import { ApplyContractApproval, Promoters } from './application/promoters.js';
import { OpsPromoterController } from './inbound/ops-promoter.controller.js';
import { InternalPromoterController } from './inbound/internal-promoter.controller.js';
import { PUBLIC_FILE_STORE, type PublicFileStore, PUBLISH_LIMITS, type PublishLimits, SEATMAP_LAYOUT_STORE } from './domain/seatmap-ports.js';
import { EventSummaryController } from './inbound/event-summary.controller.js';
import { InternalSaleConfigController } from './inbound/internal-sale-config.controller.js';
import { InternalEntryClosedController } from './inbound/internal-entry-closed.controller.js';
import { InternalEventStatusController } from './inbound/internal-event-status.controller.js';
import { ApplyEventCancellationStatus } from './application/apply-event-cancellation-status.js';
import { DrizzleEventStatusStore } from './adapters/db/drizzle-event-status-store.js';
import { EVENT_STATUS_STORE } from './domain/event-cancellation-status.js';
import { PartnerDirectoryController } from './inbound/partner-directory.controller.js';
import { PartnerEventController } from './inbound/partner-event.controller.js';
import { PartnerMediaController } from './inbound/partner-media.controller.js';
import { PartnerProductionController } from './inbound/partner-production.controller.js';
import { PartnerSaleEligibilityController } from './inbound/partner-sale-eligibility.controller.js';
import { PartnerSalePolicyController } from './inbound/partner-sale-policy.controller.js';
import { PartnerSeatmapController } from './inbound/partner-seatmap.controller.js';
import { PartnerSeatmapTemplatesController } from './inbound/partner-seatmap-templates.controller.js';
import { SearchController } from './inbound/search.controller.js';
import { WishController } from './inbound/wish.controller.js';

/** 이미지·좌석맵 가져오기의 바깥 잇기(ADR-0257). 운영은 모두 정한다(없으면 시작하지 않는다, main.ts) */
export interface MediaWiring {
  /** 이미지 출처(PEAKET_IMAGE_BASE_URL) */
  imageOrigin: string;
  processing: ImageProcessing;
  store: ImageObjectStore;
  seatmap: SeatmapParser;
  /** 없으면 기록만 하는 어댑터(실제 CDN 어댑터는 배포 단계) */
  cdn?: CdnInvalidation;
  /** 팬 좌석맵 파일을 두는 곳(ADR-0260 결정 6, 개발은 PEAKET_PUBLIC_FILE_DIR 로컬 폴더, S3는 HOT-200) */
  publicFiles: PublicFileStore;
  /** 게시의 동시 쓰기 수·전체 시한. 없으면 8개·20초 [가정] */
  publishLimits?: PublishLimits;
  /** 판매 자격 명단의 회원 코드 변환(identity MemberCodeService, ADR-0261 결정 6). 메모리 시험에서 없으면 늘 503 */
  memberCodes: MemberCodeDirectory;
  /** 판매 자격 명단 사본 넘기기(ADR-0261 결정 9). 운영은 쓰는 쪽이 정해질 때까지 늘 실패하는 어댑터. 메모리 시험에서 없으면 기록하는 어댑터 */
  eligibilityCopy: SaleEligibilityCopy;
  /** 좌석맵 템플릿 정적 카탈로그(ADR-0066). 없으면 빈 목록이다 */
  templates?: TemplateCatalog;
  /** 감사 줄의 로그 가명(서비스와 같은 PEAKET_LOG_PSEUDONYM_KEY로 만든 것, main.ts). 없으면 프로세스마다 무작위 키 */
  pseudonym?: LogPseudonym;
  /** 판매 자격 명단 운영 지표(서비스 등록부에 다는 것은 main.ts). 없으면 등록하지 않은 묶음 */
  eligibilityMetrics?: SaleEligibilityMetrics;
  /** 수요 예측 원천(구독 수·지난 회차). 없으면 0·빈 이력이라 기본 비율을 쓴다 */
  demandSource?: DemandForecastSource;
}

/** 시험 기본값: 처리·해석 작업을 잇지 않았으면 늘 503(조용히 통과시키지 않는다) */
const MEMORY_IMAGE_ORIGIN = 'https://img.peaket.test';

function mediaProviders(m: Partial<MediaWiring>, memory: boolean): Provider[] {
  return [
    { provide: IMAGE_ORIGIN, useValue: m.imageOrigin ?? MEMORY_IMAGE_ORIGIN },
    { provide: IMAGE_PROCESSING, useValue: m.processing ?? unavailableImageProcessing },
    { provide: IMAGE_OBJECT_STORE, useValue: m.store ?? new MemoryImageObjectStore() },
    { provide: SEATMAP_PARSER, useValue: m.seatmap ?? unavailableSeatmapParser },
    m.cdn ? { provide: CDN_INVALIDATION, useValue: m.cdn } : memory ? { provide: CDN_INVALIDATION, useValue: new MemoryCdnInvalidation() } : { provide: CDN_INVALIDATION, useClass: LogCdnInvalidation },
    { provide: PUBLIC_FILE_STORE, useValue: m.publicFiles ?? new MemoryPublicFileStore() },
    { provide: MEMBER_CODE_DIRECTORY, useValue: m.memberCodes ?? unavailableMemberCodes },
    { provide: SALE_ELIGIBILITY_COPY, useValue: m.eligibilityCopy ?? new MemorySaleEligibilityCopy() },
    { provide: LOG_PSEUDONYM, useValue: m.pseudonym ?? new LogPseudonymizer(randomBytes(32)) },
    { provide: SALE_ELIGIBILITY_METRICS, useValue: m.eligibilityMetrics ?? new SaleEligibilityMetrics() },
    { provide: SEATMAP_TEMPLATES, useValue: m.templates ?? new EmptyTemplateCatalog() },
    ...(m.publishLimits ? [{ provide: PUBLISH_LIMITS, useValue: m.publishLimits }] : []),
  ];
}

/**
 * 좌석맵 불러오기·저장 응답은 성공·오류 모두 Cache-Control: no-store다(ADR-0260 결정 5, seat-hold ASVS 14.2.2). 처리기 앞의 인증 가드·본문 검사·본문 상한이
 * 내는 거절(401·400·413·429)도 포함해 요청이 처리기에 닿기 전에 머리를 단다. 판매 정책 규칙·판매 자격 명단·회차 고치기·팬별 판매 자격도 같다(ADR-0261 결정 2·5·6)
 */
const noStore = (_req: unknown, res: { setHeader(name: string, value: string): unknown }, next: () => void): void => {
  res.setHeader('cache-control', 'no-store');
  next();
};

/**
 * 검색 경로(`/v1/search`로 시작하는 모든 주소)는 먼저 no-store를 단다. 처리기가 200 JSON을 낼 때만 공개 캐시 머리로 바꾼다.
 * 그래서 정의 밖 경로(`/v1/search/x.css` 등)의 404와 400·503에는 공개 캐시 머리가 없다(캐시 기만 방지, ADR-0271 결정 10, catalog-review 14.2.5)
 */
const searchNoStore = (req: { url?: string; originalUrl?: string }, res: { setHeader(name: string, value: string): unknown }, next: () => void): void => {
  const url = req.originalUrl ?? req.url ?? '';
  if (url.startsWith('/v1/search')) res.setHeader('cache-control', 'no-store');
  next();
};

/** 검색 전용 연결 묶음(ADR-0271 결정 5). 없으면 앱 연결(DATABASE)을 쓴다(로컬·시험) */
export const SEARCH_DATABASE = Symbol('SEARCH_DATABASE');

@Module({})
export class CatalogModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    const path = 'v1/partner/productions/:productionId/seatmap';
    const policy = 'v1/partner/productions/:productionId/sale-policy';
    const lists = 'v1/partner/productions/:productionId/sale-eligibility-lists';
    const templates = 'v1/partner/seatmap-templates';
    consumer
      .apply(noStore)
      .forRoutes(
        { path, method: RequestMethod.GET },
        { path, method: RequestMethod.PUT },
        { path, method: RequestMethod.POST },
        { path: templates, method: RequestMethod.GET },
        { path: templates + '/:templateId', method: RequestMethod.GET },
        { path: policy, method: RequestMethod.GET },
        { path: policy, method: RequestMethod.PUT },
        { path: lists, method: RequestMethod.GET },
        { path: lists, method: RequestMethod.POST },
        { path: lists + '/:listKey', method: RequestMethod.DELETE },
        { path: 'v1/partner/events/:eventId', method: RequestMethod.PATCH },
        { path: 'v1/partner/productions', method: RequestMethod.GET },
        { path: 'v1/partner/productions/:productionId', method: RequestMethod.GET },
        { path: 'v1/partner/todo-summary', method: RequestMethod.GET },
        { path: 'v1/partner/seller-profile', method: RequestMethod.GET },
        { path: 'v1/events/:eventId/sale-eligibility', method: RequestMethod.GET },
        { path: 'internal/v1/events/:eventId/sale-config', method: RequestMethod.GET },
      );
    consumer.apply(searchNoStore).forRoutes({ path: '{*path}', method: RequestMethod.ALL });
  }

  /**
   * 저장소를 고른다. database면 DATABASE(databaseModule)가 함께 있어야 하고, 파트너 경로는 partnerDatabase로 접속한다(ADR-0241). memory는 시험이 채울 저장소를 넘길 수 있다.
   * media는 database면 꼭 넘기고, memory면 시험이 필요한 것만 넘긴다
   */
  static register(
    o:
      | {
          storage: 'database';
          partnerDatabase: Database;
          opsDatabase?: Database;
          searchDatabase?: Database;
          media: MediaWiring;
          opsApprovals?: OpsApprovalClient;
          /** 판매 승인 사본을 DB와 대기열에 함께 쓰는 합성 저장소(BAT-616). 없으면 DB만 쓴다 */
          saleConfigStore?: SaleConfigStore;
          /** 판매 열기 클라이언트(BAT-616). 없으면 열기가 끝난 것으로 보는 메모리 어댑터(시험·직접 조립) */
          saleOpen?: SaleOpen;
          /** 판매 승인 부수 효과 지표(BAT-616). main.ts가 등록한다 */
          saleConfigMetrics?: SaleConfigMetrics;
          /** payment-svc 지급대행 등록(F-07-7). 없으면 둘 다 꺼짐(main.ts는 assemblePayoutRegistration으로 넘긴다) */
          payoutRegistration?: PayoutRegistrationPort;
        }
      | { storage: 'memory'; repository?: MemoryCatalogRepository; media?: Partial<MediaWiring>; saleConfigs?: SaleConfigStore; opsApprovals?: OpsApprovalClient; saleOpen?: SaleOpen; saleConfigMetrics?: SaleConfigMetrics; payoutRegistration?: PayoutRegistrationPort },
  ): DynamicModule {
    const shared = [GetEventSummary, CreateProduction, AddProductionEvent, Wishes, PartnerDirectory, PartnerHomeRead, ProductionImages, ImportSeatmap, FanFilePublisher, SeatmapLayouts, SeatmapTemplates, SalePolicies, UpdateProductionEvent, SaleEligibilityLists, FanSaleEligibility, SearchCatalog, PublishSaleConfigs, ApproveSaleReview, RejectSaleReview, GetDemandForecast, ChangeEventScale, Promoters, ApplyContractApproval, RequestSaleReview, OpsSaleReviews];
    const controllers = [EventSummaryController, PartnerProductionController, PartnerSaleReviewController, PartnerDirectoryController, PartnerHomeController, WishController, PartnerMediaController, PartnerSeatmapController, PartnerSeatmapTemplatesController, PartnerSalePolicyController, PartnerSaleEligibilityController, PartnerEventController, SearchController, OpsSaleReviewController, InternalSaleConfigController, InternalEntryClosedController, OpsEventController, OpsPromoterController, InternalPromoterController];
    if (o.storage === 'database') {
      return {
        module: CatalogModule,
        // core 회차 상태 반영(BUILD_ORDER GAT-110)은 core_ops 쓰기와 검색 동기화가 있어야 하므로 DB 조립에서만 연다
        controllers: [...controllers, InternalEventStatusController, InternalSaleSuspensionController],
        providers: [
          ...shared,
          ApplyEventCancellationStatus,
          ChangeSaleSuspension,
          { provide: EVENT_STATUS_STORE, useFactory: (db: Database) => new DrizzleEventStatusStore(db), inject: [OPS_DATABASE] },
          { provide: SALE_SUSPENSION_STORE, useFactory: (db: Database) => new DrizzleSaleSuspensionStore(db), inject: [OPS_DATABASE] },
          { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
          { provide: PARTNER_DATABASE, useValue: o.partnerDatabase },
          { provide: CATALOG_REPOSITORY, useClass: DrizzleCatalogRepository },
          { provide: PARTNER_PRODUCTION_MEDIA, useClass: DrizzleProductionMedia },
          { provide: SEATMAP_LAYOUT_STORE, useClass: DrizzleSeatmapLayoutStore },
          { provide: SALE_STORE, useClass: DrizzleSaleStore },
          { provide: OPS_DATABASE, useFactory: (db: Database) => o.opsDatabase ?? db, inject: [DATABASE] },
          { provide: OPS_SALE_STORE, useFactory: (db: Database, sync: DrizzleSearchReadModel) => new DrizzleSaleStore(db, sync), inject: [OPS_DATABASE, SEARCH_READ_MODEL_SYNC] },
          { provide: PROMOTER_STORE, useFactory: (db: Database, clock: Clock) => new DrizzlePromoterStore(db, clock), inject: [OPS_DATABASE, CLOCK] },
          { provide: OPS_APPROVAL_CLIENT, useValue: o.opsApprovals ?? new UnavailableOpsApprovals() },
          ...(o.saleConfigStore ? [{ provide: SALE_CONFIG_STORE, useValue: o.saleConfigStore }] : [{ provide: SALE_CONFIG_STORE, useClass: DrizzleSaleConfigStore }]),
          { provide: SALE_CONFIG_READER, useClass: DrizzleSaleConfigReader },
          { provide: ENTRY_CLOSED_STORE, useClass: DrizzleEntryClosedStore },
          { provide: SALE_CONFIG_FACTS, useClass: NoopSaleConfigFacts },
          { provide: SALE_OPEN, useValue: o.saleOpen ?? new MemorySaleOpen() },
          { provide: SALE_CONFIG_METRICS, useValue: o.saleConfigMetrics ?? new SaleConfigMetrics() },
          { provide: PAYOUT_REGISTRATION, useValue: o.payoutRegistration ?? new UnavailablePayoutRegistration() },
          { provide: SEARCH_DATABASE, useFactory: (db: Database) => o.searchDatabase ?? db, inject: [DATABASE] },
          // 0건 제안은 메모리 사전이 답한다(ADR-0271 결정 13). 사전이 아직 준비되지 않았으면 search_term으로 대신한다.
          // 한 글자 입력의 단계별 후보 읽기(결정 25)는 사전이 첫 통째로 읽기를 마친 뒤에만 쓴다(그 전에는 지금 질의)
          { provide: SEARCH_INDEX, useFactory: (db: Database, origin: string, d: SuggestionDictionary) => new DrizzleSearchIndex(db, origin, { correct: (q) => (d.ready ? d.correct(q) : undefined), keysOf: (name) => d.keysOf(name), ready: () => d.ready }), inject: [SEARCH_DATABASE, IMAGE_ORIGIN, SEARCH_DICTIONARY] },
          // 동기화는 부르는 트랜잭션(판매 승인·포스터)의 연결로 쓴다. 이 인스턴스의 연결은 사전 원천(읽기)이다
          { provide: SEARCH_READ_MODEL_SYNC, useFactory: (db: Database, origin: string) => new DrizzleSearchReadModel(db, origin), inject: [SEARCH_DATABASE, IMAGE_ORIGIN] },
          { provide: SEARCH_DICTIONARY_SOURCE, useExisting: SEARCH_READ_MODEL_SYNC },
          { provide: SEARCH_DICTIONARY, useFactory: (source: SearchDictionarySource, clock: Clock) => new SuggestionDictionary(source, clock), inject: [SEARCH_DICTIONARY_SOURCE, CLOCK] },
          { provide: DEMAND_FORECAST_SOURCE, useValue: o.media.demandSource ?? new EmptyDemandForecastSource() },
          { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
          ...mediaProviders(o.media, false),
        ],
      };
    }
    const repo = o.repository ?? new MemoryCatalogRepository();
    return {
      module: CatalogModule,
      controllers,
      providers: [
        ...shared,
        { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
        { provide: CATALOG_REPOSITORY, useValue: repo },
        { provide: PARTNER_PRODUCTION_MEDIA, useValue: new MemoryProductionMedia(repo) },
        { provide: SEATMAP_LAYOUT_STORE, useValue: new MemorySeatmapLayoutStore(repo) },
        { provide: SALE_STORE, useValue: new MemorySaleStore(repo) },
        { provide: OPS_SALE_STORE, useExisting: SALE_STORE },
        { provide: PROMOTER_STORE, useFactory: () => new MemoryPromoterStore(repo) },
        { provide: OPS_APPROVAL_CLIENT, useValue: o.opsApprovals ?? new MemoryOpsApprovals() },
        { provide: SALE_CONFIG_STORE, useValue: o.saleConfigs ?? new MemorySaleConfigStore() },
        { provide: SALE_CONFIG_READER, useExisting: SALE_CONFIG_STORE },
        {
          provide: ENTRY_CLOSED_STORE,
          useFactory: (repo: MemoryCatalogRepository, configs: SaleConfigStore) => new MemoryEntryClosedStore(repo, configs),
          inject: [CATALOG_REPOSITORY, SALE_CONFIG_STORE],
        },
        { provide: SALE_CONFIG_FACTS, useValue: new NoopSaleConfigFacts() },
        { provide: SALE_OPEN, useValue: o.saleOpen ?? new MemorySaleOpen() },
        { provide: SALE_CONFIG_METRICS, useValue: o.saleConfigMetrics ?? new SaleConfigMetrics() },
        { provide: PAYOUT_REGISTRATION, useValue: o.payoutRegistration ?? new UnavailablePayoutRegistration() },
        { provide: SEARCH_INDEX, useFactory: (catalog: MemoryCatalogRepository, origin: string, clock: Clock) => new MemorySearchIndex(catalog, origin, clock), inject: [CATALOG_REPOSITORY, IMAGE_ORIGIN, CLOCK] },
        { provide: SEARCH_DICTIONARY_SOURCE, useFactory: (index: MemorySearchIndex) => new MemorySearchDictionarySource(index), inject: [SEARCH_INDEX] },
        { provide: SEARCH_DICTIONARY, useFactory: (source: SearchDictionarySource, clock: Clock) => new SuggestionDictionary(source, clock), inject: [SEARCH_DICTIONARY_SOURCE, CLOCK] },
        { provide: DEMAND_FORECAST_SOURCE, useValue: o.media?.demandSource ?? new EmptyDemandForecastSource() },
        { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
        ...mediaProviders(o.media ?? {}, true),
      ],
    };
  }
}
