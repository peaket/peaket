// 봇 판정 표본 검토 도메인(FR-049, SCR-067, ADR-0174, BAT-197).
// - 표본 묶음은 둘이다: 통과 세션 표본(PASSED_SAMPLE)과 출시 뒤 사람 기준 표본(HUMAN_BASELINE, 두 묶음 섞기).
// - 카드에는 세션 가명·판정 사건 키·위험 점수 범주·행동 요약 범주·타임라인·있는 근거 종류만 둔다.
//   pid·계정 ID·IP·기기 가명·점수 원값·가중치는 어디에도 싣지 않는다(POL-006).
// - 판정은 표본마다 한 번이고 HUMAN·BOT·UNDECIDED 셋이다. UNDECIDED는 trust-svc로 보내지 않는다.
// - 중간 결과는 UNDECIDED를 뺀 BOT 비율의 Wilson 95% 구간이다. 마감 지표가 아니라 화면용 잠정값이다.
import { createHash } from 'node:crypto';

export const REVIEW_KINDS = ['PASSED_SAMPLE', 'HUMAN_BASELINE'] as const;
export type ReviewKind = (typeof REVIEW_KINDS)[number];
export const DEFAULT_REVIEW_KIND: ReviewKind = 'PASSED_SAMPLE';

export const SAMPLE_STATUSES = ['PENDING', 'RECORDED'] as const;
export type SampleStatus = (typeof SAMPLE_STATUSES)[number];

export const BOT_REVIEW_VERDICTS = ['HUMAN', 'BOT', 'UNDECIDED'] as const;
export type BotReviewVerdict = (typeof BOT_REVIEW_VERDICTS)[number];

/** 판정에 실을 수 있는 근거 종류. OTHER는 d5의 '그 밖' 자리다(메모 칸은 계약에 없다) */
export const JUDGEMENT_EVIDENCE_KINDS = ['CONFIRMED_SIGNAL', 'SHARED_DEVICE_OR_PAYMENT', 'POST_LABEL', 'VERIFICATION_FAILED', 'OTHER'] as const;
export type JudgementEvidenceKind = (typeof JUDGEMENT_EVIDENCE_KINDS)[number];

/** 카드에 보이는 근거 종류(메모 자리 OTHER는 카드에 없다) */
export const SAMPLE_EVIDENCE_KINDS = ['CONFIRMED_SIGNAL', 'SHARED_DEVICE_OR_PAYMENT', 'POST_LABEL', 'VERIFICATION_FAILED'] as const;

/** trust.proto ApplyLabel의 review_batch */
export const REVIEW_BATCHES = ['PASSED', 'SHADOW_CHALLENGED'] as const;
export type ReviewBatch = (typeof REVIEW_BATCHES)[number];

/** trust.proto ApplyLabel의 applied_verdict */
export const APPLIED_VERDICTS = ['ALLOW', 'CHALLENGE'] as const;
export type AppliedVerdict = (typeof APPLIED_VERDICTS)[number];

/** 판정 행에 남는 라벨 결과(표 구조 §7.3) */
export const LABEL_RESULTS = ['APPLIED', 'UNCHANGED', 'DEVICE_NOT_FOUND', 'SKIPPED'] as const;
export type LabelResultValue = (typeof LABEL_RESULTS)[number];

export const TIMELINE_STEPS = ['ENTRY', 'HOLD', 'PAYMENT'] as const;
export type TimelineStep = (typeof TIMELINE_STEPS)[number];

export interface SampleTimelineStep {
  readonly step: TimelineStep;
  readonly atMs: number;
}

/** 회차·종류에 하나뿐인 표본 배치. 기한은 core를 다시 부르지 않고 여기서 읽는다 */
export interface BotReviewBatch {
  readonly batchId: string;
  readonly eventId: string;
  readonly reviewKind: ReviewKind;
  /** 섞기 씨앗값. 같은 값이면 같은 순서가 나온다 */
  readonly seed: string;
  readonly targetCount: number;
  readonly populationCount: number;
  /** 행동 신호 삭제(오픈 + 30일 [가정]) */
  readonly retentionUntilMs: number;
  /** R2 마감(오픈 + 7일 [가정]) */
  readonly r2DueAtMs: number;
  readonly createdAtMs: number;
}

