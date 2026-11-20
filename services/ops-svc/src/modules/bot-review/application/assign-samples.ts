// 표본 배정(BOT-080, FR-049, bot-defense §13 424, 계획 G2).
// 후보 원장에서 PASSED_SAMPLE은 통과 세션 200건 [가정], HUMAN_BASELINE은 통과 200 + 그림자 추가 검증 200을 뽑아
// 한 줄로 섞어 bot_review_batch·bot_review_sample에 넣는다. 묶음 전체가 200건 이하면 전수 검토한다.
// 같은 회차·종류에 두 번 돌려도 배치 하나만 만든다(DB 유일 제약이 마지막 가드다).
// 원장 적재는 OPS-220 몫이다. 여기서는 읽기 계약(BotReviewSource)만 쓴다.
import { randomUUID } from 'node:crypto';
import {
  BotReviewProblem,
  deadlinesFrom,
  HUMAN_BASELINE_GROUP_TARGET,
  isUuid,
  PASSED_SAMPLE_TARGET,
  seededShuffle,
  type BotReviewBatch,
  type BotReviewSample,
  type ReviewBatch,
  type ReviewKind,
} from '../domain/bot-review.js';
import type { BotReviewCandidate, BotReviewSource, BotReviewStore } from '../domain/ports.js';

export interface AssignBotReviewInput {
  readonly eventId: string;
  readonly reviewKind: ReviewKind;
}

export interface AssignBotReviewResult {
  /** 후보가 없어 배치를 만들지 않았으면 null */
  readonly batchId: string | null;
  /** 이번 호출이 배치를 만들었는가 */
  readonly created: boolean;
  readonly sampleCount: number;
  readonly populationCount: number;
}

/** 한 번에 원장에서 읽는 최대 행. 200+200만 뽑으므로 넉넉하되 한 요청이 무한정 읽지 않게 둔다 */
const CANDIDATE_READ_LIMIT = 2_000;

export interface AssignBotReviewDeps {
  readonly store: BotReviewStore;
  readonly source: BotReviewSource;
  readonly now: () => number;
  /** 씨앗값을 바꿔 끼우는 자리(시험). 없으면 무작위 UUID */
  readonly newSeed?: () => string;
  readonly newId?: () => string;
}

export class AssignBotReviewSamples {
  constructor(private readonly deps: AssignBotReviewDeps) {}

  /**
   * 배치를 만들거나 이미 있으면 그대로 돌려준다. 후보가 없으면 아무것도 만들지 않는다(진행 GET은 404).
   * 원장이 답하지 못하면 BotReviewProblem(source-unavailable)이다.
   */
  async run(input: AssignBotReviewInput): Promise<AssignBotReviewResult> {
    const { store, source } = this.deps;
    if (!isUuid(input.eventId)) throw new BotReviewProblem('not-found', 404, '회차를 찾을 수 없습니다');
    const eventId = input.eventId.toLowerCase();
    const existing = await store.findBatch(eventId, input.reviewKind);
    if (existing) return { batchId: existing.batchId, created: false, sampleCount: existing.targetCount, populationCount: existing.populationCount };

    const bundles: readonly ReviewBatch[] = input.reviewKind === 'HUMAN_BASELINE' ? ['PASSED', 'SHADOW_CHALLENGED'] : ['PASSED'];
    const selected: BotReviewCandidate[] = [];
    let populationCount = 0;
    for (const bundle of bundles) {
      const population = await this.#population(eventId, input.reviewKind, bundle);
      populationCount += population;
      if (population === 0) continue;
      const target = input.reviewKind === 'HUMAN_BASELINE' ? HUMAN_BASELINE_GROUP_TARGET : PASSED_SAMPLE_TARGET;
      const want = Math.min(target, population);
      const rows = await this.#candidates(eventId, input.reviewKind, bundle, Math.min(want, CANDIDATE_READ_LIMIT));
      // 원장이 섞어 주지만, 두 묶음을 앞뒤로 붙이지 않는다는 규칙을 여기서도 지킨다(아래에서 한 번 더 섞는다)
      selected.push(...rows.slice(0, want));
    }
    if (selected.length === 0) return { batchId: null, created: false, sampleCount: 0, populationCount };

    const seed = this.deps.newSeed?.() ?? randomUUID();
    const ordered = seededShuffle(selected, seed);
    const openAtMs = Math.min(...ordered.map((c) => c.openAtMs));
    const batch: BotReviewBatch = {
      batchId: this.deps.newId?.() ?? randomUUID(),
      eventId,
      reviewKind: input.reviewKind,
      seed,
      targetCount: ordered.length,
      populationCount,
      ...deadlinesFrom(openAtMs),
      createdAtMs: this.deps.now(),
    };
    const samples = ordered.map(
      (c, ordinal): BotReviewSample => ({
        sampleId: this.deps.newId?.() ?? randomUUID(),
        batchId: batch.batchId,
        sessionRef: c.sessionRef,
        verdictEventKey: c.verdictEventKey,
        status: 'PENDING',
        // 사람 기준 표본은 두 묶음을 섞으므로 위험 점수 범주·행동 요약 범주를 두지 않는다(d5 §7.15)
        riskBand: input.reviewKind === 'HUMAN_BASELINE' ? null : c.riskBand,
        behaviorSummaryBand: input.reviewKind === 'HUMAN_BASELINE' ? null : c.behaviorSummaryBand,
        timeline: c.timeline,
        evidenceAvailable: c.evidenceAvailable,
        ordinal,
        createdAtMs: batch.createdAtMs,
        // 통과 세션 표본은 언제나 PASSED·ALLOW다. trust ApplyLabel도 첫째 묶음에 ALLOW만 받는다
        reviewBatch: input.reviewKind === 'PASSED_SAMPLE' ? 'PASSED' : c.reviewBatch,
        appliedVerdict: input.reviewKind === 'PASSED_SAMPLE' || c.reviewBatch === 'PASSED' ? 'ALLOW' : c.appliedVerdict,
      }),
    );
    if (await store.insertBatch(batch, samples)) {
      return { batchId: batch.batchId, created: true, sampleCount: samples.length, populationCount };
    }
    // 그사이 다른 요청이 먼저 만들었다: 그 배치를 돌려준다
    const raced = await store.findBatch(input.eventId, input.reviewKind);
    if (!raced) throw new BotReviewProblem('bot-review-assign-conflict', 409, '표본 배치를 만드는 요청이 겹쳤습니다. 잠시 뒤 다시 확인해 주세요', 1);
    return { batchId: raced.batchId, created: false, sampleCount: raced.targetCount, populationCount: raced.populationCount };
  }

  async #population(eventId: string, reviewKind: ReviewKind, bundle: ReviewBatch): Promise<number> {
    try {
      return await this.deps.source.population({ eventId, reviewKind, bundle });
    } catch (e) {
      if (e instanceof BotReviewProblem) throw e;
      throw sourceUnavailable();
    }
  }

  async #candidates(eventId: string, reviewKind: ReviewKind, bundle: ReviewBatch, limit: number): Promise<readonly BotReviewCandidate[]> {
    try {
      return await this.deps.source.candidates({ eventId, reviewKind, bundle, limit });
    } catch (e) {
      if (e instanceof BotReviewProblem) throw e;
      throw sourceUnavailable();
    }
  }
}

const sourceUnavailable = (): BotReviewProblem => new BotReviewProblem('bot-review-source-unavailable', 503, '표본 후보 원장에 닿지 못했습니다. 잠시 뒤 다시 시도해 주세요', 1);
