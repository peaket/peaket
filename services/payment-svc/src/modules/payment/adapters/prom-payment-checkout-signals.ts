// 결제창 준비 지표(docs/observability.md, BUILD_ORDER PRF-190). PromPaymentUnknownSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, type Registry } from '@peaket/platform';
import type { PgName } from '../domain/payment-gateway.js';
import type { PrepareCheckoutOutcome, PrepareCheckoutSignals } from '../domain/ports.js';

/** payment_checkout_prepared_total{pg, outcome}: 고르기 전에 끝난 호출의 pg는 none이다 */
export class PromPaymentCheckoutSignals implements PrepareCheckoutSignals {
  readonly #prepared = new Counter({
    name: 'payment_checkout_prepared_total',
    help: '결제창 준비 결과(결제사·결과)',
    labelNames: ['pg', 'outcome'] as const,
    registers: [],
  });

  constructor() {
    // 처음 일어나기 전에도 값을 보게 0으로 미리 보인다
    for (const pg of ['TOSS', 'PORTONE', 'SIMULATOR'] as const) for (const outcome of ['ok', 'switched', 'pg_unavailable', 'method_unsupported'] as const) this.#prepared.inc({ pg, outcome }, 0);
    for (const outcome of ['invalid', 'error'] as const) this.#prepared.inc({ pg: 'none', outcome }, 0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#prepared);
    return this;
  }

  prepared(pg: PgName | 'none', outcome: PrepareCheckoutOutcome): void {
    this.#prepared.inc({ pg, outcome });
  }
}
