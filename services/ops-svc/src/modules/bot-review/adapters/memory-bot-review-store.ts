// 표본 검토 메모리 저장소(local·ci·단위 시험). 실제 저장은 drizzle-bot-review-store가 한다.
// 같은 표본에 두 판정이 겹치면 하나만 남고 다른 하나는 already-recorded(409)다.
import { idempotencyKeyReused, idempotencyRequestInProgress } from '@peaket/platform';
import { alreadyRecorded, type BotReviewBatch, type BotReviewJudgement, type BotReviewSample, type ReviewKind } from '../domain/bot-review.js';
import type { BotReviewStore, BotReviewStorePage, JudgementIdempotency, RecordJudgementCommand, RecordJudgementResult } from '../domain/ports.js';

const keyOf = (eventId: string, reviewKind: ReviewKind): string => `${eventId.toLowerCase()}|${reviewKind}`;
const idemKeyOf = (idem: JudgementIdempotency): string => `${idem.accountRef}|${idem.operation}|${idem.key}`;
const hexOf = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex');

export class MemoryBotReviewStore implements BotReviewStore {
  readonly #batches = new Map<string, BotReviewBatch>();
  readonly #samples = new Map<string, BotReviewSample>();
  readonly #judgements = new Map<string, BotReviewJudgement>();
  /** 멱등 기록: 계정 × 작업 × 키 → 본문 지문과 결과 표본 ID */
  readonly #idempotency = new Map<string, { readonly hash: string; readonly sampleId: string }>();

  async findBatch(eventId: string, reviewKind: ReviewKind): Promise<BotReviewBatch | undefined> {
    return this.#batches.get(keyOf(eventId, reviewKind));
  }

  async insertBatch(batch: BotReviewBatch, samples: readonly BotReviewSample[]): Promise<boolean> {
    const key = keyOf(batch.eventId, batch.reviewKind);
    if (this.#batches.has(key)) return false;
    const sampleRefs = new Set<string>();
    const eventKeys = new Set<string>();
    for (const sample of samples) {
      if (sampleRefs.has(sample.sessionRef) || eventKeys.has(sample.verdictEventKey)) return false;
      sampleRefs.add(sample.sessionRef);
      eventKeys.add(sample.verdictEventKey);
    }
    this.#batches.set(key, batch);
    for (const sample of samples) this.#samples.set(sample.sampleId, sample);
    return true;
  }

  async listSamples(query: { batchId: string; status?: 'PENDING' | 'RECORDED'; afterOrdinal?: number; limit: number }): Promise<BotReviewStorePage> {
    const rows = [...this.#samples.values()]
      .filter((s) => s.batchId === query.batchId)
      .filter((s) => (query.status === undefined ? true : s.status === query.status))
      .filter((s) => (query.afterOrdinal === undefined ? true : s.ordinal > query.afterOrdinal))
      .sort((a, b) => a.ordinal - b.ordinal);
    const items = rows.slice(0, query.limit);
    const more = rows.length > query.limit;
    return { items, nextOrdinal: more ? (items[items.length - 1]?.ordinal ?? null) : null };
  }

  async findSample(sampleId: string): Promise<{ sample: BotReviewSample; batch: BotReviewBatch } | undefined> {
    const sample = this.#samples.get(sampleId);
    if (!sample) return undefined;
    const batch = [...this.#batches.values()].find((b) => b.batchId === sample.batchId);
    return batch ? { sample, batch } : undefined;
  }

  async findJudgement(sampleId: string): Promise<BotReviewJudgement | undefined> {
    return this.#judgements.get(sampleId);
  }

  async countJudgements(batchId: string): Promise<{ human: number; bot: number; undecided: number }> {
    let human = 0;
    let bot = 0;
    let undecided = 0;
    for (const sample of this.#samples.values()) {
      if (sample.batchId !== batchId) continue;
      const judgement = this.#judgements.get(sample.sampleId);
      if (!judgement) continue;
      if (judgement.verdict === 'HUMAN') human += 1;
      else if (judgement.verdict === 'BOT') bot += 1;
      else undecided += 1;
    }
    return { human, bot, undecided };
  }

  async recordJudgement(command: RecordJudgementCommand): Promise<RecordJudgementResult> {
    const existing = this.#judgements.get(command.sampleId);
    const idemKey = idemKeyOf(command.idem);
    const hash = hexOf(command.idem.requestHash);
    if (existing) {
      const record = this.#idempotency.get(idemKey);
      if (!record) throw alreadyRecorded();
      if (record.hash !== hash) throw idempotencyKeyReused();
      if (record.sampleId !== command.sampleId) throw idempotencyKeyReused();
      return { kind: 'REPLAYED', judgement: existing };
    }
    const claimed = this.#idempotency.get(idemKey);
    if (claimed) {
      if (claimed.hash !== hash) throw idempotencyKeyReused();
      throw idempotencyRequestInProgress();
    }
    this.#idempotency.set(idemKey, { hash, sampleId: command.sampleId });
    const judgement: BotReviewJudgement = {
      sampleId: command.sampleId,
      verdict: command.verdict,
      evidenceKinds: [...command.evidenceKinds],
      labelResult: command.labelResult,
      recordedAtMs: command.recordedAtMs,
    };
    this.#judgements.set(command.sampleId, judgement);
    const sample = this.#samples.get(command.sampleId);
    if (sample) this.#samples.set(command.sampleId, { ...sample, status: 'RECORDED' });
    return { kind: 'RECORDED', judgement };
  }
}
