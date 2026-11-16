// 부정 예매 운영자 취소의 값·규칙(fraud_cancellation.proto, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부', POL-032·POL-046, ADR-0171·ADR-0197, BUILD_ORDER GAT-080).
// 프레임워크·저장소를 모른다.
import { createHash } from 'node:crypto';

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

/** 요청자·승인자 길이 상한 128자 [가정](fraud_cancellation.proto requested_by·approved_by) */
export const FRAUD_CANCEL_ACTOR_MAX = 128;
/** 마감 뒤 다시 부르기에서도 나머지 단계를 마치는 실패: ticket-svc가 이미 키를 폐기하고 환급 상태로 바꾼 뒤에 난 실패(BAT-415 계획 §10 ⑤) */
export const FRAUD_AFTER_TICKET_FAILURES: ReadonlySet<FraudFailureCode> = new Set(['SEAT_RETURN_FAILED', 'CANCELLATION_CONFLICT', 'ORDER_STATE']);

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** sha256(`FraudCancel:${approvalId}:${ticketId}`) 앞 16바이트를 UUID 버전 8 모양으로 만든 취소 ID */
export function fraudCancellationId(approvalId: string, ticketId: string): string {
  const b = Buffer.from(createHash('sha256').update(`FraudCancel:${approvalId}:${ticketId}`).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 처음 부를 때의 취소 마감 = saleEndsAtMs − 2시간 */
export function fraudCancelDeadlineMs(saleEndsAtMs: number): number {
  return saleEndsAtMs - FRAUD_CANCEL_RESALE_PREP_MS;
}

/** (사건 ID, 회차, 표 ID 순으로 늘어놓은 대상과 기대 보유자)의 SHA-256 hex */
export function fraudTargetsFingerprint(fraudCaseId: string, eventId: string, targets: readonly FraudCancelTarget[]): string {
  const lines = [...targets].sort((a, b) => (a.ticketId < b.ticketId ? -1 : a.ticketId > b.ticketId ? 1 : 0)).map((t) => `${t.ticketId}:${t.expectedHolderAccountId}`);
  return createHash('sha256').update([fraudCaseId, eventId, ...lines].join('|')).digest('hex');
}

const invalid = (message: string): FraudCancellationError => new FraudCancellationError('INVALID', message);
const lowerUuid = (name: string, v: unknown): string => {
  if (typeof v !== 'string' || !LOWER_UUID.test(v)) throw invalid(`${name}는 소문자 UUID여야 한다`);
  return v;
};
const actor = (name: string, v: unknown): string => {
  if (typeof v !== 'string' || v.trim().length === 0 || [...v].length > FRAUD_CANCEL_ACTOR_MAX) throw invalid(`${name}는 1~${FRAUD_CANCEL_ACTOR_MAX}자여야 한다`);
  return v;
};

/** 입력 검사(소문자 UUID, 대상 1~500, 같은 표 두 번 금지, requested_by·approved_by 1~128자·서로 다름). @throws FraudCancellationError('INVALID') */
export function parseCancelFraudTickets(i: CancelFraudTicketsInput): CancelFraudTicketsInput {
  const approvalId = lowerUuid('approval_id', i.approvalId);
  const fraudCaseId = lowerUuid('fraud_case_id', i.fraudCaseId);
  const eventId = lowerUuid('event_id', i.eventId);
  if (!Array.isArray(i.targets) || i.targets.length < 1 || i.targets.length > FRAUD_CANCEL_MAX_TARGETS) throw invalid(`대상은 1~${FRAUD_CANCEL_MAX_TARGETS}장이어야 한다`);
  const seen = new Set<string>();
  const targets = i.targets.map((t) => {
    const ticketId = lowerUuid('ticket_id', t.ticketId);
    const expectedHolderAccountId = lowerUuid('expected_holder_account_id', t.expectedHolderAccountId);
    if (seen.has(ticketId)) throw invalid('같은 표를 두 번 줄 수 없다');
    seen.add(ticketId);
    return { ticketId, expectedHolderAccountId };
  });
  const requestedBy = actor('requested_by', i.requestedBy);
  const approvedBy = actor('approved_by', i.approvedBy);
  if (requestedBy === approvedBy) throw invalid('요청자와 승인자는 달라야 한다');
  if (i.approvedAtMs !== undefined && !Number.isFinite(i.approvedAtMs)) throw invalid('approved_at이 올바르지 않다');
  if (!Number.isFinite(i.nowMs) || !Number.isFinite(i.deadlineMs)) throw invalid('시각이 올바르지 않다');
  return { approvalId, fraudCaseId, eventId, targets, requestedBy, approvedBy, ...(i.approvedAtMs !== undefined ? { approvedAtMs: i.approvedAtMs } : {}), nowMs: i.nowMs, deadlineMs: i.deadlineMs };
}
