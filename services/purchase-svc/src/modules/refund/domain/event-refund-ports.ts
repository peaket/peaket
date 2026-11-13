// 회차 취소 일괄 환불의 포트(BAT-425). 도메인은 DB·HTTP·gRPC를 모른다.
import type { EventCancellationRequest, EventRefundFault, EventRefundItem, EventRefundTarget, RefundPgProvider } from './event-refund.js';

export interface EventRefundTargets {
  /** 그 회차의 환불 대상(결제 완료·부분 환불 주문의 발권된 티켓). 이미 진행 중인 취소는 뺀다 */
  list(eventId: string): Promise<readonly EventRefundTarget[]>;
}

export interface EventRefundStore {
  find(requestId: string): Promise<EventCancellationRequest | undefined>;
  /** 요청과 대상 항목을 한 트랜잭션에 만든다. 같은 requestId가 있으면 REPLAYED다 */
  create(request: EventCancellationRequest, items: readonly EventRefundItem[]): Promise<EventCancellationRequest>;
  /** 진행률·상태·일시정지 표시를 바꾼다 */
  update(request: EventCancellationRequest): Promise<void>;
  items(requestId: string): Promise<readonly EventRefundItem[]>;
  updateItem(item: EventRefundItem): Promise<void>;
}

/** 기존 예매 취소 Saga(CancelTicket)를 한 장씩 부르는 포트. 성공·재시도·실패만 돌려준다 */
export interface EventRefundCanceller {
  cancel(
    target: EventRefundTarget,
    q: { readonly requestId: string; readonly cancellationId: string; readonly reason: 'EVENT_CANCELLED'; readonly nowMs: number; readonly deadlineMs: number },
  ): Promise<{ readonly status: 'REFUNDED' | 'REFUND_PENDING' | 'FAILED'; readonly error?: string }>;
}

/** 실패 건을 CS 처리함 '환급 실패'로 잇는 포트. 첫 몫은 로그 대역, ops-svc 내부 HTTP는 후속이다 */
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

export interface EventRefundServiceDeps {
  readonly store: EventRefundStore;
  readonly targets: EventRefundTargets;
  readonly canceller: EventRefundCanceller;
  readonly notice?: EventRefundFailureNotice;
  readonly nowMs: () => number;
  readonly deadlineMs: () => number;
  /** 한 번에 결제사에 보내는 수. 기본 8 [가정] */
  readonly concurrency?: number;
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
  readonly kind?: 'CANCEL';
}

export interface EventRefundPauseInput {
  readonly requestId: string;
  readonly pg?: RefundPgProvider;
  readonly reason: string;
}

export interface EventRefundResumeInput {
  readonly requestId: string;
  readonly pg?: RefundPgProvider;
}
