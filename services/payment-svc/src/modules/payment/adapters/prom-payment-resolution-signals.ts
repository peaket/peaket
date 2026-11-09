// 결제 확정 소요 지표(docs/features/payment.md §9, docs/observability.md '결제 확정 소요 신호', ADR-0069·0105, BUILD_ORDER PRF-200).
// 승인 실행기와 UNKNOWN 조회 실행기가 하나를 함께 쓴다. 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Histogram, LATENCY_BUCKETS_SECONDS, type Registry } from '@peaket/platform';
import type { PgName } from '../domain/payment-gateway.js';
import type { ConfirmPath, PaymentResolutionSignals } from '../domain/ports.js';

/** payment_confirm_resolution_seconds{pg, path}: 접수부터 승인 결과가 정해질 때까지(재전송과 결과 모름 조회 포함) */
export class PromPaymentResolutionSignals implements PaymentResolutionSignals {
  readonly #seconds = new Histogram({
    name: 'payment_confirm_resolution_seconds',
    help: '승인 접수부터 결과가 정해질 때까지의 시간(초, 결제사·경로)',
    labelNames: ['pg', 'path'] as const,
    buckets: [...LATENCY_BUCKETS_SECONDS],
    registers: [],
  });

  register(registry: Registry): this {
    registry.registerMetric(this.#seconds);
    return this;
  }

  resolutionSeconds(pg: PgName, path: ConfirmPath, seconds: number): void {
    this.#seconds.observe({ pg, path }, seconds);
  }
}
