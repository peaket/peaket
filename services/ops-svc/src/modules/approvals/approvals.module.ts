// 승인 업무 모듈 조립(BAT-615 LCH-070, ADR-0320). 지급 승인은 PayoutsModule의 것을 그대로 쓰고(global export),
// 이 모듈은 계약 조건 변경 승인·라우터·HTTP 경로만 더한다.
import { type DynamicModule, Module, type Provider } from '@nestjs/common';
import { type Clock, type Database, CLOCK, INTERNAL_TOKEN } from '@peaket/platform';
import type { AuditChain } from '../audit/audit.js';
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
}

@Module({})
export class ApprovalsModule {
  static register(o: { storage: 'memory'; deps?: Partial<ApprovalsModuleDeps>; audit?: AuditChain } | ({ storage: 'database'; database: Database; audit: AuditChain } & ApprovalsModuleDeps)): DynamicModule {
    const providers: Provider[] = [
      { provide: INTERNAL_TOKEN, useValue: process.env.PEAKET_INTERNAL_TOKEN },
      {
        provide: ContractApprovals,
        useFactory: (store: ContractApprovalStore, core: CoreContractClient, reauth: ApprovalReauthVerifier, clock: Clock) => new ContractApprovals({ store, core, reauth, clock }),
        inject: [APPROVAL_STORE, CORE_CONTRACT_CLIENT, APPROVAL_REAUTH, CLOCK],
      },
      {
        provide: ApprovalRouter,
        useFactory: (payouts: PayoutApprovals, contracts: ContractApprovals) => new ApprovalRouter(payouts, contracts),
        inject: [PayoutApprovals, ContractApprovals],
      },
    ];
    const reauthProvider: Provider = { provide: APPROVAL_REAUTH, useValue: (o.storage === 'memory' ? o.deps?.reauth : o.reauth) ?? new UnavailableApprovalVerifier() };
    if (o.storage === 'database') {
      return {
        module: ApprovalsModule,
        controllers: [ApprovalsController, InternalApprovalsController],
        providers: [...providers, reauthProvider, { provide: APPROVAL_STORE, useValue: o.store ?? new DrizzleContractApprovalStore(o.database) }, { provide: CORE_CONTRACT_CLIENT, useValue: o.core ?? new UnavailableCoreContract() }],
      };
    }
    return {
      module: ApprovalsModule,
      controllers: [ApprovalsController, InternalApprovalsController],
      providers: [...providers, reauthProvider, { provide: APPROVAL_STORE, useValue: o.deps?.store ?? new MemoryContractApprovalStore(o.audit) }, { provide: CORE_CONTRACT_CLIENT, useValue: o.deps?.core ?? new MemoryCoreContract() }],
    };
  }
}
