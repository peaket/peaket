// 회차 취소 일괄 환불의 포트(BAT-425 GAT-120·GAT-130). 도메인은 DB·HTTP·gRPC를 모른다.
import type { EventRefundHoldInput, EventRefundHoldState } from './event-refund-hold.js';
import type { CancellationConfigs } from './ports.js';
import type {
  EventCancellationRequest,
  EventRefundAttempt,
  EventRefundFault,
  EventRefundItem,
  EventRefundKind,
  EventRefundTarget,
  EventRefundWindowStats,
  RefundPgProvider,
} from './event-refund.js';

export interface EventRefundTargets {
  /**
   * 그 회차의 환불 대상(결제 완료·부분 환불 주문의 발권된 티켓). 이미 진행 중인 취소는 뺀다. 다만 입장 시작 뒤 보류(REQUESTED)된 취소의 표는
   * 넣고 그 행 ID를 pendingCancellationId로 싣는다(BAT-420 GAT-110 E, 보류 취소 전환). 진행 중 회차 취소 요청이 남긴 환급 대기(REFUND_PENDING) 행의
   * 표도 넣는다(그 요청의 결과 모름 항목을 다시 부를 수 있게)
   */
  list(eventId: string): Promise<readonly EventRefundTarget[]>;
}

export interface EventRefundStore {
  find(requestId: string): Promise<EventCancellationRequest | undefined>;
  /** 요청과 대상 항목을 한 트랜잭션에 만든다. 같은 requestId가 있으면 REPLAYED다. 팬 알림 Outbox도 같은 트랜잭션에 넣는다 */
  create(request: EventCancellationRequest, items: readonly EventRefundItem[], outbox?: readonly EventRefundOutboxMessage[]): Promise<EventCancellationRequest>;
  /** 진행률·상태·일시정지 표시를 바꾼다 */
  update(request: EventCancellationRequest): Promise<void>;
  /** 실행 중(RUNNING·REFUND_WINDOW)일 때만 진행률을 바꾼다. 그 사이 PAUSED가 됐으면 덮지 않고 false */
  updateActive(request: EventCancellationRequest): Promise<boolean>;
  items(requestId: string): Promise<readonly EventRefundItem[]>;
  /** 항목 상태를 바꾸고, 같은 트랜잭션에 팬 알림 Outbox를 남길 수 있다 */
  updateItem(item: EventRefundItem, outbox?: readonly EventRefundOutboxMessage[]): Promise<void>;
  /** 연기 신청을 조건부로 넣는다. 이미 신청했거나 창이 닫혀 NOT_APPLIED면 false다(신청·창 닫기 경합을 행 잠금으로 가른다) */
  markApplied(requestId: string, ticketId: string, appliedAtMs: number): Promise<boolean>;
  /** 신청하지 않은 항목만 NOT_APPLIED로 끝낸다. 그 사이 신청이 들어왔으면 false다 */
  markNotApplied(requestId: string, ticketId: string): Promise<boolean>;
  /** 아직 끝나지 않은 요청(실행·멈춤·신청 창)을 오래된 순서로 준다. 백그라운드 실행기가 쓴다(멈춘 요청은 쓸어 담기만 한다, BAT-420) */
  activeRequests(limit: number): Promise<readonly EventCancellationRequest[]>;
  /** 그 요청에서 지금 처리할 수 있는 항목(신청됨·PENDING/UNKNOWN·next_attempt_at <= now)을 준다 */
  dueItems(requestId: string, nowMs: number, limit: number): Promise<readonly EventRefundItem[]>;
  /** 연기 신청 창이 닫힌 요청을 찾는다 */
  dueWindowClosures(nowMs: number, limit: number): Promise<readonly EventCancellationRequest[]>;
}

