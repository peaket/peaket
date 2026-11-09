// 결제사 호출 보호 지표(docs/features/payment.md §2 '결제사 호출 보호의 첫 구현', docs/observability.md 같은 줄, BUILD_ORDER PRF-183).
// PromPaymentConfirmSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { PgName } from '../domain/payment-gateway.js';
import { PG_NAMES, PG_SATURATION_REASONS, type PgLimitKind, type PgSaturationReason } from '../domain/pg-call-guard.js';
import type { PgCallGuardSignals } from '../domain/ports.js';

const FIRSTS = ['true', 'false'] as const;

/**
 * - pg_throttled_total{pg, first}: 결제사의 429 수. first는 그 명령의 첫 승인 호출이면 true, 재전송·단독 조회면 false. 값을 0으로 미리 보인다
 * - payment_pg_limit{pg, kind}: 파드의 지금 상한(게이지). kind는 rps·concurrency
 * - payment_pg_inflight{pg}: 돌고 있는 승인 호출 수(게이지)
 * - payment_pg_saturated_total{pg, reason}: 상한에 막힌 횟수. reason은 token·bulkhead. 값을 0으로 미리 보인다
 */
export class PromPgCallGuardSignals implements PgCallGuardSignals {
  readonly #throttled = new Counter({
    name: 'pg_throttled_total',
    help: '결제사의 한도 초과 응답(429) 수(결제사·첫 승인 호출 여부)',
    labelNames: ['pg', 'first'] as const,
    registers: [],
  });

  readonly #limit = new Gauge({
    name: 'payment_pg_limit',
    help: '파드의 지금 결제사 호출 상한(결제사·rps 초당·concurrency 동시 승인 호출)',
    labelNames: ['pg', 'kind'] as const,
    registers: [],
  });

  readonly #inflight = new Gauge({
    name: 'payment_pg_inflight',
    help: '파드에서 돌고 있는 결제사 승인 호출 수(결제사)',
    labelNames: ['pg'] as const,
    registers: [],
  });

  readonly #saturated = new Counter({
    name: 'payment_pg_saturated_total',
    help: '결제사 호출 상한에 막힌 횟수(결제사·까닭)',
    labelNames: ['pg', 'reason'] as const,
    registers: [],
  });

  constructor() {
    // 처음 일어나기 전에도 경보식이 값을 보게 모든 이름표를 0으로 미리 보인다
    for (const pg of PG_NAMES) {
      for (const first of FIRSTS) this.#throttled.inc({ pg, first }, 0);
      for (const reason of PG_SATURATION_REASONS) this.#saturated.inc({ pg, reason }, 0);
      this.#inflight.set({ pg }, 0);
    }
  }

  /** 지표 넷을 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#throttled);
    registry.registerMetric(this.#limit);
    registry.registerMetric(this.#inflight);
    registry.registerMetric(this.#saturated);
    return this;
  }

  throttled(pg: PgName, first: boolean): void {
    this.#throttled.inc({ pg, first: first ? 'true' : 'false' });
  }

  limit(pg: PgName, kind: PgLimitKind, value: number): void {
    this.#limit.set({ pg, kind }, value);
  }

  inflight(pg: PgName, count: number): void {
    this.#inflight.set({ pg }, count);
  }

  saturated(pg: PgName, reason: PgSaturationReason): void {
    this.#saturated.inc({ pg, reason });
  }
}
