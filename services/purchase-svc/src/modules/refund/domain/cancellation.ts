// 예매 취소 Saga의 값·결과(docs/features/transfer-refund.md §3.1·§4·§5, docs/features/payment.md §4.1, POL-032·POL-038, BUILD_ORDER GAT-080).

/** order_cancellation.reason. GAT-080은 팬 취소(USER)와 부정 예매 취소(FRAUD)를 먼저 구현한다 */
export const CANCELLATION_REASONS = [
  'USER',
  'EVENT_CANCELLED',
  'EVENT_POSTPONED',
  'ACCOUNT_WITHDRAWAL',
  'EXCEPTION',
  'MINOR_CONTRACT_CANCEL',
  'FRAUD',
] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** order_cancellation.status */
export const CANCELLATION_STATUSES = ['REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'VOIDED'] as const;
export type CancellationStatus = (typeof CANCELLATION_STATUSES)[number];

/** 환불 계좌. 저장하지 않고 결제사 취소 요청에 바로 넘긴다(POL-014) */
export interface RefundAccount {
  readonly bankCode: string;
  readonly accountNumber: string;
  readonly holderName: string;
}

/** 취소가 보는 주문·티켓 한 장. ticket-svc가 소유한 보유자·양도 상태는 여기 없다(티켓 취소 포트가 본다) */
export interface CancellationOrderView {
  readonly orderId: string;
  readonly eventId: string;
  readonly ticketId: string;
  /** 그 티켓의 좌석 ID(취소표로 되돌린다) */
  readonly seatId: string;
  /** 주문을 결제한 계정. 취소는 이 사람만 할 수 있다 */
  readonly payerAccountId: string;
  /** 티켓 권면 금액(주문 항목 unit_price) */
  readonly ticketPrice: number;
  /** 주문을 만든 시각(예매 완료 시점, 24시간 계산의 시작) */
  readonly bookedAtMs: number;
  /** 판매 종료 시각(공연 시작 24시간 전). 공연 시작은 이 값 + 24시간이다 */
  readonly saleEndsAtMs: number;
  /** 입장 시작 시각(있을 때) */
  readonly entryOpensAtMs?: number;
  /** purchase_order.status */
  readonly orderStatus: string;
}

/** 티켓 취소 포트 결과(ticket.proto CancelTicketResult와 같은 뜻) */
export type TicketCancelOutcome = 'REFUND_NOW' | 'REFUND_AFTER_CLOSE' | 'NOT_PAYER_HOLDER' | 'TRANSFER_PENDING' | 'EVENT_STARTED' | 'ALREADY_CANCELLED';

/** 결제사 취소 포트 결과(payment.proto CancelResult와 같은 뜻) */
export type PaymentCancelOutcome = 'CANCELLED' | 'PENDING' | 'REJECTED' | 'UNKNOWN';

/** order_cancellation 한 행을 만든 결과 */
export type CancellationWriteOutcome =
  | { readonly status: 'CREATED' }
  | {
      readonly status: 'REPLAYED';
      readonly cancellationId: string;
      readonly refundAmount: number;
      readonly state: CancellationStatus;
      readonly refundAfterEntryClose: boolean;
    }
  | { readonly status: 'CONFLICT' };

/** 취소 접수 결과 */
export type CancelTicketResult =
  | { readonly status: 'ACCEPTED'; readonly cancellationId: string; readonly refundAmount: number; readonly refundAfterEntryClose: boolean }
  | { readonly status: 'REPLAYED'; readonly cancellationId: string; readonly refundAmount: number; readonly refundAfterEntryClose: boolean }
  | { readonly status: 'REFUND_PENDING'; readonly cancellationId: string; readonly refundAmount: number; readonly payment: 'PENDING' | 'UNKNOWN' | 'REJECTED' }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'NOT_PAYER' }
  | { readonly status: 'ALREADY_ENDED' }
  | { readonly status: 'CONFLICT' }
  | { readonly status: 'TICKET_NOT_HELD' }
  | { readonly status: 'TRANSFER_PENDING' }
  | { readonly status: 'EVENT_STARTED' };
