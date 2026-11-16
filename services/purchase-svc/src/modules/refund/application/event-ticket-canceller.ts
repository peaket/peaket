// 회차 취소 전용 표 취소기(BAT-420 GAT-110 E, R-T24, docs/features/transfer-refund.md §5 '대상 선택과 보류 취소 전환', 빈 뼈대).
// 견적을 부르지 않고(공제 0, 권면 전액), 좌석을 되돌리지 않으며(ADR-0280 결정 3), 보류 취소(REQUESTED)는 그 행을 이어 쓴다.
import type { BusinessCalendar } from '../domain/refund-policy.js';
import type { CancellationOrders, CancellationWrites, PaymentCancellations } from '../domain/ports.js';
import type { EventRefundTarget } from '../domain/event-refund.js';
import type { EventRefundCanceller, EventTicketCancellations, PendingCancellationConversions } from '../domain/event-refund-ports.js';

export interface EventTicketCancellerDeps {
  readonly tickets: EventTicketCancellations;
  readonly conversions: PendingCancellationConversions;
  readonly orders: CancellationOrders;
  readonly writes: CancellationWrites;
  readonly payments: PaymentCancellations;
  readonly calendar: BusinessCalendar;
}

export class EventTicketCanceller implements EventRefundCanceller {
  constructor(private readonly o: EventTicketCancellerDeps) {}

  async cancel(_target: EventRefundTarget, _q: Parameters<EventRefundCanceller['cancel']>[1]): ReturnType<EventRefundCanceller['cancel']> {
    void this.o;
    throw new Error('아직 없음');
  }
}
