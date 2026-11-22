// 정산서 수기 조정의 규칙(docs/features/settlement.md §4.3 '수기 조정의 구현 규칙', ADR-0368 결정 7·8·9, POL-038 ⑦).
// 조정 행은 payment가, 2인 승인은 ops-svc 공통 승인 표가 갖는다. 검사(사유 코드·이의 대조·상태)는 정산서를 가진 이쪽이 한다.
import { payoutAmountOf, SettlementProblem, type DisputeReasonCode, type DisputeRecord, type StatementRecord, type StatementStatus } from './settlement.js';

/** 이의를 받아들인 조정의 코드(그 이의와 같은 코드) */
export const DISPUTE_ADJUSTMENT_CODES: readonly DisputeReasonCode[] = ['GROSS_AMOUNT', 'REFUND_AMOUNT', 'COMMISSION', 'OFFSET', 'OTHER'];
/** 이의 없는 조정의 코드(근거 메모 필수) */
export const NON_DISPUTE_ADJUSTMENT_CODES = ['LEDGER_ERROR', 'CONTRACT_CORRECTION', 'AGREED_DEDUCTION'] as const;
export type NonDisputeAdjustmentCode = (typeof NON_DISPUTE_ADJUSTMENT_CODES)[number];
export type AdjustmentReasonCode = DisputeReasonCode | NonDisputeAdjustmentCode;
export const ADJUSTMENT_REASON_CODES: readonly AdjustmentReasonCode[] = [...DISPUTE_ADJUSTMENT_CODES, ...NON_DISPUTE_ADJUSTMENT_CODES];

export type AdjustmentStatus = 'PENDING' | 'APPLIED' | 'VOID';

/** 조정할 수 있는 정산서 상태(§4.3). HELD는 보류가 풀린 뒤 조정한다 [가정] */
export const ADJUSTABLE_STATUSES: readonly StatementStatus[] = ['NOTIFIED', 'DISPUTED', 'CONFIRMED'];

/** 승인되지 않은 조정 행을 닫는 기한(7일 [가정], §4.3 '요청') */
export const ADJUSTMENT_PENDING_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export const EVIDENCE_NOTE_MAX = 2_000;

export interface AdjustmentRecord {
  adjustmentId: string;
  statementId: string;
  /** ops-svc 승인 업무 ID(유일). 같은 승인 ID 재요청은 이 행을 그대로 돌려준다 */
  approvalId: string;
  reasonCode: AdjustmentReasonCode;
  /** 이의 인정 조정이면 그 이의 ID */
  disputeId: string | null;
  /** 0이 아닌 정수 원. +는 지급 늘림, −는 줄임 */
  amount: number;
  evidenceNote: string | null;
  status: AdjustmentStatus;
  requestedBy: string;
  requestedAt: Date;
  appliedAt: Date | null;
}

export interface AdjustmentRequest {
  approvalId: string;
  amount: number;
  reasonCode: string;
  disputeId?: string | undefined;
  evidenceNote?: string | undefined;
  requestedBy: string;
}

export const isDisputeAdjustmentCode = (code: string): code is DisputeReasonCode => (DISPUTE_ADJUSTMENT_CODES as readonly string[]).includes(code);

/** 정산서 상태가 조정을 받는가. 아니면 409 settlement-adjustment-not-allowed(요청·적용이 같다) */
export function assertAdjustable(status: StatementStatus): void {
  if (!ADJUSTABLE_STATUSES.includes(status)) throw new SettlementProblem('settlement-adjustment-not-allowed', 409, '지금 상태의 정산서는 조정할 수 없습니다');
}

/**
 * 조정 요청 검사(§4.3 '검사'). 차례: 코드(400) → 금액·근거 메모 모양(422) → 상태(409) → 이의 대조(422).
 * 이의 코드 다섯은 그 정산서의 열린 이의와 ID·코드가 같고 정산서가 DISPUTED일 때만 받는다.
 * 이의 없는 코드는 이의 ID를 붙이지 않고, 열린 이의가 있는 정산서(DISPUTED)에는 쓰지 않는다(그 이의는 기각이나 이의 인정 조정으로 닫는다).
 */
