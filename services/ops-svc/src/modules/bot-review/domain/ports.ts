// 표본 검토가 바깥과 닿는 자리(저장소·후보 원장·trust 라벨·지표·로그).
import type {
  AppliedVerdict,
  BotReviewBatch,
  BotReviewJudgement,
  BotReviewSample,
  BotReviewVerdict,
  JudgementEvidenceKind,
  LabelResultValue,
  ReviewBatch,
  ReviewKind,
  SampleStatus,
  SampleTimelineStep,
} from './bot-review.js';

/** 멱등 키(platform IdempotencyRequest와 같은 모양). 도메인은 프레임워크 타입을 모른다 */
export interface JudgementIdempotency {
  readonly accountRef: string;
  readonly operation: string;
  readonly key: string;
  readonly requestHash: Uint8Array;
}
/** 후보 원장(분석 저장소 bot_sample_review)의 한 줄. 이 묶음은 읽기만 한다(OPS-220이 적재한다) */
export interface BotReviewCandidate {
  readonly sessionRef: string;
  /** 적용 판 판정 기록 사건 키(UUID). ApplyLabel의 verdict_event_key다 */
  readonly verdictEventKey: string;
  /** 신뢰 라벨을 부를 때만 읽고 저장하지 않는다(POL-006) */
  readonly pid: string;
  readonly reviewBatch: ReviewBatch;
  readonly appliedVerdict: AppliedVerdict;
  readonly riskBand: string | null;
  readonly behaviorSummaryBand: string | null;
  readonly timeline: readonly SampleTimelineStep[];
  readonly evidenceAvailable: readonly string[];
  /** 후보가 생긴 때(정렬 기준) */
  readonly occurredAtMs: number;
  /** 회차 오픈 시각. 배치 기한(retention_until·r2_due_at)을 여기서 만든다 */
  readonly openAtMs: number;
}

/** 후보 원장 읽기. SQL은 고정 문장이고 값만 매개변수로 넘긴다 */
export interface BotReviewSource {
  /** 그 회차·종류(와 묶음)의 후보 수(모집단). 배정이 쓴다 */
  population(q: { readonly eventId: string; readonly reviewKind: ReviewKind; readonly bundle?: ReviewBatch }): Promise<number>;
  /** 후보를 무작위로 읽는다(원장이 섞는다). 배정이 다시 섞어서 뽑는다 */
  candidates(q: {
    readonly eventId: string;
    readonly reviewKind: ReviewKind;
    readonly bundle?: ReviewBatch;
    readonly limit: number;
  }): Promise<readonly BotReviewCandidate[]>;
  /** 판정할 때만 pid를 읽는다. 없으면 undefined */
  pidOf(q: { readonly eventId: string; readonly verdictEventKey: string }): Promise<string | undefined>;
}

export interface BotReviewStoreListQuery {
  readonly batchId: string;
  readonly status?: SampleStatus;
  /** 이 ordinal보다 큰 것만(커서) */
  readonly afterOrdinal?: number;
  readonly limit: number;
}

export interface BotReviewStorePage {
  readonly items: readonly BotReviewSample[];
  /** 더 있으면 다음 커서로 쓸 ordinal */
  readonly nextOrdinal: number | null;
}

export interface RecordJudgementCommand {
  readonly sampleId: string;
  readonly verdict: BotReviewVerdict;
  readonly evidenceKinds: readonly JudgementEvidenceKind[];
  readonly labelResult: LabelResultValue;
  readonly recordedAtMs: number;
  /** 계정 × 작업 × 키 범위의 멱등 키. 같은 키·같은 본문 재시도는 같은 판정을 돌려준다 */
  readonly idem: JudgementIdempotency;
}

export interface RecordJudgementResult {
  readonly kind: 'RECORDED' | 'REPLAYED';
  readonly judgement: BotReviewJudgement;
}

/**
 * ops DB의 표 셋 저장소. 기록은 판정 행과 표본 상태를 같은 트랜잭션에 쓴다.
 * 같은 표본에 두 판정이 겹치면 하나만 RECORDED이고 다른 하나는 BotReviewProblem(already-recorded)이다.
 */
export interface BotReviewStore {
  findBatch(eventId: string, reviewKind: ReviewKind): Promise<BotReviewBatch | undefined>;
  /** 표본 배치를 한 트랜잭션에 쓴다. (event_id, review_kind)가 이미 있으면 false */
  insertBatch(batch: BotReviewBatch, samples: readonly BotReviewSample[]): Promise<boolean>;
  listSamples(query: BotReviewStoreListQuery): Promise<BotReviewStorePage>;
  findSample(sampleId: string): Promise<{ readonly sample: BotReviewSample; readonly batch: BotReviewBatch } | undefined>;
  findJudgement(sampleId: string): Promise<BotReviewJudgement | undefined>;
  countJudgements(batchId: string): Promise<{ readonly human: number; readonly bot: number; readonly undecided: number }>;
  recordJudgement(command: RecordJudgementCommand): Promise<RecordJudgementResult>;
}

/** trust-svc TrustLabelService.ApplyLabel에 SAMPLE_REVIEW로 보내는 값 */
export interface ApplySampleLabelInput {
  readonly sampleId: string;
  /** HUMAN·BOT만 온다. UNDECIDED는 부르지 않는다 */
  readonly label: 'HUMAN' | 'BOT';
  readonly eventId: string;
  readonly pid: string;
  readonly reviewBatch: ReviewBatch;
  readonly appliedVerdict: AppliedVerdict;
  readonly verdictEventKey: string;
  /** 요청자 관리 계정 ID. 내부 gRPC 처리자 증명에 쓴다 */
  readonly actedBy: string;
}

export interface AppliedSampleLabel {
  readonly changed: boolean;
  readonly blockList: 'NONE' | 'ADDED' | 'REMOVED' | 'DEVICE_NOT_FOUND';
}

export interface TrustLabels {
  apply(input: ApplySampleLabelInput): Promise<AppliedSampleLabel>;
}

/** 지표 두 개(ops_bot_review_judgements_total·ops_bot_review_label_failures_total) */
export interface BotReviewSignals {
  judgement(verdict: BotReviewVerdict, label: 'APPLIED' | 'UNCHANGED' | 'DEVICE_NOT_FOUND' | 'SKIPPED'): void;
  labelFailure(reason: 'unavailable' | 'invalid-argument' | 'already-exists' | 'device-not-found'): void;
}

/** 보안 로그 줄(ops_bot_review_judgement·ops_bot_review_label_failure). 원문 식별자는 싣지 않는다 */
export interface BotReviewLog {
  judgement(e: {
    readonly sampleId: string;
    readonly verdict: BotReviewVerdict;
    readonly reviewBatch: ReviewBatch;
    readonly label: LabelResultValue;
    readonly atMs: number;
    /** 처리자의 로그 가명. 없으면 싣지 않는다 */
    readonly accountRef?: string;
  }): void;
  labelFailure(e: { readonly sampleId: string; readonly reason: string; readonly atMs: number }): void;
}
