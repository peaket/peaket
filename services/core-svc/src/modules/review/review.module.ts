// review 모듈 조립. 메모리(단위 시험)와 Drizzle(운영) 저장소를 고른다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, DATABASE } from '@peaket/platform';
import { MemoryCatalogRepository, type CatalogRepository } from '../catalog/index.js';
import { DrizzleReviewEventDirectory } from './adapters/db/drizzle-review-event-directory.js';
import { DrizzleReviewStore } from './adapters/db/drizzle-review-store.js';
import { MemoryReviewEventDirectory } from './adapters/memory-review-event-directory.js';
import { MemoryFanProfile, UnavailableFanProfile } from './adapters/fan-profile.js';
import { MemoryReviewEligibility } from './adapters/memory-review-eligibility.js';
import { MemoryReviewStore } from './adapters/memory-review-store.js';
import { LogReviewCaseSink, LogReviewNotifier } from './adapters/review-notifier.js';
import { UnavailableReviewEligibility } from './adapters/unavailable-review-eligibility.js';
import { Reviews } from './application/reviews.js';
import { FAN_PROFILE, REVIEW_CASE_SINK, REVIEW_ELIGIBILITY, REVIEW_EVENT_DIRECTORY, REVIEW_NOTIFIER, REVIEW_STORE, type FanProfile, type ReviewCaseSink, type ReviewEligibility, type ReviewEventDirectory, type ReviewNotifier, type ReviewStore } from './domain/ports.js';
import { OpsReviewController } from './inbound/ops-review.controller.js';
import { ReviewController } from './inbound/review.controller.js';

export interface MemoryReviewWiring {
  store?: ReviewStore;
  /** 후기 목록·자격이 읽는 회차·공연. 보통 AppModule이 같은 MemoryCatalogRepository를 넘긴다 */
  catalogRepository?: CatalogRepository;
  eligibility?: ReviewEligibility;
  fanProfile?: FanProfile;
  notifier?: ReviewNotifier;
  cases?: ReviewCaseSink;
}

export interface DatabaseReviewWiring {
  database: Database;
  /** 없으면 후기 자격 확인이 503이다(주소를 넣기 전 시험·개발) */
  eligibility?: ReviewEligibility;
  fanProfile?: FanProfile;
  notifier?: ReviewNotifier;
  cases?: ReviewCaseSink;
}

@Module({})
export class ReviewModule {
  static register(o: { storage: 'memory'; wiring?: MemoryReviewWiring } | ({ storage: 'database' } & DatabaseReviewWiring)): DynamicModule {
    const controllers = [ReviewController, OpsReviewController];
    const base: Provider[] = [
      { provide: REVIEW_ELIGIBILITY, useValue: o.storage === 'memory' ? (o.wiring?.eligibility ?? new MemoryReviewEligibility()) : (o.eligibility ?? new UnavailableReviewEligibility()) },
      { provide: FAN_PROFILE, useValue: (o.storage === 'memory' ? o.wiring?.fanProfile : o.fanProfile) ?? new UnavailableFanProfile() },
      { provide: REVIEW_NOTIFIER, useValue: (o.storage === 'memory' ? o.wiring?.notifier : o.notifier) ?? new LogReviewNotifier() },
      { provide: REVIEW_CASE_SINK, useValue: (o.storage === 'memory' ? o.wiring?.cases : o.cases) ?? new LogReviewCaseSink() },
      {
        provide: Reviews,
        useFactory: (store: ReviewStore, events: ReviewEventDirectory, eligibility: ReviewEligibility, fanProfile: FanProfile, notifier: ReviewNotifier, cases: ReviewCaseSink, clock: Clock) =>
          new Reviews({ store, events, eligibility, fanProfile, notifier, cases, clock }),
        inject: [REVIEW_STORE, REVIEW_EVENT_DIRECTORY, REVIEW_ELIGIBILITY, FAN_PROFILE, REVIEW_NOTIFIER, REVIEW_CASE_SINK, CLOCK],
      },
    ];
    if (o.storage === 'database') {
      return {
        module: ReviewModule,
        controllers,
        providers: [
          ...base,
          { provide: REVIEW_STORE, useFactory: (db: Database) => new DrizzleReviewStore(db), inject: [DATABASE] },
          { provide: REVIEW_EVENT_DIRECTORY, useFactory: (db: Database) => new DrizzleReviewEventDirectory(db), inject: [DATABASE] },
        ],
      };
    }
    return {
      module: ReviewModule,
      controllers,
      providers: [
        ...base,
        { provide: REVIEW_STORE, useValue: o.wiring?.store ?? new MemoryReviewStore() },
        { provide: REVIEW_EVENT_DIRECTORY, useValue: new MemoryReviewEventDirectory(o.wiring?.catalogRepository ?? new MemoryCatalogRepository()) },
      ],
    };
  }
}
