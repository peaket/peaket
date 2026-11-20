// 표본 판정 기록(POST /v1/ops/bot-review-samples/{sampleId}/judgement, SCR-067).
// - 표본마다 한 번이다. Idempotency-Key 재시도는 같은 200, 같은 표본에 다른 본문은 409다(저장소가 가른다).
// - ApplyLabel 전에 표본 단위 선점(claim)을 잡아 두 검토자가 겹쳐도 한 요청만 라벨을 부른다.
//   선점을 못 잡으면 다른 요청이 반영 중이므로 409 bot-review-claim-in-progress다.
// - HUMAN·BOT은 trust-svc ApplyLabel(source SAMPLE_REVIEW, 판 1, review_batch, applied_verdict, verdict_event_key)을 부른다.
//   UNDECIDED는 부르지 않고 판정 행에만 남긴다(ADR-0258 결정 3).
// - ApplyLabel이 실패하면 판정 행을 커밋하지 않고 503 bot-review-label-unavailable이다(B15).
//   trust가 성공한 뒤 응답을 잃은 재시도는 같은 판 1이라 changed false이고, 그때 판정 행을 UNCHANGED로 쓴다.
import { randomUUID } from 'node:crypto';
import {
  BotReviewLabelFailure,
  BotReviewProblem,
  claimInProgress,
  evidenceRequired,
  isUuid,
  JUDGEMENT_CLAIM_MS,
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
    let claimId: string | undefined;
    let labelResult: LabelResultValue;
    if (existing) {
      // 이미 끝난 표본이다. 저장소가 같은 키의 재시도면 같은 판정을, 다른 본문이면 409를 돌려준다.
      // 라벨은 다시 부르지 않는다(같은 판 1 재시도는 trust도 changed false로 답한다).
      labelResult = existing.labelResult;
    } else {
      if (found.batch.reviewKind === 'HUMAN_BASELINE' && verdict === 'BOT' && evidenceKinds.length === 0) throw evidenceRequired();
      // 라벨을 부르기 전에 표본 단위 선점을 잡는다. 두 검토자가 다른 키로 동시에 와도 한 요청만 라벨을 부른다
      const claim = randomUUID();
      const claimed = await this.deps.store.claimJudgement({
        sampleId: found.sample.sampleId,
        claimId: claim,
        nowMs: now,
        expiresAtMs: now + JUDGEMENT_CLAIM_MS,
      });
      if (!claimed) {
        // 그사이 다른 요청이 기록을 끝냈으면 그 판정으로 이어간다(같은 키 재시도는 200, 다른 본문은 409).
        // 아직 라벨을 반영하는 중이면 이 요청은 409다
        const raced = await this.deps.store.findJudgement(found.sample.sampleId);
        if (!raced) throw claimInProgress();
        labelResult = raced.labelResult;
      } else {
        claimId = claim;
        try {
          labelResult = verdict === 'UNDECIDED' ? 'SKIPPED' : await this.#applyLabel(found, verdict, input.actedBy, now);
        } catch (e) {
          // 라벨을 못 반영했으면 판정 행을 쓰지 않고 선점을 푼다(같은 키로 다시 시도할 수 있게)
          await this.#release(found.sample.sampleId, claim);
          throw e;
        }
      }
    }

    let recorded: Awaited<ReturnType<BotReviewStore['recordJudgement']>>;
    try {
      recorded = await this.deps.store.recordJudgement({
        sampleId: found.sample.sampleId,
        verdict,
        evidenceKinds,
        labelResult,
        recordedAtMs: now,
        ...(claimId !== undefined ? { claimId } : {}),
        idem: input.idem,
      });
    } catch (e) {
      if (claimId !== undefined) await this.#release(found.sample.sampleId, claimId);
      throw e;
    }
    // 저장소가 기록과 함께 선점을 비우지만, 재시도 경로(이미 있는 판정)는 비우지 않으므로 한 번 더 푼다
    if (claimId !== undefined) await this.#release(found.sample.sampleId, claimId);
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

  /** 선점을 푼다. 풀지 못해도 수명이 지나면 다시 잡을 수 있으므로 원래 오류를 가리지 않는다 */
  async #release(sampleId: string, claimId: string): Promise<void> {
    try {
      await this.deps.store.releaseJudgementClaim({ sampleId, claimId });
    } catch {
      // 아래 판정 기록·503이 이미 사용자에게 갈 답이다
    }
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
      return labelResultOf(applied);
    } catch (e) {
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
  // changed false를 먼저 본다. trust는 성공한 판 1을 다시 부를 때 DONE(changed false)과 처음 결과(ADDED/REMOVED)를
  // 함께 주므로, 응답을 잃은 재시도는 APPLIED가 아니라 UNCHANGED다(계획 B15·§7.3).
  if (!applied.changed) return 'UNCHANGED';
  if (applied.blockList === 'DEVICE_NOT_FOUND') return 'DEVICE_NOT_FOUND';
  return 'APPLIED';
}

const invalidBody = (): BotReviewProblem => new BotReviewProblem('invalid-body', 400, '판정 본문이 올바르지 않습니다');
