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
  RefundAccountAnswer,
  TicketCancelAnswer,
} from './cancellation.js';
import type { FraudCancelTarget, FraudRefundProgress, FraudTicketResult } from './fraud-cancellation.js';
import type { CompensationPage, CompensationRecord, CompensationStatus, CompensationView } from './compensation.js';
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
    /**
     * 같은 취소 ID의 환급 시도 번호(BAT-425, ADR-0316). 0/빈 값은 첫 시도이고 멱등키 `cancel-{id}`,
     * 1~3 [가정]은 계좌를 다시 받은 시도이고 멱등키 `cancel-{id}-a{n}`이다. 결제사 취소를 부르기 전에 커밋한다
     */
    readonly refundAttempt?: number;
    /**
     * 취소 범위(payment.proto CancelScope). DEPOSIT_ONLY면 payment-svc가 입금 전 취소만 하고 입금 대기가 아니면 REJECTED다(탈퇴 참여자만 싣는다,
     * docs/features/payment.md §6 '입금 전 취소만 부르기', BAT-010). 없으면 원장 상태로 고른다(예매 취소·회차 취소·부정 예매 취소)
     */
    readonly scope?: 'DEPOSIT_ONLY';
  }): Promise<PaymentCancelOutcome>;
}

/** payment-svc GetPayment 한 번의 데드라인 300ms [가정](docs/features/payment.md §6 'purchase-svc 견적', 차단기 payment-svc-get) */
export const PAYMENT_METHOD_LOOKUP_DEADLINE_MS = 300;

/**
 * 결제 수단 읽기(payment-svc GetPayment의 virtual_account_paid, docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현', BUILD_ORDER GAT-090).
 * 참이면 가상계좌로 받은 결제다. 읽지 못하면(시간 초과·연결 실패·차단기 열림·결제 없음) 던진다. 모르는 것을 '계좌 필요 없음'으로 보지 않는다
 */
