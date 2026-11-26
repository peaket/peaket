// 지급 묶음 승인 업무(BUILD_ORDER BAT-610 잔여, FR-062, POL-038·039, settlement §5.1).
// 2인 승인: 요청자(operator)와 승인자(commander)가 달라야 하고, 승인자는 재인증(act APPROVAL)을 거친다.
export type PayoutApprovalStatus = 'PENDING_APPROVAL' | 'APPROVED' | 'REJECTED' | 'EXECUTING' | 'DONE' | 'FAILED' | 'EXPIRED';

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
  /** payment-svc가 묶음을 만들 때 계산한 지급 대상 지문(F-06-3). 옛 행은 없을 수 있다 */
  payeeDigest?: string | null;
  /** 만료 때 파트너에게 알릴 판매자(지급 묶음의 정산서에서 읽는다, IR-19) */
  promoterIds?: readonly string[];
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
  payeeDigest?: string | undefined;
  approvalId?: string;
  portoneBulkPayoutId?: string;
}

/** SCR-049 상세(openapi OpsPayoutBatchDetail). payment-svc 내부 묶음 상세를 그대로 중계한다. */
export interface PayoutBatchDetailView {
  batch: PayoutBatchView;
  statements: readonly Record<string, unknown>[];
  payouts: readonly Record<string, unknown>[];
  holds: readonly Record<string, unknown>[];
  kycNotices: readonly { promoterId: string; sellerStatus: string; from: string; to: string; amount: number; threshold: number; notice: boolean }[];
}

export interface PayoutApprovalView {
  approvalId: string;
  kind: 'PAYOUT_BATCH';
  targetRef: string;
  amount: number;
  reasonCode: 'PAYOUT_BATCH';
  reasonText: string;
  payeeDigest: string | null;
  status: PayoutApprovalStatus;
  requiredApprovals: 2;
  approvals: string[];
  requestedBy: { adminAccountId: string; displayName: string | null; role: string };
  requestedAt: string;
  canApprove: boolean;
  dueAt: string | null;
  closeReason: string | null;
}

/** payment-svc가 승인 기록과 지급 묶음을 대조할 때 쓰는 내부 사실(BAT-625). 사유 글·계좌·내부 토큰은 싣지 않는다. */
export interface PayoutApprovalFacts {
  approvalId: string;
  kind: 'PAYOUT_BATCH';
  targetRef: string;
  batchId: string;
  pg: 'TOSS' | 'PORTONE';
  pgStore: 'STANDARD' | 'ESCROW';
  payoutDate: string;
  currency: 'KRW';
  amount: number;
  statementCount: number;
  status: PayoutApprovalStatus;
  payeeDigest: string | null;
  requiredApprovals: 2;
  requestedBy: string;
  approvals: string[];
  approvedAt: string | null;
}

export const payoutApprovalFacts = (r: PayoutApprovalRecord): PayoutApprovalFacts => ({
  approvalId: r.approvalId,
  kind: 'PAYOUT_BATCH',
  targetRef: r.batchId,
  batchId: r.batchId,
  pg: r.pg,
  pgStore: r.pgStore,
  payoutDate: r.payoutDate,
  currency: 'KRW',
  amount: r.amount,
  statementCount: r.statementCount,
  status: r.status,
  payeeDigest: r.payeeDigest ?? null,
  requiredApprovals: 2,
  requestedBy: r.requesterId,
  approvals: r.approverId ? [r.approverId] : [],
  approvedAt: r.approvedAt?.toISOString() ?? null,
});

export const payoutApprovalView = (r: PayoutApprovalRecord, actor: { accountId: string; role: string }): PayoutApprovalView => ({
  approvalId: r.approvalId,
  kind: 'PAYOUT_BATCH',
  targetRef: r.batchId,
  amount: r.amount,
  reasonCode: 'PAYOUT_BATCH',
  reasonText: r.reasonText,
  payeeDigest: r.payeeDigest ?? null,
  status: r.status,
  requiredApprovals: 2,
  approvals: r.approverId ? [r.approverId] : [],
  requestedBy: { adminAccountId: r.requesterId, displayName: null, role: r.requesterRole },
  requestedAt: r.createdAt.toISOString(),
  canApprove: r.status === 'PENDING_APPROVAL' || r.status === 'FAILED' ? r.requesterId !== actor.accountId && actor.role === 'commander' : false,
  dueAt: approvalDueAt(r.payoutDate).toISOString(),
  closeReason: r.status === 'REJECTED' ? r.reasonText : r.status === 'EXPIRED' ? (r.failure ?? 'DEADLINE_PASSED') : r.failure,
});

/**
 * 지급일 전 영업일 15시까지 승인하지 않으면 다음 영업일로 미룬다(settlement §5.1). 그 시각을 KST로 계산한다.
 * 토·일은 건너뛰고, 토·일이 지급일이면 직전 금요일 15시다.
 */
export function approvalDueAt(payoutDate: string): Date {
  const [y, m, d] = payoutDate.split('-').map(Number);
  const base = new Date(Date.UTC(y!, m! - 1, d!));
  do {
    base.setUTCDate(base.getUTCDate() - 1);
  } while (base.getUTCDay() === 0 || base.getUTCDay() === 6);
  const yyyy = base.getUTCFullYear();
  const mm = String(base.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(base.getUTCDate()).padStart(2, '0');
  return new Date(`${yyyy}-${mm}-${dd}T15:00:00+09:00`);
}

/**
 * 지급일 다음 은행 영업일(토·일만 뺀다). 15시 만료 뒤 파트너에게 알리는 새 지급일이다(F-06-3).
 */
export function nextBusinessDayOf(payoutDate: string): string {
  const [y, m, d] = payoutDate.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d!));
  do {
    at.setUTCDate(at.getUTCDate() + 1);
  } while (at.getUTCDay() === 0 || at.getUTCDay() === 6);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}

/**
 * CS 역할에게 보이는 정산서 칸(openapi CsCaseDetail.statementDispute와 같은 칸, settlement §4.2 '기각'·§9, F-07-5 리뷰 RV-03).
 * 결제사(pg·결제 상점)·결제사 내부 ID·정산 계좌·묶음·대사 제외 결제는 싣지 않는다. payment 응답에 칸이 더 있어도 이 칸만 고른다.
 */
export interface StatementDisputeView {
  statementId: string;
  kind: string;
  eventId: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  grossAmount: number;
  refundAmount: number;
  commissionAmount: number;
  commissionVat: number;
  offsetAmount: number;
  payoutAmount: number;
  status: string;
  disputeDueAt: string | null;
}

export function statementDisputeView(raw: unknown): StatementDisputeView {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof r[k] === 'string' ? (r[k] as string) : '');
  const strOrNull = (k: string): string | null => (typeof r[k] === 'string' ? (r[k] as string) : null);
  const num = (k: string): number => (typeof r[k] === 'number' ? (r[k] as number) : 0);
  return {
    statementId: str('statementId'),
    kind: str('kind'),
    eventId: strOrNull('eventId'),
    periodStart: strOrNull('periodStart'),
    periodEnd: strOrNull('periodEnd'),
    grossAmount: num('grossAmount'),
    refundAmount: num('refundAmount'),
    commissionAmount: num('commissionAmount'),
    commissionVat: num('commissionVat'),
    offsetAmount: num('offsetAmount'),
    payoutAmount: num('payoutAmount'),
    status: str('status'),
    disputeDueAt: strOrNull('disputeDueAt'),
  };
}
