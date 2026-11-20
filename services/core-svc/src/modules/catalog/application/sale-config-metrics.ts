// 판매 승인의 부수 효과 지표(BAT-616, ADR-0327 결정 9).
// - sale_open_total{result}: 판매 열기 결과(opened·exists·no-layout·error·unwired)
// - sale_config_publish_total{result}: 회차 판매 설정 사본 쓰기 결과(ok·failed)
// 서비스 프로세스(승인 직후)와 relay 프로세스(정비 일)가 각자 한 벌을 만들어 자기 등록부에 단다.
import { Counter, type Registry } from '@peaket/platform';

export type SaleOpenMetricResult = 'opened' | 'exists' | 'no-layout' | 'error' | 'unwired';

export class SaleConfigMetrics {
  readonly #open = new Counter({ name: 'sale_open_total', help: '판매 열기 결과(result: opened·exists·no-layout·error·unwired)', labelNames: ['result'] as const, registers: [] });
  readonly #publish = new Counter({ name: 'sale_config_publish_total', help: '회차 판매 설정 사본 쓰기 결과(result: ok·failed)', labelNames: ['result'] as const, registers: [] });

  register(registry: Registry): this {
    for (const m of [this.#open, this.#publish]) registry.registerMetric(m);
    return this;
  }

  saleOpen(result: SaleOpenMetricResult): void {
    this.#open.inc({ result });
  }

  publish(result: 'ok' | 'failed'): void {
    this.#publish.inc({ result });
  }
}

export const SALE_CONFIG_METRICS = Symbol('SALE_CONFIG_METRICS');
