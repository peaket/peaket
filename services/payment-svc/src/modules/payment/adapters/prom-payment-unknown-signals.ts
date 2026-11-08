// UNKNOWN 해소 지표(docs/features/payment.md §2 'UNKNOWN 해소의 첫 구현', docs/observability.md 같은 줄, BUILD_ORDER PRF-182).
// PromPaymentConfirmSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { PgName } from '../domain/payment-gateway.js';
import type { PaymentUnknownSignals } from '../domain/ports.js';
import { PAYMENT_UNKNOWN_QUERY_OUTCOMES, type PaymentUnknownQueryOutcome } from '../domain/unknown-resolver.js';

const PGS: readonly PgName[] = ['TOSS', 'PORTONE', 'SIMULATOR'];

/**
 * - payment_unknown_query_total{pg, outcome}: outcome은 PAYMENT_UNKNOWN_QUERY_OUTCOMES. 결제사 셋과 값을 0으로 미리 보인다
 * - payment_unknown_in_flight: 파드에서 돌고 있는 단독 조회 수(게이지)
 * - payment_unknown_overdue_total: 1시간 [가정] 넘어 알린 수
 * - payment_unknown_write_failures_total: 답 반영 쓰기가 실패한 수
 */
export class PromPaymentUnknownSignals implements PaymentUnknownSignals {
  readonly #total = new Counter({
    name: 'payment_unknown_query_total',
    help: 'UNKNOWN 단독 조회의 결과별 수(결제사·결과)',
    labelNames: ['pg', 'outcome'] as const,
    registers: [],
  });

  readonly #inFlight = new Gauge({
    name: 'payment_unknown_in_flight',
    help: '파드에서 돌고 있는 결제사 단독 조회 수',
    registers: [],
  });

  readonly #overdue = new Counter({
    name: 'payment_unknown_overdue_total',
    help: '결과를 모른 채 1시간을 넘겨 알린 결제 수',
    registers: [],
  });

  readonly #writeFailures = new Counter({
    name: 'payment_unknown_write_failures_total',
    help: 'UNKNOWN 조회 답을 쓰지 못한 수',
    registers: [],
  });

  constructor() {
    // 처음 일어나기 전에도 경보식이 값을 보게 모든 이름표를 0으로 미리 보인다
    for (const pg of PGS) for (const outcome of PAYMENT_UNKNOWN_QUERY_OUTCOMES) this.#total.inc({ pg, outcome }, 0);
    this.#overdue.inc(0);
    this.#writeFailures.inc(0);
  }

  /** 지표 넷을 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#total);
    registry.registerMetric(this.#inFlight);
    registry.registerMetric(this.#overdue);
    registry.registerMetric(this.#writeFailures);
    return this;
  }

  outcome(pg: PgName, outcome: PaymentUnknownQueryOutcome): void {
    this.#total.inc({ pg, outcome });
  }

  overdue(): void {
    this.#overdue.inc();
  }

  inFlight(count: number): void {
    this.#inFlight.set(count);
  }

  writeFailure(): void {
    this.#writeFailures.inc();
  }
}
