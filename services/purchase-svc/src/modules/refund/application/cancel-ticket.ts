// 예매 취소 Saga(POST /v1/tickets/{ticketId}/cancellation, docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1, POL-032·POL-038, BUILD_ORDER GAT-080).
// 차례: 주문·결제자 확인 → 견적(공제) → ticket-svc 키 폐기·취소표·양도 확인 → order_cancellation → payment-svc 부분 취소 → 상태.
// ticket-svc가 멈추면 아무것도 쓰지 않는다. 결제사가 결과 모름이면 REFUND_PENDING으로 두고 재시도 큐가 이어 간다.
import { REFUND_RETRY_MAX_ATTEMPTS, refundRetryDelayMs, type CancellationReason, type CancellationStatus, type CancelTicketResult, type RefundAccount } from '../domain/cancellation.js';
import type { CancellationOrders, CancellationWrites, PaymentCancellations, SeatReturns, TicketCancellations } from '../domain/ports.js';
import type { BusinessCalendar, RefundQuote } from '../domain/refund-policy.js';
import { quoteRefund } from '../domain/refund-policy.js';
import { eventStartsAtOf } from './quote-cancellation.js';

/**
 * 입장 기록 마감의 보수적 상한(ms). core-svc의 `event.entry_closed_at`이 purchase-svc에 오기 전까지 쓴다:
 * 공연 24시간 [가정] + 역할 유효 끝 2시간 + 미보고 기기 24시간 [가정] = 50시간. 이보다 일찍 환급하지 않는다.
 * 정확한 마감 시각을 연결하면 이 상수를 그 값으로 바꾼다(known gap).
 */
const ENTRY_CLOSE_SAFE_MS = 50 * 60 * 60_000;

export interface CancelTicketInput {
  readonly accountId: string;
  readonly ticketId: string;
  /** 클라이언트 Idempotency-Key(소문자 UUID v4). order_cancellation.id와 결제사 멱등키 재료가 된다 */
  readonly cancellationId: string;
  readonly reason: CancellationReason;
  readonly nowMs: number;
  readonly deadlineMs: number;
  readonly refundAccount?: RefundAccount;
  /** 회차 취소 일괄 환불 요청 ID(BAT-425) */
  readonly eventCancellationRequestId?: string;
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
    // 같은 취소 ID의 재요청은 견적·티켓 취소·좌석 되돌리기를 다시 하지 않는다. 주문이 이미 REFUNDED여도 처음 결과를 준다
    const existing = await this.o.orders.findCancellation(i.cancellationId);
    if (existing) {
      if (existing.orderId !== order.orderId || existing.ticketId !== i.ticketId) return { status: 'CONFLICT' };
      return this.#replay(existing.state, existing.refundAmount, existing.refundAttempts, order.orderId, i);
    }
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
    if (q.status === 'INVALID_AMOUNT') return { status: 'ALREADY_ENDED' };
    // 지금 시각으로 공연이 시작됐으면 새 취소는 없다. 다만 앞 시도가 공연 전에 키만 폐기했을 수 있어, ticket-svc를 행을 바꾸지 않는 확인(replayOnly)으로 불러
    // 팬 취소 기록이 있으면 그 첫 취소로 잇는다(리뷰 B2 보충, docs/features/payment.md §4.1 '공연이 시작된 뒤 다시 누른 경우')
    const replayOnly = q.status === 'EVENT_STARTED';