/** 검토할 세션 카드. pid·기기 가명·점수 원값은 없다 */
export interface BotReviewSample {
  readonly sampleId: string;
  readonly batchId: string;
  readonly sessionRef: string;
  /** 뽑힌 세션의 적용 판 판정 기록 사건 키. ApplyLabel의 verdict_event_key다 */
  readonly verdictEventKey: string;
  readonly status: SampleStatus;
  readonly riskBand: string | null;
  readonly behaviorSummaryBand: string | null;
  readonly timeline: readonly SampleTimelineStep[];
  readonly evidenceAvailable: readonly string[];
  /** 서버가 섞은 순서. 화면은 이 값을 그대로 쓴다 */
  readonly ordinal: number;
  readonly createdAtMs: number;
  /**
   * ApplyLabel에 실을 묶음 표시·적용 판 판정. API 응답에는 싣지 않는다(HUMAN_BASELINE의 가림).
   * 사람 기준 표본은 두 묶음이 한 배치에 섞여 있어 표본마다 따로 보관한다.
   */
  readonly reviewBatch: ReviewBatch;
  readonly appliedVerdict: AppliedVerdict;
}

export interface BotReviewJudgement {
  readonly sampleId: string;
  readonly verdict: BotReviewVerdict;
  readonly evidenceKinds: readonly JudgementEvidenceKind[];
  readonly labelResult: LabelResultValue;
  readonly recordedAtMs: number;
}

export interface BotReviewCounts {
  readonly human: number;
  readonly bot: number;
  readonly undecided: number;
}

export interface BotReviewInterim {
  readonly missedBotRate: number;
  readonly ci95Low: number;
  readonly ci95High: number;
}

// ---- 응답 보기 ----

export interface OpsBotReviewView {
  readonly eventId: string;
  readonly reviewKind: ReviewKind;
  readonly reviewedCount: number;
  readonly targetCount: number;
  readonly deadlineAt: string;
  readonly r2DueAt: string | null;
  readonly interim: BotReviewInterim | null;
}

export interface OpsBotReviewSampleView {
  readonly sampleId: string;
  readonly sessionRef: string;
  readonly status: SampleStatus;
  readonly riskBand: string | null;
  readonly behaviorSummaryBand: string | null;
  readonly timeline: readonly { readonly step: TimelineStep; readonly at: string }[];
  readonly evidenceAvailable: readonly string[];
}

export interface OpsBotReviewSamplePage {
  readonly items: readonly OpsBotReviewSampleView[];
  readonly nextCursor: string | null;
}

export interface OpsBotReviewJudgementView {
  readonly sampleId: string;
  readonly verdict: BotReviewVerdict;
  readonly recordedAt: string;
}

// ---- 값 ----

/** 표본 목표(FR-049, [가정]) */
export const PASSED_SAMPLE_TARGET = 200;
/** 사람 기준 표본은 통과·그림자 추가 검증 묶음마다 200건 [가정]이다(두 묶음 합 400) */
export const HUMAN_BASELINE_GROUP_TARGET = 200;
export const HUMAN_BASELINE_TARGET = HUMAN_BASELINE_GROUP_TARGET * 2;
/** 행동 신호 삭제(오픈 + 30일 [가정], bot-defense §13) */
export const REVIEW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
/** R2 마감(오픈 + 7일 [가정]) */
export const REVIEW_R2_DUE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_SAMPLE_LIMIT = 50;
export const MAX_SAMPLE_LIMIT = 100;
/**
 * 판정 선점(claim) 수명. 같은 표본에 두 검토자가 겹칠 때 한 요청만 ApplyLabel을 부르게 한다.
 * ApplyLabel 데드라인(5초 [가정])과 DB 쓰기를 넉넉히 덮되, 요청이 죽어도 이 시간 뒤에는 다시 시도할 수 있다.
 */
