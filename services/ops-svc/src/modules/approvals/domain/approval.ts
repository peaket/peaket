// 계약 조건 변경 승인 업무의 도메인(BAT-615 LCH-070, ADR-0320 결정 2·3, POL-038 ⑨).
// operator가 요청하고, 요청자가 아닌 commander가 act=APPROVAL 재인증 뒤 승인한다. 한 파트너에 열린 변경은 하나다.
import type { AdminRole, RoleChangeApprovalRecord } from '../../admin-accounts/index.js';

export class ContractApprovalProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'ContractApprovalProblem';
  }
}

export type ContractApprovalStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'DONE' | 'FAILED' | 'WITHDRAWN';

export type GuaranteeKind = 'DEPOSIT' | 'PERFORMANCE_BOND';

export interface ContractTermsSnapshot {
  commissionRateBp: number;
  guaranteeRateBp: number;
  guaranteeKind: GuaranteeKind;
  validFrom: string;
}

export interface ContractApprovalRecord {
  approvalId: string;
  promoterId: string;
  current: ContractTermsSnapshot;
  requestedCommissionRateBp: number | null;
  requestedGuaranteeRateBp: number | null;
  requestedGuaranteeKind: GuaranteeKind | null;
  requestedBy: string;
  requesterRole: string;
  reasonText: string;
  status: ContractApprovalStatus;
  closeReason: string | null;
  approverId: string | null;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  version: number;
}

export interface OpsActor {
  accountId: string;
  sessionId: string;
  role: string;
}

/** openapi ApprovalRequest. 계약 변경은 contractTerms를 싣고 amount·requestedRole·fraudAction은 없다 */
export interface ContractApprovalView {
  approvalId: string;
  kind: 'CONTRACT_TERMS_CHANGE';
  targetRef: string;
  reasonCode: 'CONTRACT_TERMS_CHANGE';
  reasonText: string;
  requiredApprovals: 2;
  approvals: string[];
  status: ContractApprovalStatus;
  requestedBy: { adminAccountId: string; displayName: null; role: string };
  requestedAt: string;
  canApprove: boolean;
  dueAt: null;
  closeReason: string | null;
  contractTerms: {
    current: ContractTermsSnapshot;
    requestedCommissionRateBp: number | null;
    requestedGuaranteeRateBp: number | null;
    requestedGuaranteeKind: GuaranteeKind | null;
  };
}

export const contractApprovalView = (r: ContractApprovalRecord, actor: OpsActor): ContractApprovalView => ({
  approvalId: r.approvalId,
  kind: 'CONTRACT_TERMS_CHANGE',
  targetRef: r.promoterId,
  reasonCode: 'CONTRACT_TERMS_CHANGE',
  reasonText: r.reasonText,
  requiredApprovals: 2,
  approvals: r.approverId && r.status === 'DONE' ? [r.approverId] : [],
  status: r.status,
  requestedBy: { adminAccountId: r.requestedBy, displayName: null, role: r.requesterRole },
  requestedAt: r.createdAt.toISOString(),
  canApprove: (r.status === 'PENDING_APPROVAL' || r.status === 'FAILED' || r.status === 'EXECUTING') && r.requestedBy !== actor.accountId && actor.role === 'commander',
  dueAt: null,
  closeReason: r.status === 'REJECTED' || r.status === 'WITHDRAWN' ? r.closeReason : r.status === 'FAILED' ? r.closeReason : null,
  contractTerms: {
    current: r.current,
    requestedCommissionRateBp: r.requestedCommissionRateBp,
    requestedGuaranteeRateBp: r.requestedGuaranteeRateBp,
    requestedGuaranteeKind: r.requestedGuaranteeKind,
  },
});

/** 계약 승인 상세는 요청자와 commander만, 목록 줄도 그 둘에게만 보인다(J-T29 ⑦) */
export const canSeeContractApproval = (r: ContractApprovalRecord, actor: OpsActor): boolean => r.requestedBy === actor.accountId || actor.role === 'commander';

