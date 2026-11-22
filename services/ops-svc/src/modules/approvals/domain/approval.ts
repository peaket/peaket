// 계약 조건 변경 승인 업무의 도메인(BAT-615 LCH-070, ADR-0320 결정 2·3, POL-038 ⑨).
// operator가 요청하고, 요청자가 아닌 commander가 act=APPROVAL 재인증 뒤 승인한다. 한 파트너에 열린 변경은 하나다.

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

// ---- 정산서 수기 조정 승인(F-07-5 LCH-100, ADR-0368 결정 7·8, POL-038 ⑦, settlement §4.3) ----
// cs_lead가 요청하고 요청자가 아닌 commander가 act=APPROVAL 재인증 뒤 승인한다. 조정 행(금액·사유 코드·이의·근거 메모)은 payment-svc가 갖고,
// ops는 공통 승인 표(approval_request·approval_vote)에 승인 업무만 둔다(마이그레이션 없음).

export type SettlementAdjustmentApprovalStatus = 'PENDING_APPROVAL' | 'REJECTED' | 'EXECUTING' | 'DONE' | 'FAILED';

/** 승인 업무에 보이는 근거 메모의 앞부분 길이(200자 [가정]). 원문은 payment 조정 행에만 있다 */
export const ADJUSTMENT_REASON_TEXT_MAX = 200;

export interface SettlementAdjustmentApprovalRecord {
  approvalId: string;
  statementId: string;
  amount: number;
  reasonCode: string;
  reasonText: string;
  requestedBy: string;
  requesterRole: string;
  status: SettlementAdjustmentApprovalStatus;
  closeReason: string | null;
  approverId: string | null;
  /** 투표(approval_vote)한 승인자. 요청자는 들 수 없다(표 CHECK) */
  approvals: string[];
  /** 첫 투표 시각 */
  approvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface SettlementAdjustmentApprovalView {
  approvalId: string;
  kind: 'SETTLEMENT_ADJUSTMENT';
  targetRef: string;
  amount: number;
  reasonCode: string;
  reasonText: string;
  requiredApprovals: 2;
  approvals: string[];
  status: SettlementAdjustmentApprovalStatus;
  requestedBy: { adminAccountId: string; displayName: null; role: string };
  requestedAt: string;
  canApprove: boolean;
  dueAt: null;
  closeReason: string | null;
  contractTerms: null;
}

export const settlementAdjustmentApprovalView = (r: SettlementAdjustmentApprovalRecord, actor: OpsActor): SettlementAdjustmentApprovalView => ({
  approvalId: r.approvalId,
  kind: 'SETTLEMENT_ADJUSTMENT',
  targetRef: r.statementId,
  amount: r.amount,
  reasonCode: r.reasonCode,
  reasonText: r.reasonText,
  requiredApprovals: 2,
  approvals: [...r.approvals],
  status: r.status,
  requestedBy: { adminAccountId: r.requestedBy, displayName: null, role: r.requesterRole },
  requestedAt: r.createdAt.toISOString(),
  canApprove: (r.status === 'PENDING_APPROVAL' || r.status === 'FAILED' || r.status === 'EXECUTING') && r.requestedBy !== actor.accountId && actor.role === 'commander',
  dueAt: null,
  closeReason: r.status === 'REJECTED' || r.status === 'FAILED' ? r.closeReason : null,
  contractTerms: null,
});

/** payment-svc가 대조할 사실(ADR-0368 결정 8). 근거 메모·요청자 역할·계좌는 싣지 않는다 */
export interface SettlementAdjustmentApprovalFacts {
  approvalId: string;
  kind: 'SETTLEMENT_ADJUSTMENT';
  targetRef: string;
  amount: number;
  reasonCode: string;
  status: SettlementAdjustmentApprovalStatus;
  requiredApprovals: 2;
  requestedBy: string;
  approvals: string[];
  approvedAt: string | null;
}

export const settlementAdjustmentApprovalFacts = (r: SettlementAdjustmentApprovalRecord): SettlementAdjustmentApprovalFacts => ({
  approvalId: r.approvalId,
  kind: 'SETTLEMENT_ADJUSTMENT',
  targetRef: r.statementId,
  amount: r.amount,
  reasonCode: r.reasonCode,
  status: r.status,
  requiredApprovals: 2,
  requestedBy: r.requestedBy,
  approvals: [...r.approvals],
  approvedAt: r.approvedAt?.toISOString() ?? null,
});

/** 조정 승인 상세·목록은 요청자와 commander만 본다(그 밖 404, 계약 승인과 같다) */
export const canSeeSettlementAdjustmentApproval = (r: SettlementAdjustmentApprovalRecord, actor: OpsActor): boolean => r.requestedBy === actor.accountId || actor.role === 'commander';

/**
 * 판정 자격: 승인 대기·실패·적용 중이고, 요청자가 아닌 commander. 실패·적용 중은 적용이 payment에 이미 커밋됐을 수 있어
 * 승인은 적용만 다시 부르고, 반려는 payment void를 먼저 부른다(settlement §4.3 '승인', 리뷰 RV-04)
 */
export function assertCanDecideAdjustment(r: SettlementAdjustmentApprovalRecord, actor: OpsActor, action: 'approve' | 'reject'): void {
  void action;
  if (r.status !== 'PENDING_APPROVAL' && r.status !== 'FAILED' && r.status !== 'EXECUTING') {
    throw new ContractApprovalProblem('approval-not-pending', 409, '승인 대기 중인 조정이 아닙니다');
  }
  if (r.requestedBy === actor.accountId) throw new ContractApprovalProblem('approval-self-not-allowed', 403, `요청자는 ${action === 'approve' ? '승인' : '반려'}할 수 없습니다`);
  if (actor.role !== 'commander') throw new ContractApprovalProblem('approval-role-required', 403, 'commander만 정산서 조정을 판정할 수 있습니다');
}
