// 뿌리 모듈: 운영 명령·CS 처리함의 저장소를 DB/메모리로 골라 싣는다.
// DB 조립은 감사 체인 작업자·5분 앵커와 명령 정비 작업을 모듈 수명주기로 켠다(BAT-355). 지표 묶음은 COMMAND_SIGNALS·AUDIT_SIGNALS로 내놓는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import {
  AuditCheckpointService,
  AuditModule,
  DrizzleAuditChain,
  DrizzleAuditCheckpointStore,
  DrizzleAuditIntakeStore,
  MemoryAuditChain,
  MemoryAuditCheckpointStore,
  MemoryAuditIntakeStore,
  type AuditCheckpointStore,
  type AuditBackgroundOptions,
  type AuditChain,
  type AuditChainReader,
  type AuditMacKey,
  type AuditSignals,
  type MacAnchorStore,
} from './modules/audit/index.js';
import { CommandsModule, type CommandExecutor, type CommandsModuleExtras, type HandleCommandEvent } from './modules/commands/index.js';
import { DrizzleCommandStore, IdentityActiveCommanders, MemoryCommandStore } from './modules/commands/index.js';
import { CasesModule, DrizzleCsCaseStore, MemoryCsCaseStore } from './modules/cases/index.js';
import { AlertsModule, DrizzleOpsAlertStore, MemoryOpsAlertStore, type OpsAlertStore } from './modules/alerts/index.js';
import { LiveModule, OpsLiveFeed } from './modules/live/index.js';
import { PriorityModule, type PriorityModuleDeps } from './modules/priority/index.js';
import { ScannerDevicesModule, type TicketScannerDevices } from './modules/scanner-devices/index.js';
import { PayoutsModule, UnavailableApprovalVerifier, type PayoutsModuleDeps } from './modules/payouts/index.js';
import { ApprovalsModule, type ApprovalsModuleDeps } from './modules/approvals/index.js';
import { BotReviewModule, type BotReviewSignals, type BotReviewSource, type TrustLabels } from './modules/bot-review/index.js';
import type { AdminIdentity, AdminReauth } from './modules/admin-accounts/domain/ports.js';
import {
  CsCaseEventCancellationCases,
  DrizzleEventCancellationStore,
  DrizzlePartnerEventCancellationStore,
  DrizzleSaleSuspensionLookup,
  EventCancellationsModule,
  MemoryEventCancellationStore,
  MemorySaleSuspensionLookup,
  StoreCancelledEventGuard,
  type EventCancellationCases,
  type EventCancellationReauth,
  type EventCancellationStore,
  type EventOwnerLookup,
  type EventRefundReader,
  type EventRefundStarter,
  type EventSaleStopper,
  type PartnerEventCancellationStore,
  type SaleSuspensionLookup,
} from './modules/event-cancellations/index.js';

