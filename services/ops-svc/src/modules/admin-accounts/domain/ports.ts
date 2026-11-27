// 관제 관리 계정 모듈의 포트: identity AdminAccountService·AdminDesignationService·AdminSessionService 클라이언트와
// 승인 업무 저장소, 재인증 확인기(ADR-0322).
import type { ApprovalReauthVerifier } from '../../payouts/index.js';
import type { AdminAccountDetail, AdminAccountView, AdminDesignationView, AdminGroup, AdminRole, AdminStatus, DesignationKind } from './admin-account.js';

export interface AdminAccountListQuery {
  group: AdminGroup;
  promoterId?: string;
  status?: AdminStatus;
  cursor?: string;
  limit: number;
}

/** identity 관리 계정 gRPC. 결과 값은 Problem으로 바꿔 던진다(AdminAccountProblem) */
export interface AdminIdentity {
  list(q: AdminAccountListQuery): Promise<{ items: AdminAccountView[]; nextCursor: string | null }>;
  get(adminAccountId: string): Promise<AdminAccountDetail | null>;
  invite(i: { requestId: string; actedBy: string; email: string; displayName: string; role: AdminRole; promoterId?: string }): Promise<AdminAccountView>;
  changeRole(i: { requestId: string; actedBy: string; adminAccountId: string; role: AdminRole; expectedVersion: number; approvalId?: string }): Promise<AdminAccountView>;
  reinvite(i: { requestId: string; actedBy: string; adminAccountId: string; reason: 'RESEND' | 'PROTECT_LOCK' | 'CREDENTIAL_LOST' }): Promise<AdminAccountView>;
  remove(i: { requestId: string; actedBy: string; adminAccountId: string }): Promise<AdminAccountView | null>;
  designate(i: { requestId: string; actedBy: string; adminAccountId: string; kind: DesignationKind; basis: string }): Promise<AdminDesignationView>;
  revokeDesignation(i: { requestId: string; actedBy: string; adminAccountId: string; kind: DesignationKind }): Promise<void>;
  terminateSessions(i: { requestId: string; actedBy: string; adminAccountId: string; sessionId?: string }): Promise<{ endedCount: number; alreadyDone: boolean }>;
  designations(adminAccountId: string): Promise<DesignationKind[]>;
}

export const ADMIN_IDENTITY = Symbol.for('peaket.ops.admin-identity');
export const ADMIN_REAUTH = Symbol.for('peaket.ops.admin-reauth');
/** 파트너사 실재 확인(RV-12). 없으면 초대를 422 unknown-promoter, 조회 장애는 503 promoter-directory-unavailable로 닫는다 */
export interface PromoterDirectory {
  exists(promoterId: string): Promise<boolean>;
}
export const PROMOTER_DIRECTORY = Symbol.for('peaket.ops.promoter-directory');

export type AdminReauth = Pick<ApprovalReauthVerifier, 'verify'>;

/** 열린 승인 업무(COMMANDER_ROLE_CHANGE) 한 건 */
export interface RoleChangeApprovalRecord {
  approvalId: string;
  kind: 'COMMANDER_ROLE_CHANGE';
  targetRef: string;
  requestedRole: AdminRole;
  fromRole: AdminRole;
  targetVersion: number;
  reason: string;
  requestedBy: string;
  status: 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'DONE' | 'FAILED' | 'EXPIRED';
  requiredApprovals: 1 | 2;
  approverId: string | null;
  closeReason: string | null;
  createdAtMs: number;
  updatedAtMs: number;
  dueAtMs: number;
}

export interface RoleChangeApprovalStore {
  insert(r: RoleChangeApprovalRecord): Promise<void>;
  find(approvalId: string): Promise<RoleChangeApprovalRecord | null>;
  /** 판(version) 조건부 갱신. 다른 승인이 먼저 처리했으면 false */
  save(r: RoleChangeApprovalRecord, expectedVersion: number): Promise<boolean>;
  list(filter: { status?: readonly string[]; limit: number }): Promise<RoleChangeApprovalRecord[]>;
}
