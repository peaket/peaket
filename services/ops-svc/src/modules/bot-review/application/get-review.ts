// 표본 검토 진행 읽기(GET /v1/ops/events/{eventId}/bot-review, SCR-067).
// 표본이 없으면 404, 행동 신호 보존(오픈 + 30일 [가정])이 지나면 410이다.
// 배치가 아직 없을 때 후보 원장이 답하지 못하면 503 source-unavailable로 404(표본 없음)와 구분한다(계획 §7.4).
// HUMAN_BASELINE은 두 묶음을 합친 진행 수만 보이고 interim은 null이다(묶음별 수·비율을 보이면 검토가 그쪽으로 기운다).
import {
  BotReviewProblem,
  isUuid,
  notFound,
  progressView,
  retentionEnded,
  type OpsBotReviewView,
  type ReviewKind,
} from '../domain/bot-review.js';
import type { BotReviewSource, BotReviewStore } from '../domain/ports.js';

export interface GetBotReviewInput {
  readonly eventId: string;
  readonly reviewKind: ReviewKind;
}

export class GetBotReview {
  constructor(
    private readonly store: BotReviewStore,
    private readonly source: BotReviewSource,
    private readonly now: () => number,
  ) {}

  async run(input: GetBotReviewInput): Promise<OpsBotReviewView> {
    if (!isUuid(input.eventId)) throw notFound();
    const batch = await this.store.findBatch(input.eventId.toLowerCase(), input.reviewKind);
    if (!batch) {
      // 배치가 없다. 원장을 읽을 수 있으면 '표본 없음'(404), 원장이 답하지 못하면 503이다
      try {
        await this.source.population({ eventId: input.eventId.toLowerCase(), reviewKind: input.reviewKind });
      } catch {
        throw sourceUnavailable();
      }
      throw notFound();
    }
    if (this.now() > batch.retentionUntilMs) throw retentionEnded();
    const counts = await this.store.countJudgements(batch.batchId);
    return progressView(batch, counts);
  }
}

const sourceUnavailable = () =>
  new BotReviewProblem('bot-review-source-unavailable', 503, '표본 후보 원장에 닿지 못했습니다. 잠시 뒤 다시 시도해 주세요', 1);
