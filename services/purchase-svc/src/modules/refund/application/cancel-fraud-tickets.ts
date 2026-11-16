// 부정 예매 운영자 취소 쓰임새(fraud_cancellation.proto CancelFraudTickets, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부', BUILD_ORDER GAT-080).
// 차례: 입력 검사 → 같은 승인의 기록 → (처음) 판매 설정·취소 마감 → 요청 기록 → ticket-svc OperatorCancelTickets → 받은 표의 좌석 되돌리기 →
// order_cancellation(FRAUD, 공제 0원, REFUND_PENDING) → 결과 저장. 결제사는 부르지 않는다(환급 재시도 실행기가 집는다).
// BAT-415 시험 담당의 빈 뼈대다. 동작은 구현 담당이 채운다.
import type { CancelFraudTicketsInput, FraudTicketResult } from '../domain/fraud-cancellation.js';
import type { CancellationConfigs, CancellationOrders, CancellationWrites, FraudCancellationStore, OperatorTicketCancellations, SeatReturns } from '../domain/ports.js';
import type { BusinessCalendar } from '../domain/refund-policy.js';

export interface CancelFraudTicketsDeps {
  readonly store: FraudCancellationStore;
  readonly tickets: OperatorTicketCancellations;
  readonly orders: CancellationOrders;
  readonly configs: CancellationConfigs;
  readonly writes: CancellationWrites;
  readonly calendar: BusinessCalendar;
  readonly seats?: SeatReturns;
}

export class CancelFraudTickets {
  constructor(readonly o: CancelFraudTicketsDeps) {}

  /** 결과는 요청의 대상 차례다. @throws FraudCancellationError INVALID|ALREADY_EXISTS|DEADLINE_PASSED */
  async execute(_i: CancelFraudTicketsInput): Promise<readonly FraudTicketResult[]> {
    throw new Error('아직 없음');
  }
}
