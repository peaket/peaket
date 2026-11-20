// 표본 판정 기록(POST /v1/ops/bot-review-samples/{sampleId}/judgement, SCR-067).
// - 표본마다 한 번이다. Idempotency-Key 재시도는 같은 200, 같은 표본에 다른 본문은 409다(저장소가 가른다).
// - HUMAN·BOT은 trust-svc ApplyLabel(source SAMPLE_REVIEW, 판 1, review_batch, applied_verdict, verdict_event_key)을 부른다.
//   UNDECIDED는 부르지 않고 판정 행에만 남긴다(ADR-0258 결정 3).
// - ApplyLabel이 실패하면 판정 행을 커밋하지 않고 503 bot-review-label-unavailable이다(B15).
//   trust가 성공한 뒤 응답을 잃은 재시도는 같은 판 1이라 changed false이고, 그때 판정 행을 쓴다.
import {
  BotReviewLabelFailure,
  BotReviewProblem,
  evidenceRequired,
  isUuid,
  JUDGEMENT_EVIDENCE_KINDS,
  labelUnavailable,
  notFound,
  retentionEnded,
  BOT_REVIEW_VERDICTS,
  type BotReviewJudgement,
  type BotReviewVerdict,
  type JudgementEvidenceKind,
  type LabelResultValue,
} from '../domain/bot-review.js';
import type { BotReviewLog, BotReviewSignals, BotReviewSource, BotReviewStore, TrustLabels } from '../domain/ports.js';
import type { IdempotencyRequest } from '@peaket/platform';

export interface RecordJudgementInput {
  readonly sampleId: string;
  readonly verdict: string;
  readonly evidenceKinds?: readonly string[];
  /** Principal의 관리 계정 ID. 본문에서 받지 않는다 */
  readonly actedBy: string;
  readonly idem: IdempotencyRequest;
}

export interface RecordJudgementDeps {
  readonly store: BotReviewStore;
  readonly source: BotReviewSource;
  /** 없으면 HUMAN·BOT 판정이 503이다(UNDECIDED는 그대로 기록) */
  readonly labels?: TrustLabels | undefined;
  readonly now: () => number;
  readonly signals?: BotReviewSignals | undefined;
  readonly log?: BotReviewLog | undefined;
  /** 처리자 원문 ID를 로그 가명으로 바꾼다. 없으면 로그에 처리자를 싣지 않는다 */
  readonly accountRef?: ((accountId: string) => string | undefined) | undefined;
}

export class RecordBotReviewJudgement {
  constructor(private readonly deps: RecordJudgementDeps) {}

  async run(input: RecordJudgementInput): Promise<BotReviewJudgement> {
    const verdict = verdictOf(input.verdict);
    const evidenceKinds = evidenceOf(input.evidenceKinds);
    if (!isUuid(input.sampleId)) throw notFound();
    const found = await this.deps.store.findSample(input.sampleId.toLowerCase());
    if (!found) throw notFound();
    const now = this.deps.now();
    if (now > found.batch.retentionUntilMs) throw retentionEnded();

    const existing = await this.deps.store.findJudgement(found.sample.sampleId);
    let labelResult: LabelResultValue;
    if (existing) {
      // 이미 끝난 표본이다. 저장소가 같은 키의 재시도면 같은 판정을, 다른 본문이면 409를 돌려준다.
      // 라벨은 다시 부르지 않는다(같은 판 1 재시도는 trust도 changed false로 답한다).
      labelResult = existing.labelResult;
    } else if (verdict === 'UNDECIDED') {
      labelResult = 'SKIPPED';
    } else {
      if (found.batch.reviewKind === 'HUMAN_BASELINE' && verdict === 'BOT' && evidenceKinds.length === 0) throw evidenceRequired();
      labelResult = await this.#applyLabel(found, verdict, input.actedBy, now);
    }

    const recorded = await this.deps.store.recordJudgement({
      sampleId: found.sample.sampleId,
      verdict,
      evidenceKinds,
      labelResult,
      recordedAtMs: now,
      idem: input.idem,
    });
    if (recorded.kind === 'RECORDED') {
      this.deps.signals?.judgement(verdict, labelResult);
      const accountRef = this.deps.accountRef?.(input.actedBy);
      this.deps.log?.judgement({
        sampleId: found.sample.sampleId,
        verdict,
        reviewBatch: found.sample.reviewBatch,
        label: labelResult,
        atMs: recorded.judgement.recordedAtMs,
        ...(accountRef ? { accountRef } : {}),
      });
    }
    return recorded.judgement;
  }

