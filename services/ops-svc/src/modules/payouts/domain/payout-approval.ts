// 지급 묶음 승인 업무(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·039, settlement §5.1).
// 2인 승인: 요청자(operator)와 승인자(commander)가 달라야 하고, 승인자는 재인증(act APPROVAL)을 거친다.
export type PayoutApprovalStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'DONE' | 'FAILED';

export class PayoutApprovalProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'PayoutApprovalProblem';
  }
}

export interface PayoutApprovalRecord {
  approvalId: string;
  batchId: string;
  pg: 'TOSS' | 'PORTONE';
  pgStore: 'STANDARD' | 'ESCROW';
  payoutDate: string;
  amount: number;
  statementCount: number;
  status: PayoutApprovalStatus;
  requesterId: string;
  requesterRole: string;
  approverId: string | null;
  reasonText: string;
  failure: string | null;
  createdAt: Date;
  updatedAt: Date;
  approvedAt: Date | null;
  executedAt: Date | null;
  version: number;
}

export interface PayoutBatchView {
  batchId: string;
  pg: 'TOSS' | 'PORTONE';
  pgStore: 'STANDARD' | 'ESCROW';
  payoutDate: string;
  totalAmount: number;
  statementCount: number;
  status: string;
  approvalId?: string;
  portoneBulkPayoutId?: string;
}

export interface PayoutApprovalView {
  approvalId: string;
  kind: 'PAYOUT_BATCH';
  targetRef: string;
  amount: number;
  reasonCode: 'PAYOUT_BATCH';
  reasonText: string;
  status: PayoutApprovalStatus;
  requiredApprovals: 2;
  approvals: string[];
  requestedBy: { adminAccountId: string; displayName: string | null; role: string };
  requestedAt: string;
  canApprove: boolean;
  dueAt: string | null;
  closeReason: string | null;
}

export const payoutApprovalView = (r: PayoutApprovalRecord, actor: { accountId: string; role: string }): PayoutApprovalView => ({
  approvalId: r.approvalId,
  kind: 'PAYOUT_BATCH',
  targetRef: r.batchId,
  amount: r.amount,
  reasonCode: 'PAYOUT_BATCH',
  reasonText: r.reasonText,
  status: r.status,
  requiredApprovals: 2,
  approvals: r.approverId ? [r.approverId] : [],
  requestedBy: { adminAccountId: r.requesterId, displayName: null, role: r.requesterRole },
  requestedAt: r.createdAt.toISOString(),
  canApprove: r.status === 'PENDING_APPROVAL' || r.status === 'FAILED' ? r.requesterId !== actor.accountId && actor.role === 'commander' : false,
  dueAt: approvalDueAt(r.payoutDate).toISOString(),
  closeReason: r.status === 'REJECTED' ? r.reasonText : r.failure,
});

/** 지급일 전 영업일 15시까지 승인하지 않으면 다음 영업일로 미룬다(settlement §5.1). 그 시각을 KST로 계산한다. */
export function approvalDueAt(payoutDate: string): Date {
  const d = new Date(`${payoutDate}T00:00:00+09:00`);
  return new Date(d.getTime() - 24 * 60 * 60 * 1000 + 15 * 60 * 60 * 1000);
}
