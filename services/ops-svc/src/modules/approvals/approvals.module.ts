// 승인 업무 모듈 조립(BAT-615 LCH-070, ADR-0320, BAT-045 BOT-152, F-06-3). 지급 승인은 PayoutsModule의 것을 그대로 쓰고(global export),
// 이 모듈은 계약 조건 변경 승인·commander 역할 변경 승인(admin-accounts 모듈)·정산서 수기 조정 승인(F-07-5)·일반 승인 수명주기(F-06-3)·라우터·HTTP 경로를 함께 조립한다.
// 조정 승인의 payment-svc 클라이언트는 PayoutsModule이 전역으로 내보내는 SETTLEMENT_PAYMENT_CLIENT를 쓴다.
import { type DynamicModule, Global, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK } from '@peaket/platform';
import { MemoryAuditChain, type AuditChain, type AuditChainReader } from '../audit/index.js';
import { AdminAccountsModule, DrizzleRoleChangeApprovalStore, MemoryRoleChangeApprovalStore, RoleChangeApprovals, UnavailableAdminIdentity, type AdminIdentity, type AdminReauth, type RoleChangeApprovalStore } from '../admin-accounts/index.js';
import { PayoutApprovals, SETTLEMENT_PAYMENT_CLIENT, UnavailableApprovalVerifier, type ApprovalReauthVerifier, type SettlementPaymentClient } from '../payouts/index.js';
import { ApprovalLifecycle } from './application/approval-lifecycle.js';
import { ApprovalRouter } from './application/approval-router.js';
import { ContractApprovals } from './application/contract-approvals.js';
import { SettlementAdjustmentApprovals } from './application/settlement-adjustment-approvals.js';
import {
  APPROVAL_REAUTH,
  APPROVAL_STORE,
  CORE_CONTRACT_CLIENT,
  SETTLEMENT_ADJUSTMENT_APPROVAL_STORE,
  type ContractApprovalStore,
  type CoreContractClient,
  type SettlementAdjustmentApprovalStore,
} from './domain/ports.js';
import { APPROVAL_LIFECYCLE_STORE, type ApprovalLifecycleStore } from './domain/lifecycle-ports.js';
import type { ApprovalLifecycleDeps } from './application/approval-lifecycle.js';
import { DrizzleContractApprovalStore, DrizzleSettlementAdjustmentApprovalStore } from './adapters/db/drizzle-store.js';
import { DrizzleApprovalLifecycleStore } from './adapters/db/drizzle-lifecycle-store.js';
import { MemoryContractApprovalStore, MemorySettlementAdjustmentApprovalStore } from './adapters/memory-store.js';
import { MemoryApprovalLifecycleStore } from './adapters/memory-lifecycle-store.js';
import { InternalApprovalsController } from './inbound/internal-approvals.controller.js';
import { ApprovalsController } from './inbound/approvals.controller.js';
import { SettlementAdjustmentsController } from './inbound/settlement-adjustments.controller.js';
import { MemoryCoreContract, UnavailableCoreContract } from '../../adapters/http-core-contract.js';
import type { ApprovalFailureCases } from '../cases/index.js';

export interface ApprovalsModuleDeps {
  readonly store?: ContractApprovalStore;
  readonly core?: CoreContractClient;
  readonly reauth?: ApprovalReauthVerifier;
  /** 관리 계정·역할 변경 승인(BAT-045). identity가 없으면 닫힌 대역(503)이다 */
  readonly admin?: { readonly identity: AdminIdentity; readonly reauth?: AdminReauth };
  /** 시험에서 역할 변경 승인 저장소를 넘긴다. 없으면 storage에 맞는 기본을 만든다 */
  readonly roleChangeStore?: RoleChangeApprovalStore;
  /** 감사 체인 읽기(권한 변경 내역). 없으면 빈 목록이다 */
  readonly reader?: AuditChainReader;
  /** 시험에서 정산서 조정 승인 저장소를 넘긴다. 없으면 storage에 맞는 기본을 만든다 */
  readonly settlementAdjustmentStore?: SettlementAdjustmentApprovalStore;
  /** 시험에서 승인 수명주기 저장소를 넘긴다. 없으면 storage에 맞는 기본을 만든다 */
  readonly lifecycleStore?: ApprovalLifecycleStore;
  /** 일반 승인 수명주기(F-06-3)의 대상·실행·알림 포트. 없으면 닫힌 대역(503)이다 */
  readonly lifecycle?: Omit<ApprovalLifecycleDeps, 'store' | 'reauth' | 'clock' | 'audit' | 'payoutExpiry'>;
  /** CS '승인 업무 실행 실패' 건(F-06-2 ADR-0364 결정 6). 계약 조건 변경·관리 역할 변경 승인이 부른다 */
  readonly failureCases?: ApprovalFailureCases;
}

