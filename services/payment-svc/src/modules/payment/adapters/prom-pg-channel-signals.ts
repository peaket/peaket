// 낮춘 상한 맞추기와 포트원 채널 하위 결제사 관측의 지표(docs/features/payment.md §2·§2.2, docs/observability.md 같은 줄, BUILD_ORDER PRF-203).
// PromPgCallGuardSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, type Registry } from '@peaket/platform';
import type { PgChannelLimitSyncSignals, PgChannelLimitSyncStep, PgChannelObservedOutcome, PgChannelObservedSignals } from '../domain/ports.js';

const SYNC_STEPS: readonly PgChannelLimitSyncStep[] = ['read', 'write', 'conflict'];
const OBSERVED: readonly PgChannelObservedOutcome[] = ['match', 'mismatch', 'unattributed', 'unconfigured'];
const OBSERVED_STEPS = ['read', 'write'] as const;

/**
 * - payment_pg_limit_sync_failures_total{step}: 낮춘 상한 표 맞추기 실패(read 읽기·write 쓰기·conflict 판 번호에 더 져서 그만둔 쓰기)
 * - payment_pg_channel_observed_total{outcome}: 포트원 답의 하위 결제사 대조(match·mismatch·unattributed·unconfigured)
 * - payment_pg_channel_observed_failures_total{step}: 관측 표 읽기·쓰기 실패
 * 모든 이름표를 0으로 미리 보인다
 */
export class PromPgChannelSignals implements PgChannelLimitSyncSignals, PgChannelObservedSignals {
  readonly #syncFailures = new Counter({ name: 'payment_pg_limit_sync_failures_total', help: '낮춘 결제사 채널 상한 표 맞추기 실패(단계)', labelNames: ['step'] as const, registers: [] });
  readonly #observed = new Counter({ name: 'payment_pg_channel_observed_total', help: '포트원 결제 답의 하위 결제사 대조(결과)', labelNames: ['outcome'] as const, registers: [] });
  readonly #observedFailures = new Counter({ name: 'payment_pg_channel_observed_failures_total', help: '포트원 채널의 관측 하위 결제사 표 읽기·쓰기 실패(단계)', labelNames: ['step'] as const, registers: [] });

  constructor() {
    for (const step of SYNC_STEPS) this.#syncFailures.inc({ step }, 0);
    for (const outcome of OBSERVED) this.#observed.inc({ outcome }, 0);
    for (const step of OBSERVED_STEPS) this.#observedFailures.inc({ step }, 0);
  }

  /** 지표 셋을 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#syncFailures);
    registry.registerMetric(this.#observed);
    registry.registerMetric(this.#observedFailures);
    return this;
  }

  limitSyncFailed(step: PgChannelLimitSyncStep): void {
    this.#syncFailures.inc({ step });
  }

  channelObserved(outcome: PgChannelObservedOutcome): void {
    this.#observed.inc({ outcome });
  }

  channelObservedFailed(step: 'read' | 'write'): void {
    this.#observedFailures.inc({ step });
  }
}
