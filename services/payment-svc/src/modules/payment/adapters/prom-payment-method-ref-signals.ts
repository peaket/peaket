// 결제 수단 연결값 지표(docs/observability.md 조사 수집 신호, docs/features/payment.md §2.1 '결제 수단 연결값의 첫 구현', BUILD_ORDER HOT-145).
// PromPaymentUnknownSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, type Registry } from '@peaket/platform';
import type { PaymentMethodRefSignals } from '../domain/ports.js';
import type { PaymentMethodRefMissingReason } from '../domain/payment-method-ref.js';

/** inv_ref_missing_total{service, label, reason}: payment-svc의 pay 라벨. reason은 NO_KEY(라벨 키 없음)·CARD_SHAPE(카드 정보 모양 틀림)다. 출시 필수 값이라 identity-svc와 달리 NO_KEY도 센다(BUILD_ORDER HOT-145 코드 리뷰) */
export class PromPaymentMethodRefSignals implements PaymentMethodRefSignals {
  readonly #missing = new Counter({
    name: 'inv_ref_missing_total',
    help: '조사용 가명을 계산하지 못해 비운 수(서비스·라벨·까닭)',
    labelNames: ['service', 'label', 'reason'] as const,
    registers: [],
  });

  constructor() {
    // 처음 일어나기 전에도 값을 보게 0으로 미리 보인다
    for (const reason of ['NO_KEY', 'CARD_SHAPE'] as const) this.#missing.inc({ service: 'payment-svc', label: 'pay', reason }, 0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#missing);
    return this;
  }

  missing(reason: PaymentMethodRefMissingReason): void {
    this.#missing.inc({ service: 'payment-svc', label: 'pay', reason });
  }
}
