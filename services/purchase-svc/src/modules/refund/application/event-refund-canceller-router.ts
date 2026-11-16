// 일괄 환불 표 취소의 갈래(BAT-420 GAT-110 E8, ADR-0280 결정 3): EVENT_CANCELLED는 회차 취소 전용 취소기(견적·좌석 되돌림 없음),
// EVENT_POSTPONED는 예매 취소 Saga(연기 신청 환급, 좌석 되돌림)로 보내고 답을 그대로 준다.
import type { EventRefundTarget } from '../domain/event-refund.js';
import type { EventRefundCanceller } from '../domain/event-refund-ports.js';

export class EventRefundCancellerRouter implements EventRefundCanceller {
  constructor(private readonly o: { readonly cancel: EventRefundCanceller; readonly postpone: EventRefundCanceller }) {}

  async cancel(target: EventRefundTarget, q: Parameters<EventRefundCanceller['cancel']>[1]): ReturnType<EventRefundCanceller['cancel']> {
    return q.reason === 'EVENT_POSTPONED' ? this.o.postpone.cancel(target, q) : this.o.cancel.cancel(target, q);
  }
}
