// 승인 업무 모듈 조립(BAT-615 LCH-070, ADR-0320, BAT-045 BOT-152). 지급 승인은 PayoutsModule의 것을 그대로 쓰고(global export),
// 이 모듈은 계약 조건 변경 승인·commander 역할 변경 승인(admin-accounts 모듈)·라우터·HTTP 경로를 함께 조립한다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, INTERNAL_TOKEN } from '@peaket/platform';
import { MemoryAuditChain, type AuditChain, type AuditChainReader } from '../audit/index.js';
import { AdminAccountsModule, DrizzleRoleChangeApprovalStore, MemoryRoleChangeApprovalStore, RoleChangeApprovals, UnavailableAdminIdentity, type AdminIdentity, type AdminReauth, type RoleChangeApprovalStore } from '../admin-accounts/index.js';
import { PayoutApprovals, UnavailableApprovalVerifier, type ApprovalReauthVerifier } from '../payouts/index.js';
import { ApprovalRouter } from './application/approval-router.js';
import { ContractApprovals } from './application/contract-approvals.js';
import { APPROVAL_REAUTH, APPROVAL_STORE, CORE_CONTRACT_CLIENT, type ContractApprovalStore, type CoreContractClient } from './domain/ports.js';
import { DrizzleContractApprovalStore } from './adapters/db/drizzle-store.js';
import { MemoryContractApprovalStore } from './adapters/memory-store.js';
import { InternalApprovalsController } from './inbound/internal-approvals.controller.js';
import { ApprovalsController } from './inbound/approvals.controller.js';
import { MemoryCoreContract, UnavailableCoreContract } from '../../adapters/http-core-contract.js';

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
}

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
    });
    const providers: Provider[] = [
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      {
        provide: ContractApprovals,
        useFactory: (store: ContractApprovalStore, core: CoreContractClient, reauth: ApprovalReauthVerifier, clock: Clock) => new ContractApprovals({ store, core, reauth, clock }),
        inject: [APPROVAL_STORE, CORE_CONTRACT_CLIENT, APPROVAL_REAUTH, CLOCK],
      },
      {
        provide: ApprovalRouter,
        useFactory: (payouts: PayoutApprovals, contracts: ContractApprovals, roleChanges: RoleChangeApprovals) => new ApprovalRouter(payouts, contracts, roleChanges),
        inject: [PayoutApprovals, ContractApprovals, RoleChangeApprovals],
      },
    ];
    const reauthProvider: Provider = { provide: APPROVAL_REAUTH, useValue: deps.reauth ?? new UnavailableApprovalVerifier() };
    if (o.storage === 'database') {
      return {
        module: ApprovalsModule,
        imports: [adminModule],
        controllers: [ApprovalsController, InternalApprovalsController],
        providers: [...providers, reauthProvider, { provide: APPROVAL_STORE, useValue: o.store ?? new DrizzleContractApprovalStore(o.database) }, { provide: CORE_CONTRACT_CLIENT, useValue: o.core ?? new UnavailableCoreContract() }],
      };
    }
    return {
      module: ApprovalsModule,
      imports: [adminModule],
      controllers: [ApprovalsController, InternalApprovalsController],
      providers: [...providers, reauthProvider, { provide: APPROVAL_STORE, useValue: deps.store ?? new MemoryContractApprovalStore(audit) }, { provide: CORE_CONTRACT_CLIENT, useValue: deps.core ?? new MemoryCoreContract() }],
    };
  }
}
