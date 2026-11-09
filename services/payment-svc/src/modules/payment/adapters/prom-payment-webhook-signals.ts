// 웹훅 받기 지표(docs/observability.md 같은 줄, BUILD_ORDER HOT-150). PromPaymentUnknownSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, type Registry } from '@peaket/platform';
import type { PgName } from '../domain/payment-gateway.js';
import { PG_NAMES } from '../domain/pg-call-guard.js';
import type { PaymentWebhookSignals } from '../domain/ports.js';
import { PAYMENT_WEBHOOK_OUTCOMES, type PaymentWebhookOutcome } from '../domain/webhook-receipt.js';

/** payment_webhook_received_total{pg, outcome}: outcome은 PAYMENT_WEBHOOK_OUTCOMES. 결제사 셋과 값을 0으로 미리 보인다 */
export class PromPaymentWebhookSignals implements PaymentWebhookSignals {
  readonly #total = new Counter({
    name: 'payment_webhook_received_total',
    help: '받은 결제사 웹훅의 결과별 수(결제사·결과)',
    labelNames: ['pg', 'outcome'] as const,
    registers: [],
  });

  constructor() {
    // 처음 일어나기 전에도 경보식이 값을 보게 모든 이름표를 0으로 미리 보인다
    for (const pg of PG_NAMES) for (const outcome of PAYMENT_WEBHOOK_OUTCOMES) this.#total.inc({ pg, outcome }, 0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#total);
    return this;
  }

  outcome(pg: PgName, outcome: PaymentWebhookOutcome): void {
    this.#total.inc({ pg, outcome });
  }
}
