// 부정 예매 운영자 취소의 값·규칙(fraud_cancellation.proto, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부', POL-032·POL-046, ADR-0171·ADR-0197, BUILD_ORDER GAT-080).
// BAT-415 시험 담당의 빈 뼈대다. 함수의 동작은 구현 담당이 채운다.

/** 한 승인 업무의 대상 표 상한 500장 [가정] */
export const FRAUD_CANCEL_MAX_TARGETS = 500;
/** 취소 마감 = 판매 종료 − 2시간 [가정](= 공연 시작 − 26시간) */
export const FRAUD_CANCEL_RESALE_PREP_MS = 7_200_000;
export const FRAUD_TICKET_OUTCOMES = ['ACCEPTED', 'SKIPPED_ALREADY_ENDED', 'SKIPPED_ENTRY_STARTED', 'SKIPPED_HOLDER_CHANGED', 'FAILED'] as const;
export type FraudTicketOutcome = (typeof FRAUD_TICKET_OUTCOMES)[number];
export const FRAUD_FAILURE_CODES = ['TICKET_UNAVAILABLE', 'SEAT_RETURN_FAILED', 'CANCELLATION_CONFLICT', 'ORDER_STATE', 'INTERNAL'] as const;
export type FraudFailureCode = (typeof FRAUD_FAILURE_CODES)[number];

export interface FraudCancelTarget {
  readonly ticketId: string;
  readonly expectedHolderAccountId: string;
}

export interface CancelFraudTicketsInput {
  readonly approvalId: string;
  readonly fraudCaseId: string;
  readonly eventId: string;
  readonly targets: readonly FraudCancelTarget[];
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly approvedAtMs?: number;
  readonly nowMs: number;
  readonly deadlineMs: number;
}

export interface FraudTicketResult {
  readonly ticketId: string;
  readonly outcome: FraudTicketOutcome;
  /** ACCEPTED만 */
  readonly cancellationId?: string;
  /** ACCEPTED만(공제 없음 = 권면 금액) */
  readonly refundAmount?: number;
  readonly withdrawnTransferOfferId?: string;
  /** FAILED만 */
  readonly failureCode?: FraudFailureCode;
}

export type FraudRefundState = 'PENDING' | 'REFUNDED' | 'NEEDS_CS';

export interface FraudRefundProgress {
  readonly ticketId: string;
  readonly cancellationId: string;
  readonly state: FraudRefundState;
  readonly refundedAtMs?: number;
}

/** INVALID → INVALID_ARGUMENT, ALREADY_EXISTS → ALREADY_EXISTS, DEADLINE_PASSED → FAILED_PRECONDITION, NOT_FOUND → NOT_FOUND */
export class FraudCancellationError extends Error {
  constructor(
    readonly code: 'INVALID' | 'ALREADY_EXISTS' | 'DEADLINE_PASSED' | 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'FraudCancellationError';
  }
}

/** sha256(`FraudCancel:${approvalId}:${ticketId}`) 앞 16바이트를 UUID 버전 8 모양으로 만든 취소 ID */
export function fraudCancellationId(_approvalId: string, _ticketId: string): string {
  throw new Error('아직 없음');
}

/** 처음 부를 때의 취소 마감 = saleEndsAtMs − 2시간 */
export function fraudCancelDeadlineMs(_saleEndsAtMs: number): number {
  throw new Error('아직 없음');
}

/** (사건 ID, 회차, 표 ID 순으로 늘어놓은 대상과 기대 보유자)의 SHA-256 hex */
export function fraudTargetsFingerprint(_fraudCaseId: string, _eventId: string, _targets: readonly FraudCancelTarget[]): string {
  throw new Error('아직 없음');
}

/** 입력 검사(소문자 UUID, 대상 1~500, 같은 표 두 번 금지, requested_by·approved_by 1~128자·서로 다름). @throws FraudCancellationError('INVALID') */
export function parseCancelFraudTickets(_i: CancelFraudTicketsInput): CancelFraudTicketsInput {
  throw new Error('아직 없음');
}
