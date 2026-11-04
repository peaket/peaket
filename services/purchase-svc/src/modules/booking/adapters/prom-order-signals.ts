// booking 모듈 지표(docs/observability.md '주문 상태와 상태 이력이 어긋나지 않는다', BUILD_ORDER PRF-160). PromSeatSignals와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Gauge, type Registry } from '@peaket/platform';
import type { OrderSignals } from '../domain/ports.js';

/**
 * - order_history_mismatch(게이지, 이름표 없음): 마지막 매일 검사에서 어긋난 주문 수. 1 이상이면 SEV3(kind hygiene)
 */
export class PromOrderSignals implements OrderSignals {
  readonly #mismatch = new Gauge({ name: 'order_history_mismatch', help: '마지막 매일 주문 상태·이력 검사에서 어긋난 주문 수(1 이상이면 SEV3 hygiene)', registers: [] });

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#mismatch);
    return this;
  }

  /** order_history_mismatch를 count로 둔다. 던지지 않는다(붙이기 전에도 값을 둔다) */
  historyMismatch(count: number): void {
    this.#mismatch.set(count);
  }
}
