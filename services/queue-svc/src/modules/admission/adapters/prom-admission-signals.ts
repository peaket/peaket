// 입장 확정 지표(docs/observability.md §5 대기 순서 신호·입장 루프 신호, ADR-0049·0104·0183). 이름표는 값이 몇 개뿐인 것만 단다(observability §8).
import { Counter, Histogram, type Registry } from '@peaket/platform';
import type { AdmissionSignals } from '../domain/ports.js';

/** 도착 지연·곧 입장 대기(초). 반영 지연 예산 2초와 오는 중 창 5초 근처를 잘게 본다 */
const WAIT_BUCKETS = [0.25, 0.5, 1, 1.5, 2, 3, 5, 8, 10, 20, 30, 60, 120, 300];
/** 실제 대기 ÷ 처음 보인 예상 대기 */
const RATIO_BUCKETS = [0.25, 0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 2, 3, 5];

export class PromAdmissionSignals implements AdmissionSignals {
  readonly #beforeTurn = new Counter({ name: 'queue_admit_before_turn_total', help: '차례 전 입장(번호 > serving인 ADMITTED). 0건 불변식', registers: [] });
  readonly #turnFailed = new Counter({ name: 'queue_turn_entry_failed_total', help: '차례가 온 뒤 입장 실패(user: 15분 만료, system: 차례 확인 뒤 대기열 Redis 일시 장애)', labelNames: ['cause'] as const, registers: [] });
  readonly #eta = new Histogram({ name: 'queue_eta_error_ratio', help: '실제 대기 ÷ 처음 보인 예상 대기', buckets: RATIO_BUCKETS, registers: [] });
  readonly #arrival = new Histogram({ name: 'admission_arrival_delay_seconds', help: '번호를 부른 때 → 처음 입장 확정 요청이 온 때', buckets: WAIT_BUCKETS, registers: [] });
  readonly #soonWait = new Histogram({ name: 'admission_soon_wait_seconds', help: '처음 SOON → ADMITTED', buckets: WAIT_BUCKETS, registers: [] });

  register(registry: Registry): this {
    for (const m of [this.#beforeTurn, this.#turnFailed, this.#eta, this.#arrival, this.#soonWait]) registry.registerMetric(m);
    return this;
  }

  admittedBeforeTurn(): void {
    this.#beforeTurn.inc();
  }

  turnEntryFailed(cause: 'user' | 'system'): void {
    this.#turnFailed.inc({ cause });
  }

  arrivalDelay(seconds: number): void {
    this.#arrival.observe(seconds);
  }

  soonWait(seconds: number): void {
    this.#soonWait.observe(seconds);
  }

  etaError(ratio: number): void {
    this.#eta.observe(ratio);
  }
}