    // ticket-svc가 행 잠금 안에서 결제자·보유자·진행 중 양도·공연 시작을 다시 본다. 거절이면 아무것도 쓰지 않는다.
    const ticket = await this.o.tickets.cancel({
      orderId: order.orderId,
      ticketIds: [i.ticketId],
      requestedByAccountId: i.accountId,
      cancellationId: i.cancellationId,
      deadlineMs: i.deadlineMs,
      ...(replayOnly ? { replayOnly: true } : {}),
    });
    // 확인에서 첫 팬 취소가 없으면(유효한 표·다른 길로 끝난 표·남이 보유) 지금처럼 공연 시작이고 아무것도 쓰지 않는다
    if (replayOnly && typeof ticket !== 'object') return { status: 'EVENT_STARTED' };
    // 이어 갈 취소(run)·견적·티켓 단계 결과. 앞 시도가 티켓 단계만 마친 팬 취소를 새 키로 다시 누른 것이면 첫 취소 ID로 잇는다(아래)
    let run: CancelTicketInput = i;
    let quote: RefundQuote;
    let ticketResult: 'REFUND_NOW' | 'REFUND_AFTER_CLOSE';
    if (typeof ticket === 'object') {
      // 리뷰 B2(docs/features/payment.md §4.1 '앞 시도가 티켓 단계만 마친 팬 취소 잇기'): ticket-svc가 그 표의 키를 폐기한 팬 취소(K1)를 알려 왔다.
      // 결제자 확인은 위에서 했다. K2가 아니라 K1로 좌석·취소 행·환급을 마치고, 공제 기준 시각은 K1이 키를 폐기한 시각이다
      run = { ...i, cancellationId: ticket.firstCancellationId };
      const before = await this.o.orders.findCancellation(run.cancellationId);
      if (before) {
        if (before.orderId !== order.orderId || before.ticketId !== i.ticketId) return { status: 'CONFLICT' };
        return this.#replay(before.state, before.refundAmount, before.refundAttempts, order.orderId, run);
      }
      const atFirst = quoteRefund({
        ticketPrice: order.ticketPrice,
        eventStartsAtMs: eventStartsAtOf(order.saleEndsAtMs),
        bookedAtMs: order.bookedAtMs,
        nowMs: ticket.firstCancelledAtMs,
        calendar: this.o.calendar,
        zeroDeduction: zeroDeductionFor(i.reason),
        ...(order.entryOpensAtMs !== undefined ? { entryOpensAtMs: order.entryOpensAtMs } : {}),
      });
      if (atFirst.status === 'EVENT_STARTED') return { status: 'EVENT_STARTED' };
      if (atFirst.status === 'INVALID_AMOUNT') return { status: 'ALREADY_ENDED' };
      quote = atFirst.quote;
      ticketResult = ticket.firstResult;
    } else {
      if (q.status !== 'OK') return { status: 'EVENT_STARTED' };
      quote = q.quote;
      if (ticket === 'NOT_PAYER_HOLDER') return { status: 'TICKET_NOT_HELD' };
      if (ticket === 'TRANSFER_PENDING') return { status: 'TRANSFER_PENDING' };
      if (ticket === 'EVENT_STARTED') return { status: 'EVENT_STARTED' };
      // 팬 취소가 아닌 길(운영자 취소·무효)이 먼저 끝냈다: 좌석 되돌리기·취소 행·결제사 호출을 하지 않는다(같은 취소 ID의 재요청은 ticket-svc가 처음 결과를 준다)
      if (ticket === 'ALREADY_CANCELLED') return { status: 'ALREADY_ENDED' };
      ticketResult = ticket;
    }

    // 취소표: 티켓 키를 폐기한 뒤 좌석을 RETURNED로 되돌린다. 이 단계가 실패하면 취소 행을 만들지 않아
    // 같은 취소 ID의 재시도가 티켓 취소(멱등)와 좌석 되돌리기를 다시 한다
    if (this.o.seats) await this.o.seats.returnSold({ eventId: order.eventId, orderId: order.orderId, seatId: order.seatId, accountId: i.accountId, saleEndsAtMs: order.saleEndsAtMs });

    // ticket-svc는 공연 시작으로 REFUND_AFTER_CLOSE를 가르고, 견적은 입장 시작(entryOpensAt)으로 가른다.
    // 입장이 시작됐지만 공연 시작 전인 취소도 키만 폐기하고 환급은 입장 기록 마감 뒤로 미룬다(ADR-0051 결정 13)
    // 회차 취소·연기는 입장 여부와 관계없이 바로 환급한다(transfer-refund §5). 팬 취소만 입장 기록 마감을 기다린다.
    const afterClose = i.reason !== 'EVENT_CANCELLED' && i.reason !== 'EVENT_POSTPONED' && (ticketResult === 'REFUND_AFTER_CLOSE' || quote.refundAfterEntryClose);
    const write = await this.o.writes.create({
      cancellationId: run.cancellationId,
      orderId: order.orderId,
      ticketId: i.ticketId,
      reason: i.reason,
      daysBefore: quote.daysBefore,
      within24h: quote.within24h,
      deductionBp: quote.deductionBp,
      deductionAmount: quote.deductionAmount,
      refundAmount: quote.refundAmount,
      status: afterClose ? 'REQUESTED' : 'REFUND_PENDING',
      nowMs: i.nowMs,
      ...(afterClose ? { refundDueAtMs: eventStartsAtOf(order.saleEndsAtMs) + ENTRY_CLOSE_SAFE_MS } : {}),
      actor: `account:${i.accountId}`,
      ...(i.eventCancellationRequestId !== undefined ? { eventCancellationRequestId: i.eventCancellationRequestId } : {}),
    });
    if (write.status === 'CONFLICT') return { status: 'CONFLICT' };
    if (write.status === 'REPLAYED') return this.#replay(write.state, write.refundAmount, write.refundAttempts, order.orderId, run);

