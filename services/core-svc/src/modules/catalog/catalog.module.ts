// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다).
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Database } from '@peaket/platform';
import { LogCdnInvalidation, MemoryCdnInvalidation, unavailableImageProcessing, unavailableSeatmapParser } from './adapters/cdn-invalidation.js';
import { DrizzleCatalogRepository, PARTNER_DATABASE } from './adapters/db/drizzle-catalog-repository.js';
import { DrizzleProductionMedia } from './adapters/db/drizzle-production-media.js';
import { MemoryImageObjectStore } from './adapters/image-store.js';
import { MemoryCatalogRepository, MemoryProductionMedia } from './adapters/memory-catalog-repository.js';
import { AddProductionEvent } from './application/add-production-event.js';
import { CreateProduction } from './application/create-production.js';
import { GetEventSummary } from './application/get-event-summary.js';
import { ImportSeatmap } from './application/import-seatmap.js';
import { PartnerDirectory } from './application/partner-directory.js';
import { ProductionImages } from './application/production-images.js';
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
import { CATALOG_REPOSITORY } from './domain/ports.js';
import { EventSummaryController } from './inbound/event-summary.controller.js';
import { PartnerDirectoryController } from './inbound/partner-directory.controller.js';
import { PartnerMediaController } from './inbound/partner-media.controller.js';
import { PartnerProductionController } from './inbound/partner-production.controller.js';
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
  ];
}

@Module({})
export class CatalogModule {
  /**
   * 저장소를 고른다. database면 DATABASE(databaseModule)가 함께 있어야 하고, 파트너 경로는 partnerDatabase로 접속한다(ADR-0241). memory는 시험이 채울 저장소를 넘길 수 있다.
   * media는 database면 꼭 넘기고, memory면 시험이 필요한 것만 넘긴다
   */
  static register(o: { storage: 'database'; partnerDatabase: Database; media: MediaWiring } | { storage: 'memory'; repository?: MemoryCatalogRepository; media?: Partial<MediaWiring> }): DynamicModule {
    const shared = [GetEventSummary, CreateProduction, AddProductionEvent, Wishes, PartnerDirectory, ProductionImages, ImportSeatmap];
    const controllers = [EventSummaryController, PartnerProductionController, PartnerDirectoryController, WishController, PartnerMediaController];
    if (o.storage === 'database') {
      return {
        module: CatalogModule,
        controllers,
        providers: [
          ...shared,
          { provide: PARTNER_DATABASE, useValue: o.partnerDatabase },
          { provide: CATALOG_REPOSITORY, useClass: DrizzleCatalogRepository },
          { provide: PARTNER_PRODUCTION_MEDIA, useClass: DrizzleProductionMedia },
          ...mediaProviders(o.media, false),
        ],
      };
    }
    const repo = o.repository ?? new MemoryCatalogRepository();
    return {
      module: CatalogModule,
      controllers,
      providers: [...shared, { provide: CATALOG_REPOSITORY, useValue: repo }, { provide: PARTNER_PRODUCTION_MEDIA, useValue: new MemoryProductionMedia(repo) }, ...mediaProviders(o.media ?? {}, true)],
    };
  }
}
