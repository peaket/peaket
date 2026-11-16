// 예매 취소 Saga의 포트(BUILD_ORDER GAT-070·GAT-080). 도메인은 플랫폼·DB·gRPC를 모른다.
import type {
  CancellationOrderView,
  CancellationReason,
  CancellationRecord,
  CancellationStatus,
  CancellationWriteOutcome,
  DueRefund,
  PaymentCancelOutcome,
  RefundAccount,
  TicketCancelAnswer,
} from './cancellation.js';
import type { FraudCancelTarget, FraudRefundProgress, FraudTicketResult } from './fraud-cancellation.js';
import type { BusinessCalendar } from './refund-policy.js';

/** 취소가 읽는 주문·티켓(운영은 purchase DB order_item.ticket_id → purchase_order, 판매 설정) */
export interface CancellationOrders {
  /** 티켓 ID로 주문 한 장. 없거나 소문자 UUID가 아니면 undefined */
  findByTicket(ticketId: string): Promise<CancellationOrderView | undefined>;
  /** 같은 취소 ID의 기존 기록. 견적·티켓 취소 전에 재요청을 알아본다 */
  findCancellation(cancellationId: string): Promise<CancellationRecord | undefined>;
}

/** ticket-svc TicketService.CancelTickets(티켓 행 잠금 안에서 결제자·보유자·양도·공연 시작을 본다) */
export interface TicketCancellations {
  cancel(q: {
    readonly orderId: string;
    readonly ticketIds: readonly string[];
    readonly requestedByAccountId: string;
    readonly cancellationId: string;
    readonly deadlineMs: number;
    /** 아무 행도 바꾸지 않는 확인(ticket.proto replay_only, 리뷰 B2 보충). 공연 시작 뒤 다시 누른 팬 취소를 첫 취소로 잇는 데만 쓴다 */
    readonly replayOnly?: boolean;
    /** 취소 사유(ticket.proto reason, 다시 보기 R1). ticket-svc가 기록에 남기고 첫 팬 취소 칸은 USER 기록만 싣는다 */
    readonly reason?: CancellationReason;
  }): Promise<TicketCancelAnswer>;
}

/** payment-svc PaymentService.CancelPayment. 결제사 멱등키는 cancel-{cancellationId}다 */
export interface PaymentCancellations {
  cancel(q: {
    readonly cancellationId: string;
    readonly orderId: string;
    /** 환급액(원). 부분 취소 금액 */
    readonly amount: number;
    readonly reason: CancellationReason;
    readonly refundAccount?: RefundAccount;
    readonly deadlineMs: number;
  }): Promise<PaymentCancelOutcome>;
}

/** order_cancellation 쓰기(운영은 purchase DB 한 트랜잭션) */
export interface CancellationWrites {
  /**
   * 같은 cancellationId가 이미 있으면 REPLAYED(처음 결과를 그대로 돌려준다). 같은 티켓의 진행 중 취소가 있으면 CONFLICT.
   * status는 처음엔 REQUESTED(입장 기록 마감 뒤 환급) 또는 REFUND_PENDING(지금 환급)이다.
   */
  create(q: {
    readonly cancellationId: string;
    readonly orderId: string;
    readonly ticketId: string;
    readonly reason: CancellationReason;
    readonly daysBefore: number;
    readonly within24h: boolean;
    readonly deductionBp: number;
    readonly deductionAmount: number;
    readonly refundAmount: number;
    readonly status: CancellationStatus;
    readonly nowMs: number;
    /** 입장 기록 마감 뒤 환급할 시각(REQUESTED만) */
    readonly refundDueAtMs?: number;
    /** 주문 상태 전이(T22~T25)의 행위자. `account:<UUID>` */
    readonly actor: string;
    /** 회차 취소 일괄 환불 요청 ID(BAT-425). 있으면 order_cancellation에 함께 남긴다 */
    readonly eventCancellationRequestId?: string;
    /** 부정 예매 운영자 취소의 사건 ID·승인 ID(BAT-415 몫 F). 있으면 order_cancellation에 함께 남긴다 */
    readonly fraudCaseId?: string;
    readonly approvalId?: string;
  }): Promise<CancellationWriteOutcome>;
  /** 입장 기록 마감 뒤 환급할 REQUESTED와 재시도할 REFUND_PENDING(환급 시각이 지난 것) */
  dueRefunds(nowMs: number, limit: number): Promise<readonly DueRefund[]>;
  /**
   * 환급 상태 바꾸기(REFUNDED·VOIDED). 없으면 조용히 넘어간다. REFUNDED는 REFUND_PENDING 행만 바꾼다(그사이 CS가 무효로 끝낸 취소를 덮지 않는다,
   * BAT-420 GAT-090 A3). 바꾼 행이 없으면 false를 돌려줄 수 있다(대역은 돌려주지 않아도 된다)
   */
  updateStatus(q: { readonly cancellationId: string; readonly status: CancellationStatus; readonly nowMs: number }): Promise<boolean | void>;
  /** 결제사 결과 모름·일시 실패: REFUND_PENDING 행에만 다음 재시도 시각을 적는다(BAT-420 A3). 바꾼 행이 없으면 false를 돌려줄 수 있다 */
  scheduleRefundRetry(q: { readonly cancellationId: string; readonly attempts: number; readonly nextRetryAtMs: number; readonly lastError: string; readonly nowMs: number }): Promise<boolean | void>;
  /** 재시도 소진·업무 거절: REFUND_PENDING 행에만 CS 처리함 대상 표시(refund_failed_at)를 남긴다(BAT-420 A3). 바꾼 행이 없으면 false를 돌려줄 수 있다 */
  markRefundFailed(q: { readonly cancellationId: string; readonly attempts: number; readonly lastError: string; readonly nowMs: number }): Promise<boolean | void>;
}

