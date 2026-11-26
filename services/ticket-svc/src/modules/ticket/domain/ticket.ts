// 티켓 발권·취소·월렛 목록의 순수 규칙(BUILD_ORDER HOT-160, docs/features/payment.md §2·§4.1).
// 저장소·gRPC와 분리해 시험한다. 티켓 키는 발권 응답에만 싣고 DB에는 SHA-256만 둔다.
import { createHash, randomBytes } from 'node:crypto';

/** 티켓 상태. docs/planning/03 §2.5와 docs/data.md `ticket.status`의 값. 이 최소 구현은 ISSUED·ACTIVE·REFUNDED·VOIDED만 쓰고, 나머지는 뒤 모듈이 채운다. */
export type TicketStatus = 'ISSUED' | 'ACTIVE' | 'TRANSFER_PENDING' | 'CANCEL_REQUESTED' | 'REFUNDED' | 'FLAGGED' | 'VOIDED';

/** 한 번에 발권하는 좌석 수 상한(1인당 매수 상한 4의 두 배, 방어적 상한) */
export const MAX_TICKETS_PER_ISSUE = 10;
/** 월렛 목록 한 쪽 기본·최대 */
export const DEFAULT_WALLET_LIMIT = 20;
export const MAX_WALLET_LIMIT = 100;

export interface IssueTicketsInput {
  readonly orderId: string;
  readonly eventId: string;
  readonly payerAccountId: string;
  readonly seatIds: readonly string[];
  readonly issueGeneration: number;
  /** 회차 시작 시각(epoch ms). 없으면 취소는 입장 전으로 본다. */
  readonly eventStartsAtMs?: number;
}

export interface TicketRecord {
  readonly ticketId: string;
  readonly accountId: string;
  readonly payerAccountId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly seatId: string;
  /** 좌석 배치의 게이트 구역. 최소 구현은 빈 값이다(좌석 배치 연결은 후속). */
  readonly gateZone: string;
  readonly status: TicketStatus;
  readonly issueGeneration: number;
  /** 스캐너가 읽는 공개 포인터(PEAKET1:<ticket_id>) */
  readonly qrPayload: string;
  /** 티켓 키의 SHA-256(hex). 원문은 발권 응답에만 있다. */
  readonly keyHash: string;
  /** 발권 응답에만 붙는 키 원문. 저장소에서 다시 읽은 기록에는 없다. */
  readonly ticketKey?: string;
  readonly keyRevokedAtMs?: number;
  /** 양도 요청이 진행 중이면 취소를 거절하는 자리(양도 모듈은 후속). */
  readonly transferPending: boolean;
  /** 부정 예매 양도 잠금 사건 ID 자리(후속). */
  readonly fraudLockCaseId?: string;
  /** 그 사건이 이 표에 적은 판(ADR-0171). 같은 사건의 더 큰 판만 반영한다 */
  readonly fraudLockVersion?: number;
  readonly version: number;
  readonly issuedAtMs: number;
  readonly eventStartsAtMs?: number;
}

/** 양도 회수 결과(F-06-3, transfer-refund §3.1·§7.2, POL-038 ③). 조건이 맞지 않으면 값으로 돌려준다. */
export type TransferReclaimResult = 'RECLAIMED' | 'SKIPPED_ENTRY_STARTED' | 'SKIPPED_ENTRY_RECORDED' | 'SKIPPED_NOT_TRANSFERRED' | 'SKIPPED_HOLDER_CHANGED';

export interface TransferReclaimOutcome {
  readonly result: TransferReclaimResult;
  readonly ticketId: string;
  readonly previousHolderAccountId?: string;
}

export type TicketReclaimErrorCode = 'ALREADY_EXISTS' | 'FAILED_PRECONDITION' | 'INVALID_ARGUMENT' | 'NOT_FOUND';
export class TicketReclaimError extends Error {
  constructor(
    readonly code: TicketReclaimErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'TicketReclaimError';
  }
}

export interface IssueTicketsResult {
  readonly tickets: readonly TicketRecord[];
  /** 같은 주문·세대의 재요청이면 true. 이때 ticketKey는 비어 있다. */
  readonly replayed: boolean;
}

// ---- 주문 단위 발권 막기(ticket.proto BlockTicketIssuance, BAT-011 HOT-161·PRF-173, ADR-0354 결정 2) ----