export const JUDGEMENT_CLAIM_MS = 30_000;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const isUuid = (value: string): boolean => UUID.test(value.toLowerCase());

/** 질의의 reviewKind. 없으면 기본 PASSED_SAMPLE, 모르는 값은 400이다 */
export function parseReviewKind(raw: string | undefined | null): ReviewKind {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_REVIEW_KIND;
  if ((REVIEW_KINDS as readonly string[]).includes(raw)) return raw as ReviewKind;
  throw new BotReviewProblem('invalid-query', 400, 'reviewKind는 PASSED_SAMPLE·HUMAN_BASELINE 가운데 하나여야 합니다');
}

export function targetOf(reviewKind: ReviewKind): number {
  return reviewKind === 'HUMAN_BASELINE' ? HUMAN_BASELINE_TARGET : PASSED_SAMPLE_TARGET;
}

export function isReviewKind(value: string): value is ReviewKind {
  return (REVIEW_KINDS as readonly string[]).includes(value);
}

// ---- 중간 결과(Wilson 95%) ----

const Z95 = 1.959963984540054;

/** 이항 비율의 Wilson 95% 구간. 표본이 0이면 부르지 않는다 */
export function wilsonInterval(successes: number, total: number): { readonly low: number; readonly high: number } {
  if (!(Number.isInteger(successes) && Number.isInteger(total) && total > 0 && successes >= 0 && successes <= total)) {
    throw new RangeError(`Wilson 구간: successes=${successes}, total=${total}`);
  }
  const p = successes / total;
  const z2 = Z95 * Z95;
  const denominator = 1 + z2 / total;
  const center = (p + z2 / (2 * total)) / denominator;
  const margin = (Z95 * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total)) / denominator;
  return { low: Math.max(0, center - margin), high: Math.min(1, center + margin) };
}

/**
 * 중간 결과는 UNDECIDED를 뺀 BOT ÷ (HUMAN + BOT)의 Wilson 95% 구간이다.
 * 판정한 표본이 0건이면 null이고, HUMAN_BASELINE은 부르는 쪽이 null로 둔다(묶음을 알아낼 단서가 된다).
 */
export function interimOf(counts: BotReviewCounts): BotReviewInterim | null {
  const decided = counts.human + counts.bot;
  if (decided === 0) return null;
  const interval = wilsonInterval(counts.bot, decided);
  return { missedBotRate: counts.bot / decided, ci95Low: interval.low, ci95High: interval.high };
}

// ---- 화면 보기로 바꾸기 ----

export function progressView(batch: BotReviewBatch, counts: BotReviewCounts): OpsBotReviewView {
  return {
    eventId: batch.eventId,
    reviewKind: batch.reviewKind,
    reviewedCount: counts.human + counts.bot + counts.undecided,
    targetCount: batch.targetCount,
    deadlineAt: new Date(batch.retentionUntilMs).toISOString(),
    // R2가 행동 신호 삭제보다 먼저다. 같은 날이면 둘 다 남긴다
    r2DueAt: new Date(batch.r2DueAtMs).toISOString(),
    interim: batch.reviewKind === 'HUMAN_BASELINE' ? null : interimOf(counts),
  };
}

/** 카드 보기. HUMAN_BASELINE은 위험 점수 범주·행동 요약 범주를 싣지 않는다(d5 §7.15) */
export function sampleView(sample: BotReviewSample, reviewKind: ReviewKind): OpsBotReviewSampleView {
  const hidden = reviewKind === 'HUMAN_BASELINE';
  return {
    sampleId: sample.sampleId,
    sessionRef: sample.sessionRef,
    status: sample.status,
    riskBand: hidden ? null : sample.riskBand,
    behaviorSummaryBand: hidden ? null : sample.behaviorSummaryBand,
    timeline: sample.timeline.map((t) => ({ step: t.step, at: new Date(t.atMs).toISOString() })),
    evidenceAvailable: sample.evidenceAvailable,
  };
}

