// 회차 취소 일괄 환불의 티켓 한 장 실행기. 기존 예매 취소 Saga(CancelTicket)를 그대로 부른다.
import type { CancelTicket } from './cancel-ticket.js';
import type { EventRefundCanceller } from '../domain/event-refund-ports.js';

export class CancelTicketEventRefund implements EventRefundCanceller {
  constructor(private readonly cancelTicket: CancelTicket) {}

  async cancel(target: Parameters<EventRefundCanceller['cancel']>[0], q: Parameters<EventRefundCanceller['cancel']>[1]) {
    const result = await this.cancelTicket.execute({
      accountId: target.payerAccountId,
      ticketId: target.ticketId,
      cancellationId: q.cancellationId,
      reason: 'EVENT_CANCELLED',
      nowMs: q.nowMs,
      deadlineMs: q.deadlineMs,
      eventCancellationRequestId: q.requestId,
    });
    if (result.status === 'ACCEPTED' || result.status === 'REPLAYED') return { status: 'REFUNDED' as const };
    if (result.status === 'REFUND_PENDING') return { status: 'REFUND_PENDING' as const };
    return { status: 'FAILED' as const, error: result.status };
  }
}