/** 발권을 막는 사유의 길이 상한 200자 [가정](ticket.proto BlockTicketIssuanceRequest.reason) */
export const MAX_BLOCK_REASON_LENGTH = 200;

export interface BlockTicketIssuanceInput {
  /** 막을 주문(소문자 UUID) */
  readonly orderId: string;
  /** 막는 사유(감사·로그용). 비워도 된다 */
  readonly reason?: string;
  /** 무효로 하는 시각(주입한 시계, 유닉스 밀리초). 없으면 gRPC 처리기가 서버 시계를 넣는다 */
  readonly nowMs?: number;
}

/** 검사를 지나 시각이 정해진 발권 막기 입력(저장소가 받는다) */
export interface NormalizedBlockTicketIssuanceInput extends BlockTicketIssuanceInput {
  readonly nowMs: number;
}

export interface BlockTicketIssuanceResult {
  /** 이번 호출로 무효가 된 티켓 수. 다시 부르면 0이다 */
  readonly voided: number;
  /** 그 주문의 티켓 가운데 입장 기록(IN·PASS)이 있는 수. 다시 불러도 같은 값이다 */
  readonly alreadyEntered: number;
}

/**
 * 주문의 발권을 막는다. 소문자 UUID·사유 200자 이하만 받는다(대문자 UUID는 고쳐 받지 않고 거절한다).
 * @throws TicketInputError orderId가 소문자 UUID가 아님, 사유가 너무 김, 시각이 올바르지 않음
 */
export function normalizeBlockIssueInput(i: BlockTicketIssuanceInput): NormalizedBlockTicketIssuanceInput {
  const orderId = requireLowerUuid('orderId', i.orderId);
  if (typeof i.nowMs !== 'number' || !Number.isFinite(i.nowMs) || i.nowMs < 0) throw new TicketInputError('nowMs가 올바르지 않다');
  if (i.reason !== undefined && (typeof i.reason !== 'string' || i.reason.length > MAX_BLOCK_REASON_LENGTH)) throw new TicketInputError(`reason은 ${MAX_BLOCK_REASON_LENGTH}자 이하여야 한다`);
  const reason = i.reason?.trim();
  return { orderId, nowMs: i.nowMs, ...(reason ? { reason } : {}) };
}

export type CancelTicketResult = 'REFUND_NOW' | 'REFUND_AFTER_CLOSE' | 'NOT_PAYER_HOLDER' | 'TRANSFER_PENDING' | 'EVENT_STARTED' | 'ALREADY_CANCELLED';

export interface CancelTicketsInput {
  readonly orderId: string;
  readonly ticketIds: readonly string[];
  readonly requestedByAccountId: string;
  readonly cancellationId: string;
  readonly nowMs: number;
  /**
   * 아무 행도 바꾸지 않는 확인(ticket.proto CancelTicketsRequest.replay_only, 리뷰 B2 보충, docs/features/payment.md §4.1 '공연이 시작된 뒤 다시 누른 경우').
   * 참이면 티켓 행·취소 기록을 바꾸지 않고, 끝난 표는 ALREADY_CANCELLED(팬 취소 기록이 있으면 첫 칸), 유효한 표는 EVENT_STARTED다
   */
  readonly replayOnly?: boolean;
  /**
   * 취소 사유(ticket.proto CancelTicketsRequest.reason, 다시 보기 R1). 처음 커밋하는 기록에 남기고, 첫 팬 취소 칸은 사유 USER인 기록만 싣는다.
   * 비면 사유 없는 기록, 목록 밖이면 TicketInputError
   */
  readonly reason?: string;
}

export interface CancelTicketOutcome {
  readonly ticketId: string;
  readonly result: CancelTicketResult;
  /**
   * result가 ALREADY_CANCELLED이고 그 표를 먼저 취소한 팬 취소(ticket_cancellation의 REFUND_NOW·REFUND_AFTER_CLOSE, 가장 이른 것)가 있을 때만(리뷰 B2,
   * docs/features/payment.md §4.1 '앞 시도가 티켓 단계만 마친 팬 취소 잇기'). 운영자 취소·무효로 끝난 표는 없다
   */
  readonly first?: { readonly cancellationId: string; readonly result: 'REFUND_NOW' | 'REFUND_AFTER_CLOSE'; readonly cancelledAtMs: number };
}

// ---- 부정 예매 운영자 취소(ticket.proto OperatorCancelTickets, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부', BUILD_ORDER GAT-080, BAT-415 몫 F) ----