/** 환급 재시도 소진·업무 거절을 CS 처리함에 잇는 포트(ops-svc 계약이 생기기 전에는 기록 대역) */
export interface RefundFailureNotice {
  open(q: { readonly cancellationId: string; readonly orderId: string; readonly attempts: number; readonly lastError: string; readonly nowMs: number }): Promise<void>;
}

/**
 * BAT-420 리뷰 D5: 그 회차의 회차 취소(CANCEL)가 확정됐는가(event_cancellation_request kind CANCEL·status RUNNING·PAUSED·COMPLETED가 있다).
 * 참이면 팬 취소·견적은 티켓 단계 앞에서 409 event-cancelled다(transfer-refund §5 '확정 뒤 팬 취소'). 연기(POSTPONE)·판정 중 요청은 거짓이다
 */
export interface EventCancellationLookup {
  confirmed(eventId: string): Promise<boolean>;
}

/** 취소 견적·Saga가 읽는 회차 판매 설정(좌석맵 판의 saleEndsAt·entryOpensAt) */
export interface CancellationConfigs {
  config(eventId: string): Promise<{ readonly saleEndsAtMs: number; readonly entryOpensAtMs?: number } | undefined>;
}

/** 취소표 되돌리기(purchase DB seat_sale RETURNED·한도 감소. Redis 비트맵·델타는 후속) */
export interface SeatReturns {
  returnSold(q: {
    readonly eventId: string;
    readonly orderId: string;
    readonly seatId: string;
    readonly accountId: string;
    readonly saleEndsAtMs: number;
  }): Promise<number>;
}

// ---- 입장 기록 대조와 환급 집기(BAT-420 GAT-090 A, docs/features/transfer-refund.md §3.1 '입장 기록 대조와 환급 집기') ----

/** ticket-svc GetEntryRecords 한 번의 데드라인 2초 [가정] */
export const ENTRY_LOOKUP_DEADLINE_MS = 2_000;
export interface EntryRecordView {
  readonly found: boolean;
  readonly entered: boolean;
  readonly firstEnteredAtMs?: number;
}
/** ticket-svc GetEntryRecords. 실패·시간 초과는 던진다 */
export interface EntryRecords {
  lookup(ticketIds: readonly string[], deadlineMs: number): Promise<ReadonlyMap<string, EntryRecordView>>;
}
export interface CancellationClaims {
  /** REQUESTED이고 entry_recorded_at이 빈 행만 REFUND_PENDING(next_refund_at 빔)으로. 바꿨으면 true */
  claimDue(cancellationId: string, nowMs: number): Promise<boolean>;
  /** REQUESTED 행에 entry_recorded_at을 쓰고 refund_due_at을 비운다. 바꿨으면 true */
  markEntryRecorded(cancellationId: string, enteredAtMs: number, nowMs: number): Promise<boolean>;
}
/** ops CS 처리함 FLAGGED(category ENTRY_AFTER_CANCEL, sourceId = 취소 ID, eventKey = `entry-after-cancel:${cancellationId}`의 SHA-256 앞 16바이트 UUID, caseEventKey). best effort */
export interface EntryFlagNotice {
  open(q: { readonly cancellationId: string; readonly orderId: string; readonly ticketId: string; readonly enteredAtMs: number; readonly nowMs: number }): Promise<void>;
}