export function judgementView(judgement: BotReviewJudgement): OpsBotReviewJudgementView {
  return { sampleId: judgement.sampleId, verdict: judgement.verdict, recordedAt: new Date(judgement.recordedAtMs).toISOString() };
}

export function remainingCount(view: OpsBotReviewView): number {
  return Math.max(0, view.targetCount - view.reviewedCount);
}

// ---- 섞기 ----

/**
 * 씨앗값으로 섞는다(같은 씨앗이면 같은 순서). 두 묶음을 앞뒤로 붙이지 않고 한 줄로 섞는 데 쓴다.
 * 배열을 바꾸지 않고 새 배열을 돌려준다.
 */
export function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const out = items.slice();
  let state = createHash('sha256').update(seed, 'utf8').digest().readUInt32LE(0) || 0x9e3779b9;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let i = out.length - 1; i > 0; i--) {
    const j = next() % (i + 1);
    const a = out[i]!;
    out[i] = out[j]!;
    out[j] = a;
  }
  return out;
}

// ---- 오류 ----

/** 받는 층이 Problem으로 바꾸는 업무 오류 */
export class BotReviewProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    title: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(title);
    this.name = 'BotReviewProblem';
  }
}

export const notFound = (): BotReviewProblem => new BotReviewProblem('not-found', 404, '표본을 찾을 수 없습니다');
export const retentionEnded = (): BotReviewProblem => new BotReviewProblem('retention-ended', 410, '행동 신호 보존 기한이 지나 표본을 검토할 수 없습니다');
export const alreadyRecorded = (): BotReviewProblem => new BotReviewProblem('bot-review-already-recorded', 409, '이미 판정을 기록한 표본입니다');
/** 같은 표본에 두 요청이 겹쳤고 다른 요청이 라벨을 반영하는 중이다. 한 요청만 ApplyLabel을 부른다 */
export const claimInProgress = (): BotReviewProblem =>
  new BotReviewProblem('bot-review-claim-in-progress', 409, '다른 요청이 이 표본의 판정을 반영하는 중입니다. 잠시 뒤 다시 확인해 주세요', 1);
export const evidenceRequired = (): BotReviewProblem =>
  new BotReviewProblem('bot-review-evidence-required', 422, '사람 기준 표본을 봇으로 판정하려면 행동 요약 밖의 근거를 하나 이상 골라야 합니다');
export const labelUnavailable = (): BotReviewProblem =>
  new BotReviewProblem('bot-review-label-unavailable', 503, '봇 라벨을 반영하지 못했습니다. 잠시 뒤 같은 요청을 다시 보내 주세요', 1);
export const sourceUnavailable = (): BotReviewProblem =>
  new BotReviewProblem('bot-review-source-unavailable', 503, '표본 후보 원장에 닿지 못했습니다. 잠시 뒤 다시 시도해 주세요', 1);

/** trust-svc ApplyLabel이 거절하거나 답하지 못했을 때의 사유(지표 라벨) */
export class BotReviewLabelFailure extends Error {
  constructor(readonly reason: 'unavailable' | 'invalid-argument' | 'already-exists' | 'device-not-found') {
    super(`label ${reason}`);
    this.name = 'BotReviewLabelFailure';
  }
}

/** 표본 후보 원장(gRPC가 아니라 ClickHouse 읽기)이 답하지 못했다 */
export class BotReviewSourceFailure extends Error {
  constructor(readonly detail: string) {
    super(detail);
    this.name = 'BotReviewSourceFailure';
  }
}

/** 오픈 시각에서 기한을 만든다. 후보 원장의 open_at을 쓴다 */
export function deadlinesFrom(openAtMs: number): { readonly retentionUntilMs: number; readonly r2DueAtMs: number } {
  if (!Number.isFinite(openAtMs) || openAtMs <= 0) throw new RangeError(`openAtMs=${openAtMs}`);
  return { retentionUntilMs: openAtMs + REVIEW_RETENTION_MS, r2DueAtMs: openAtMs + REVIEW_R2_DUE_MS };
}
