// 관제 관리 계정·역할 변경 승인 모듈(BUILD_ORDER BOT-152, ADR-0322). AppModule이 identity 클라이언트와 저장소를 넘긴다.
// HTTP 승인함 경로(/v1/ops/approval-requests*)는 approvals 모듈의 라우터가 이 모듈의 RoleChangeApprovals를 함께 쓴다.
import { type DynamicModule, Module } from '@nestjs/common';
import { CLOCK, type Clock } from '@peaket/platform';
import type { AuditChain, AuditChainReader } from '../audit/index.js';
import { AdminAccounts } from './application/admin-accounts.js';
import { RoleChangeApprovals } from './application/role-change-approvals.js';
import { DrizzleRoleChangeApprovalStore, MemoryRoleChangeApprovalStore } from './adapters/db/drizzle-role-change-approvals.js';
import { ADMIN_IDENTITY, ADMIN_REAUTH, type AdminIdentity, type AdminReauth, type RoleChangeApprovalStore } from './domain/ports.js';
import { AdminAccountsController, AdminSessionSelfController } from './inbound/admin-accounts.controller.js';

export interface AdminAccountsModuleDeps {
  readonly identity: AdminIdentity;
  readonly reauth?: AdminReauth;
  readonly store: RoleChangeApprovalStore;
  readonly audit: AuditChain;
  readonly reader?: AuditChainReader;
}

@Module({})
export class AdminAccountsModule {
  static register(deps: AdminAccountsModuleDeps): DynamicModule {
    return {
      module: AdminAccountsModule,
      controllers: [AdminAccountsController, AdminSessionSelfController],
      providers: [
        { provide: ADMIN_IDENTITY, useValue: deps.identity },
        { provide: ADMIN_REAUTH, useValue: deps.reauth },
        {
          provide: RoleChangeApprovals,
          useFactory: (clock: Clock) =>
            new RoleChangeApprovals({ store: deps.store, identity: deps.identity, reauth: deps.reauth, audit: deps.audit, clock }),
          inject: [CLOCK],
        },
        {
          provide: AdminAccounts,
          useFactory: (approvals: RoleChangeApprovals, clock: Clock) =>
            new AdminAccounts({ identity: deps.identity, reauth: deps.reauth, approvals, audit: deps.audit, ...(deps.reader ? { reader: deps.reader } : {}), clock }),
          inject: [RoleChangeApprovals, CLOCK],
        },
      ],
      exports: [AdminAccounts, RoleChangeApprovals],
    };
  }
}

export { DrizzleRoleChangeApprovalStore, MemoryRoleChangeApprovalStore };
