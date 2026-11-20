// 시험·local·ci용 표본 후보 원장 대역(PEAKET_BOT_REVIEW_SOURCE=fixture).
// 운영 원장(bot_sample_review)은 OPS-220이 적재한다. 단위 시험은 이 클래스에 행을 넘겨 REST·판정을 본다.
import { BotReviewSourceFailure, type ReviewBatch, type ReviewKind } from '../domain/bot-review.js';
import type { BotReviewCandidate, BotReviewSource } from '../domain/ports.js';

export class FixtureBotReviewSource implements BotReviewSource {
  constructor(private readonly rows: readonly BotReviewCandidate[] = []) {}

  async population(q: { eventId: string; reviewKind: ReviewKind; bundle?: ReviewBatch }): Promise<number> {
    return this.#rows(q).length;
  }

  async candidates(q: { eventId: string; reviewKind: ReviewKind; bundle?: ReviewBatch; limit: number }): Promise<readonly BotReviewCandidate[]> {
    return this.#rows(q).slice(0, q.limit);
  }

  async pidOf(q: { eventId: string; verdictEventKey: string }): Promise<string | undefined> {
    return this.rows.find((r) => r.verdictEventKey.toLowerCase() === q.verdictEventKey.toLowerCase())?.pid;
  }

  #rows(q: { eventId: string; reviewKind: ReviewKind; bundle?: ReviewBatch }): BotReviewCandidate[] {
    const bundle = q.bundle ?? (q.reviewKind === 'PASSED_SAMPLE' ? 'PASSED' : undefined);
    return this.rows.filter((r) => r.reviewBatch === bundle || bundle === undefined);
  }
}

/** 원장 주소가 없거나 대역을 고르지 않았을 때. 진행·목록·판정이 503 source-unavailable이다 */
export class UnavailableBotReviewSource implements BotReviewSource {
  async population(): Promise<number> {
    throw new BotReviewSourceFailure('bot-review source is not configured');
  }

  async candidates(): Promise<readonly BotReviewCandidate[]> {
    throw new BotReviewSourceFailure('bot-review source is not configured');
  }

  async pidOf(): Promise<string | undefined> {
    throw new BotReviewSourceFailure('bot-review source is not configured');
  }
}