interface CommonWiring {
  readonly executor?: CommandExecutor;
  /**
   * 감사 체인 작업자·빈 행 경보·5분 앵커와 명령 정비 작업의 타이머(BAT-355, ADR-0340·0341). DB 조립은 기본으로 켠다.
   * false면 타이머를 켜지 않는다(감사 체인 키·앵커 설정 검사는 한다). 시험은 간격을 바꿔 넣을 수 있다
   */
  readonly background?: false | { readonly audit?: Partial<Omit<AuditBackgroundOptions, 'enabled'>>; readonly maintenanceMs?: number };
  /** 감사 체인 키·앵커 저장소·환경 값을 넘긴다(시험). 없으면 process.env로 고른다(local·ci·demo 밖에서 키 ID·넘길 리전·버킷이 없으면 시작하지 않는다) */
  readonly auditMac?: { readonly key?: AuditMacKey; readonly anchors?: MacAnchorStore; readonly env?: Record<string, string | undefined> };
  /** 감사 체인 지표 묶음(시작 조립이 서비스 레지스트리에 붙인다). 없으면 모듈이 만든다 */
  readonly auditSignals?: AuditSignals;
  /** dry-run 센 값 원천·명령 4 보호 대역 목록(시험·BAT-365), 명령 12 온세일 윈도우·하위 결제사 판정 원천(BAT-360, 시작 조립이 core HTTP·payment gRPC로 채운다) */
  readonly commandExtras?: Pick<CommandsModuleExtras, 'dryRunSources' | 'protectedRanges' | 'signals' | 'pgAssignment' | 'postReviews' | 'blockIpSets' | 'opsEvents'>;
  /** 우선 구매 권리 발급·회수(GAT-135). 없으면 그 경로를 열지 않는다 */
  readonly priority?: PriorityModuleDeps;
  /** 시험에서 체크포인트 시각을 고정한다. 없으면 Date.now */
  readonly nowMs?: number;
  /** Kafka 소비자(ops.command-events)가 쓸 처리기(BAT-465 R-584). HTTP 수신기와 같은 객체다 */
  readonly onCommandEvent?: (h: HandleCommandEvent) => void;
  /** 메모리 조립의 감사 체크포인트 저장소(시험이 게시 작업과 같은 행을 나눠 본다, BAT-360). 없으면 새로 만든다. API 프로세스는 서명 키를 갖지 않는다(ADR-0348 결정 1) */
  readonly auditCheckpoints?: AuditCheckpointStore;
  /** ticket-svc ScannerDeviceService gRPC 클라이언트(BAT-450). 없으면 관제 기기 경로를 열지 않는다 */
  readonly scannerDevices?: TicketScannerDevices;
  /** 시험에서 감사 체인을 넘겨 기록을 확인한다. 없으면 DB/메모리 체인을 만든다 */
  readonly auditChain?: AuditChain & AuditChainReader;
  /** 지급 승인 업무(BAT-610 잔여). 없으면 메모리 저장·503 payment 클라이언트로 조립한다 */
  readonly payouts?: PayoutsModuleDeps;
  /** 계약 조건 변경 승인 업무(BAT-615). 없으면 메모리 저장·메모리 core 대역, 재인증은 닫힌 대역이다 */
  readonly approvals?: ApprovalsModuleDeps;
  /** 관리 계정 REST·승인 업무(BAT-045 BOT-152, ADR-0322). identity는 필수이고, reauth가 없으면 쓰기가 503이다 */
  readonly adminAccounts?: {
    readonly identity: AdminIdentity;
    readonly reauth?: AdminReauth;
  };
  /**
   * 봇 표본 검토(BAT-197 BOT-080, FR-049). source가 없으면 진행·배정이 503이고, labels가 없으면 HUMAN·BOT 판정이 503이다.
   * signals는 main.ts가 서비스 레지스트리에 붙인다. accountRef는 처리자의 로그 가명이다.
   */
  readonly botReview?: {
    readonly source?: BotReviewSource;
    readonly labels?: TrustLabels;
    readonly signals?: BotReviewSignals;
    readonly accountRef?: (accountId: string) => string | undefined;
  };
  /**
   * 회차 취소 요청(BAT-425 GAT-130 잔여, BAT-420 GAT-110). refunds·reauth가 없으면 요청·확정이 503이다.
   * reader(미리보기·진행률)·stopper(판매 멈춤)·owners(파트너 소속)는 시작 조립(event-cancellation-wiring)이 고른다. 없으면 그 경로가 503이다.
   * suspension(판매 중지 확인, ops 명령 기록)·cases(CS '판정 대기' 건)는 주지 않으면 같은 DB/메모리 저장소의 기본을 쓴다.
   */
  readonly eventCancellations?: {
    readonly refunds?: EventRefundStarter;
    readonly reauth?: EventCancellationReauth;
    readonly reader?: EventRefundReader;
    readonly stopper?: EventSaleStopper;
    readonly owners?: EventOwnerLookup;
    readonly suspension?: SaleSuspensionLookup;
    readonly cases?: EventCancellationCases;
    /** purchase-svc SetEventRefundHold(BAT-420 몫 D, 시작 조립이 purchase gRPC 클라이언트로 채운다). 없으면 CANCEL 요청·판정·확정이 503이다 */
    readonly holds?: import('./modules/event-cancellations/index.js').EventRefundHolds;
    /** 지표 ops_event_cancellation_revert_failures_total(웨이브 끝 리뷰 K4, main.ts가 서비스 레지스트리에 붙인다) */
    readonly revertFailures?: { inc(): void };
    /** core 회차 상태 반영(BAT-420-rest GAT-110, 시작 조립이 PEAKET_CORE_HTTP_URL로 채운다). 없으면 부르지 않는다 */
    readonly core?: import('./modules/event-cancellations/index.js').CoreEventStatus;
    /** 지표 ops_event_cancellation_core_apply_failures_total(main.ts가 서비스 레지스트리에 붙인다) */
    readonly coreApplyFailures?: { inc(): void };
  };
}

