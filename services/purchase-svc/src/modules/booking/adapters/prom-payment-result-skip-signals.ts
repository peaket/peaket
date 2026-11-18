// 결제 결과 소비자가 반영하지 않고 건너뛴 사건 지표(추천 적용 2026-11-18, BAT-600 계획, ADR-0299 결정 4). PromPaymentPullSignals와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
// trade.payments에는 굿즈·티켓 연동 부가 상품 결제(orderKind MERCH, core-svc shop 주문)도 실린다. purchase-svc 주문이 아니므로 반영하지 않고 센다.
// 열거에 없는 값(새 판이 더한 종류, Avro 기본값 UNRECOGNIZED)도 같은 길로 건너뛰고 unrecognized로 센다(docs/api/avro/README.md §3 '열거 기호 더하기').
import { Counter, type Registry } from '@peaket/platform';
import { PAYMENT_EVENT_SKIP_REASONS, type PaymentEventSkipReason, type PaymentEventSkipSignals } from '../domain/payment-result.js';

/**
 * - payment_result_skipped_total{reason}(카운터, reason: merch·unrecognized): 결제 결과 소비자가 주문 종류(orderKind)가 TICKET이 아니라 반영하지 않은 사건 수
 */
export class PromPaymentEventSkipSignals implements PaymentEventSkipSignals {
  readonly #skipped = new Counter({
    name: 'payment_result_skipped_total',
    help: '결제 결과 소비자가 반영하지 않고 건너뛴 결제 사건 수(reason: merch 굿즈·부가 상품 결제, unrecognized 모르는 주문 종류). unrecognized가 0보다 크면 계약 판이 소비자보다 앞섰다(ADR-0299 결정 4)',
    labelNames: ['reason'] as const,
    registers: [],
  });

  constructor() {
    // 이름표 값을 0으로 미리 보인다(처음 건너뛰기 전에도 경보식이 값을 본다)
    for (const reason of PAYMENT_EVENT_SKIP_REASONS) this.#skipped.inc({ reason }, 0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#skipped);
    return this;
  }

  /** payment_result_skipped_total{reason}을 1 올린다. 던지지 않는다 */
  skipped(reason: PaymentEventSkipReason): void {
    this.#skipped.inc({ reason });
  }
}