/** 한 번에 운영자 취소하는 표 상한 500장 [가정](fraud_cancellation.proto 대상 1~500) */
export const OPERATOR_CANCEL_MAX_TARGETS = 500;
export type OperatorCancelResult = 'CANCELED' | 'SKIPPED_ALREADY_ENDED' | 'SKIPPED_ENTRY_RECORDED' | 'SKIPPED_HOLDER_CHANGED';
export interface OperatorCancelTarget {
  readonly ticketId: string;
  readonly expectedHolderAccountId: string;
}
export interface OperatorCancelInput {
  readonly approvalId: string;
  readonly fraudCaseId: string;
  readonly eventId: string;
  readonly targets: readonly OperatorCancelTarget[];
  readonly nowMs: number;
}
export interface OperatorCancelOutcome {
  readonly ticketId: string;
  readonly result: OperatorCancelResult;
  readonly orderId: string;
  /** 시스템이 거둔 양도 요청 ID. 양도 요청 표가 생기기 전(GAT-050)에는 늘 없다 */
  readonly withdrawnTransferOfferId?: string;
}

/** 운영자 취소가 건너뛰는 이미 끝난 상태(docs/features/transfer-refund.md §7.4: 환급·무효·취소 접수·부정 표시) */
export const OPERATOR_CANCEL_ENDED_STATUSES: ReadonlySet<TicketStatus> = new Set(['REFUNDED', 'VOIDED', 'CANCEL_REQUESTED', 'FLAGGED']);

const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** 소문자 UUID만 받는다(대문자·앞뒤 공백을 고쳐 받지 않고 거절한다, 정본 '소문자 UUID') */
function requireLowerUuid(name: string, v: unknown): string {
  if (typeof v !== 'string' || !LOWER_UUID.test(v)) throw new TicketInputError(`${name}는 소문자 UUID여야 한다`);
  return v;
}

/** 소문자 UUID·대상 1~500·같은 표 두 번 금지. @throws TicketInputError */
export function normalizeOperatorCancelInput(i: OperatorCancelInput): OperatorCancelInput {
  const approvalId = requireLowerUuid('approvalId', i.approvalId);
  const fraudCaseId = requireLowerUuid('fraudCaseId', i.fraudCaseId);
  const eventId = requireLowerUuid('eventId', i.eventId);
  if (i.targets.length < 1 || i.targets.length > OPERATOR_CANCEL_MAX_TARGETS) throw new TicketInputError(`targets는 1~${OPERATOR_CANCEL_MAX_TARGETS}장이어야 한다`);
  const seen = new Set<string>();
  const targets = i.targets.map((t) => {
    const ticketId = requireLowerUuid('ticketId', t.ticketId);
    const expectedHolderAccountId = requireLowerUuid('expectedHolderAccountId', t.expectedHolderAccountId);
    if (seen.has(ticketId)) throw new TicketInputError('같은 표를 두 번 줄 수 없다');
    seen.add(ticketId);
    return { ticketId, expectedHolderAccountId };
  });
  if (!Number.isFinite(i.nowMs) || i.nowMs < 0) throw new TicketInputError('nowMs가 올바르지 않다');
  return { approvalId, fraudCaseId, eventId, targets, nowMs: i.nowMs };
}

/**
 * 운영자 취소에서 표 하나를 가른다(행 잠금 안, 차례: 이미 끝남 → 입장 기록 → 보유자). CANCELED면 부른 쪽이 키를 폐기하고 환급 상태로 바꾼다.
 * 결제자 = 보유자 검사는 하지 않는다(받은 사람이 가진 표도 취소한다)
 */
export function operatorCancelResultOf(t: Pick<TicketRecord, 'status' | 'accountId'>, entryRecorded: boolean, expectedHolderAccountId: string): OperatorCancelResult {
  if (OPERATOR_CANCEL_ENDED_STATUSES.has(t.status)) return 'SKIPPED_ALREADY_ENDED';
  if (entryRecorded) return 'SKIPPED_ENTRY_RECORDED';
  if (t.accountId !== expectedHolderAccountId) return 'SKIPPED_HOLDER_CHANGED';
  return 'CANCELED';
}

// ---- 회차 취소 표 끝내기(ticket.proto EventCancelTickets, BAT-420 GAT-110 E)·입장 기록 대조(GetEntryRecords, GAT-090 A) ----

