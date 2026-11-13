// 예매 취소 Saga(POST /v1/tickets/{ticketId}/cancellation, docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1, POL-032·POL-038, BUILD_ORDER GAT-080).
// 차례: 주문·결제자 확인 → 견적(공제) → ticket-svc 키 폐기·취소표·양도 확인 → order_cancellation → payment-svc 부분 취소 → 상태.
// ticket-svc가 멈추면 아무것도 쓰지 않는다. 결제사가 결과 모름이면 REFUND_PENDING으로 두고 재시도 큐가 이어 간다.
import type { CancellationReason, CancelTicketResult, RefundAccount } from '../domain/cancellation.js';
import type { CancellationOrders, CancellationWrites, PaymentCancellations, SeatReturns, TicketCancellations } from '../domain/ports.js';
import type { BusinessCalendar } from '../domain/refund-policy.js';
import { quoteRefund } from '../domain/refund-policy.js';
import { eventStartsAtOf } from './quote-cancellation.js';

export interface CancelTicketInput {
  readonly accountId: string;
  readonly ticketId: string;
  /** 클라이언트 Idempotency-Key(소문자 UUID v4). order_cancellation.id와 결제사 멱등키 재료가 된다 */
  readonly cancellationId: string;
  readonly reason: CancellationReason;
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly refundAccount?: RefundAccount;
}

/** 회차 취소·부정 예매·미성년자 계약 취소·탈퇴는 공제하지 않는다(POL-032·POL-038·POL-046) */
export function zeroDeductionFor(reason: CancellationReason): boolean {
  return reason === 'FRAUD' || reason === 'EVENT_CANCELLED' || reason === 'EVENT_POSTPONED' || reason === 'ACCOUNT_WITHDRAWAL' || reason === 'MINOR_CONTRACT_CANCEL';
}

export class CancelTicket {
  constructor(
    private readonly o: {
      readonly orders: CancellationOrders;
      readonly calendar: BusinessCalendar;
      readonly tickets: TicketCancellations;
      readonly payments: PaymentCancellations;
      readonly writes: CancellationWrites;
      readonly seats?: SeatReturns;
    },
  ) {}

  async execute(i: CancelTicketInput): Promise<CancelTicketResult> {
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
      zeroDeduction: zeroDeductionFor(i.reason),
      ...(order.entryOpensAtMs !== undefined ? { entryOpensAtMs: order.entryOpensAtMs } : {}),
    });
    if (q.status === 'EVENT_STARTED') return { status: 'EVENT_STARTED' };
    if (q.status === 'INVALID_AMOUNT') return { status: 'ALREADY_ENDED' };

    // ticket-svc가 행 잠금 안에서 결제자·보유자·진행 중 양도·공연 시작을 다시 본다. 거절이면 아무것도 쓰지 않는다.
    const ticket = await this.o.tickets.cancel({
      orderId: order.orderId,
      ticketIds: [i.ticketId],
      requestedByAccountId: i.accountId,
      cancellationId: i.cancellationId,
      deadlineMs: i.deadlineMs,
    });
    if (ticket === 'NOT_PAYER_HOLDER') return { status: 'TICKET_NOT_HELD' };
    if (ticket === 'TRANSFER_PENDING') return { status: 'TRANSFER_PENDING' };
    if (ticket === 'EVENT_STARTED') return { status: 'EVENT_STARTED' };

    // 취소표: 티켓 키를 폐기한 뒤 좌석을 RETURNED로 되돌린다. 이 단계가 실패하면 취소 행을 만들지 않아
    // 같은 취소 ID의 재시도가 티켓 취소(멱등)와 좌석 되돌리기를 다시 한다
    if (this.o.seats) await this.o.seats.returnSold({ eventId: order.eventId, orderId: order.orderId, seatId: order.seatId, accountId: i.accountId });

    const afterClose = ticket === 'REFUND_AFTER_CLOSE';
    const write = await this.o.writes.create({
      cancellationId: i.cancellationId,
      orderId: order.orderId,
      ticketId: i.ticketId,
      reason: i.reason,
      daysBefore: q.quote.daysBefore,
      within24h: q.quote.within24h,
      deductionBp: q.quote.deductionBp,
      deductionAmount: q.quote.deductionAmount,
      refundAmount: q.quote.refundAmount,
      status: afterClose ? 'REQUESTED' : 'REFUND_PENDING',
      nowMs: i.nowMs,
    });
    if (write.status === 'CONFLICT') return { status: 'CONFLICT' };
    if (write.status === 'REPLAYED') {
      return {
        status: 'REPLAYED',
        cancellationId: write.cancellationId,
        refundAmount: write.refundAmount,
        refundAfterEntryClose: write.refundAfterEntryClose,
      };
    }

    // 입장 시작 뒤 취소는 키만 폐기하고 환급은 입장 기록 마감 뒤에 한다(ADR-0051 결정 13).
    if (afterClose) return { status: 'ACCEPTED', cancellationId: i.cancellationId, refundAmount: q.quote.refundAmount, refundAfterEntryClose: true };

    const payment = await this.o.payments.cancel({
      cancellationId: i.cancellationId,
      orderId: order.orderId,
      amount: q.quote.refundAmount,
      reason: i.reason,
      ...(i.refundAccount !== undefined ? { refundAccount: i.refundAccount } : {}),
      deadlineMs: i.deadlineMs,
    });
    if (payment === 'CANCELLED') {
      await this.o.writes.updateStatus({ cancellationId: i.cancellationId, status: 'REFUNDED', nowMs: i.nowMs });
      return { status: 'ACCEPTED', cancellationId: i.cancellationId, refundAmount: q.quote.refundAmount, refundAfterEntryClose: false };
    }
    // 결과 모름·재시도 대기·업무 거절은 모두 환급 대기다. 거절은 CS 처리함이 이어 받는다.
    await this.o.writes.updateStatus({ cancellationId: i.cancellationId, status: 'REFUND_PENDING', nowMs: i.nowMs });
    return {
      status: 'REFUND_PENDING',
      cancellationId: i.cancellationId,
      refundAmount: q.quote.refundAmount,
      payment: payment === 'REJECTED' ? 'REJECTED' : payment,
    };
  }
}