/** 결제사 호출 기록. 자동 정지의 1분 창·연속 실패·실패 금액을 센다 */
export interface EventRefundAttemptStore {
  record(attempt: EventRefundAttempt): Promise<void>;
  window(pg: RefundPgProvider, sinceMs: number): Promise<EventRefundWindowStats>;
  /** 결제사 전체의 1분 창. 업무 거절률은 작업 전체를 멈추므로 결제사 몫과 따로 센다 */
  windowAll(sinceMs: number): Promise<EventRefundWindowStats>;
  consecutiveFailures(pg: RefundPgProvider): Promise<number>;
}

/**
 * 표 한 장을 환불하는 포트(회차 취소 전용 취소기, 연기는 예매 취소 Saga). 성공·재시도·실패를 돌려준다.
 * NOT_SENT는 결제사로 보내기 전의 실패(티켓 단계 등, BAT-420 GAT-110 E7)라 결제사 호출 기록·자동 정지에 넣지 않고 재시도한다
 */
export interface EventRefundCanceller {
  cancel(
    target: EventRefundTarget,
    q: {
      readonly requestId: string;
      /** 그 요청의 회차(ticket-svc 표 끝내기가 다른 회차 표를 막는 데 쓴다, BAT-420) */
      readonly eventId?: string;
      readonly cancellationId: string;
      readonly reason: 'EVENT_CANCELLED' | 'EVENT_POSTPONED';
      readonly nowMs: number;
      readonly deadlineMs: number;
    },
  ): Promise<{ readonly status: 'REFUNDED' | 'REFUND_PENDING' | 'FAILED'; readonly error?: string } | { readonly status: 'NOT_SENT'; readonly error: string }>;
}

/** 실패 건을 CS 처리함 '환급 실패'로 잇는 포트 */
export interface EventRefundFailureNotice {
  open(q: {
    readonly requestId: string;
    readonly orderId: string;
    readonly ticketId: string;
    readonly cancellationId: string;
    readonly attempts: number;
    readonly lastError: string;
    readonly nowMs: number;
  }): Promise<void>;
}

/** 자동 정지·창 닫힘을 ops-svc 경보로 남기는 포트(SEV2). 실패해도 환급 상태는 그대로다 */
export interface EventRefundAlert {
  raise(q: {
    readonly requestId: string;
    readonly eventId: string;
    readonly pg?: RefundPgProvider;
    readonly reason: string;
    readonly severity: 'SEV2' | 'SEV3';
    readonly detail: Record<string, unknown>;
    readonly nowMs: number;
  }): Promise<void>;
}

/** 팬 알림 Outbox 한 줄(trade.orders). 실제 발송은 core-svc notify가 맡는다 */
export interface EventRefundOutboxMessage {
  readonly topic: string;
  readonly key: string;
  readonly payload: Uint8Array;
}

/** 환불 완료·실패·연기 안내를 팬 알림 경로(Outbox)로 남기는 포트 */
export interface EventRefundFanNotifier {
  /** 회차 취소·연기 확정. 대상 주문마다 한 줄 */
  confirmed(request: EventCancellationRequest, targets: readonly EventRefundTarget[], nowMs: number): readonly EventRefundOutboxMessage[];
  /** 한 장의 환급 완료 */
  refunded(request: EventCancellationRequest, item: EventRefundItem, target: EventRefundTarget | undefined, nowMs: number): EventRefundOutboxMessage;
  /** 한 장의 환급 실패(CS REFUND_FAILED와 별개로 팬에게도 알린다) */
  failed(request: EventCancellationRequest, item: EventRefundItem, target: EventRefundTarget | undefined, nowMs: number): EventRefundOutboxMessage;
}

