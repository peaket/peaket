// 표본 검토 Drizzle 저장소(ops DB, 마이그레이션 0020).
// 판정 행과 표본 상태(RECORDED)를 같은 트랜잭션에 쓰고, 표본 ID 기본 키가 마지막 가드다.
// 멱등은 공용 idempotency_record(platform IdempotencyStore)를 업무 쓰기와 같은 트랜잭션에서 쓴다.
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import { type Clock, type Database, type DbTransaction, IdempotencyStore, idempotencyKeyReused } from '@peaket/platform';
import { alreadyRecorded, type BotReviewBatch, type BotReviewJudgement, type BotReviewSample } from '../../domain/bot-review.js';
import type { BotReviewStore, BotReviewStorePage, JudgementIdempotency, RecordJudgementCommand, RecordJudgementResult } from '../../domain/ports.js';
import { botReviewBatch, botReviewJudgement, botReviewSample } from './schema.js';

const pgCode = (e: unknown): string | undefined => {
  const any = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const c = any?.code ?? any?.cause?.code;
  return typeof c === 'string' ? c : undefined;
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type BatchRow = typeof botReviewBatch.$inferSelect;
type SampleRow = typeof botReviewSample.$inferSelect;
type JudgementRow = typeof botReviewJudgement.$inferSelect;

const batchOf = (r: BatchRow): BotReviewBatch => ({
  batchId: r.id,
  eventId: r.eventId,
  reviewKind: r.reviewKind,
  seed: r.seed,
  targetCount: r.targetCount,
  populationCount: r.populationCount,
  retentionUntilMs: r.retentionUntil.getTime(),
  r2DueAtMs: r.r2DueAt.getTime(),
  createdAtMs: r.createdAt.getTime(),
});

const sampleOf = (r: SampleRow): BotReviewSample => ({
  sampleId: r.id,
  batchId: r.batchId,
  sessionRef: r.sampleRef,
  verdictEventKey: r.verdictEventKey,
  status: r.status,
  riskBand: r.riskBand,
  behaviorSummaryBand: r.behaviorSummaryBand,
  timeline: r.timeline,
  evidenceAvailable: r.evidenceAvailable,
  ordinal: r.ordinal,
  createdAtMs: r.createdAt.getTime(),
  reviewBatch: r.reviewBatch,
  appliedVerdict: r.appliedVerdict,
});

const judgementOf = (r: JudgementRow): BotReviewJudgement => ({
  sampleId: r.sampleId,
  verdict: r.verdict as BotReviewJudgement['verdict'],
  evidenceKinds: r.evidenceKinds as BotReviewJudgement['evidenceKinds'],
  labelResult: r.labelResult as BotReviewJudgement['labelResult'],
  recordedAtMs: r.recordedAt.getTime(),
});

export class DrizzleBotReviewStore implements BotReviewStore {
  readonly #idem: IdempotencyStore;

  constructor(
    private readonly db: Database,
    clock: Clock,
  ) {
    this.#idem = new IdempotencyStore({ clock });
  }

  async findBatch(eventId: string, reviewKind: BotReviewBatch['reviewKind']): Promise<BotReviewBatch | undefined> {
    if (!UUID.test(eventId)) return undefined;
    const rows = await this.db.db
      .select()
      .from(botReviewBatch)
      .where(and(eq(botReviewBatch.eventId, eventId.toLowerCase()), eq(botReviewBatch.reviewKind, reviewKind)))
      .limit(1);
    return rows[0] ? batchOf(rows[0]) : undefined;
  }

  async insertBatch(batch: BotReviewBatch, samples: readonly BotReviewSample[]): Promise<boolean> {
    try {
      return await this.db.transaction(async (tx) => {
        const seen = await tx.select({ id: botReviewBatch.id }).from(botReviewBatch).where(eq(botReviewBatch.id, batch.batchId)).limit(1);
        if (seen[0]) return false;
        const same = await tx
          .select({ id: botReviewBatch.id })
          .from(botReviewBatch)
          .where(and(eq(botReviewBatch.eventId, batch.eventId), eq(botReviewBatch.reviewKind, batch.reviewKind)))
          .limit(1);
        if (same[0]) return false;
        await tx.insert(botReviewBatch).values({
          id: batch.batchId,
          eventId: batch.eventId,
          reviewKind: batch.reviewKind,
          seed: batch.seed,
          targetCount: batch.targetCount,
          populationCount: batch.populationCount,
          retentionUntil: new Date(batch.retentionUntilMs),
          r2DueAt: new Date(batch.r2DueAtMs),
          createdAt: new Date(batch.createdAtMs),
        });
        if (samples.length > 0) {
          await tx.insert(botReviewSample).values(
            samples.map((s) => ({
              id: s.sampleId,
              batchId: batch.batchId,
              sampleRef: s.sessionRef,
              verdictEventKey: s.verdictEventKey,
              status: s.status,
              riskBand: s.riskBand,
              behaviorSummaryBand: s.behaviorSummaryBand,
              timeline: s.timeline,
              evidenceAvailable: [...s.evidenceAvailable],
              ordinal: s.ordinal,
              reviewBatch: s.reviewBatch,
              appliedVerdict: s.appliedVerdict,
              createdAt: new Date(s.createdAtMs),
            })),
          );
        }
        return true;
      });
    } catch (e) {
      // (event_id, review_kind) 유일 제약에 걸렸다: 다른 요청이 먼저 만들었다
      if (pgCode(e) === '23505') return false;
      throw e;
    }
  }

  async listSamples(query: {
    batchId: string;
    status?: BotReviewSample['status'];
    afterOrdinal?: number;
    limit: number;
  }): Promise<BotReviewStorePage> {
    const conditions = [eq(botReviewSample.batchId, query.batchId)];
    if (query.status !== undefined) conditions.push(eq(botReviewSample.status, query.status));
    if (query.afterOrdinal !== undefined) conditions.push(gt(botReviewSample.ordinal, query.afterOrdinal));
    const rows = await this.db.db
      .select()
      .from(botReviewSample)
      .where(and(...conditions))
      .orderBy(asc(botReviewSample.ordinal))
      .limit(query.limit + 1);
    const items = rows.slice(0, query.limit).map(sampleOf);
    const more = rows.length > query.limit;
    return { items, nextOrdinal: more ? (items[items.length - 1]?.ordinal ?? null) : null };
  }

  async findSample(sampleId: string): Promise<{ sample: BotReviewSample; batch: BotReviewBatch } | undefined> {
    if (!UUID.test(sampleId)) return undefined;
    const rows = await this.db.db
      .select({ sample: botReviewSample, batch: botReviewBatch })
      .from(botReviewSample)
      .innerJoin(botReviewBatch, eq(botReviewSample.batchId, botReviewBatch.id))
      .where(eq(botReviewSample.id, sampleId.toLowerCase()))
      .limit(1);
    const row = rows[0];
    return row ? { sample: sampleOf(row.sample), batch: batchOf(row.batch) } : undefined;
  }

  async findJudgement(sampleId: string): Promise<BotReviewJudgement | undefined> {
    if (!UUID.test(sampleId)) return undefined;
    const rows = await this.db.db.select().from(botReviewJudgement).where(eq(botReviewJudgement.sampleId, sampleId.toLowerCase())).limit(1);
    return rows[0] ? judgementOf(rows[0]) : undefined;
  }

  async countJudgements(batchId: string): Promise<{ human: number; bot: number; undecided: number }> {
    if (!UUID.test(batchId)) return { human: 0, bot: 0, undecided: 0 };
    const rows = await this.db.db
      .select({ verdict: botReviewJudgement.verdict })
      .from(botReviewJudgement)
      .innerJoin(botReviewSample, eq(botReviewJudgement.sampleId, botReviewSample.id))
      .where(eq(botReviewSample.batchId, batchId));
    let human = 0;
    let bot = 0;
    let undecided = 0;
    for (const row of rows) {
      if (row.verdict === 'HUMAN') human += 1;
      else if (row.verdict === 'BOT') bot += 1;
      else undecided += 1;
    }
    return { human, bot, undecided };
  }

  async recordJudgement(command: RecordJudgementCommand): Promise<RecordJudgementResult> {
    if (!UUID.test(command.sampleId)) throw alreadyRecorded();
    const hash = Buffer.from(command.idem.requestHash);
    try {
      return await this.db.transaction(async (tx) => {
        const rows = await tx.select().from(botReviewJudgement).where(eq(botReviewJudgement.sampleId, command.sampleId)).limit(1);
        if (rows[0]) {
          const replay = await this.#replayOf(tx, command.idem, hash, command.sampleId);
          if (!replay) throw alreadyRecorded();
          return { kind: 'REPLAYED' as const, judgement: judgementOf(rows[0]) };
        }
        const judgement = await this.#idem.run(tx, command.idem, {
          execute: async () => {
            const inserted = await tx
              .insert(botReviewJudgement)
              .values({
                sampleId: command.sampleId,
                verdict: command.verdict,
                evidenceKinds: [...command.evidenceKinds],
                labelResult: command.labelResult,
                recordedAt: new Date(command.recordedAtMs),
              })
              .onConflictDoNothing()
              .returning();
            const value = inserted[0] ? judgementOf(inserted[0]) : undefined;
            if (!value) throw alreadyRecorded();
            const updated = await tx
              .update(botReviewSample)
              .set({ status: 'RECORDED' })
              .where(eq(botReviewSample.id, command.sampleId))
              .returning({ id: botReviewSample.id });
            if (!updated[0]) throw alreadyRecorded();
            return { resultRef: command.sampleId, value };
          },
          replay: async () => {
            const again = await tx.select().from(botReviewJudgement).where(eq(botReviewJudgement.sampleId, command.sampleId)).limit(1);
            if (!again[0]) throw alreadyRecorded();
            return judgementOf(again[0]);
          },
        });
        return { kind: 'RECORDED' as const, judgement };
      });
    } catch (e) {
      // 같은 표본에 두 판정이 겹쳐 표본 ID 기본 키에 걸렸다: 하나만 남는다
      if (pgCode(e) === '23505') throw alreadyRecorded();
      throw e;
    }
  }

  /** 이미 끝난 표본에 같은 키·같은 지문의 재시도인지 본다. 아니면 false(409)다 */
  async #replayOf(tx: DbTransaction, idem: JudgementIdempotency, hash: Buffer, sampleId: string): Promise<boolean> {
    const rows = (
      await tx.execute(sql`select request_hash, result_ref from idempotency_record
        where account_ref = ${idem.accountRef} and operation = ${idem.operation} and idempotency_key = ${idem.key}`)
    ).rows as { request_hash: Buffer; result_ref: string | null }[];
    const row = rows[0];
    if (!row || row.result_ref !== sampleId) return false;
    const stored = Buffer.from(row.request_hash);
    if (stored.length !== hash.length || !stored.equals(hash)) throw idempotencyKeyReused();
    return true;
  }
}
