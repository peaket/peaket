// 예매 취소 견적(GET /v1/tickets/{ticketId}/cancellation-quote, POL-032, BUILD_ORDER GAT-070).
// 결제자만 견적을 본다. 보유자·양도 상태는 ticket-svc가 취소할 때 다시 보고, 견적은 주문·판매 설정만 읽는다.
import type { CancellationOrders, EventCancellationLookup } from '../domain/ports.js';
import type { BusinessCalendar, RefundQuote } from '../domain/refund-policy.js';
import { quoteRefund } from '../domain/refund-policy.js';

export interface QuoteCancellationInput {
  readonly accountId: string;
  readonly ticketId: string;
  readonly nowMs: number;
}

export interface CancellationQuoteView extends RefundQuote {
  readonly ticketId: string;
  readonly orderId: string;
  readonly ticketPrice: number;
}

export type QuoteCancellationResult =
  | { readonly status: 'OK'; readonly quote: CancellationQuoteView }
  | { readonly status: 'NOT_FOUND' }
  | { readonly status: 'NOT_PAYER' }
  | { readonly status: 'ALREADY_ENDED' }
  | { readonly status: 'EVENT_STARTED' }
  | { readonly status: 'INVALID_AMOUNT' }
  /** BAT-420 리뷰 D5(빈 뼈대): 그 회차의 회차 취소가 확정됐다(409 event-cancelled) */
  | { readonly status: 'EVENT_CANCELLED' };

const EVENT_START_OFFSET_MS = 24 * 60 * 60 * 1000;

/** 공연 시작 = 판매 종료(공연 시작 24시간 전) + 24시간 */
export function eventStartsAtOf(saleEndsAtMs: number): number {
  return saleEndsAtMs + EVENT_START_OFFSET_MS;
}

export class QuoteCancellation {
  constructor(
    private readonly o: {
      readonly orders: CancellationOrders;
      readonly calendar: BusinessCalendar;
      /** BAT-420 리뷰 D5(빈 뼈대, 아직 쓰지 않는다): 확정된 회차면 EVENT_CANCELLED */
      readonly eventCancellations?: EventCancellationLookup;
    },
  ) {}

  async execute(i: QuoteCancellationInput): Promise<QuoteCancellationResult> {
    const order = await this.o.orders.findByTicket(i.ticketId);
    if (!order) return { status: 'NOT_FOUND' };
    if (order.payerAccountId !== i.accountId) return { status: 'NOT_PAYER' };
    if (order.orderStatus !== 'CONFIRMED' && order.orderStatus !== 'PARTIALLY_REFUNDED') return { status: 'ALREADY_ENDED' };
    const q = quoteRefund({
      ticketPrice: order.ticketPrice,
      eventStartsAtMs: eventStartsAtOf(order.saleEndsAtMs),
      bookedAtMs: order.bookedAtMs,
      nowMs: i.nowMs,
      calendar: this.o.calendar,
      ...(order.entryOpensAtMs !== undefined ? { entryOpensAtMs: order.entryOpensAtMs } : {}),
    });
    if (q.status !== 'OK') return q;
    return { status: 'OK', quote: { ...q.quote, ticketId: i.ticketId, orderId: order.orderId, ticketPrice: order.ticketPrice } };
  }
}
