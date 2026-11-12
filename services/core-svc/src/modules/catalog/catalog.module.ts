// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다).
import { type DynamicModule, type MiddlewareConsumer, Module, type NestModule, type Provider, RequestMethod } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { type Clock, type Database, LogPseudonymizer, CLOCK } from '@peaket/platform';
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
import { MemorySearchIndex } from './adapters/memory-search-index.js';
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
import { ProductionImages } from './application/production-images.js';
import { SaleEligibilityLists } from './application/sale-eligibility-lists.js';
import { SalePolicies } from './application/sale-policy.js';
import { SearchCatalog } from './application/search.js';
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
import { SEARCH_INDEX } from './domain/search.js';
import type { TemplateCatalog } from './domain/seatmap-templates.js';
import { SALE_STORE } from './domain/sale-ports.js';
import { PUBLIC_FILE_STORE, type PublicFileStore, PUBLISH_LIMITS, type PublishLimits, SEATMAP_LAYOUT_STORE } from './domain/seatmap-ports.js';
import { EventSummaryController } from './inbound/event-summary.controller.js';
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
        { path: 'v1/events/:eventId/sale-eligibility', method: RequestMethod.GET },
      );
  }

  /**
   * 저장소를 고른다. database면 DATABASE(databaseModule)가 함께 있어야 하고, 파트너 경로는 partnerDatabase로 접속한다(ADR-0241). memory는 시험이 채울 저장소를 넘길 수 있다.
   * media는 database면 꼭 넘기고, memory면 시험이 필요한 것만 넘긴다
   */
  static register(o: { storage: 'database'; partnerDatabase: Database; media: MediaWiring } | { storage: 'memory'; repository?: MemoryCatalogRepository; media?: Partial<MediaWiring> }): DynamicModule {
    const shared = [GetEventSummary, CreateProduction, AddProductionEvent, Wishes, PartnerDirectory, ProductionImages, ImportSeatmap, FanFilePublisher, SeatmapLayouts, SeatmapTemplates, SalePolicies, UpdateProductionEvent, SaleEligibilityLists, FanSaleEligibility, SearchCatalog];
    const controllers = [EventSummaryController, PartnerProductionController, PartnerDirectoryController, WishController, PartnerMediaController, PartnerSeatmapController, PartnerSeatmapTemplatesController, PartnerSalePolicyController, PartnerSaleEligibilityController, PartnerEventController, SearchController];
    if (o.storage === 'database') {
      return {
        module: CatalogModule,
        controllers,
        providers: [
          ...shared,
          { provide: PARTNER_DATABASE, useValue: o.partnerDatabase },
          { provide: CATALOG_REPOSITORY, useClass: DrizzleCatalogRepository },
          { provide: PARTNER_PRODUCTION_MEDIA, useClass: DrizzleProductionMedia },
          { provide: SEATMAP_LAYOUT_STORE, useClass: DrizzleSeatmapLayoutStore },
          { provide: SALE_STORE, useClass: DrizzleSaleStore },
          { provide: SEARCH_INDEX, useClass: DrizzleSearchIndex },
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
        { provide: CATALOG_REPOSITORY, useValue: repo },
        { provide: PARTNER_PRODUCTION_MEDIA, useValue: new MemoryProductionMedia(repo) },
        { provide: SEATMAP_LAYOUT_STORE, useValue: new MemorySeatmapLayoutStore(repo) },
        { provide: SALE_STORE, useValue: new MemorySaleStore(repo) },
        { provide: SEARCH_INDEX, useFactory: (catalog: MemoryCatalogRepository, origin: string, clock: Clock) => new MemorySearchIndex(catalog, origin, clock), inject: [CATALOG_REPOSITORY, IMAGE_ORIGIN, CLOCK] },
        ...mediaProviders(o.media ?? {}, true),
      ],
    };
  }
}
