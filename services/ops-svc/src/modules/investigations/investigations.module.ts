// F-04-12 조사 모듈 조립. AppModule이 저장소·외부 포트·지정 확인기를 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import { type AdminIdentity } from '../admin-accounts/index.js';
import type { SaleScheduleSource } from '../readiness/index.js';
import { Investigations, type InvestigationsDeps } from './application/investigations.js';
import { InvestigationsController } from './inbound/investigations.controller.js';
import type {
  FraudAlerts,
  FraudForensicsRunner,
  FraudLabels,
  FraudNotifier,
  FraudOpsEventSink,
  InvestigationAccessLog,
  InvestigationStore,
  SnapshotVerifier,
  TransferLocks,
} from './domain/ports.js';

export interface InvestigationsModuleDeps {
  readonly store: InvestigationStore;
  readonly schedule: SaleScheduleSource;
  readonly locks: TransferLocks;
  readonly notifier: FraudNotifier;
  readonly labels: FraudLabels;
  readonly alerts: FraudAlerts;
  readonly access: InvestigationAccessLog;
  readonly events: FraudOpsEventSink;
  readonly verifier: SnapshotVerifier;
  readonly now: () => number;
  readonly identity: Pick<AdminIdentity, 'designations'>;
  readonly audit?: InvestigationsDeps['audit'];
  readonly runner?: FraudForensicsRunner;
}

@Module({})
export class InvestigationsModule {
  static register(deps: InvestigationsModuleDeps): DynamicModule {
    const service: Provider = {
      provide: Investigations,
      inject: [CLOCK],
      useFactory: (clock: Clock) =>
        new Investigations({
          store: deps.store,
          identity: deps.identity,
          schedule: deps.schedule,
          locks: deps.locks,
          notifier: deps.notifier,
          labels: deps.labels,
          alerts: deps.alerts,
          access: deps.access,
          events: deps.events,
          verifier: deps.verifier,
          now: deps.now ?? (() => clock.now()),
          ...(deps.audit ? { audit: deps.audit } : {}),
          ...(deps.runner ? { runner: deps.runner } : {}),
        }),
    };
    return { module: InvestigationsModule, controllers: [InvestigationsController], providers: [service] };
  }
}
