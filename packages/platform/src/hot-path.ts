// 핫패스 구간 진단 지표(BAT-027, HOT-462, 2026-11-11, R-472).
// 지연 원인을 코드 안 구간별로 가르기 위한 진단용 지표다. 낮은 카디널리티만 쓴다:
// service(논리 서비스 이름), stage(고정 구간 이름), outcome(고정 결과 이름). 계정·주문·좌석 ID는 싣지 않는다(docs/observability.md §8).
// 계측은 동작을 바꾸지 않는다. 시계는 주입 Clock이 아니라 process.hrtime(단조)을 쓴다(요청의 Clock 의미를 건드리지 않는다).
import { Counter, Histogram, type Registry } from '@prometheus-io/client';
import { LATENCY_BUCKETS_SECONDS } from './metrics.js';

/** Nest 조립에서 HotPathMetrics를 넘기는 토큰(없으면 계측하지 않는다) */
export const HOT_PATH_METRICS = Symbol('platform.HotPathMetrics');

/** 구간 이름(고정 목록). 새 구간을 넣을 때는 docs/observability.md §8의 목록도 함께 고친다 */
export type HotPathStage =
  | 'hold.session'
  | 'hold.seat_config'
  | 'hold.seat_resolve'
  | 'hold.replay'
  | 'hold.lua'
  | 'hold.attempts'
  | 'hold.session_record'
  | 'hold.total'
  | 'payment.confirm.claim'
  | 'payment.confirm.read'
  | 'payment.confirm.mark'
  | 'payment.confirm.gateway'
  | 'payment.confirm.finish'
  | 'payment.confirm.reschedule'
  | 'payment.confirm.drop'
  | 'payment.confirm.release'
  | 'payment.status.read'
  | 'payment.status.deposit_read'
  | 'payment.status.wait'
  | 'payment.status.total'
  | 'queue.entry.schedule'
  | 'queue.entry.preempt'
  | 'queue.entry.arrival'
  | 'queue.entry.number'
  | 'queue.entry.batch_record'
  | 'queue.entry.record'
  | 'queue.entry.batch_result'
  | 'queue.entry.mirror'
  | 'queue.entry.release'
  | 'queue.entry.total';

/** 결과 이름(고정 목록). 화면·경보가 쓰는 이름이므로 함부로 바꾸지 않는다 */
export type HotPathOutcome =
  | 'ok'
  | 'conflict'
  | 'quota_exceeded'
  | 'rehold_wait'
  | 'paused'
  | 'not_ready'
  | 'idem_reused'
  | 'invalid_seat'
  | 'sale_ended'
  | 'session_not_found'
  | 'event_mismatch'
  | 'deadline_exceeded'
  | 'store_unavailable'
  | 'invalid_request'
  | 'error'
  | 'ticket'
  | 'batching'
  | 'already_admitted'
  | 'already_waiting'
  | 'entry_cancelled'
  | 'preverify_invalid'
  | 'not_open'
  | 'not_found'
  | 'sold_out'
  | 'queue_recovering'
  | 'lobby_closed'
  | 'lobby_participant_not_found'
  | 'eligibility_required'
  | 'degraded_limited'
  | 'identity_verification_required'
  | 'approved'
  | 'already'
  | 'declined'
  | 'waiting'
  | 'in_progress'
  | 'unknown'
  | 'expired'
  | 'restart'
  | 'no_adapter'
  | 'circuit_open'
  | 'rejected';

/**
 * 한 서비스의 핫패스 구간 지표.
 * - `hot_path_stage_seconds{service, stage}`: 구간 하나의 시간(초). 칸은 표준 지연 칸(docs/observability.md §8)
 * - `hot_path_outcomes_total{service, outcome}`: 요청 하나의 최종 결과
 *
 * 지표를 붙이기 전(register 전)에도 observe/outcome은 메모리에 쌓인다. 요청을 받기 전에 register하는 것이 정상 조립이다.
 */
export class HotPathMetrics {
  readonly #stageSeconds: Histogram<'service' | 'stage'>;
  readonly #outcomes: Counter<'service' | 'outcome'>;
  readonly #registered = new WeakSet<Registry>();

  constructor(readonly service: string) {
    this.#stageSeconds = new Histogram({
      name: 'hot_path_stage_seconds',
      help: '핫패스 구간 하나의 시간(초). service·stage는 고정 목록(docs/observability.md §8)',
      labelNames: ['service', 'stage'] as const,
      buckets: [...LATENCY_BUCKETS_SECONDS],
      registers: [],
    });
    this.#outcomes = new Counter({
      name: 'hot_path_outcomes_total',
      help: '핫패스 요청 하나의 최종 결과(고정 목록, docs/observability.md §8)',
      labelNames: ['service', 'outcome'] as const,
      registers: [],
    });
  }

  /** 서비스 레지스트리에 붙이고 자신을 돌려준다(같은 레지스트리에 두 번 붙여도 한 번만 붙는다) */
  register(registry: Registry): this {
    if (this.#registered.has(registry)) return this;
    registry.registerMetric(this.#stageSeconds);
    registry.registerMetric(this.#outcomes);
    this.#registered.add(registry);
    return this;
  }

  /**
   * 구간 시간을 재기 시작한다. 돌려준 함수를 끝날 때(성공·실패 모두) 부르면 한 번 관측한다.
   * 두 번 불러도 한 번만 관측한다. 지표가 던져도 요청을 막지 않는다.
   */
  start(stage: HotPathStage): () => void {
    const started = process.hrtime.bigint();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.#observe(stage, Number(process.hrtime.bigint() - started) / 1e9);
    };
  }

  /** 이미 잰 시간(초)을 관측한다. 음수·NaN은 0으로 본다 */
  observe(stage: HotPathStage, seconds: number): void {
    this.#observe(stage, seconds);
  }

  /** 결과 하나를 센다(기본 1). 지표가 던져도 요청을 막지 않는다 */
  outcome(outcome: HotPathOutcome, count = 1): void {
    try {
      this.#outcomes.inc({ service: this.service, outcome }, count);
    } catch {
      // 계측이 요청을 막지 않는다
    }
  }

  #observe(stage: HotPathStage, seconds: number): void {
    try {
      this.#stageSeconds.observe({ service: this.service, stage }, Number.isFinite(seconds) ? Math.max(0, seconds) : 0);
    } catch {
      // 계측이 요청을 막지 않는다
    }
  }
}

/** 있으면 구간 시간을 재고, 없으면 그대로 부른다(계측을 끈 조립·시험) */
export async function timeHotPath<T>(metrics: HotPathMetrics | undefined, stage: HotPathStage, work: () => Promise<T>): Promise<T> {
  if (metrics === undefined) return work();
  const done = metrics.start(stage);
  try {
    return await work();
  } finally {
    done();
  }
}

/** 동기 구간용(작은 기록 하나) */
export function timeHotPathSync<T>(metrics: HotPathMetrics | undefined, stage: HotPathStage, work: () => T): T {
  if (metrics === undefined) return work();
  const done = metrics.start(stage);
  try {
    return work();
  } finally {
    done();
  }
}
