// F-04-15 support 모듈 조립. local·ci는 메모리, 운영은 core DB와 Redis 사본(주입)을 쓴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, CLOCK, type Database, DATABASE } from '@peaket/platform';
import { DrizzleSupportAppealStore } from './adapters/db/drizzle-support-appeal-store.js';
import { MemoryFraudAppealViews } from './adapters/memory-fraud-appeal-views.js';
import { MemorySupportAppealStore } from './adapters/memory-support-appeal-store.js';
import { UnavailableAppealTargets, UnavailableFraudCaseAppeals } from './adapters/unavailable-ports.js';
import { SupportAppeals } from './application/support-appeals.js';
import type { AppealTargets, FraudAppealViews, FraudCaseAppeals, SupportAppealStore } from './domain/ports.js';
import { SupportAppealsController } from './inbound/appeals.controller.js';

export const SUPPORT_APPEAL_STORE = Symbol('support.appeal-store');
export const FRAUD_APPEAL_VIEWS = Symbol('support.fraud-appeal-views');
export const FRAUD_CASE_APPEALS = Symbol('support.fraud-case-appeals');
export const APPEAL_TARGETS = Symbol('support.appeal-targets');

export interface SupportWiring {
  readonly appeals: SupportAppealStore;
  readonly views: FraudAppealViews;
  readonly fraudCases?: FraudCaseAppeals;
  readonly targets?: AppealTargets;
  readonly now: () => number;
}

@Module({})
export class SupportModule {
  static register(o: { storage: 'memory'; wiring?: SupportWiring } | ({ storage: 'database'; database: Database } & Partial<SupportWiring>)): DynamicModule {
    const store: Provider =
      o.storage === 'database'
        ? { provide: SUPPORT_APPEAL_STORE, useFactory: (db: Database) => new DrizzleSupportAppealStore(db), inject: [DATABASE] }
        : { provide: SUPPORT_APPEAL_STORE, useValue: o.wiring?.appeals ?? new MemorySupportAppealStore() };
    const views: Provider = { provide: FRAUD_APPEAL_VIEWS, useValue: (o.storage === 'memory' ? o.wiring?.views : o.views) ?? new MemoryFraudAppealViews() };
    const fraudCases: Provider = { provide: FRAUD_CASE_APPEALS, useValue: (o.storage === 'memory' ? o.wiring?.fraudCases : o.fraudCases) ?? new UnavailableFraudCaseAppeals() };
    const targets: Provider = { provide: APPEAL_TARGETS, useValue: (o.storage === 'memory' ? o.wiring?.targets : o.targets) ?? new UnavailableAppealTargets() };
    const service: Provider = {
      provide: SupportAppeals,
      inject: [SUPPORT_APPEAL_STORE, FRAUD_APPEAL_VIEWS, FRAUD_CASE_APPEALS, APPEAL_TARGETS, CLOCK],
      useFactory: (s: SupportAppealStore, v: FraudAppealViews, f: FraudCaseAppeals, t: AppealTargets, clock: Clock) =>
        new SupportAppeals({ store: s, views: v, fraudCases: f, targets: t, now: o.storage === 'memory' && o.wiring ? o.wiring.now : () => clock.now() }),
    };
    return { module: SupportModule, controllers: [SupportAppealsController], providers: [store, views, fraudCases, targets, service] };
  }
}