/** 한 번에 회차 취소로 끝내는 표 상한 200장 [가정](ticket.proto EventCancelTicketsRequest) */
export const EVENT_CANCEL_MAX_TARGETS = 200;
/** 한 번에 입장 기록을 묻는 표 상한 100장 [가정](ticket.proto GetEntryRecordsRequest) */
export const ENTRY_RECORDS_MAX_TICKETS = 100;
export type EventCancelResult = 'CANCELED' | 'ALREADY_ENDED';
export interface EventCancelTarget {
  readonly ticketId: string;
  /** purchase-svc가 정한 취소 ID(ticket_cancellation의 멱등 키) */
  readonly cancellationId: string;
}
export interface EventCancelInput {
  readonly cancellationRequestId: string;
  readonly eventId: string;
  readonly targets: readonly EventCancelTarget[];
  readonly nowMs: number;
}
export interface EventCancelOutcome {
  readonly ticketId: string;
  readonly result: EventCancelResult;
  readonly orderId: string;
  /** 지금 보유자(결제자와 다를 수 있다) */
  readonly holderAccountId: string;
  /** 진행 중 양도 표시를 이번 호출이 껐는가 */
  readonly transferWithdrawn: boolean;
}
export interface EntryRecord {
  readonly ticketId: string;
  readonly found: boolean;
  /** 들어감(IN)·통과(PASS) 스캔이 하나라도 있는가 */
  readonly entered: boolean;
  /** entered일 때 가장 이른 들어감·통과 시각 */
  readonly firstEnteredAtMs?: number;
}

/** 회차 취소가 그대로 두는 이미 끝난 상태(환급·무효). 나머지 다섯(ISSUED·ACTIVE·TRANSFER_PENDING·CANCEL_REQUESTED·FLAGGED)은 끝낸다 */
export const EVENT_CANCEL_ENDED_STATUSES: ReadonlySet<TicketStatus> = new Set(['REFUNDED', 'VOIDED']);

/** 소문자 UUID, 대상 1~200, 같은 표 두 번 금지. @throws TicketInputError */
export function normalizeEventCancelInput(i: EventCancelInput): EventCancelInput {
  const cancellationRequestId = requireLowerUuid('cancellationRequestId', i.cancellationRequestId);
  const eventId = requireLowerUuid('eventId', i.eventId);
  if (!Array.isArray(i.targets) || i.targets.length < 1 || i.targets.length > EVENT_CANCEL_MAX_TARGETS) throw new TicketInputError(`targets는 1~${EVENT_CANCEL_MAX_TARGETS}장이어야 한다`);
  const seen = new Set<string>();
  const targets = i.targets.map((t) => {
    const ticketId = requireLowerUuid('ticketId', t.ticketId);
    const cancellationId = requireLowerUuid('cancellationId', t.cancellationId);
    if (seen.has(ticketId)) throw new TicketInputError('같은 표를 두 번 줄 수 없다');
    seen.add(ticketId);
    return { ticketId, cancellationId };
  });
  if (!Number.isFinite(i.nowMs) || i.nowMs < 0) throw new TicketInputError('nowMs가 올바르지 않다');
  return { cancellationRequestId, eventId, targets, nowMs: i.nowMs };
}

/** 소문자 UUID, 1~100, 중복 금지. @throws TicketInputError */
export function normalizeEntryRecordsInput(ticketIds: readonly string[]): readonly string[] {
  if (!Array.isArray(ticketIds) || ticketIds.length < 1 || ticketIds.length > ENTRY_RECORDS_MAX_TICKETS) throw new TicketInputError(`ticketIds는 1~${ENTRY_RECORDS_MAX_TICKETS}장이어야 한다`);
  const seen = new Set<string>();
  return ticketIds.map((v) => {
    const ticketId = requireLowerUuid('ticketId', v);
    if (seen.has(ticketId)) throw new TicketInputError('같은 표를 두 번 줄 수 없다');
    seen.add(ticketId);
    return ticketId;
  });
}

export interface ListTicketsInput {
  readonly accountId: string;
  readonly cursor?: string;
  readonly limit: number;
}

/** 후기 작성 자격 판정에 쓰는 티켓 한 줄(BAT-585, FR-016·POL-042) */
export interface ReviewEligibilityTicket {
  readonly accountId: string;
  readonly payerAccountId: string;
  readonly orderId: string;
  readonly status: TicketStatus;
  readonly issuedAtMs: number;
}

