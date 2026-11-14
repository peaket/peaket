// 회차 취소 일괄 환불의 포트(BAT-425 GAT-120·GAT-130). 도메인은 DB·HTTP·gRPC를 모른다.
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
  /** 그 회차의 환불 대상(결제 완료·부분 환불 주문의 발권된 티켓). 이미 진행 중인 취소는 뺀다 */
  list(eventId: string): Promise<readonly EventRefundTarget[]>;
}

export interface EventRefundStore {
  find(requestId: string): Promise<EventCancellationRequest | undefined>;
  /** 요청과 대상 항목을 한 트랜잭션에 만든다. 같은 requestId가 있으면 REPLAYED다. 팬 알림 Outbox도 같은 트랜잭션에 넣는다 */
  create(request: EventCancellationRequest, items: readonly EventRefundItem[], outbox?: readonly EventRefundOutboxMessage[]): Promise<EventCancellationRequest>;
  /** 진행률·상태·일시정지 표시를 바꾼다 */
  update(request: EventCancellationRequest): Promise<void>;
  items(requestId: string): Promise<readonly EventRefundItem[]>;
  /** 항목 상태를 바꾸고, 같은 트랜잭션에 팬 알림 Outbox를 남길 수 있다 */
  updateItem(item: EventRefundItem, outbox?: readonly EventRefundOutboxMessage[]): Promise<void>;
  /** 연기 신청을 조건부로 넣는다. 이미 신청했거나 창이 닫혀 NOT_APPLIED면 false다(신청·창 닫기 경합을 행 잠금으로 가른다) */
  markApplied(requestId: string, ticketId: string, appliedAtMs: number): Promise<boolean>;
  /** 신청하지 않은 항목만 NOT_APPLIED로 끝낸다. 그 사이 신청이 들어왔으면 false다 */
  markNotApplied(requestId: string, ticketId: string): Promise<boolean>;
  /** 아직 끝나지 않은 요청(실행·신청 창)을 오래된 순서로 준다. 백그라운드 실행기가 쓴다 */
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

/** 기존 예매 취소 Saga(CancelTicket)를 한 장씩 부르는 포트. 성공·재시도·실패만 돌려준다 */
export interface EventRefundCanceller {
  cancel(
    target: EventRefundTarget,
    q: { readonly requestId: string; readonly cancellationId: string; readonly reason: 'EVENT_CANCELLED' | 'EVENT_POSTPONED'; readonly nowMs: number; readonly deadlineMs: number },
  ): Promise<{ readonly status: 'REFUNDED' | 'REFUND_PENDING' | 'FAILED'; readonly error?: string }>;
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
