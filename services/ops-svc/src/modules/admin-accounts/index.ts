// 관리 계정 바운디드 컨텍스트의 공개 면(다른 컨텍스트·시작 파일은 이 파일로만 가져온다, architecture §3.1).
export { AdminAccounts, type AdminAccountsDeps, type OpsActor, requestIdOf } from './application/admin-accounts.js';
export {
  ADMIN_IDENTITY,
  ADMIN_REAUTH,
  type AdminAccountListQuery,
  type AdminIdentity,
  type AdminReauth,
  type RoleChangeApprovalRecord,
  type RoleChangeApprovalStore,
} from './domain/ports.js';
export {
  AdminAccountProblem,
  DESIGNATION_KINDS,
  PARTNER_ROLES,
  OPS_ROLES,
  etagOf,
  groupOf,
  isPartnerRole,
  parseIfMatch,
  type AdminAccountDetail,
  type AdminAccountView,
  type AdminDesignationView,
  type AdminGroup,
  type AdminPermissionChangeView,
  type AdminRole,
  type AdminSessionSummary,
  type AdminStatus,
  type DesignationKind,
  type LockKind,
} from './domain/admin-account.js';
export { GrpcIdentityAdminAccounts, UnavailableAdminIdentity } from './adapters/grpc-identity-admin-accounts.js';
export { AdminAccountsController, AdminSessionSelfController } from './inbound/admin-accounts.controller.js';
export { AdminAccountsModule, type AdminAccountsModuleDeps, DrizzleRoleChangeApprovalStore, MemoryRoleChangeApprovalStore } from './admin-accounts.module.js';
export { RoleChangeApprovals, type RoleChangeApprovalsDeps } from './application/role-change-approvals.js';
