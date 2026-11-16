// 일괄 환불 표 취소의 갈래(BAT-420 GAT-110 E8, 빈 뼈대): EVENT_CANCELLED는 회차 취소 전용 취소기, EVENT_POSTPONED는 예매 취소 Saga(좌석 되돌림)로 보낸다.
import type { EventRefundTarget } from '../domain/event-refund.js';
import type { EventRefundCanceller } from '../domain/event-refund-ports.js';

export class EventRefundCancellerRouter implements EventRefundCanceller {
  constructor(private readonly o: { readonly cancel: EventRefundCanceller; readonly postpone: EventRefundCanceller }) {}

  async cancel(_target: EventRefundTarget, _q: Parameters<EventRefundCanceller['cancel']>[1]): ReturnType<EventRefundCanceller['cancel']> {
    void this.o;
    throw new Error('아직 없음');
  }
}