/** 명령 3·11 사후 검토의 의존(ADR-0349 결정 7): 1인 기간 판정은 관리 계정 identity(넘긴 것이 먼저), 기한 넘김 SEV3는 같은 ops 경보 저장소 */
function postReviewWiring(o: CommonWiring, alerts: OpsAlertStore): NonNullable<CommandsModuleExtras['postReviews']> {
  const commanders = o.commandExtras?.postReviews?.commanders ?? (o.adminAccounts ? new IdentityActiveCommanders(o.adminAccounts.identity) : undefined);
  return { ...(commanders ? { commanders } : {}), alerts: o.commandExtras?.postReviews?.alerts ?? alerts };
}

/** 회차 취소 모듈의 의존(넘긴 것만 싣고, 판매 중지 확인·판정 대기 건은 기본을 채운다). 파트너 저장소는 DB 조립에서만 넣는다 */
function eventCancellationDeps(
  o: CommonWiring,
  store: EventCancellationStore,
  defaults: { suspension: SaleSuspensionLookup; cases: EventCancellationCases; partnerStore?: PartnerEventCancellationStore },
  audit: AuditChain,
) {
  const e = o.eventCancellations ?? {};
  return {
    store,
    audit,
    ...(defaults.partnerStore ? { partnerStore: defaults.partnerStore } : {}),
    ...(e.revertFailures ? { revertFailures: e.revertFailures } : {}),
    suspension: e.suspension ?? defaults.suspension,
    cases: e.cases ?? defaults.cases,
    ...(e.refunds ? { refunds: e.refunds } : {}),
    ...(e.reauth ? { reauth: e.reauth } : {}),
    ...(e.reader ? { reader: e.reader } : {}),
    ...(e.stopper ? { stopper: e.stopper } : {}),
    ...(e.owners ? { owners: e.owners } : {}),
    ...(e.holds ? { holds: e.holds } : {}),
    ...(e.core ? { core: e.core } : {}),
    ...(e.coreApplyFailures ? { coreApplyFailures: e.coreApplyFailures } : {}),
  };
}