export type ReviewIneligibleReason = 'NOT_ENDED' | 'NOT_PAYER' | 'NO_VALID_TICKET' | 'EVENT_CANCELLED';

export interface ReviewEligibilityInput {
  readonly accountId: string;
  readonly eventId: string;
  readonly nowMs: number;
  /** 회차의 공연 종료 예정 시각(event.ends_at). core-svc가 넘긴다 */
  readonly eventEndsAtMs: number;
  /** 취소된 회차면 core-svc가 먼저 거른다. ticket-svc는 이 값을 받지 않는다 */
  readonly eventCancelled?: boolean;
}

export interface ReviewEligibilityResult {
  readonly eligible: boolean;
  /** 자격의 근거가 된 결제자 주문(review.basis_order_id) */
  readonly basisOrderId?: string;
  readonly reason?: ReviewIneligibleReason;
}

/** 후기를 쓸 수 있는 티켓 상태. 취소·환불·무효·신고 보류는 뺀다(양도 진행 중은 결제자가 아직 주인이다) */
const REVIEW_VALID_STATUS: ReadonlySet<TicketStatus> = new Set(['ISSUED', 'ACTIVE', 'TRANSFER_PENDING']);

/**
 * 후기 작성 자격(FR-016, POL-042 ①): 공연 종료 예정 시각이 지났고, 그 회차 티켓의 결제자이며,
 * 취소·환불·무효가 아닌 티켓이 남아 있어야 한다. 양도받은 보유자는 결제자가 아니므로 쓸 수 없다.
 * 티켓 상태와 결제자만 본다. 회차 취소는 core-svc가 catalog에서 먼저 본다.
 */
export function reviewEligibilityOf(tickets: readonly ReviewEligibilityTicket[], input: ReviewEligibilityInput): ReviewEligibilityResult {
  if (input.eventCancelled) return { eligible: false, reason: 'EVENT_CANCELLED' };
  if (!Number.isFinite(input.eventEndsAtMs) || input.eventEndsAtMs <= 0) return { eligible: false, reason: 'NOT_ENDED' };
  if (input.nowMs < input.eventEndsAtMs) return { eligible: false, reason: 'NOT_ENDED' };
  const valid = tickets.filter((t) => REVIEW_VALID_STATUS.has(t.status));
  if (valid.length === 0) return { eligible: false, reason: 'NO_VALID_TICKET' };
  const payer = valid
    .filter((t) => t.payerAccountId === input.accountId)
    .sort((a, b) => a.issuedAtMs - b.issuedAtMs || a.orderId.localeCompare(b.orderId));
  if (payer.length === 0) return { eligible: false, reason: 'NOT_PAYER' };
  return { eligible: true, basisOrderId: payer[0]!.orderId };
}

/** 후기 자격 입력을 검사한다. event_ends_at은 core-svc가 카탈로그에서 읽어 넘긴다 */
export function normalizeReviewEligibilityInput(i: ReviewEligibilityInput): ReviewEligibilityInput {
  return {
    accountId: requireUuid('accountId', i.accountId),
    eventId: requireUuid('eventId', i.eventId),
    nowMs: i.nowMs,
    eventEndsAtMs: i.eventEndsAtMs,
    ...(i.eventCancelled === undefined ? {} : { eventCancelled: i.eventCancelled }),
  };
}

/** 보유 티켓 확인 입력(ListHeldTickets, ADR-0301 결정 1). 둘 다 소문자 UUID다 */
export interface ListHeldTicketsInput {
  readonly accountId: string;
  readonly eventId: string;
}

/** 보유 티켓 한 장(티켓 ID와 상태만. 티켓 키·좌석은 싣지 않는다) */
export interface HeldTicket {
  readonly ticketId: string;
  readonly status: TicketStatus;
}

/** 지금 보유자가 쓸 수 있는 유효한 티켓 상태(ADR-0301 결정 1: ISSUED·ACTIVE). 양도 진행 중·취소 접수·환급·무효·신고 보류는 뺀다 */
export const HELD_TICKET_STATUSES: readonly TicketStatus[] = ['ISSUED', 'ACTIVE'];

/** 소문자 UUID만 받는다(대문자도 거절, ADR-0301 결정 1). @throws TicketInputError */
export function normalizeListHeldTicketsInput(i: ListHeldTicketsInput): ListHeldTicketsInput {
  return { accountId: requireLowerUuid('accountId', i.accountId), eventId: requireLowerUuid('eventId', i.eventId) };
}