  /** ApplyLabel. 실패는 503 label-unavailable이고 판정 행을 쓰지 않는다 */
  async #applyLabel(found: NonNullable<Awaited<ReturnType<BotReviewStore['findSample']>>>, verdict: Exclude<BotReviewVerdict, 'UNDECIDED'>, actedBy: string, now: number): Promise<LabelResultValue> {
    const labels = this.deps.labels;
    if (!labels) {
      this.deps.signals?.labelFailure('unavailable');
      this.deps.log?.labelFailure({ sampleId: found.sample.sampleId, reason: 'unavailable', atMs: now });
      throw labelUnavailable();
    }
    let pid: string | undefined;
    try {
      pid = await this.deps.source.pidOf({ eventId: found.batch.eventId, verdictEventKey: found.sample.verdictEventKey });
    } catch {
      // 라벨을 부르려면 원장의 pid가 필요하다. 읽지 못하면 라벨 실패로 보고 판정 행을 쓰지 않는다
      this.deps.signals?.labelFailure('unavailable');
      this.deps.log?.labelFailure({ sampleId: found.sample.sampleId, reason: 'unavailable', atMs: now });
      throw labelUnavailable();
    }
    if (!pid) {
      this.deps.signals?.labelFailure('device-not-found');
      this.deps.log?.labelFailure({ sampleId: found.sample.sampleId, reason: 'device-not-found', atMs: now });
      throw labelUnavailable();
    }
    try {
      const applied = await labels.apply({
        sampleId: found.sample.sampleId,
        label: verdict,
        eventId: found.batch.eventId,
        pid,
        reviewBatch: found.sample.reviewBatch,
        appliedVerdict: found.sample.appliedVerdict,
        verdictEventKey: found.sample.verdictEventKey,
        actedBy,
      });
      return labelResultOf(applied);    } catch (e) {
      const reason = e instanceof BotReviewLabelFailure ? e.reason : 'unavailable';
      this.deps.signals?.labelFailure(reason);
      this.deps.log?.labelFailure({ sampleId: found.sample.sampleId, reason, atMs: now });
      throw labelUnavailable();
    }
  }
}

function verdictOf(raw: string): BotReviewVerdict {
  if ((BOT_REVIEW_VERDICTS as readonly string[]).includes(raw)) return raw as BotReviewVerdict;
  throw invalidBody();
}

function evidenceOf(raw: readonly string[] | undefined): readonly JudgementEvidenceKind[] {
  const values = raw ?? [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!(JUDGEMENT_EVIDENCE_KINDS as readonly string[]).includes(value)) throw invalidBody();
    if (seen.has(value)) throw invalidBody();
    seen.add(value);
  }
  return values as readonly JudgementEvidenceKind[];
}

function labelResultOf(applied: { readonly changed: boolean; readonly blockList: 'NONE' | 'ADDED' | 'REMOVED' | 'DEVICE_NOT_FOUND' }): LabelResultValue {
  if (applied.blockList === 'ADDED' || applied.blockList === 'REMOVED') return 'APPLIED';
  if (applied.blockList === 'DEVICE_NOT_FOUND') return 'DEVICE_NOT_FOUND';
  return applied.changed ? 'APPLIED' : 'UNCHANGED';
}

const invalidBody = (): BotReviewProblem => new BotReviewProblem('invalid-body', 400, '판정 본문이 올바르지 않습니다');
