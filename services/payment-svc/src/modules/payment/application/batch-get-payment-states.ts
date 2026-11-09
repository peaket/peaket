// 쓰임새: 결제 결과 조회(gRPC BatchGetPayments, ADR-0140 결정 2·3, docs/features/payment.md §2 '결제 결과 당기기의 첫 구현' 서버 쪽 답 고르기, BUILD_ORDER PRF-180).
// purchase-svc의 '결과 늦음 점검'이 부른다. 쓰기 인스턴스를 읽고 결제사는 부르지 않는다. 없는 주문은 답에 넣지 않는다.
import { parseBatchGetOrderIds, type PaymentState } from '../domain/confirm-command.js';
import type { CallBudget, PaymentCommandSignals, PaymentStateReader } from '../domain/ports.js';

export interface BatchGetPaymentStatesDeps {
  readonly reader: PaymentStateReader;
  readonly signals: PaymentCommandSignals;
}

export class BatchGetPaymentStates {
  constructor(private readonly deps: BatchGetPaymentStatesDeps) {}

  /**
   * @param orderIds 주문 ID 1~100건 [가정]의 소문자 UUID
   * @param budget 이 호출에 남은 시간(저장소의 문장 시간 한도 재료)
   * @returns 결제 기록이 있는 주문만(차례는 보장하지 않는다)
   * @throws PaymentInputError 입력이 틀림(지표 invalid)
   */
  async execute(orderIds: readonly string[], budget?: CallBudget): Promise<PaymentState[]> {
    let ids: string[];
    try {
      ids = parseBatchGetOrderIds(orderIds);
    } catch (err) {
      this.deps.signals.batchGet('invalid');
      throw err;
    }
    try {
      const states = await this.deps.reader.batchGet(ids, budget);
      this.deps.signals.batchGet('ok');
      return states;
    } catch (err) {
      this.deps.signals.batchGet('error');
      throw err;
    }
  }
}