export interface WalletTicket {
  readonly ticketId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly seatId: string;
  readonly status: TicketStatus;
  readonly qrPayload: string;
  readonly issuedAtMs: number;
  /** 좌석 배치의 게이트 구역. 빈 값이면 아직 모른다 */
  readonly gateZone: string;
  /** 발권 때 받은 회차 시작(epoch ms). 없으면 모른다 */
  readonly eventStartsAtMs?: number;
  /** 부정 예매 양도 잠금이 이 표에 걸렸는지(POL-046 ③) */
  readonly transferLocked: boolean;
  /** 지금 보유자가 결제자인지(받은 표가 아닌지) */
  readonly heldByPayer: boolean;
  /** 진행 중인 양도 요청(보유자 = 결제자일 때만). 목록의 pendingTransfer가 쓴다 */
  readonly pendingOffer?: { readonly offerId: string; readonly expiresAtMs: number };
}

/**
 * 월렛 목록 HTTP 응답의 항목 한 장(openapi `Ticket`의 칸 가운데 ticket 데이터로 채우는 것만, docs/features/offline-gate.md §2 '무엇을 싣나').
 * 주문·좌석·계정 ID, QR 포인터, 티켓 키와 해시는 싣지 않는다(ASVS v5.0.0-15.3.1). 모르는 칸은 거짓 값을 채우지 않고 뺀다
 */
export interface WalletListItem {
  readonly ticketId: string;
  readonly eventId: string;
  readonly status: TicketStatus;
  readonly transferLocked: boolean;
  readonly gateZone?: string;
  readonly eventStartsAt?: string;
  /** 취소 기한 = 회차 시작(POL-032) */
  readonly cancelDeadline?: string;
  /** 결제자가 보유한 표만 null. 받은 표는 보낸 분 닉네임을 ticket 데이터가 모르므로 칸을 뺀다 */
  readonly receivedFromNickname?: null;
  /** 진행 중인 양도 요청. 없거나 받은 표면 null(openapi Ticket.pendingTransfer, F-05-2) */
  readonly pendingTransfer: { readonly offerId: string; readonly expiresAt: string } | null;
}

export function walletListItemOf(t: WalletTicket): WalletListItem {
  const startsAt = t.eventStartsAtMs === undefined ? undefined : new Date(t.eventStartsAtMs).toISOString();
  return {
    ticketId: t.ticketId,
    eventId: t.eventId,
    status: t.status,
    transferLocked: t.transferLocked,
    ...(t.gateZone.trim() === '' ? {} : { gateZone: t.gateZone }),
    ...(startsAt === undefined ? {} : { eventStartsAt: startsAt, cancelDeadline: startsAt }),
    ...(t.heldByPayer ? { receivedFromNickname: null } : {}),
    pendingTransfer:
      t.heldByPayer && t.pendingOffer ? { offerId: t.pendingOffer.offerId, expiresAt: new Date(t.pendingOffer.expiresAtMs).toISOString() } : null,
  };
}

export interface ListTicketsResult {
  readonly tickets: readonly WalletTicket[];
  readonly nextCursor?: string;
}

/** 잘못된 입력(빈 값·UUID 아님·중복 좌석·상한 초과). gRPC INVALID_ARGUMENT로 바꾼다. */
export class TicketInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketInputError';
  }
}

/** 월렛 목록 커서가 풀리지 않는다(처음 쪽으로 보지 않는다). HTTP는 400 invalid-query, gRPC는 INVALID_ARGUMENT다 */
export class WalletCursorError extends TicketInputError {
  constructor() {
    super('cursor가 올바르지 않다');
    this.name = 'WalletCursorError';
  }
}

/** 같은 주문·세대에 다른 내용으로 다시 발권하려 했다. gRPC FAILED_PRECONDITION로 바꾼다. */
export class TicketConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TicketConflictError';
  }
}

/**
 * 그 주문의 발권이 막혔다(BlockTicketIssuance가 남긴 guard 행). gRPC FAILED_PRECONDITION로 바꾼다.
 * 글에는 내부 값(주문·티켓·사유)을 싣지 않는다
 */