export function validateAdjustment(req: AdjustmentRequest, statement: StatementRecord, disputes: readonly DisputeRecord[]): asserts req is AdjustmentRequest & { reasonCode: AdjustmentReasonCode } {
  if (!(ADJUSTMENT_REASON_CODES as readonly string[]).includes(req.reasonCode)) throw new SettlementProblem('invalid-query', 400, '조정 사유 코드가 맞지 않습니다');
  if (!Number.isSafeInteger(req.amount) || req.amount === 0) throw new SettlementProblem('invalid-query', 422, '조정 금액은 0이 아닌 정수 원이어야 합니다');
  const note = req.evidenceNote;
  if (note !== undefined && note.length > EVIDENCE_NOTE_MAX) throw new SettlementProblem('invalid-query', 422, '근거 메모는 2,000자까지입니다');
  const needsNote = req.reasonCode === 'OTHER' || !isDisputeAdjustmentCode(req.reasonCode);
  if (needsNote && (note === undefined || note.trim() === '')) throw new SettlementProblem('invalid-query', 422, '이 사유 코드는 근거 메모가 필요합니다');
  assertAdjustable(statement.status);
  if (isDisputeAdjustmentCode(req.reasonCode)) {
    if (!req.disputeId) throw new SettlementProblem('settlement-adjustment-dispute-mismatch', 422, '이의 인정 조정에는 이의 ID가 필요합니다');
    if (statement.status !== 'DISPUTED') throw new SettlementProblem('settlement-adjustment-dispute-mismatch', 422, '이의 중인 정산서가 아닙니다');
    const open = disputes.find((d) => d.disputeId === req.disputeId && d.statementId === statement.statementId && d.result === null);
    if (!open) throw new SettlementProblem('settlement-adjustment-dispute-mismatch', 422, '그 정산서의 열린 이의가 아닙니다');
    if (open.reasonCode !== req.reasonCode) throw new SettlementProblem('settlement-adjustment-dispute-mismatch', 422, '이의의 사유 코드와 조정 사유 코드가 다릅니다');
    return;
  }
  if (req.disputeId !== undefined) throw new SettlementProblem('settlement-adjustment-dispute-mismatch', 422, '이의 없는 조정에는 이의 ID를 붙이지 않습니다');
  if (statement.status === 'DISPUTED') throw new SettlementProblem('settlement-adjustment-dispute-mismatch', 422, '이의 중인 정산서는 이의 인정 조정이나 기각으로 처리합니다');
}

/** 조정 합계를 반영한 지급액(§4.3 '적용'). 지급액 식 하나(payoutAmountOf)를 그대로 쓴다. 0 아래일 수 있다 */
export const payoutWithAdjustment = (s: Pick<StatementRecord, 'grossAmount' | 'refundAmount' | 'commissionAmount' | 'commissionVat' | 'offsetAmount'>, adjustmentAmount: number): number =>
  payoutAmountOf({ ...s, adjustmentAmount });

export const adjustmentView = (a: AdjustmentRecord) => ({
  adjustmentId: a.adjustmentId,
  statementId: a.statementId,
  approvalId: a.approvalId,
  reasonCode: a.reasonCode,
  disputeId: a.disputeId,
  amount: a.amount,
  status: a.status,
  requestedBy: a.requestedBy,
  requestedAt: a.requestedAt.toISOString(),
  appliedAt: a.appliedAt?.toISOString() ?? null,
});
export type AdjustmentView = ReturnType<typeof adjustmentView>;

/** 같은 승인 ID 재요청이 처음 요청과 같은가(다르면 409, 승인 ID를 다른 조정에 다시 쓰지 않는다) */
export const sameAdjustmentRequest = (a: AdjustmentRecord, statementId: string, req: AdjustmentRequest): boolean =>
  a.statementId === statementId && a.amount === req.amount && a.reasonCode === req.reasonCode && (a.disputeId ?? undefined) === (req.disputeId ?? undefined) && a.requestedBy === req.requestedBy;
