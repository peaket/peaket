// 주문 만료 지표(OrderExpirySignals, ADR-0107, BUILD_ORDER PRF-172 설계 5). PromPaymentPullSignals와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다. API 파드(사건 고리)와 릴레이 프로세스(안전망 반복)가 각자 붙인다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import { ORDER_EXPIRY_STAGES, ORDER_EXPIRY_TRIGGERS, type OrderExpiryStage, type OrderExpiryTrigger } from '../domain/order-expiry.js';
import type { OrderExpirySignals } from '../domain/ports.js';

/**
 * - purchase_order_expired_total{trigger}(카운터, trigger: session·hold·attempt·sweep): 만료로 끝낸 주문 수
 * - purchase_order_expiry_failures_total{stage}(카운터): 만료 처리 실패 수(안전망이 받친다)
 * - purchase_order_open_stale(게이지, 이름표 없음): 만든 지 1~30일 [가정]인데 아직 열린 주문 수(1 이상이면 SEV3, 매일 정비 일이 낸다. 리더가 아닌 파드는 0)
 */
export class PromOrderExpirySignals implements OrderExpirySignals {
  readonly #expired = new Counter({
    name: 'purchase_order_expired_total',
    help: '결제하지 않아 만료로 끝낸 주문 수(trigger: session·hold·attempt·sweep, ADR-0107)',
    labelNames: ['trigger'] as const,
    registers: [],
  });

  readonly #failures = new Counter({
    name: 'purchase_order_expiry_failures_total',
    help: '주문 만료 처리 실패 수(stage: 실패한 단계. 안전망이 받친다, ADR-0107)',
    labelNames: ['stage'] as const,
    registers: [],
  });

  readonly #openStale = new Gauge({
    name: 'purchase_order_open_stale',
    help: '만든 지 1~30일인데 아직 열린 주문(CREATED·AUTHENTICATED) 수. 1 이상이면 SEV3(ADR-0107)',
    registers: [],
  });

  constructor() {
    // 이름표 값을 0으로 미리 보인다(처음 만료 전에도 경보식이 값을 본다)
    for (const trigger of ORDER_EXPIRY_TRIGGERS) this.#expired.inc({ trigger }, 0);
    for (const stage of ORDER_EXPIRY_STAGES) this.#failures.inc({ stage }, 0);
    this.#openStale.set(0);
  }

  /** 지표 셋을 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#expired);
    registry.registerMetric(this.#failures);
    registry.registerMetric(this.#openStale);
    return this;
  }

  /** purchase_order_expired_total{trigger}를 1 올린다(모르는 값은 이름표 수가 늘지 않게 버린다). 던지지 않는다 */
  expired(trigger: OrderExpiryTrigger): void {
    if ((ORDER_EXPIRY_TRIGGERS as readonly string[]).includes(trigger)) this.#expired.inc({ trigger });
  }

  /** purchase_order_expiry_failures_total{stage}를 1 올린다(모르는 값은 버린다). 던지지 않는다 */
  failure(stage: OrderExpiryStage): void {
    if ((ORDER_EXPIRY_STAGES as readonly string[]).includes(stage)) this.#failures.inc({ stage });
  }

  /** purchase_order_open_stale을 count로 둔다. 던지지 않는다 */
  openStale(count: number): void {
    this.#openStale.set(count);
  }
}