export interface PaymentMethodLookup {
  virtualAccountPaid(q: { readonly orderId: string; readonly deadlineMs: number }): Promise<boolean>;
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
  /**
   * 계좌 대기(payment가 REFUND_ACCOUNT_REQUIRED, BUILD_ORDER GAT-090): REFUND_PENDING 행에 refund_account_required_at을 쓰고 next_refund_at을 비운다.
   * 재시도 횟수(refund_attempts)는 바꾸지 않는다. 바꾼 행이 없으면 false를 돌려줄 수 있다. 없는 대역은 실패 표시(markRefundFailed)로 대신한다
   */
  markRefundAccountRequired?(q: { readonly cancellationId: string; readonly nowMs: number }): Promise<boolean | void>;
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

// ---- 지연 환급 계좌 다시 받기(BAT-425 GAT-130, ADR-0316) ----

/**
 * 계좌 다시 받기 시도 쓰기(운영은 purchase DB order_cancellation). 행 잠금 안에서 조건을 다시 보고 refund_attempt를 1 올린 뒤
 * 커밋하고, 유스케이스가 그 뒤에 결제사를 부른다(ASVS 2.3.3 '새 행·시도 올리기·payment 호출·답 반영의 경계').
 * oldAttempt는 유스케이스가 읽은 값이다. 그사이 다른 요청이 시도를 올렸으면(조건부 0행) undefined라 하나만 오른다(R-T42 ④)
 */
export interface RefundAccountWrites {
  /**
   * REFUND_PENDING·refund_account_required_at 있음·refund_attempt = oldAttempt·oldAttempt < 3일 때만 올린다.
   * idempotency가 있으면 같은 계정·작업·키를 플랫폼 멱등 기록(order_idempotency)에 같은 트랜잭션의 첫 쓰기로 잡고,
   * 같은 키의 다시 부름은 시도를 올리지 않고 그 시도의 값을 돌려준다(BAT-425 RV-03)
   */
  beginAttempt(q: {
    readonly cancellationId: string;
    readonly oldAttempt: number;
    readonly nowMs: number;
    readonly idempotency?: {
      readonly accountRef: string;
      readonly key: string;
      readonly requestHash: Uint8Array;
      readonly operation: 'REFUND_ACCOUNT';
    };
  }): Promise<
    | {
        readonly attempt: number;
        readonly orderId: string;
        readonly ticketId: string;
        readonly refundAmount: number;
        readonly reason: CancellationReason;
        readonly retryAttempts: number;
      }
    | undefined
  >;
  /**
   * 계좌 대기 표시를 지운다(REFUND_PENDING만). nextRefundAtMs가 있으면 다음 재시도 시각도 쓴다(결과 모름 1분 [가정]).
   * 계좌 거절·업무 거절은 부르는 쪽이 markRefundFailed를 이어 부른다
   */
  clearWaiting(q: { readonly cancellationId: string; readonly nextRefundAtMs?: number; readonly lastError?: string; readonly nowMs: number }): Promise<void>;
  /** 결제사가 환급했다: REFUND_PENDING 행을 REFUNDED로 바꾼다(주문 전이는 CancellationWrites.updateStatus와 같은 규칙) */
  updateStatus(q: { readonly cancellationId: string; readonly status: CancellationStatus; readonly nowMs: number }): Promise<boolean | void>;
  /** 결제사 업무 거절: 계좌 대기 표시를 지운 뒤 CS '환급 실패' 대상 표시(refund_failed_at)를 남긴다 */
  markFailed(q: { readonly cancellationId: string; readonly attempts: number; readonly lastError: string; readonly nowMs: number }): Promise<boolean | void>;
  /**
   * 같은 키의 첫 답을 취소 행에 적는다(0031, BAT-425 RV-03). 없으면 메모리 답 재생만 한다(단위·시험 대역).
   * 계좌 원문이 아닌 상태 이름표만 쓴다
   */
  saveAnswer?(q: { readonly cancellationId: string; readonly idempotencyKey: string; readonly answer: RefundAccountAnswer; readonly nowMs: number }): Promise<void>;
}

// ---- 배상 기록·계좌 입력·송금(BAT-425 GAT-130 잔여, ADR-0317) ----

/** 배상 행 저장소(운영은 purchase DB compensation) */
export interface CompensationStore {
  /** 그 계정이 결제한 주문의 배상만 최근 순으로 준다. 커서는 불투명 글자다(guidelines §3) */
  list(accountId: string, q?: { readonly cursor?: string; readonly limit?: number }): Promise<CompensationPage>;
  /** 그 계정이 결제한 주문의 배상 하나. 없거나 남의 건이면 undefined(같은 404) */
  get(accountId: string, compensationId: string): Promise<CompensationView | undefined>;
  /** 계좌 입력 전 상태 확인용. 없거나 남의 건이면 undefined */
  findForAccount(accountId: string, compensationId: string): Promise<CompensationRecord | undefined>;
  /**
   * ACCOUNT_PENDING 행에만 계좌 끝 4자리·송금 결과를 쓴다. 바뀐 행을 돌려준다. 그사이 다른 요청이 끝냈으면(0행) 지금 행을 돌려준다.
   * 계좌번호 원문은 받지 않는다(POL-014)
   */
  saveTransfer(q: {
    readonly compensationId: string;
    readonly status: Exclude<CompensationStatus, 'ACCOUNT_PENDING'>;
    readonly accountLast4: string;
    readonly transferId?: string;
    readonly receivableId?: string;
    readonly failureReason?: string;
    readonly nowMs: number;
  }): Promise<CompensationRecord | undefined>;
}

/** payment-svc CompensationTransferService.RequestCompensationTransfer의 결과(payment 응답과 같은 뜻) */
export interface CompensationTransferResult {
  readonly transferId: string;
  readonly status: 'REQUESTED' | 'PAID' | 'FAILED';
  readonly receivableId?: string;
  readonly accountLast4?: string;
  readonly failureReason?: string;
}

/**
 * payment-svc 배상 송금 포트(ADR-0317). compensationId가 멱등 키다. 계좌는 이 호출에만 싣고 저장하지 않는다.
 * UNAVAILABLE이면 CompensationTransferUnavailable을 던진다(503 compensation-transfer-unavailable, Retry-After 5초 [가정])
 */
export interface CompensationTransfer {
  request(q: {
    readonly compensationId: string;
    readonly orderId: string;
    readonly accountId: string;
    readonly promoterId?: string;
    readonly eventId?: string;
    readonly amount: number;
    readonly account: RefundAccount;
  }): Promise<CompensationTransferResult>;
}

/** 송금이 FAILED일 때 CS 처리함 '배상 대기'(COMPENSATION_PENDING) 한 건을 여는 포트. eventKey = compensation:{id} */
export interface CompensationCaseNotice {
  open(q: { readonly compensationId: string; readonly orderId: string; readonly nowMs: number }): Promise<void>;
}

/**
 * payment-svc 내부 `GET /internal/v1/circuits`의 결제사 서킷 상태를 읽는 포트(BAT-425 GAT-120, transfer-refund §5 '스스로 멈춤' 3).
 * `open`만 참이다. 10초 [가정] 캐시하고, 읽기 실패는 모든 몫을 거짓으로 둔다(환급을 읽기 장애로 세우지 않는다)
 */
export interface PgCircuits {
  circuitOpen(pg: 'TOSS' | 'PORTONE' | 'SIMULATOR'): boolean;
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

/** 팬 취소가 받는 재인증 작업 묶음(docs/security/authz-matrix.md §6). 본문에 환급 계좌가 있으면 FAN_HIGH_RISK, 없으면 FAN_SENSITIVE */
export type FanReauthAct = 'FAN_SENSITIVE' | 'FAN_HIGH_RISK';
/**
 * 팬 재인증 토큰의 받는 쪽 작업 op(docs/security/authz-matrix.md §6 '받는 쪽 작업 op의 값', ADR-0293).
 * 본문에 환급 계좌가 없으면 TICKET_CANCEL(FAN_SENSITIVE), 있으면 TICKET_CANCEL_REFUND_ACCOUNT(FAN_HIGH_RISK).
 * 지연 환급 계좌 다시 받기는 REFUND_ACCOUNT, 배상 계좌 입력은 COMPENSATION_ACCOUNT이고 둘 다 FAN_HIGH_RISK다(BAT-425, ADR-0316·0317)
 */
export type FanReauthOp = 'TICKET_CANCEL' | 'TICKET_CANCEL_REFUND_ACCOUNT' | 'REFUND_ACCOUNT' | 'COMPENSATION_ACCOUNT';

/** 재인증 토큰을 확인하지 못함(팬 공개키 묶음을 한 번도 받지 못함, jti 저장소 오류). 받는 층은 503 reauth-unavailable로 답한다 */
export class ReauthUnavailable extends Error {
  constructor(message = '재인증 토큰을 확인하지 못했다', options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ReauthUnavailable';
  }
}

/**
 * 재인증 토큰 확인(docs/features/transfer-refund.md §3.1 '팬 취소의 재인증 확인'). true = 통과이고 이번 호출이 jti를 잡았다,
 * false = 거절(403 reauth-required). 확인하지 못하면 ReauthUnavailable을 던진다(503). 대역이 없는 조립은 늘 false다
 */
export interface ReauthGate {
  verify(token: string | undefined, q: { readonly accountId: string; readonly sessionId: string; readonly act: FanReauthAct; readonly op: FanReauthOp }): Promise<boolean>;
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
  /** 없으면 재인증 토큰을 확인하지 않고 취소를 403으로 닫는다(닫힌 대역 unavailableReauth) */
  readonly reauth?: ReauthGate;
  /** 확정된 회차의 팬 취소·견적은 409 event-cancelled(BAT-420 리뷰 D5). 없으면 확인하지 않는다(시작 조립은 DB가 있으면 꽂는다) */
  readonly eventCancellations?: EventCancellationLookup;
  /**
   * 견적·팬 취소의 가상계좌 판정(BUILD_ORDER GAT-090). 없으면(시험·옛 조립) 판정하지 않는다: 견적의 refundAccountRequired는 거짓이고 팬 취소는 본문의 계좌를
   * 전처럼 그대로 넘긴다. 시작 조립은 늘 gRPC 어댑터를 꽂는다
   */
  readonly paymentMethods?: PaymentMethodLookup;
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