/** 좌석 Redis 비트맵을 끄고 구역 델타를 내는 포트(취소표 즉시 재판매) */
export interface SeatReturnNotices {
  returnSold(q: {
    readonly eventId: string;
    readonly seats: readonly { readonly index: number; readonly sectionIndex: number; readonly seatOffset: number }[];
    readonly keepUntilMs: number;
  }): Promise<'OK' | 'NOT_READY'>;
}

export const REAUTH_GATE = Symbol('purchase.REAUTH_GATE');

/** 재인증 토큰 확인(identity 계약이 생기기 전에는 늘 false인 대역) */
export interface ReauthGate {
  verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string }): Promise<boolean>;
}

/** 견적·취소가 함께 쓰는 의존성 */
export interface RefundDeps {
  readonly orders: CancellationOrders;
  readonly calendar: BusinessCalendar;
  readonly tickets: TicketCancellations;
  readonly payments: PaymentCancellations;
  readonly writes: CancellationWrites;
  /** 없으면 좌석 DB 되돌리기를 하지 않는다(계산·계약 시험) */
  readonly seats?: SeatReturns;
  /** 없으면 재인증 토큰을 확인하지 못해 취소를 403으로 닫는다 */
  readonly reauth?: ReauthGate;
  /** 확정된 회차의 팬 취소·견적은 409 event-cancelled(BAT-420 리뷰 D5). 없으면 확인하지 않는다(시작 조립은 DB가 있으면 꽂는다) */
  readonly eventCancellations?: EventCancellationLookup;
}

// ---- 부정 예매 운영자 취소(BAT-415 몫 F, fraud_cancellation.proto, docs/features/transfer-refund.md §7.4) ----

/** ticket-svc OperatorCancelTickets의 표 하나 결과 */
export type OperatorTicketResult = 'CANCELED' | 'SKIPPED_ALREADY_ENDED' | 'SKIPPED_ENTRY_RECORDED' | 'SKIPPED_HOLDER_CHANGED';
export interface OperatorTicketOutcome {
  readonly ticketId: string;
  readonly result: OperatorTicketResult;
  readonly orderId: string;
  readonly withdrawnTransferOfferId?: string;
}

/** ticket-svc TicketService.OperatorCancelTickets(행 잠금 안에서 이미 끝남 → 입장 기록 → 보유자를 가르고 나머지는 키를 폐기한다) */
export interface OperatorTicketCancellations {
  /** 전송 실패·답 모름은 던진다 */
  operatorCancel(q: {
    readonly approvalId: string;
    readonly fraudCaseId: string;
    readonly eventId: string;
    readonly targets: readonly FraudCancelTarget[];
    readonly deadlineMs: number;
  }): Promise<readonly OperatorTicketOutcome[]>;
}

/** 승인 업무 하나의 요청 기록(fraud_cancellation_request) */
export interface FraudCancellationRequestRecord {
  readonly approvalId: string;
  readonly fraudCaseId: string;
  readonly eventId: string;
  readonly fingerprint: string;
  readonly requestedBy: string;
  readonly approvedBy: string;
  readonly approvedAtMs?: number;
  readonly createdAtMs: number;
}

/** 운영자 취소의 요청·표별 결과 저장소(fraud_cancellation_request·fraud_cancellation_ticket) */
export interface FraudCancellationStore {
  find(approvalId: string): Promise<FraudCancellationRequestRecord | undefined>;
  /** 처음이면 CREATED. 같은 승인 ID가 이미 있으면(겹친 호출) EXISTS와 그 기록 */
  create(r: FraudCancellationRequestRecord): Promise<{ readonly status: 'CREATED' } | { readonly status: 'EXISTS'; readonly record: FraudCancellationRequestRecord }>;
  results(approvalId: string): Promise<readonly FraudTicketResult[]>;
  /** (approval_id, ticket_id)로 덮어 쓴다 */
  saveResults(approvalId: string, results: readonly (FraudTicketResult & { readonly expectedHolderAccountId: string })[], nowMs: number): Promise<void>;
  /** ACCEPTED 표의 order_cancellation 상태(REFUNDED → REFUNDED·status_changed_at, refund_failed_at 있음·VOIDED → NEEDS_CS, 그 밖 PENDING) */
  refunds(approvalId: string): Promise<readonly FraudRefundProgress[]>;
}
