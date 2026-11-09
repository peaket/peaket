// 모듈 조립 파일: 포트에 어댑터를 묶는다(층 규칙의 밖. 모든 층을 가져온다).
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database } from '@peaket/platform';
import { DrizzleCatalogRepository, PARTNER_DATABASE } from './adapters/db/drizzle-catalog-repository.js';
import { MemoryCatalogRepository } from './adapters/memory-catalog-repository.js';
import { AddProductionEvent } from './application/add-production-event.js';
import { CreateProduction } from './application/create-production.js';
import { GetEventSummary } from './application/get-event-summary.js';
import { Wishes } from './application/wish.js';
import { CATALOG_REPOSITORY } from './domain/ports.js';
import { EventSummaryController } from './inbound/event-summary.controller.js';
import { PartnerProductionController } from './inbound/partner-production.controller.js';
import { WishController } from './inbound/wish.controller.js';

@Module({})
export class CatalogModule {
  /** 저장소를 고른다. database면 DATABASE(databaseModule)가 함께 있어야 하고, 파트너 경로는 partnerDatabase로 접속한다(ADR-0241). memory는 시험이 채울 저장소를 넘길 수 있다 */
  static register(o: { storage: 'database'; partnerDatabase: Database } | { storage: 'memory'; repository?: MemoryCatalogRepository }): DynamicModule {
    return {
      module: CatalogModule,
      controllers: [EventSummaryController, PartnerProductionController, WishController],
      providers: [
        GetEventSummary,
        CreateProduction,
        AddProductionEvent,
        Wishes,
        ...(o.storage === 'database'
          ? [{ provide: PARTNER_DATABASE, useValue: o.partnerDatabase }, { provide: CATALOG_REPOSITORY, useClass: DrizzleCatalogRepository }]
          : [{ provide: CATALOG_REPOSITORY, useValue: o.repository ?? new MemoryCatalogRepository() }]),
      ],
    };
  }
}
