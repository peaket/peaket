// 운영 신호(docs/features/bot-defense.md §15·§16)와 정규 로그 줄 trust_score. 라벨은 가짓수가 적은 것만 쓰고 사유 범주는 라벨로 쓰지 않는다.
import { Counter, type Registry } from '@peaket/platform';
import type { LabelSource } from '../domain/labels.js';
import type { BlockListChangeLog, FeatureName, MigrationFeature, TrustSignals, VerdictRecord, VerdictRecorder } from '../domain/ports.js';
import type { MissingCause } from '../domain/scorers.js';
import type { HardSignal, HumanCheckResult, ScoreContext, ScorerName, Verdict } from '../domain/types.js';

export class PromTrustSignals implements TrustSignals {
  readonly #verdicts = new Counter({ name: 'trust_verdicts_total', help: '판정 수', labelNames: ['context', 'verdict'] as const, registers: [] });
  readonly #human = new Counter({ name: 'trust_human_check_total', help: '사람 확인 서버 검증 결과(PASSED·FAILED·PENDING)', labelNames: ['result'] as const, registers: [] });
  readonly #missing = new Counter({ name: 'trust_scorer_missing_total', help: '값 없음이 된 점수기(cause: dependency 의존성 장애, absent 원래 없는 값)', labelNames: ['scorer', 'cause'] as const, registers: [] });
  readonly #hard = new Counter({ name: 'trust_block_list_hits_total', help: '확정 신호로 판정을 앞에서 정한 수(signal: BLOCK_LIST·HONEYPOT)', labelNames: ['signal'] as const, registers: [] });
  readonly #feature = new Counter({ name: 'trust_feature_read_failures_total', help: '판정 피처 키를 읽거나 쓰지 못한 수(feature: block·honeypot·accounts·history·shared·entries)', labelNames: ['feature'] as const, registers: [] });
  readonly #after = new Counter({ name: 'trust_after_response_failures_total', help: '응답 뒤로 미룬 쓰기 실패', labelNames: ['work'] as const, registers: [] });
  readonly #honeypot = new Counter({ name: 'trust_honeypot_hits_total', help: '허니팟 기록 조건을 만족한 적중(signed_in: 로그인한 요청)', labelNames: ['signed_in'] as const, registers: [] });
  readonly #invRef = new Counter({ name: 'inv_ref_missing_total', help: '라벨 키가 없어 계산하지 못한 조사용 가명(SEV3, docs/observability.md §5)', labelNames: ['service', 'label', 'reason'] as const, registers: [] });
  readonly #shadow = new Counter({ name: 'trust_shadow_disagreements_total', help: '그림자 판과 적용 판의 판정이 갈린 수(direction: shadow_only 그림자 판만 추가 검증, active_only 적용 판만 추가 검증)', labelNames: ['direction'] as const, registers: [] });
  readonly #migrations = new Counter({ name: 'trust_inv_ref_migrations_total', help: '기기 라벨 키 회전의 이음에서 옛 판 키를 새 판 키로 옮긴 수(result: moved·failed·skipped)', labelNames: ['feature', 'result'] as const, registers: [] });
  readonly #blockList = new Counter({ name: 'trust_block_list_changes_total', help: '라벨 반영이 차단 기기 목록을 바꾼 수(op: added·removed, source: 라벨 출처)', labelNames: ['op', 'source'] as const, registers: [] });

  register(registry: Registry): void {
    registry.registerMetric(this.#verdicts);
    registry.registerMetric(this.#human);
    registry.registerMetric(this.#missing);
    registry.registerMetric(this.#hard);
    registry.registerMetric(this.#feature);
    registry.registerMetric(this.#after);
    registry.registerMetric(this.#honeypot);
    registry.registerMetric(this.#invRef);
    registry.registerMetric(this.#shadow);
    registry.registerMetric(this.#migrations);
    registry.registerMetric(this.#blockList);
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

  afterFailed(work: 'challenge' | 'verification' | 'account' | 'honeypot'): void {
    this.#after.inc({ work });
  }

  honeypotHit(signedIn: boolean): void {
    this.#honeypot.inc({ signed_in: signedIn ? 'true' : 'false' });
  }

  invRefMissing(label: string, reason: 'THROTTLED' | 'KMS_ERROR' | 'NO_KEY'): void {
    this.#invRef.inc({ service: 'trust-svc', label, reason });
  }

  shadowDisagreement(direction: 'shadow_only' | 'active_only'): void {
    this.#shadow.inc({ direction });
  }

  invRefMigration(feature: MigrationFeature, result: 'moved' | 'failed' | 'skipped'): void {
    this.#migrations.inc({ feature, result });
  }

  blockListChange(op: 'added' | 'removed', source: LabelSource): void {
    this.#blockList.inc({ op, source });
  }
}

/**
 * 정규 로그 줄 trust_score(§15). Kafka 판정 기록은 json-telemetry-recorder.ts가 함께 낸다.
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
        // 그림자 판(§10.4)이 돌았으면 그 판정과 판 번호를 같은 줄에 적는다
        ...(r.shadow ? { shadowVerdict: r.shadow.verdict, shadowProfileVersion: r.shadow.profileVersion } : {}),
      },
      'trust_score',
    );
  }
}

/**
 * 라벨 반영의 보안 로그(docs/features/bot-defense.md §9 '기록'·'실패', ASVS 16.3.3·16.3.4).
 * - change: 차단 키를 바꾼 줄 trust_block_list_change(건 ID, 출처, 바뀐 것, 처리자의 로그 가명 accountRef, 시각). 운영 로그에 기기 가명과 처리자 원문 ID는 쓰지 않는다
 *   (docs/observability.md §7 '선택적 비즈니스 필드'). 어느 기기를 바꿨는지는 ops-svc가 응답과 함께 처리함 건·사건 기록에 남긴다
 * - failed: 저장소에 닿지 못한 경고 줄 trust_label_apply_failed(건 ID, 출처, 실패한 단계)
 * 칸을 하나씩 골라 싣는다. 로거가 던져도 삼킨다(라벨 반영을 막지 않는다)
 */
export class LogBlockListChange implements BlockListChangeLog {
  constructor(
    private readonly logger: { info(fields: Record<string, unknown>, message: string): void; warn(fields: Record<string, unknown>, message: string): void },
    private readonly pseudonymizer: { ref(value: string): string },
  ) {}

  change(e: Parameters<BlockListChangeLog['change']>[0]): void {
    try {
      const line = { kind: 'security', event: 'trust_block_list_change', caseId: e.caseId, source: e.source, change: e.change, accountRef: this.pseudonymizer.ref(e.actedBy), at: new Date(e.atMs).toISOString() };
      this.logger.info(line, 'trust_block_list_change');
    } catch {
      // 로그 실패는 응답을 바꾸지 않는다
    }
  }

  failed(e: Parameters<BlockListChangeLog['failed']>[0]): void {
    try {
      this.logger.warn({ kind: 'security', event: 'trust_label_apply_failed', caseId: e.caseId, source: e.source, step: e.step }, '라벨 반영 저장소에 닿지 못해 UNAVAILABLE로 답했다(ops-svc가 다시 보낸다)');
    } catch {
      // 로그 실패는 응답을 바꾸지 않는다
    }
  }
}
