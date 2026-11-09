// 티켓 무효 실행기 지표(TicketVoidSignals, BUILD_ORDER HOT-152, docs/observability.md). PromTicketIssueSignals와 같은 꼴이다.
import { Counter, type Registry } from '@peaket/platform';
import type { TicketVoidSignals } from '../domain/ports.js';

const RESULTS = ['voided', 'retry', 'stopped'] as const;

/** ticket_void_attempts_total{result}: 무효 호출을 마친 큐 행 수. 값을 0으로 미리 보인다 */
export class PromTicketVoidSignals implements TicketVoidSignals {
  readonly #attempts = new Counter({ name: 'ticket_void_attempts_total', help: '티켓 무효 호출을 마친 큐 행 수(result: voided·retry·stopped)', labelNames: ['result'] as const, registers: [] });

  constructor() {
    for (const result of RESULTS) this.#attempts.inc({ result }, 0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#attempts);
    return this;
  }

  attempt(result: 'voided' | 'retry' | 'stopped'): void {
    this.#attempts.inc({ result });
  }
}
