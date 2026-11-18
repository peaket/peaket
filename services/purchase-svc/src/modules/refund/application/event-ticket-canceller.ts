// 회차 취소 전용 표 취소기(BAT-420 GAT-110 E, R-T24, docs/features/transfer-refund.md §5 '대상 선택과 보류 취소 전환').
// 견적을 부르지 않고(공제 0, 권면 전액), 좌석을 되돌리지 않으며(ADR-0280 결정 3), 결제자·보유자·양도·입장·공연 시작과 무관하다.
// 차례: ① 보류 취소(REQUESTED) 표는 그 행을 조건부로 전환(그사이 집혔으면 cancellation-in-progress) ② 아니면 ticket-svc 표 끝내기 → 취소 행 쓰기
// ③ 결제사 취소(cancel-{취소 ID}) → 환급 상태. 티켓 단계가 실패하면 결제사로 보내지 않은 실패(NOT_SENT)라 일괄 환불이 결제사 실패로 세지 않고 재시도한다.
import { eventStartsAtOf } from './quote-cancellation.js';
import { calendarDaysBefore, type BusinessCalendar } from '../domain/refund-policy.js';
import type { CancellationOrders, CancellationWrites, PaymentCancellations } from '../domain/ports.js';
import type { EventRefundTarget } from '../domain/event-refund.js';
import type { EventRefundCanceller, EventTicketCancellations, PendingCancellationConversions } from '../domain/event-refund-ports.js';

export interface EventTicketCancellerDeps {
  readonly tickets: EventTicketCancellations;
  readonly conversions: PendingCancellationConversions;
  readonly orders: CancellationOrders;
  readonly writes: CancellationWrites;
  readonly payments: PaymentCancellations;
  /** 다른 취소 조립과 같은 모양을 지키려고 받는다(회차 취소는 영업일 셈을 쓰지 않는다) */
  readonly calendar: BusinessCalendar;
}

type Result = Awaited<ReturnType<EventRefundCanceller['cancel']>>;
/** 회차 취소 환급의 주문 상태 전이 행위자 */
const ACTOR = 'system:event-cancellation';

export class EventTicketCanceller implements EventRefundCanceller {
  constructor(private readonly o: EventTicketCancellerDeps) {}

  async cancel(target: EventRefundTarget, q: Parameters<EventRefundCanceller['cancel']>[1]): Promise<Result> {
    // ① 입장 시작 뒤 보류된 팬 취소: 그 행을 이어 써 그 행 ID로 권면 전액을 환급한다(표는 팬 취소 때 키가 이미 폐기됐다)
    if (target.pendingCancellationId !== undefined && target.pendingCancellationId === q.cancellationId) {
      const converted = await this.o.conversions.convert({ cancellationId: q.cancellationId, eventCancellationRequestId: q.requestId, refundAmount: target.ticketPrice, nowMs: q.nowMs });
      if (converted === 'NOT_REQUESTED') return { status: 'FAILED', error: 'cancellation-in-progress' };
      return this.#pay(target, q, target.ticketPrice);
    }
    // ② ticket-svc 표 끝내기(보유자·양도·입장과 무관). 실패는 결제사로 보내지 않은 실패다
    let outcome;
    try {
      [outcome] = await this.o.tickets.eventCancel({
        cancellationRequestId: q.requestId,
        eventId: q.eventId ?? '',
        targets: [{ ticketId: target.ticketId, cancellationId: q.cancellationId }],
        deadlineMs: q.deadlineMs,
      });
    } catch {
      return { status: 'NOT_SENT', error: 'ticket-unavailable' };
    }
    if (!outcome) return { status: 'NOT_SENT', error: 'ticket-unavailable' };
    if (outcome.result === 'ALREADY_ENDED') {
      // 같은 취소 ID로 앞 시도가 끝까지 가지 못했으면 그 행으로 다시 부른다. 행이 없으면 다른 길로 끝난 표다
      const recorded = await this.o.orders.findCancellation(q.cancellationId);
      if (!recorded) return { status: 'FAILED', error: 'ticket-already-ended' };
      if (recorded.state === 'REFUNDED') return { status: 'REFUNDED' };
      if (recorded.state !== 'REFUND_PENDING') return { status: 'FAILED', error: 'ticket-already-ended' };
      return this.#pay(target, q, recorded.refundAmount);
    }
    const write = await this.o.writes.create({
      cancellationId: q.cancellationId,
      orderId: target.orderId,
      ticketId: target.ticketId,
      reason: 'EVENT_CANCELLED',
      daysBefore: calendarDaysBefore(eventStartsAtOf(target.saleEndsAtMs), q.nowMs),
      within24h: false,
      deductionBp: 0,
      deductionAmount: 0,
      refundAmount: target.ticketPrice,
      status: 'REFUND_PENDING',
      eventCancellationRequestId: q.requestId,
      actor: ACTOR,
      nowMs: q.nowMs,
    });
    if (write.status === 'CONFLICT') return { status: 'FAILED', error: 'cancellation-conflict' };
    if (write.status === 'REPLAYED') {
      if (write.state === 'REFUNDED') return { status: 'REFUNDED' };
      if (write.state !== 'REFUND_PENDING') return { status: 'FAILED', error: 'cancellation-conflict' };
      return this.#pay(target, q, write.refundAmount);
    }
    return this.#pay(target, q, target.ticketPrice);
  }

  /** ③ 결제사 취소. 끝나면 환급 상태(REFUND_PENDING 행만), 업무 거절은 실패, 모름·대기는 재시도(상태를 쓰지 않는다) */
  async #pay(target: EventRefundTarget, q: Parameters<EventRefundCanceller['cancel']>[1], amount: number): Promise<Result> {
    const payment = await this.o.payments.cancel({ cancellationId: q.cancellationId, orderId: target.orderId, amount, reason: 'EVENT_CANCELLED', deadlineMs: q.deadlineMs });
    if (payment === 'CANCELLED') {
      await this.o.writes.updateStatus({ cancellationId: q.cancellationId, status: 'REFUNDED', nowMs: q.nowMs });
      return { status: 'REFUNDED' };
    }
    if (payment === 'REJECTED') return { status: 'FAILED', error: 'REJECTED' };
    // 가상계좌 결제: 일괄 환불에는 계좌가 없어 payment-svc가 결제사를 부르지 않고 계좌 대기로 답한다(항목 ACCOUNT_PENDING, BUILD_ORDER GAT-090, R-T40)
    if (payment === 'REFUND_ACCOUNT_REQUIRED') return { status: 'ACCOUNT_PENDING' };
    return { status: 'REFUND_PENDING' };
  }
}
