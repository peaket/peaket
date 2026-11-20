// 표본 검토 지표(docs/observability.md §3·§7, 계획 G11).
// - ops_bot_review_judgements_total{verdict,label}: 판정 기록 수(UNDECIDED는 label SKIPPED)
// - ops_bot_review_label_failures_total{reason}: ApplyLabel 실패·거절 수
// 표본 ID·세션 가명·pid는 이름표에 싣지 않는다(카디널리티 규칙 §8).
import { Counter, type Registry } from '@peaket/platform';
import type { BotReviewSignals } from '../domain/ports.js';

export class PromBotReviewSignals implements BotReviewSignals {
  readonly #judgements = new Counter({
    name: 'ops_bot_review_judgements_total',
    help: '봇 표본 검토 판정 기록 수(verdict HUMAN·BOT·UNDECIDED, label APPLIED·UNCHANGED·DEVICE_NOT_FOUND·SKIPPED)',
    labelNames: ['verdict', 'label'] as const,
    registers: [],
  });
  readonly #labelFailures = new Counter({
    name: 'ops_bot_review_label_failures_total',
    help: '표본 검토 라벨 반영 실패 수(reason unavailable·invalid-argument·already-exists·device-not-found)',
    labelNames: ['reason'] as const,
    registers: [],
  });

  constructor() {
    // 처음 긁을 때 0인 계열도 보이게 한다
    for (const verdict of ['HUMAN', 'BOT'] as const) {
      for (const label of ['APPLIED', 'UNCHANGED', 'DEVICE_NOT_FOUND'] as const) this.#judgements.inc({ verdict, label }, 0);
    }
    this.#judgements.inc({ verdict: 'UNDECIDED', label: 'SKIPPED' }, 0);
    for (const reason of ['unavailable', 'invalid-argument', 'already-exists', 'device-not-found'] as const) this.#labelFailures.inc({ reason }, 0);
  }

  judgement(verdict: 'HUMAN' | 'BOT' | 'UNDECIDED', label: 'APPLIED' | 'UNCHANGED' | 'DEVICE_NOT_FOUND' | 'SKIPPED'): void {
    this.#judgements.inc({ verdict, label });
  }

  labelFailure(reason: 'unavailable' | 'invalid-argument' | 'already-exists' | 'device-not-found'): void {
    this.#labelFailures.inc({ reason });
  }

  register(registry: Registry): this {
    registry.registerMetric(this.#judgements);
    registry.registerMetric(this.#labelFailures);
    return this;
  }
}
