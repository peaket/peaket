// 뿌리 모듈: 운영 명령·CS 처리함의 저장소를 DB/메모리로 골라 싣는다.
import { type DynamicModule, Module } from '@nestjs/common';
import { type Database, databaseModule } from '@peaket/platform';
import { AuditCheckpointService, AuditModule, DrizzleAuditChain, DrizzleAuditCheckpointStore, MemoryAuditChain, MemoryAuditCheckpointStore, ephemeralAuditAnchorSigner, type AuditAnchorSigner, type AuditChain, type AuditChainReader } from './modules/audit/index.js';
import { CommandsModule, type CommandExecutor, type HandleCommandEvent } from './modules/commands/index.js';
import { DrizzleCommandStore, MemoryCommandStore } from './modules/commands/index.js';
import { CasesModule, DrizzleCsCaseStore, MemoryCsCaseStore } from './modules/cases/index.js';
import { AlertsModule, DrizzleOpsAlertStore, MemoryOpsAlertStore } from './modules/alerts/index.js';
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
  /** 우선 구매 권리 발급·회수(GAT-135). 없으면 그 경로를 열지 않는다 */
  readonly priority?: PriorityModuleDeps;
  /** 시험에서 체크포인트 시각을 고정한다. 없으면 Date.now */
  readonly nowMs?: number;
  /** Kafka 소비자(ops.command-events)가 쓸 처리기(BAT-465 R-584). HTTP 수신기와 같은 객체다 */
  readonly onCommandEvent?: (h: HandleCommandEvent) => void;
  /** 감사 체크포인트 공개 앵커 서명기(BAT-465 R-584). 없으면 임시 Ed25519 키를 쓴다(시험) */
  readonly signer?: AuditAnchorSigner;
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
    const signer = o.signer ?? ephemeralAuditAnchorSigner();
    if ('database' in o) {
      const chain = o.auditChain ?? new DrizzleAuditChain(o.database);
      const checkpoints = new AuditCheckpointService(new DrizzleAuditCheckpointStore(o.database), chain, () => o.nowMs ?? Date.now(), signer);
      const store = new DrizzleCommandStore(o.database);
      const cancellations = new DrizzleEventCancellationStore(o.database);
      const csCases = new DrizzleCsCaseStore(o.database);
      return {
        module: AppModule,
        imports: [
          databaseModule(o.database),
          CommandsModule.register(store, o.executor, checkpoints, o.onCommandEvent, new StoreCancelledEventGuard(cancellations), o.adminAccounts?.reauth ?? o.approvals?.reauth ?? o.payouts?.reauth),
          AuditModule.register(checkpoints, signer),
          LiveModule.register(new OpsLiveFeed({ commands: store, checkpoints })),
          CasesModule.register(csCases),
          AlertsModule.register(new DrizzleOpsAlertStore(o.database)),
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
    const checkpoints = new AuditCheckpointService(new MemoryAuditCheckpointStore(), chain, () => o.nowMs ?? Date.now(), signer);
    const store = new MemoryCommandStore(chain);
    const cancellations = new MemoryEventCancellationStore(chain);
    const csCases = new MemoryCsCaseStore();
    return {
      module: AppModule,
      imports: [
        CommandsModule.register(store, o.executor, checkpoints, o.onCommandEvent, new StoreCancelledEventGuard(cancellations), o.adminAccounts?.reauth ?? o.approvals?.reauth ?? o.payouts?.reauth),
        AuditModule.register(checkpoints, signer),
        LiveModule.register(new OpsLiveFeed({ commands: store, checkpoints })),
        CasesModule.register(csCases),
        AlertsModule.register(new MemoryOpsAlertStore()),
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
