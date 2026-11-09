// 운영 신호(docs/features/bot-defense.md §15·§16)와 정규 로그 줄 trust_score. 라벨은 가짓수가 적은 것만 쓰고 사유 범주는 라벨로 쓰지 않는다.
import { Counter, type Registry } from '@peaket/platform';
import type { FeatureName, TrustSignals, VerdictRecord, VerdictRecorder } from '../domain/ports.js';
import type { MissingCause } from '../domain/scorers.js';
import type { HardSignal, HumanCheckResult, ScoreContext, ScorerName, Verdict } from '../domain/types.js';

export class PromTrustSignals implements TrustSignals {
  readonly #verdicts = new Counter({ name: 'trust_verdicts_total', help: '판정 수', labelNames: ['context', 'verdict'] as const, registers: [] });
  readonly #human = new Counter({ name: 'trust_human_check_total', help: '사람 확인 서버 검증 결과(PASSED·FAILED·PENDING)', labelNames: ['result'] as const, registers: [] });
  readonly #missing = new Counter({ name: 'trust_scorer_missing_total', help: '값 없음이 된 점수기(cause: dependency 의존성 장애, absent 원래 없는 값)', labelNames: ['scorer', 'cause'] as const, registers: [] });
  readonly #hard = new Counter({ name: 'trust_block_list_hits_total', help: '확정 신호로 판정을 앞에서 정한 수(signal: BLOCK_LIST·HONEYPOT)', labelNames: ['signal'] as const, registers: [] });
  readonly #feature = new Counter({ name: 'trust_feature_read_failures_total', help: '판정 피처 키를 읽지 못한 수(feature: block·honeypot·accounts·history)', labelNames: ['feature'] as const, registers: [] });
  readonly #after = new Counter({ name: 'trust_after_response_failures_total', help: '응답 뒤로 미룬 쓰기 실패', labelNames: ['work'] as const, registers: [] });

  register(registry: Registry): void {
    registry.registerMetric(this.#verdicts);
    registry.registerMetric(this.#human);
    registry.registerMetric(this.#missing);
    registry.registerMetric(this.#hard);
    registry.registerMetric(this.#feature);
    registry.registerMetric(this.#after);
  }

  verdict(context: ScoreContext, verdict: Verdict): void {
    this.#verdicts.inc({ context, verdict });
  }

  humanCheck(result: HumanCheckResult): void {
    this.#human.inc({ result });
  }

  scorerMissing(scorer: ScorerName, cause: MissingCause): void {
    this.#missing.inc({ scorer, cause });
  }

  hardSignal(signal: Exclude<HardSignal, 'NONE'>): void {
    this.#hard.inc({ signal });
  }

  featureFailed(feature: FeatureName): void {
    this.#feature.inc({ feature });
  }

  afterFailed(work: 'challenge' | 'verification' | 'account'): void {
    this.#after.inc({ work });
  }
}

/**
 * 판정 기록의 첫 구현: 정규 로그 줄 trust_score만 쓴다(§15). Kafka 판정 기록(telemetry.trust-verdicts)은 BUILD_ORDER BOT-055·BOT-060이다.
 * 로그에는 사람·기기 식별값과 확정 신호 종류를 싣지 않는다. 사유 범주는 이 줄에서만 본다(§16)
 */
export class LogVerdictRecorder implements VerdictRecorder {
  constructor(private readonly logger: { info(fields: Record<string, unknown>, message: string): void }) {}

  record(r: VerdictRecord): void {
    this.logger.info(
      {
        context: r.context,
        verdict: r.verdict,
        reason: r.reason ?? null,
        degraded: r.degraded,
        missingScorers: r.missingScorers,
        profileVersion: r.profileVersion,
        durationMs: r.durationMs,
        humanCheck: r.humanCheck,
      },
      'trust_score',
    );
  }
}
