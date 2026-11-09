// 회차 판매 상태 판정 지표(docs/observability.md, docs/features/seat-hold.md §4 '판정의 첫 구현', BUILD_ORDER PRF-144).
// 이름표는 값이 몇 개뿐인 것만 단다(회차 ID를 달지 않는다, observability §8). PromSeatSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 붙인다.
// - purchase_event_sale_transitions_total{to}(카운터, to는 SaleStatus): 상태가 바뀐 수
// - purchase_event_sale_republished_total(카운터): 같은 판을 다시 낸 수
// - purchase_event_sale_guard_blocked_total(카운터): 활성 판매 행 수가 맞지 않아 매진 후보를 막은 틱 수
// - purchase_event_sale_tick_failures_total{stage}(카운터, stage는 lease·counts·paying·write·avg): 실패한 수(avg는 평균 칸만 빼고 틱은 이어 간다)
// - purchase_event_sale_skipped_total{reason}(카운터, reason은 no_config·not_ready·overlapped·bad_member): 건너뛴 수
// - purchase_event_sale_all_held_seconds(게이지): 이 파드가 맡은 회차 가운데 ALL_HELD가 가장 오래 이어진 시간(리뷰 고침 H1)
// - purchase_event_sale_tick_seconds(히스토그램): 틱 하나가 걸린 시간(리뷰 고침 M4)
import { Counter, Gauge, Histogram, LATENCY_BUCKETS_SECONDS, type Registry } from '@peaket/platform';
import type { SaleSkipReason, SaleStateSignals, SaleTickStage } from '../domain/ports.js';
import type { SaleStatus } from '../domain/sale-state.js';

/** SaleStateSignals의 Prometheus 구현. 메서드는 던지지 않는다(붙이기 전에도 센다) */
export class PromSaleStateSignals implements SaleStateSignals {
  readonly #transitions = new Counter({ name: 'purchase_event_sale_transitions_total', help: '회차 판매 상태가 바뀐 수(to: 바뀐 뒤 상태)', labelNames: ['to'] as const, registers: [] });
  readonly #republished = new Counter({ name: 'purchase_event_sale_republished_total', help: '상태가 그대로라 같은 판을 다시 낸 수', registers: [] });
  readonly #guardBlocked = new Counter({ name: 'purchase_event_sale_guard_blocked_total', help: '활성 판매 행 수가 맞지 않아 매진 후보를 막은 틱 수', registers: [] });
  readonly #tickFailures = new Counter({ name: 'purchase_event_sale_tick_failures_total', help: '판정이 실패한 수(stage: lease·counts·paying·write는 그 회차 틱을 쉬고, avg는 평균 칸만 뺀다)', labelNames: ['stage'] as const, registers: [] });
  readonly #skipped = new Counter({ name: 'purchase_event_sale_skipped_total', help: '건너뛴 수(reason: no_config·not_ready는 회차 틱, overlapped는 틱, bad_member는 만료 인덱스 멤버)', labelNames: ['reason'] as const, registers: [] });
  readonly #allHeld = new Gauge({ name: 'purchase_event_sale_all_held_seconds', help: '이 파드가 맡은 회차 가운데 ALL_HELD가 가장 오래 이어진 시간(초). 없으면 0', registers: [] });
  readonly #tickSeconds = new Histogram({ name: 'purchase_event_sale_tick_seconds', help: '판정 틱 하나가 걸린 시간(초). 칸은 표준 목록', buckets: [...LATENCY_BUCKETS_SECONDS], registers: [] });

  /** 지표를 registry에 붙이고 자신을 돌려준다(main.ts가 service.metrics.registry로 한 번 부른다) */
  register(registry: Registry): this {
    registry.registerMetric(this.#transitions);
    registry.registerMetric(this.#republished);
    registry.registerMetric(this.#guardBlocked);
    registry.registerMetric(this.#tickFailures);
    registry.registerMetric(this.#skipped);
    registry.registerMetric(this.#allHeld);
    registry.registerMetric(this.#tickSeconds);
    return this;
  }

  transition(to: SaleStatus): void {
    this.#transitions.inc({ to });
  }

  republished(): void {
    this.#republished.inc();
  }

  guardBlocked(): void {
    this.#guardBlocked.inc();
  }

  tickFailure(stage: SaleTickStage): void {
    this.#tickFailures.inc({ stage });
  }

  skipped(reason: SaleSkipReason, count = 1): void {
    this.#skipped.inc({ reason }, count);
  }

  allHeldSeconds(seconds: number): void {
    this.#allHeld.set(seconds);
  }

  tickSeconds(seconds: number): void {
    this.#tickSeconds.observe(seconds);
  }
}