@Module({})
export class AppModule {
  /**
   * partnerDatabase: 파트너 회차 취소 경로의 DB 풀(ops_partner 역할, PEAKET_PARTNER_DATABASE_URL, 웨이브 끝 리뷰 S2). 없으면 관제 풀을 함께 쓴다(local·ci·시험)
   */
  static register(o: ({ database: Database; partnerDatabase?: Database } & CommonWiring) | ({ memory: true } & CommonWiring)): DynamicModule {
    if ('database' in o) {
      const chain = o.auditChain ?? new DrizzleAuditChain(o.database);
      const checkpoints = new AuditCheckpointService(new DrizzleAuditCheckpointStore(o.database), chain, () => o.nowMs ?? Date.now());
      const store = new DrizzleCommandStore(o.database);
      const cancellations = new DrizzleEventCancellationStore(o.database);
      const csCases = new DrizzleCsCaseStore(o.database);
      const alerts = new DrizzleOpsAlertStore(o.database);
      const background = o.background === false ? undefined : (o.background ?? {});
      return {
        module: AppModule,
        imports: [
          databaseModule(o.database),
          CommandsModule.register(store, o.executor, checkpoints, o.onCommandEvent, new StoreCancelledEventGuard(cancellations), o.adminAccounts?.reauth ?? o.approvals?.reauth ?? o.payouts?.reauth, {
            ...(o.commandExtras ?? {}),
            postReviews: postReviewWiring(o, alerts),
            maintenance: { enabled: background !== undefined, ...(background?.maintenanceMs !== undefined ? { intervalMs: background.maintenanceMs } : {}) },
          }),
          AuditModule.register(checkpoints, {
            intake: new DrizzleAuditIntakeStore(o.database),
            ...(o.auditSignals ? { signals: o.auditSignals } : {}),
            background: {
              database: o.database,
              alerts,
              ...(o.auditMac?.key ? { key: o.auditMac.key } : {}),
              ...(o.auditMac?.anchors ? { anchors: o.auditMac.anchors } : {}),
              ...(o.auditMac?.env ? { env: o.auditMac.env } : {}),
              enabled: background !== undefined,
              ...(background?.audit ? { options: background.audit } : {}),
            },
          }),
          LiveModule.register(new OpsLiveFeed({ commands: store, checkpoints })),
          CasesModule.register(csCases),
          AlertsModule.register(alerts),
          ...(o.priority ? [PriorityModule.register({ ...o.priority, audit: chain })] : []),
          ...(o.scannerDevices ? [ScannerDevicesModule.register({ devices: o.scannerDevices, audit: chain })] : []),
          PayoutsModule.register(o.payouts ? { storage: 'database', database: o.database, ...o.payouts, audit: chain } : { storage: 'memory', deps: { audit: chain } }),
          ApprovalsModule.register({
            storage: 'database',
            database: o.database,
            audit: chain,
            reader: chain,
            ...(o.approvals ?? {}),
            ...(o.adminAccounts ? { admin: o.adminAccounts } : {}),
            reauth: o.approvals?.reauth ?? o.payouts?.reauth ?? new UnavailableApprovalVerifier(),
          }),
          BotReviewModule.register({ database: o.database, ...(o.botReview ?? {}) }),
          EventCancellationsModule.register(
            eventCancellationDeps(
              o,
              cancellations,
              {
                suspension: new DrizzleSaleSuspensionLookup(o.database),
                cases: new CsCaseEventCancellationCases(csCases),
                // 파트너 경로는 파트너 풀과 세션 테넌트로만 접속한다(행 보안, authz-matrix §5.3 'ops-svc 구현')
                partnerStore: new DrizzlePartnerEventCancellationStore(o.partnerDatabase ?? o.database),
              },
              chain,
            ),
          ),
        ],
      };
    }
    const chain = o.auditChain ?? new MemoryAuditChain();
    const checkpoints = new AuditCheckpointService(o.auditCheckpoints ?? new MemoryAuditCheckpointStore(), chain, () => o.nowMs ?? Date.now());
    const store = new MemoryCommandStore(chain);
    const cancellations = new MemoryEventCancellationStore(chain);
    const csCases = new MemoryCsCaseStore();
    const memoryAlerts = new MemoryOpsAlertStore();
    return {
      module: AppModule,
      imports: [
        CommandsModule.register(store, o.executor, checkpoints, o.onCommandEvent, new StoreCancelledEventGuard(cancellations), o.adminAccounts?.reauth ?? o.approvals?.reauth ?? o.payouts?.reauth, {
          ...(o.commandExtras ?? {}),
          postReviews: postReviewWiring(o, memoryAlerts),
        }),
        AuditModule.register(checkpoints, { intake: new MemoryAuditIntakeStore(chain), ...(o.auditSignals ? { signals: o.auditSignals } : {}) }),
        LiveModule.register(new OpsLiveFeed({ commands: store, checkpoints })),
        CasesModule.register(csCases),
        AlertsModule.register(memoryAlerts),
        ...(o.priority ? [PriorityModule.register({ ...o.priority, audit: chain })] : []),
        ...(o.scannerDevices ? [ScannerDevicesModule.register({ devices: o.scannerDevices, audit: chain })] : []),
        PayoutsModule.register({ storage: 'memory', deps: { ...(o.payouts ?? {}), audit: chain } }),
        ApprovalsModule.register({
          storage: 'memory',
          audit: chain,
          deps: {
            ...(o.approvals ?? {}),
            ...(o.adminAccounts ? { admin: o.adminAccounts } : {}),
            reader: chain,
            reauth: o.approvals?.reauth ?? o.payouts?.reauth ?? new UnavailableApprovalVerifier(),
          },
        }),
        BotReviewModule.register({ ...(o.botReview ?? {}) }),
        EventCancellationsModule.register(eventCancellationDeps(o, cancellations, { suspension: new MemorySaleSuspensionLookup(store), cases: new CsCaseEventCancellationCases(csCases) }, chain)),
      ],
    };
  }
}
