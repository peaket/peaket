// 회차 취소 일괄 환불의 티켓 한 장 실행기(연기 신청 환급). 기존 예매 취소 Saga(CancelTicket)를 그대로 부른다.
import type { CancelTicket } from './cancel-ticket.js';
import type { EventRefundCanceller } from '../domain/event-refund-ports.js';

export class CancelTicketEventRefund implements EventRefundCanceller {
  constructor(private readonly cancelTicket: CancelTicket) {}

  async cancel(target: Parameters<EventRefundCanceller['cancel']>[0], q: Parameters<EventRefundCanceller['cancel']>[1]) {
    const result = await this.cancelTicket.execute({
      accountId: target.payerAccountId,
      ticketId: target.ticketId,
      cancellationId: q.cancellationId,
      reason: q.reason,
      nowMs: q.nowMs,
      deadlineMs: q.deadlineMs,
      eventCancellationRequestId: q.requestId,
    });
    if (result.status === 'ACCEPTED' || result.status === 'REPLAYED') return { status: 'REFUNDED' as const };
    // 결제사 업무 거절은 일괄 환불 항목 실패와 같은 길(FAILURE_ERRORS → 항목 FAILED·행 실패 표시·팬 실패 알림·일괄 환불 실패 건 표시 한 트랜잭션)로 끝낸다.
    // 결과 모름(PENDING·UNKNOWN)은 지금처럼 재시도다(다시 보기 2 N7, transfer-refund §5 '주인')
    if (result.status === 'REFUND_PENDING') {
      // 가상계좌 결제의 계좌 대기는 다시 보내지 않는 끝난 항목이다(BUILD_ORDER GAT-090, R-T40)
      if (result.payment === 'REFUND_ACCOUNT_REQUIRED') return { status: 'ACCOUNT_PENDING' as const };
      return result.payment === 'REJECTED' ? { status: 'FAILED' as const, error: 'REJECTED' } : { status: 'REFUND_PENDING' as const };
    }
    return { status: 'FAILED' as const, error: result.status };
  }
}