export const openContractApproval = (r: ContractApprovalRecord): boolean => r.status === 'PENDING_APPROVAL' || r.status === 'EXECUTING' || r.status === 'FAILED';

/** 재인증을 마친 승인자가 지금 상태를 바꿀 수 있는가. EXECUTING은 core 적용 성공 뒤 저장이 실패해 남은 상태로, 같은 승인 ID 재시도만 허용한다(RV-06) */
export function assertCanDecide(r: ContractApprovalRecord, actor: OpsActor, action: 'approve' | 'reject'): void {
  if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED' && !(action === 'approve' && r.status === 'EXECUTING')) {
    throw new ContractApprovalProblem('contract-approval-not-pending', 409, '승인 대기 중인 계약 변경이 아닙니다');
  }
  if (r.requestedBy === actor.accountId) throw new ContractApprovalProblem('approval-self-not-allowed', 403, `요청자는 ${action === 'approve' ? '승인' : '반려'}할 수 없습니다`);
  if (actor.role !== 'commander') throw new ContractApprovalProblem('approval-role-required', 403, 'commander만 계약 변경을 판정할 수 있습니다');
}

/** 요청 값이 모두 null이면(바꿀 칸이 없으면) 만들지 않는다 */
export function hasRequestedChange(r: Pick<ContractApprovalRecord, 'requestedCommissionRateBp' | 'requestedGuaranteeRateBp' | 'requestedGuaranteeKind'>): boolean {
  return r.requestedCommissionRateBp !== null || r.requestedGuaranteeRateBp !== null || r.requestedGuaranteeKind !== null;
}

// 승인 업무 가운데 COMMANDER_ROLE_CHANGE 한 종류(docs/data.md approval_request·approval_vote, POL-038 ⑨, ADR-0322).
// due_at은 요청 뒤 5영업일 [가정]이다. 다른 종류(환불·지급·수사기관 자료 등)는 각 기능 묶음이 맡는다.
export const APPROVAL_DUE_BUSINESS_DAYS = 5;

/** 요청 시각(ms) 뒤 영업일 n일(토·일을 건너뛴다). 같은 시각의 그날이다 */
export function addBusinessDays(ms: number, days: number): number {
  const d = new Date(ms);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d.getTime();
}

export interface RoleChangeApprovalView {
  approvalId: string;
  kind: 'COMMANDER_ROLE_CHANGE';
  targetRef: string;
  requestedRole: AdminRole;
  amount: 0;
  reasonCode: 'COMMANDER_ROLE_CHANGE';
  reasonText: string;
  status: RoleChangeApprovalRecord['status'];
  requiredApprovals: 2;
  approvals: string[];
  requestedBy: { adminAccountId: string; displayName: null; role: AdminRole };
  requestedAt: string;
  canApprove: boolean;
  dueAt: string;
  closeReason: string | null;
}

export const roleChangeApprovalView = (r: RoleChangeApprovalRecord, actor: { accountId: string; role: string }): RoleChangeApprovalView => ({
  approvalId: r.approvalId,
  kind: 'COMMANDER_ROLE_CHANGE',
  targetRef: r.targetRef,
  requestedRole: r.requestedRole,
  amount: 0,
  reasonCode: 'COMMANDER_ROLE_CHANGE',
  reasonText: r.reason,
  status: r.status,
  requiredApprovals: 2,
  approvals: r.approverId ? [r.approverId] : [],
  requestedBy: { adminAccountId: r.requestedBy, displayName: null, role: 'commander' },
  requestedAt: new Date(r.createdAtMs).toISOString(),
  canApprove: r.status === 'PENDING_APPROVAL' && r.requestedBy !== actor.accountId && actor.role === 'commander',
  dueAt: new Date(r.dueAtMs).toISOString(),
  closeReason: r.closeReason,
});
