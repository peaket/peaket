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
  TicketCancelOutcome,
} from './cancellation.js';
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
  }): Promise<TicketCancelOutcome>;
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
  }): Promise<CancellationWriteOutcome>;
  /** 입장 기록 마감 뒤 환급할 REQUESTED와 재시도할 REFUND_PENDING(환급 시각이 지난 것) */
  dueRefunds(nowMs: number, limit: number): Promise<readonly DueRefund[]>;
  /** 환급 상태 바꾸기(REFUNDED·VOIDED). 없으면 조용히 넘어간다 */
  updateStatus(q: { readonly cancellationId: string; readonly status: CancellationStatus; readonly nowMs: number }): Promise<void>;
  /** 결제사 결과 모름·일시 실패: REFUND_PENDING으로 두고 다음 재시도 시각을 적는다 */
  scheduleRefundRetry(q: { readonly cancellationId: string; readonly attempts: number; readonly nextRetryAtMs: number; readonly lastError: string; readonly nowMs: number }): Promise<void>;
  /** 재시도 소진·업무 거절: REFUND_PENDING을 유지하고 CS 처리함 대상 표시(refund_failed_at)를 남긴다 */
  markRefundFailed(q: { readonly cancellationId: string; readonly attempts: number; readonly lastError: string; readonly nowMs: number }): Promise<void>;
}

/** 환급 재시도 소진·업무 거절을 CS 처리함에 잇는 포트(ops-svc 계약이 생기기 전에는 기록 대역) */
export interface RefundFailureNotice {
  open(q: { readonly cancellationId: string; readonly orderId: string; readonly attempts: number; readonly lastError: string; readonly nowMs: number }): Promise<void>;
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
}