export interface EventRefundServiceDeps {
  readonly store: EventRefundStore;
  readonly targets: EventRefundTargets;
  readonly canceller: EventRefundCanceller;
  readonly notice?: EventRefundFailureNotice;
  /** 자동 정지·창 닫힘을 ops-svc에 남긴다. 없으면 로그만 남긴다 */
  readonly alert?: EventRefundAlert;
  /** 팬 알림 Outbox. 없으면 알림을 남기지 않는다 */
  readonly fanNotifier?: EventRefundFanNotifier;
  /** 결제사 호출 기록. 없으면 자동 정지를 세지 않는다 */
  readonly attempts?: EventRefundAttemptStore;
  /** 그 결제사의 서킷이 열렸는지. 없으면 열리지 않은 것으로 본다 */
  readonly circuitOpen?: (pg: RefundPgProvider) => boolean;
  readonly nowMs: () => number;
  readonly deadlineMs: () => number;
  /** 한 번에 결제사에 보내는 수. 기본 8 [가정] */
  readonly concurrency?: number;
  /** Start가 요청을 만든 뒤 바로 처리하는 최대 건수. 나머지는 백그라운드 실행기가 이어 간다 */
  readonly firstBatch?: number;
  /** 백그라운드 실행기가 한 요청에서 한 번에 처리하는 최대 건수. 기본 200 [가정] */
  readonly batchSize?: number;
  /** 확정 뒤 끝난 주문 쓸어 담기(BAT-420 GAT-110 H, ADR-0280 결정 4). 없으면(옛 조립) 쓸어 담지 않는다. 운영 조립은 꼭 넣는다 */
  readonly items?: EventRefundItemAdder;
  /** 끝나지 않은 주문이 있으면 COMPLETED로 가지 않는다(ADR-0280 결정 5). 없으면 완료를 미루지 않는다 */
  readonly openOrders?: EventOpenOrders;
  /** 회차 취소 요청 중 보류 취소의 환급 미룸(BAT-420 몫 D, gRPC SetEventRefundHold). 없으면 setHold가 실패한다 */
  readonly holds?: EventRefundHolds;
  /** 확정 때 남는 공제 차액 대상(입장 시작 뒤 공제하고 결제사로 보낸 사용자 취소). 없으면 찾지 않는다 */
  readonly gaps?: DeductionGapCancellations;
  /** 남는 차액의 CS 처리함 건(REFUND_FAILED, category DEDUCTION_GAP) */
  readonly gapNotice?: DeductionGapNotice;
  /** 보충 2: 차액 대상의 입장 시작 시각은 대상 표가 아니라 회차 판매 설정(entryOpensAtMs)에서 읽는다(대상 0이어도 찾는다). 없으면 차액을 찾지 않는다 */
  readonly configs?: CancellationConfigs;
  /** 보충 2: 설정에 입장 시작이 없어 차액을 찾지 않을 때의 경고 등. 없으면 남기지 않는다 */
  readonly log?: { warn(o: object, msg: string): void };
}

// ---- BAT-420 몫 D(OPEN[45] 결정): 미룸·차액 건 ----

export interface EventRefundHolds {
  /**
   * 걸기: 같은 회차에 다른 요청 ID의 풀리지 않고 기한 안인 미룸이 있으면 EventRefundHoldError('ALREADY_EXISTS'). 같은 요청 ID면 expires_at만 바꾼다(늘리기·같은 값 멱등).
   * 풀기: 같은 요청 ID일 때만 released_at을 쓴다(다르면 아무것도 하지 않고 지금 상태를 준다)
   */
  set(i: EventRefundHoldInput): Promise<EventRefundHoldState>;
  /** 기한이 지났는데 풀리지 않은 미룸을 released_at으로 풀고 그 (회차, 요청) 목록을 준다(조건부 갱신, 한 번만) */
  releaseExpired(nowMs: number, limit: number): Promise<readonly { eventId: string; cancellationRequestId: string }[]>;
}

export interface DeductionGapCancellations {
  /** 그 회차에서 입장 시작 뒤에 접수돼 공제하고 결제사로 보낸 취소: reason USER, deduction_amount > 0, created_at ≥ entryOpensAt, status REFUND_PENDING·REFUNDED */
  list(eventId: string, entryOpensAtMs: number): Promise<readonly { cancellationId: string; orderId: string; ticketId: string; deductionAmount: number }[]>;
  /**
   * BAT-420 리뷰 D5: 그 표의 진행 중(REFUND_PENDING·REFUNDED) 사용자 취소(USER) 하나. 항목이 ticket-already-ended·cancellation-conflict로 끝날 때
   * 공제 > 0이면 일반 실패 대신 차액 건으로 보낸다(확정과 겹친 팬 공제 환급). 없으면 undefined
   */
  forTicket?(ticketId: string): Promise<{ cancellationId: string; orderId: string; ticketId: string; deductionAmount: number } | undefined>;
}