@Global()
@Module({})
export class ApprovalsModule {
  static register(o: { storage: 'memory'; deps?: Partial<ApprovalsModuleDeps>; audit?: AuditChain } | ({ storage: 'database'; database: Database; audit: AuditChain } & ApprovalsModuleDeps)): DynamicModule {
    const deps = o.storage === 'memory' ? (o.deps ?? {}) : o;
    const audit = o.audit ?? new MemoryAuditChain();
    const adminReauth = deps.admin?.reauth ?? deps.reauth;
    const adminModule = AdminAccountsModule.register({
      identity: deps.admin?.identity ?? new UnavailableAdminIdentity(),
      ...(adminReauth ? { reauth: adminReauth } : {}),
      store: deps.roleChangeStore ?? (o.storage === 'memory' ? new MemoryRoleChangeApprovalStore() : new DrizzleRoleChangeApprovalStore(o.database)),
      audit,
      ...(deps.reader ? { reader: deps.reader } : {}),
      ...(deps.failureCases ? { failureCases: deps.failureCases } : {}),
    });
    const lifecycleStore: ApprovalLifecycleStore = deps.lifecycleStore ?? (o.storage === 'database' ? new DrizzleApprovalLifecycleStore(o.database) : new MemoryApprovalLifecycleStore(audit));
    const providers: Provider[] = [
      { provide: APPROVAL_LIFECYCLE_STORE, useValue: lifecycleStore },
      {
        provide: ContractApprovals,
        useFactory: (store: ContractApprovalStore, core: CoreContractClient, reauth: ApprovalReauthVerifier, clock: Clock) => new ContractApprovals({ store, core, reauth, clock, ...(deps.failureCases ? { failureCases: deps.failureCases } : {}) }),
        inject: [APPROVAL_STORE, CORE_CONTRACT_CLIENT, APPROVAL_REAUTH, CLOCK],
      },
      {
        provide: SettlementAdjustmentApprovals,
        useFactory: (store: SettlementAdjustmentApprovalStore, payments: SettlementPaymentClient, reauth: ApprovalReauthVerifier, clock: Clock) => new SettlementAdjustmentApprovals({ store, payments, reauth, clock }),
        inject: [SETTLEMENT_ADJUSTMENT_APPROVAL_STORE, SETTLEMENT_PAYMENT_CLIENT, APPROVAL_REAUTH, CLOCK],
      },
      {
        provide: ApprovalLifecycle,
        useFactory: (store: ApprovalLifecycleStore, reauth: ApprovalReauthVerifier, clock: Clock, payouts: PayoutApprovals) => {
          const failureCases =
            deps.lifecycle?.failureCases ??
            (deps.failureCases
              ? {
                  failed: (i: { approvalId: string; kind: string; dueAtMs: number | null }) => deps.failureCases!.failed(i, clock.now()),
                  succeeded: (id: string) => deps.failureCases!.succeeded(id, clock.now()),
                }
              : undefined);
          return new ApprovalLifecycle({
            store,
            reauth,
            clock,
            audit,
            payoutExpiry: payouts,
            ...(deps.lifecycle?.targets ? { targets: deps.lifecycle.targets } : {}),
            ...(deps.lifecycle?.executors ? { executors: deps.lifecycle.executors } : {}),
            ...(deps.lifecycle?.notifier ? { notifier: deps.lifecycle.notifier } : {}),
            ...(deps.lifecycle?.alerts ? { alerts: deps.lifecycle.alerts } : {}),
            ...(failureCases ? { failureCases } : {}),
          });
        },
        inject: [APPROVAL_LIFECYCLE_STORE, APPROVAL_REAUTH, CLOCK, PayoutApprovals],
      },
      {
        provide: ApprovalRouter,
        useFactory: (payouts: PayoutApprovals, contracts: ContractApprovals, roleChanges: RoleChangeApprovals, adjustments: SettlementAdjustmentApprovals, lifecycle: ApprovalLifecycle) => new ApprovalRouter(payouts, contracts, roleChanges, adjustments, lifecycle),
        inject: [PayoutApprovals, ContractApprovals, RoleChangeApprovals, SettlementAdjustmentApprovals, ApprovalLifecycle],
      },
      {
        provide: SETTLEMENT_ADJUSTMENT_APPROVAL_STORE,
        useValue: deps.settlementAdjustmentStore ?? (o.storage === 'database' ? new DrizzleSettlementAdjustmentApprovalStore(o.database) : new MemorySettlementAdjustmentApprovalStore(audit)),
      },
    ];
    const reauthProvider: Provider = { provide: APPROVAL_REAUTH, useValue: deps.reauth ?? new UnavailableApprovalVerifier() };
    if (o.storage === 'database') {
      return {
        module: ApprovalsModule,
        imports: [adminModule],
        controllers: [ApprovalsController, InternalApprovalsController, SettlementAdjustmentsController],
        exports: [ApprovalLifecycle],
        providers: [...providers, reauthProvider, { provide: APPROVAL_STORE, useValue: o.store ?? new DrizzleContractApprovalStore(o.database) }, { provide: CORE_CONTRACT_CLIENT, useValue: o.core ?? new UnavailableCoreContract() }],
      };
    }
    return {
      module: ApprovalsModule,
      imports: [adminModule],
      controllers: [ApprovalsController, InternalApprovalsController, SettlementAdjustmentsController],
      providers: [...providers, reauthProvider, { provide: APPROVAL_STORE, useValue: deps.store ?? new MemoryContractApprovalStore(audit) }, { provide: CORE_CONTRACT_CLIENT, useValue: deps.core ?? new MemoryCoreContract() }],
    };
  }
}
