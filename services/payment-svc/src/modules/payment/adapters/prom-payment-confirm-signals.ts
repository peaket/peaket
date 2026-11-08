// 승인 실행기 지표(docs/features/payment.md §2 '승인 실행기의 첫 구현', docs/observability.md 같은 줄, BUILD_ORDER PRF-181).
// PromPaymentCommandSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, Gauge, Histogram, LATENCY_BUCKETS_SECONDS, type Registry } from '@peaket/platform';
import { PAYMENT_CONFIRM_OUTCOMES, type PaymentConfirmOutcome } from '../domain/confirm-runner.js';
import type { PgName } from '../domain/payment-gateway.js';
import type { PaymentConfirmSignals } from '../domain/ports.js';

const PGS: readonly PgName[] = ['TOSS', 'PORTONE', 'SIMULATOR'];

/**
 * - payment_confirm_total{pg, outcome}: outcome은 PAYMENT_CONFIRM_OUTCOMES(approved·already·declined·waiting·in_progress·unknown·expired·restart·no_adapter). 결제사 셋과 값을 0으로 미리 보인다
 * - payment_confirm_seconds{pg}: 결제사 호출 시간. 칸은 LATENCY_BUCKETS_SECONDS(표준 목록, 60초 포함)
 * - payment_confirm_in_flight: 파드에서 돌고 있는 승인 호출 수(게이지)
 * - payment_confirm_write_failures_total: 쓰기가 다시 해도 실패한 수
 */
export class PromPaymentConfirmSignals implements PaymentConfirmSignals {
  readonly #total = new Counter({
    name: 'payment_confirm_total',
    help: '승인 실행기의 처리 결과별 수(결제사·결과)',
    labelNames: ['pg', 'outcome'] as const,
    registers: [],
  });

  readonly #seconds = new Histogram({
    name: 'payment_confirm_seconds',
    help: '결제사 승인 호출 시간(초)',
    labelNames: ['pg'] as const,
    buckets: [...LATENCY_BUCKETS_SECONDS],
    registers: [],
  });

  readonly #inFlight = new Gauge({
    name: 'payment_confirm_in_flight',
    help: '파드에서 돌고 있는 결제사 승인 호출 수',
    registers: [],
  });

  readonly #writeFailures = new Counter({
    name: 'payment_confirm_write_failures_total',
    help: '승인 실행기의 쓰기가 다시 해도 실패한 수',
    registers: [],
  });

  constructor() {
    // 처음 일어나기 전에도 경보식이 값을 보게 모든 이름표를 0으로 미리 보인다
    for (const pg of PGS) for (const outcome of PAYMENT_CONFIRM_OUTCOMES) this.#total.inc({ pg, outcome }, 0);
    this.#writeFailures.inc(0);
  }

  /** 지표 넷을 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#total);
    registry.registerMetric(this.#seconds);
    registry.registerMetric(this.#inFlight);
    registry.registerMetric(this.#writeFailures);
    return this;
  }

  outcome(pg: PgName, outcome: PaymentConfirmOutcome): void {
    this.#total.inc({ pg, outcome });
  }

  callSeconds(pg: PgName, seconds: number): void {
    this.#seconds.observe({ pg }, seconds);
  }

  inFlight(count: number): void {
    this.#inFlight.set(count);
  }

  writeFailure(): void {
    this.#writeFailures.inc();
  }
}