export interface DeductionGapNotice {
  /** ops CS REFUND_FAILED(category DEDUCTION_GAP, sourceId = 취소 ID, eventKey = sha256(`deduction-gap:${id}`) 앞 16바이트 UUID). best effort */
  open(q: { readonly cancellationId: string; readonly orderId: string; readonly deductionAmount: number; readonly requestId: string; readonly nowMs: number }): Promise<void>;
}

// ---- BAT-420 GAT-110 E·H: 회차 취소 전용 표 취소·보류 취소 전환·쓸어 담기·끝나지 않은 주문 ----

/** ticket-svc EventCancelTickets. 실패·시간 초과는 던진다 */
export interface EventTicketCancellations {
  eventCancel(q: {
    readonly cancellationRequestId: string;
    readonly eventId: string;
    readonly targets: readonly { readonly ticketId: string; readonly cancellationId: string }[];
    readonly deadlineMs: number;
  }): Promise<readonly { readonly ticketId: string; readonly result: 'CANCELED' | 'ALREADY_ENDED'; readonly orderId: string; readonly holderAccountId: string; readonly transferWithdrawn: boolean }[]>;
}

/** 주문 행 잠금 안에서 status = 'REQUESTED'인 그 행만: reason EVENT_CANCELLED, deduction 0, refund = refundAmount, event_cancellation_request_id, refund_due_at 빔, REFUND_PENDING */
export interface PendingCancellationConversions {
  convert(q: { readonly cancellationId: string; readonly eventCancellationRequestId: string; readonly refundAmount: number; readonly nowMs: number }): Promise<'CONVERTED' | 'NOT_REQUESTED'>;
}

/** 없는 (요청, 표)만 PENDING으로 더한다(cancellation_id 유일). 더한 항목을 돌려준다 */
export interface EventRefundItemAdder {
  addItems(requestId: string, items: readonly EventRefundItem[], outbox?: readonly EventRefundOutboxMessage[]): Promise<readonly EventRefundItem[]>;
}

/** 그 회차의 끝나지 않은 주문 수(CREATED·AUTHENTICATED·ACCEPTED·RESERVED·AWAITING_DEPOSIT·APPROVED·UNKNOWN) */
export interface EventOpenOrders {
  count(eventId: string): Promise<number>;
}

export interface EventRefundPreviewInput {
  readonly eventId: string;
  readonly fault: EventRefundFault;
}

export interface EventRefundStartInput {
  readonly eventId: string;
  readonly requestId: string;
  readonly fault: EventRefundFault;
  readonly ruledBy: string;
  readonly confirmedBy: string;
  readonly fanNoticeReason?: string;
  readonly kind?: EventRefundKind;
  /** 연기(POSTPONE)의 새 시작 시각. 신청 창의 기본 닫힘 시각이다 */
  readonly postponedToMs?: number;
  /** 연기(POSTPONE)의 신청 창 닫힘 시각. 없으면 postponedToMs를 쓴다 */
  readonly refundWindowClosesAtMs?: number;
}

export interface EventRefundPauseInput {
  readonly requestId: string;
  readonly pg?: RefundPgProvider;
  readonly reason: string;
}

export interface EventRefundResumeInput {
  readonly requestId: string;
  readonly pg?: RefundPgProvider;
  readonly reason?: string;
}

export interface EventRefundApplyInput {
  readonly requestId: string;
  readonly ticketId: string;
  readonly applicationId?: string;
  readonly appliedAtMs?: number;
}

export interface EventRefundCloseWindowInput {
  readonly requestId: string;
  readonly closedBy: string;
  readonly reason: string;
}
