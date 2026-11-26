// F-04-12 조사 모듈 조립. AppModule이 저장소·외부 포트·지정 확인기를 넘긴다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { CLOCK, INTERNAL_TOKEN, InternalTokenGuard, type Clock } from '@peaket/platform';
import { type AdminIdentity } from '../admin-accounts/index.js';
import type { SaleScheduleSource } from '../readiness/index.js';
import { Investigations, type InvestigationsDeps } from './application/investigations.js';
import { FraudActions } from './application/fraud-actions.js';
import { EvidenceBundles, ExternalPosts, type EvidenceBundlesDeps } from './application/fraud-evidence.js';
import { InvestigationsController } from './inbound/investigations.controller.js';
import { FraudAppealsController } from './inbound/fraud-appeals.controller.js';
import { EvidenceBundlesController } from './inbound/evidence-bundles.controller.js';
import { ExternalPostsController } from './inbound/external-posts.controller.js';
import type {
  FraudAlerts,
  FraudAppealCopies,
  FraudForensicsRunner,
  FraudLabels,
  FraudNotifier,
  FraudOpsEventSink,
  FraudTicketDirectory,
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
  readonly fraudActions?: FraudActions;
  /** F-04-15 소명 화면 사본(core-svc gRPC). FraudActions와 같은 포트를 Investigations에도 넘긴다 */
  readonly fraudCopies?: FraudAppealCopies;
  /** F-04-15 결제자별 잠금 표 조회(ticket-svc gRPC). 소명 요청 때 사본에 잠글 표를 싣는다 */
  readonly fraudTickets?: Pick<FraudTicketDirectory, 'listForAction'>;
  /** F-04-14 증거 묶음·외부 게시물 포트 묶음. 없으면 새 경로를 열지 않는다(기준 트리 404) */
  readonly evidence?: EvidenceBundlesDeps;
  /** AppModule이 FraudActions와 같은 인스턴스를 쓰기 위해 미리 만든 서비스. 없으면 evidence로 만든다 */
  readonly evidenceServices?: { readonly evidence: EvidenceBundles; readonly posts: ExternalPosts };
}

@Module({})
export class InvestigationsModule {
  static register(deps: InvestigationsModuleDeps): DynamicModule {
    const evidenceServices = deps.evidenceServices ?? (deps.evidence ? { evidence: new EvidenceBundles(deps.evidence), posts: new ExternalPosts(deps.evidence) } : undefined);
    const service: Provider = {
      provide: Investigations,
      inject: [CLOCK],
      useFactory: (clock: Clock) =>
        new Investigations({
          store: deps.store,
          identity: deps.identity,
          schedule: deps.schedule,
          ...(deps.fraudActions ? { fraud: deps.fraudActions } : {}),
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
          ...(deps.fraudCopies ? { copies: deps.fraudCopies } : {}),
          ...(deps.fraudTickets ? { tickets: deps.fraudTickets } : {}),
          ...(evidenceServices
            ? {
                evidence: {
                  listBundleIds: async (eventId: string, caseId: string) => {
                    const page = await evidenceServices.evidence.list({ accountId: 'system', role: 'commander' }, { eventId, limit: 100 });
                    return page.items.filter((x) => x.caseId === caseId).map((x) => String(x.bundleId));
                  },
                },
              }
            : {}),
        }),
    };
    const providers: Provider[] = [service, { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN }, InternalTokenGuard];
    if (deps.fraudActions) providers.push({ provide: FraudActions, useValue: deps.fraudActions });
    if (evidenceServices) {
      providers.push({ provide: EvidenceBundles, useValue: evidenceServices.evidence }, { provide: ExternalPosts, useValue: evidenceServices.posts });
      deps.fraudActions?.attachEvidence(evidenceServices.evidence);
    }
    const controllers = [
      InvestigationsController,
      ...(deps.fraudActions ? [FraudAppealsController] : []),
      ...(evidenceServices ? [EvidenceBundlesController, ExternalPostsController] : []),
    ];
    return {
      module: InvestigationsModule,
      controllers,
      providers,
      ...(deps.fraudActions || evidenceServices ? { exports: [...(deps.fraudActions ? [FraudActions] : []), ...(evidenceServices ? [EvidenceBundles, ExternalPosts] : [])] } : {}),
    };
  }
}