export class TicketIssueBlockedError extends Error {
  constructor(message = '이 주문의 발권은 막혔다') {
    super(message);
    this.name = 'TicketIssueBlockedError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(v: string): boolean {
  return UUID.test(v);
}

function requireUuid(name: string, v: string): string {
  const t = v.trim();
  if (!isUuid(t)) throw new TicketInputError(`${name}는 UUID여야 한다`);
  return t.toLowerCase();
}

function requireText(name: string, v: string, max = 200): string {
  const t = v.trim();
  if (!t || t.length > max) throw new TicketInputError(`${name}는 1~${max}자여야 한다`);
  return t;
}

/** 발권 입력을 검사하고 정규화한다. 좌석은 중복을 없애고 정렬해 멱등 지문을 안정적으로 만든다. */
export function normalizeIssueInput(i: IssueTicketsInput): IssueTicketsInput & { readonly seatIds: readonly string[] } {
  const orderId = requireUuid('orderId', i.orderId);
  const eventId = requireUuid('eventId', i.eventId);
  const payerAccountId = requireUuid('payerAccountId', i.payerAccountId);
  if (!Number.isSafeInteger(i.issueGeneration) || i.issueGeneration < 0) throw new TicketInputError('issueGeneration은 0 이상의 정수여야 한다');
  const seatIds = [...new Set(i.seatIds.map((s) => requireUuid('seatId', s)))].sort();
  if (seatIds.length === 0) throw new TicketInputError('seatIds가 비었다');
  if (seatIds.length > MAX_TICKETS_PER_ISSUE) throw new TicketInputError(`한 번에 ${MAX_TICKETS_PER_ISSUE}좌석까지만 발권한다`);
  if (i.eventStartsAtMs !== undefined && (!Number.isFinite(i.eventStartsAtMs) || i.eventStartsAtMs < 0)) throw new TicketInputError('eventStartsAtMs가 올바르지 않다');
  return { orderId, eventId, payerAccountId, seatIds, issueGeneration: i.issueGeneration, ...(i.eventStartsAtMs === undefined ? {} : { eventStartsAtMs: i.eventStartsAtMs }) };
}

/** 같은 주문·세대의 재요청인지 가리는 지문. 좌석 차례가 달라도 같은 값이고, 회차 시작 시각 같은 표시 값은 넣지 않는다. */
export function issueFingerprint(i: IssueTicketsInput): string {
  const n = normalizeIssueInput(i);
  return createHash('sha256').update(JSON.stringify([n.orderId, n.eventId, n.payerAccountId, n.seatIds, n.issueGeneration]), 'utf8').digest('hex');
}

/** 티켓 소지 증명 키(32바이트 base64url). 발권 응답에만 싣는다. */
export function newTicketKey(): string {
  return randomBytes(32).toString('base64url');
}

export function ticketKeyHash(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest('hex');
}

/** 스캐너가 읽는 공개 QR 포인터. 키·서명을 담지 않는다(회전 QR은 기기 키 등록 뒤). */
export function qrPayloadOf(ticketId: string): string {
  return `PEAKET1:${ticketId}`;
}

export interface WalletCursor {
  readonly issuedAtMs: number;
  readonly ticketId: string;
}

export function walletCursorOf(c: WalletCursor): string {
  return Buffer.from(JSON.stringify([c.issuedAtMs, c.ticketId]), 'utf8').toString('base64url');
}

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** 커서(`[발권 ms, 티켓 UUID]` JSON의 base64url)를 푼다. 풀리지 않으면 undefined */
export function parseWalletCursor(raw: string | undefined): WalletCursor | undefined {
  if (!raw || !BASE64URL.test(raw)) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== 2 || typeof v[1] !== 'string' || !isUuid(v[1])) return undefined;
    const at: unknown = v[0];
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0) return undefined;
    return { issuedAtMs: at, ticketId: v[1].toLowerCase() };
  } catch {
    return undefined;
  }
}

/**
 * 목록 입력을 검사한다. limit은 gRPC의 0(생략)을 기본값으로 보고 범위 안으로 맞춘다(HTTP는 계약 검사가 0·101을 먼저 400으로 낸다).
 * @throws WalletCursorError 커서가 있는데 풀리지 않음(처음 쪽으로 보지 않는다, docs/features/offline-gate.md §2 '차례와 나누기')
 */
export function normalizeListInput(i: ListTicketsInput): ListTicketsInput {
  const accountId = requireUuid('accountId', i.accountId);
  const limit = Math.max(1, Math.min(MAX_WALLET_LIMIT, Math.trunc(i.limit) || DEFAULT_WALLET_LIMIT));
  if (i.cursor === undefined) return { accountId, limit };
  const cursor = parseWalletCursor(i.cursor);
  if (!cursor) throw new WalletCursorError();
  return { accountId, limit, cursor: walletCursorOf(cursor) };
}