    // 입장 시작 뒤 취소는 키만 폐기하고 환급은 입장 기록 마감 뒤에 한다(ADR-0051 결정 13).
    if (afterClose) return { status: 'ACCEPTED', cancellationId: run.cancellationId, refundAmount: quote.refundAmount, refundAfterEntryClose: true };

    const payment = await this.o.payments.cancel({
      cancellationId: run.cancellationId,
      orderId: order.orderId,
      amount: quote.refundAmount,
      reason: i.reason,
      ...(i.refundAccount !== undefined ? { refundAccount: i.refundAccount } : {}),
      deadlineMs: i.deadlineMs,
    });
    if (payment === 'CANCELLED') {
      await this.o.writes.updateStatus({ cancellationId: run.cancellationId, status: 'REFUNDED', nowMs: i.nowMs });
      return { status: 'ACCEPTED', cancellationId: run.cancellationId, refundAmount: quote.refundAmount, refundAfterEntryClose: false };
    }
    // 결과 모름·재시도 대기·업무 거절은 모두 환급 대기다. 업무 거절은 바로, 결과 모름은 재시도 뒤
    // 다 쓰면 CS 처리함 '환급 실패'로 넘긴다(refund_failed_at, transfer-refund §7.1)
    const attempts = 1;
    if (payment === 'REJECTED' || attempts >= REFUND_RETRY_MAX_ATTEMPTS) {
      await this.o.writes.markRefundFailed({ cancellationId: run.cancellationId, attempts, lastError: payment, nowMs: i.nowMs });
    } else {
      await this.o.writes.scheduleRefundRetry({ cancellationId: run.cancellationId, attempts, nextRetryAtMs: i.nowMs + refundRetryDelayMs(attempts), lastError: payment, nowMs: i.nowMs });
    }
    return {
      status: 'REFUND_PENDING',
      cancellationId: run.cancellationId,
      refundAmount: quote.refundAmount,
      payment: payment === 'REJECTED' ? 'REJECTED' : payment,
    };
  }

  /** 같은 취소 ID의 재요청. REFUND_PENDING이면 같은 멱등키로 결제사를 다시 부르고, 끝난 취소는 처음 결과를 준다 */
  async #replay(state: CancellationStatus, refundAmount: number, refundAttempts: number, orderId: string, i: CancelTicketInput): Promise<CancelTicketResult> {
    // CS가 무효로 끝낸 취소는 되살리지 않는다
    if (state === 'VOIDED') return { status: 'CONFLICT' };
    if (state === 'REFUND_PENDING') {
      const payment = await this.o.payments.cancel({
        cancellationId: i.cancellationId,
        orderId,
        amount: refundAmount,
        reason: i.reason,
        ...(i.refundAccount !== undefined ? { refundAccount: i.refundAccount } : {}),
        deadlineMs: i.deadlineMs,
      });
      if (payment === 'CANCELLED') {
        await this.o.writes.updateStatus({ cancellationId: i.cancellationId, status: 'REFUNDED', nowMs: i.nowMs });
        return { status: 'ACCEPTED', cancellationId: i.cancellationId, refundAmount, refundAfterEntryClose: false };
      }
      const attempts = refundAttempts + 1;
      if (payment === 'REJECTED' || attempts >= REFUND_RETRY_MAX_ATTEMPTS) {
        await this.o.writes.markRefundFailed({ cancellationId: i.cancellationId, attempts, lastError: payment, nowMs: i.nowMs });
      } else {
        await this.o.writes.scheduleRefundRetry({ cancellationId: i.cancellationId, attempts, nextRetryAtMs: i.nowMs + refundRetryDelayMs(attempts), lastError: payment, nowMs: i.nowMs });
      }
      return {
        status: 'REFUND_PENDING',
        cancellationId: i.cancellationId,
        refundAmount,
        payment: payment === 'REJECTED' ? 'REJECTED' : payment,
      };
    }
    return {
      status: 'REPLAYED',
      cancellationId: i.cancellationId,
      refundAmount,
      refundAfterEntryClose: state === 'REQUESTED',
    };
  }
}
