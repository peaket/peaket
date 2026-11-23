// 우선 구매 권리 대조 지표(ADR-0385). 이름표에는 권리 ID·계정 ID를 달지 않는다.
// purchase_priority_grant_sync_total{result}(result: ok·failed·invalid): 사본 보내기 결과 수
// purchase_priority_grant_expire_total{result}(result: ok·failed): 기한 지난 OFFERED 정리 결과 수
import { Counter, type Registry } from '@peaket/platform';
import type { PriorityGrantSyncSignals } from '../domain/ports.js';

export class PromPriorityGrantSignals implements PriorityGrantSyncSignals {
  readonly #sync = new Counter({
    name: 'purchase_priority_grant_sync_total',
    help: '우선 구매 권리 q:prio 사본 보내기 결과 수(result: ok·failed·invalid)',
    labelNames: ['result'] as const,
    registers: [],
  });
  readonly #expire = new Counter({
    name: 'purchase_priority_grant_expire_total',
    help: '기한 지난 우선 구매 권리 정리 결과 수(result: ok·failed)',
    labelNames: ['result'] as const,
    registers: [],
  });

  sync(result: 'ok' | 'failed' | 'invalid'): void {
    this.#sync.inc({ result });
  }

  expire(result: 'ok' | 'failed'): void {
    this.#expire.inc({ result });
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다(start.ts가 service.metrics.registry로 한 번 부른다) */
  register(registry: Registry): this {
    for (const m of [this.#sync, this.#expire]) registry.registerMetric(m);
    return this;
  }
}
