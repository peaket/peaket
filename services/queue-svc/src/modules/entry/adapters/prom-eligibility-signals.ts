// 판매 자격 대조 지표(ADR-0265 결정 9, docs/features/queue-admission.md §3 운영 확인). 창 안 판정과 설정 틀림만 센다.
import { Counter, type Registry } from '@peaket/platform';
import type { EligibilitySignals } from '../domain/ports.js';

export class PromEligibilitySignals implements EligibilitySignals {
  readonly #checks = new Counter({
    name: 'queue_sale_eligibility_checks_total',
    help: '로비·진입의 판매 자격 대조 결과(allowed·denied·copy_missing·config_invalid)',
    labelNames: ['path', 'result'] as const,
    registers: [],
  });

  register(registry: Registry): void {
    registry.registerMetric(this.#checks);
  }

  check(i: Parameters<EligibilitySignals['check']>[0]): void {
    this.#checks.inc({ path: i.path, result: i.result });
  }
}