export function normalizeCancelInput(i: CancelTicketsInput): CancelTicketsInput {
  const orderId = requireUuid('orderId', i.orderId);
  const requestedByAccountId = requireUuid('requestedByAccountId', i.requestedByAccountId);
  const cancellationId = requireUuid('cancellationId', i.cancellationId);
  const ticketIds = [...new Set(i.ticketIds.map((t) => requireUuid('ticketId', t)))];
  if (ticketIds.length === 0) throw new TicketInputError('ticketIds가 비었다');
  if (!Number.isFinite(i.nowMs) || i.nowMs < 0) throw new TicketInputError('nowMs가 올바르지 않다');
  if (i.reason !== undefined && i.reason !== '' && !CANCEL_REASONS.has(i.reason)) throw new TicketInputError('reason이 목록 밖의 값이다');
  return {
    orderId,
    ticketIds,
    requestedByAccountId,
    cancellationId,
    nowMs: i.nowMs,
    ...(i.replayOnly === true ? { replayOnly: true } : {}),
    ...(i.reason !== undefined && i.reason !== '' ? { reason: i.reason } : {}),
  };
}

/** CancelTickets 사유: purchase-svc CANCELLATION_REASONS(order_cancellation.reason)와 같은 일곱(FRAUD 포함, ticket.proto CancelTicketsRequest.reason) */
const CANCEL_REASONS: ReadonlySet<string> = new Set(['USER', 'EVENT_CANCELLED', 'EVENT_POSTPONED', 'ACCOUNT_WITHDRAWAL', 'EXCEPTION', 'MINOR_CONTRACT_CANCEL', 'FRAUD']);
/** 다른 취소 ID의 ALREADY_CANCELLED에 첫 팬 취소로 이어 줄 수 있는 기록의 사유(다시 보기 R1: 일괄 환불 항목·사유 없는 기록은 잇지 않는다) */
export const FAN_CANCEL_REASON = 'USER';

/**
 * replayOnly 확인의 표 하나 결과(행을 바꾸지 않는다, 리뷰 B2 보충). 없는 표·다른 주문·결제자가 아닌 요청은 NOT_PAYER_HOLDER(첫 팬 취소를 남에게 알려 주지 않는다),
 * 끝난 표(환급·무효·취소 접수·부정 표시)는 ALREADY_CANCELLED(부른 쪽이 팬 취소 기록을 첫 칸으로 붙인다), 아직 유효한 표는 EVENT_STARTED다(공연 시작 뒤 새 취소는 없다)
 */
export function replayOnlyResultOf(t: Pick<TicketRecord, 'orderId' | 'payerAccountId' | 'status'> | undefined, input: Pick<CancelTicketsInput, 'orderId' | 'requestedByAccountId'>): 'NOT_PAYER_HOLDER' | 'ALREADY_CANCELLED' | 'EVENT_STARTED' {
  if (!t || t.orderId !== input.orderId || t.payerAccountId !== input.requestedByAccountId) return 'NOT_PAYER_HOLDER';
  if (t.status === 'REFUNDED' || t.status === 'VOIDED' || t.status === 'CANCEL_REQUESTED' || t.status === 'FLAGGED') return 'ALREADY_CANCELLED';
  return 'EVENT_STARTED';
}

/** 월렛 목록에 싣는 값만 고른다(키 원문·해시는 싣지 않는다). pendingOffer는 저장소가 붙인다 */
export function walletTicketOf(t: TicketRecord & { readonly pendingOffer?: { readonly offerId: string; readonly expiresAtMs: number } }): WalletTicket {
  return {
    ticketId: t.ticketId,
    orderId: t.orderId,
    eventId: t.eventId,
    seatId: t.seatId,
    status: t.status,
    qrPayload: t.qrPayload,
    issuedAtMs: t.issuedAtMs,
    gateZone: t.gateZone,
    ...(t.eventStartsAtMs === undefined ? {} : { eventStartsAtMs: t.eventStartsAtMs }),
    transferLocked: t.fraudLockCaseId !== undefined,
    heldByPayer: t.accountId === t.payerAccountId,
    ...(t.pendingOffer === undefined ? {} : { pendingOffer: t.pendingOffer }),
  };
}
