// 운영 후기 저장소(BUILD_ORDER BAT-585). 후기 목록은 event를 조인해 공연 단위로 모으고,
// 신고 저장·불법 촬영물 즉시 가림은 한 트랜잭션으로 한다(ASVS 2.3.3).
import type { Database, DbTransaction } from '@peaket/platform';
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { ReportRecord, ReviewRecord, ReviewSort, TakedownRecord } from '../../domain/review.js';
import type { ReviewListInput, ReviewListResult, ReviewStore } from '../../domain/ports.js';
import { contentReport, review, reviewHiddenFingerprint, takedownAction } from './schema.js';

type Db = Database['db'] | DbTransaction;
type ReviewRow = typeof review.$inferSelect;
type ReportRow = typeof contentReport.$inferSelect;
type TakedownRow = typeof takedownAction.$inferSelect;

interface Cursor {
  readonly t: number;
  readonly i: string;
  readonly r: number;
}
const encodeCursor = (r: ReviewRecord): string => Buffer.from(JSON.stringify({ t: r.createdAtMs, i: r.reviewId, r: r.rating }), 'utf8').toString('base64url');
const decodeCursor = (raw: string | undefined): Cursor | undefined => {
  if (!raw) return undefined;
  try {
    const v: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof v !== 'object' || v === null) return undefined;
    const o = v as Record<string, unknown>;
    if (typeof o.t !== 'number' || typeof o.i !== 'string' || typeof o.r !== 'number') return undefined;
    return { t: o.t, i: o.i, r: o.r };
  } catch {
    return undefined;
  }
};

const recordOf = (r: ReviewRow): ReviewRecord => ({
  reviewId: r.id,
  eventId: r.eventId,
  productionId: '',
  accountId: r.accountId,
  basisOrderId: r.basisOrderId,
  rating: r.rating,
  body: r.body,
  status: r.status as ReviewRecord['status'],
  ...(r.notice ? { notice: r.notice as ReviewRecord['notice'] } : {}),
  ...(r.noticeUntil ? { noticeUntilMs: r.noticeUntil.getTime() } : {}),
  contentFingerprint: r.contentFingerprint,
  authorDisplay: r.authorDisplay,
  createdAtMs: r.createdAt.getTime(),
  updatedAtMs: r.updatedAt.getTime(),
  edited: r.edited,
});

const reportOf = (r: ReportRow): ReportRecord => ({
  reportId: r.id,
  targetId: r.targetId,
  reporterAccountId: r.reporterAccountId,
  category: r.category as ReportRecord['category'],
  detail: r.detail,
  rightsHolder: r.rightsHolder,
  ...(r.notifyChannel ? { notifyChannel: r.notifyChannel as 'APP' | 'EMAIL' } : {}),
  status: r.status as ReportRecord['status'],
  ...(r.outcome ? { outcome: r.outcome as ReportRecord['outcome'] } : {}),
  ...(r.caseId ? { caseId: r.caseId } : {}),
  createdAtMs: r.createdAt.getTime(),
  ...(r.resolvedAt ? { resolvedAtMs: r.resolvedAt.getTime() } : {}),
  purgeAtMs: r.purgeAt.getTime(),
});

const takedownOf = (r: TakedownRow): TakedownRecord => ({
  takedownId: r.id,
  ...(r.noticeId ? { noticeId: r.noticeId } : {}),
  reviewId: r.reviewId,
  reason: r.reason as TakedownRecord['reason'],
  contentFingerprint: r.contentFingerprint,
  hiddenAtMs: r.hiddenAt.getTime(),
  ...(r.endsAt ? { endsAtMs: r.endsAt.getTime() } : {}),
  ...(r.restoredAt ? { restoredAtMs: r.restoredAt.getTime() } : {}),
});

const visibleWhere = (viewer: string | undefined) =>
  viewer
    ? or(eq(review.status, 'VISIBLE'), isNotNull(review.notice), eq(review.accountId, viewer))
    : or(eq(review.status, 'VISIBLE'), isNotNull(review.notice));

const cursorWhere = (c: Cursor | undefined, sort: ReviewSort) => {
  if (!c) return undefined;
  const afterCreated = or(lt(review.createdAt, new Date(c.t)), and(eq(review.createdAt, new Date(c.t)), lt(review.id, c.i)));
  if (sort === 'LATEST') return afterCreated;
  if (sort === 'RATING_DESC') return or(lt(review.rating, c.r), and(eq(review.rating, c.r), afterCreated));
  return or(gt(review.rating, c.r), and(eq(review.rating, c.r), afterCreated));
};

export class DrizzleReviewStore implements ReviewStore {
  constructor(private readonly database: Database) {}

  async insertReview(r: ReviewRecord): Promise<void> {
    await this.database.db.insert(review).values({
      id: r.reviewId,
      eventId: r.eventId,
      accountId: r.accountId,
      basisOrderId: r.basisOrderId,
      rating: r.rating,
      body: r.body,
      status: r.status,
      notice: r.notice ?? null,
      noticeUntil: r.noticeUntilMs === undefined ? null : new Date(r.noticeUntilMs),
      contentFingerprint: r.contentFingerprint,
      authorDisplay: r.authorDisplay,
      edited: r.edited,
      createdAt: new Date(r.createdAtMs),
      updatedAt: new Date(r.updatedAtMs),
    });
  }

  async findReview(reviewId: string): Promise<ReviewRecord | undefined> {
    const rows = await this.database.db.select({ review }).from(review).where(eq(review.id, reviewId)).limit(1);
    return rows[0] ? this.#withProduction(rows[0].review) : undefined;
  }

  async findReviewByEventAccount(eventId: string, accountId: string): Promise<ReviewRecord | undefined> {
    const rows = await this.database.db
      .select({ review })
      .from(review)
      .where(and(eq(review.eventId, eventId), eq(review.accountId, accountId), ne(review.status, 'DELETED')))
      .limit(1);
    return rows[0] ? this.#withProduction(rows[0].review) : undefined;
  }

  async updateReview(reviewId: string, patch: Partial<Pick<ReviewRecord, 'rating' | 'body' | 'status' | 'notice' | 'noticeUntilMs' | 'contentFingerprint' | 'updatedAtMs' | 'edited'>>): Promise<void> {
    await this.database.db
      .update(review)
      .set({
        ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...('notice' in patch ? { notice: patch.notice ?? null } : {}),
        ...('noticeUntilMs' in patch ? { noticeUntil: patch.noticeUntilMs === undefined ? null : new Date(patch.noticeUntilMs) } : {}),
        ...(patch.contentFingerprint !== undefined ? { contentFingerprint: patch.contentFingerprint } : {}),
        ...(patch.updatedAtMs !== undefined ? { updatedAt: new Date(patch.updatedAtMs) } : {}),
        ...(patch.edited !== undefined ? { edited: patch.edited } : {}),
      })
      .where(eq(review.id, reviewId));
  }

  async softDeleteReview(reviewId: string, nowMs: number): Promise<void> {
    await this.database.db.update(review).set({ status: 'DELETED', body: '', authorDisplay: '***', deletedAt: new Date(nowMs), updatedAt: new Date(nowMs) }).where(eq(review.id, reviewId));
  }

  async listReviews(input: ReviewListInput): Promise<ReviewListResult> {
    const eventIds = await this.#eventIdsOfProduction(input.productionId);
    if (eventIds.length === 0) return { items: [] };
    const c = decodeCursor(input.cursor);
    const where = and(inArray(review.eventId, eventIds), ne(review.status, 'DELETED'), visibleWhere(input.viewerAccountId), cursorWhere(c, input.sort));
    const order =
      input.sort === 'LATEST'
        ? [desc(review.createdAt), desc(review.id)]
        : input.sort === 'RATING_DESC'
          ? [desc(review.rating), desc(review.createdAt), desc(review.id)]
          : [asc(review.rating), desc(review.createdAt), desc(review.id)];
    const rows = await this.database.db.select({ review }).from(review).where(where).orderBy(...order).limit(input.limit + 1);
    const page = rows.slice(0, input.limit);
    const items = page.map((r) => ({ ...recordOf(r.review), productionId: input.productionId }));
    const last = items[items.length - 1];
    return { items, ...(rows.length > input.limit && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  async listVisibleByProduction(productionId: string): Promise<readonly ReviewRecord[]> {
    const eventIds = await this.#eventIdsOfProduction(productionId);
    if (eventIds.length === 0) return [];
    const rows = await this.database.db.select({ review }).from(review).where(and(inArray(review.eventId, eventIds), eq(review.status, 'VISIBLE')));
    return rows.map((r) => ({ ...recordOf(r.review), productionId }));
  }

  async reportedTargetIds(accountId: string, targetIds: readonly string[]): Promise<ReadonlySet<string>> {
    if (targetIds.length === 0) return new Set();
    const rows = await this.database.db
      .select({ targetId: contentReport.targetId })
      .from(contentReport)
      .where(and(eq(contentReport.reporterAccountId, accountId), inArray(contentReport.targetId, [...targetIds])));
    return new Set(rows.map((r) => r.targetId));
  }

  async insertReport(r: ReportRecord, hide?: { takedown: TakedownRecord; status: 'HIDDEN' }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.insert(contentReport).values({
        id: r.reportId,
        targetKind: 'REVIEW',
        targetId: r.targetId,
        reporterAccountId: r.reporterAccountId,
        category: r.category,
        detail: r.detail,
        rightsHolder: r.rightsHolder,
        notifyChannel: r.notifyChannel ?? null,
        status: r.status,
        createdAt: new Date(r.createdAtMs),
        purgeAt: new Date(r.purgeAtMs),
      });
      if (hide) {
        await tx.update(review).set({ status: hide.status, updatedAt: new Date(hide.takedown.hiddenAtMs) }).where(eq(review.id, r.targetId));
        await tx.insert(takedownAction).values(valuesOfTakedown(hide.takedown));
      }
    });
  }

  async findReportByTargetReporter(targetId: string, reporterAccountId: string): Promise<ReportRecord | undefined> {
    const rows = await this.database.db
      .select()
      .from(contentReport)
      .where(and(eq(contentReport.targetId, targetId), eq(contentReport.reporterAccountId, reporterAccountId)))
      .limit(1);
    return rows[0] ? reportOf(rows[0]) : undefined;
  }

  async countReportsByReporterSince(reporterAccountId: string, sinceMs: number): Promise<number> {
    const rows = await this.database.db
      .select({ id: contentReport.id })
      .from(contentReport)
      .where(and(eq(contentReport.reporterAccountId, reporterAccountId), gt(contentReport.createdAt, new Date(sinceMs))));
    return rows.length;
  }

  async reportsByTarget(targetId: string): Promise<readonly ReportRecord[]> {
    const rows = await this.database.db.select().from(contentReport).where(eq(contentReport.targetId, targetId)).orderBy(asc(contentReport.createdAt));
    return rows.map(reportOf);
  }

  async resolveReports(targetId: string, outcome: ReportRecord['outcome'], nowMs: number): Promise<void> {
    await this.database.db.update(contentReport).set({ status: 'RESOLVED', outcome: outcome ?? null, resolvedAt: new Date(nowMs) }).where(eq(contentReport.targetId, targetId));
  }

  async insertTakedown(t: TakedownRecord): Promise<void> {
    await this.database.db.insert(takedownAction).values(valuesOfTakedown(t));
  }

  async takedownsByReview(reviewId: string): Promise<readonly TakedownRecord[]> {
    const rows = await this.database.db.select().from(takedownAction).where(eq(takedownAction.reviewId, reviewId)).orderBy(asc(takedownAction.hiddenAt));
    return rows.map(takedownOf);
  }

  async restoreTakedowns(reviewId: string, nowMs: number): Promise<void> {
    await this.database.db.update(takedownAction).set({ restoredAt: new Date(nowMs) }).where(and(eq(takedownAction.reviewId, reviewId), isNull(takedownAction.restoredAt)));
  }

  async addHiddenFingerprint(fingerprint: string, noticeId: string | undefined, nowMs: number): Promise<void> {
    await this.database.db.insert(reviewHiddenFingerprint).values({ fingerprint, noticeId: noticeId ?? null, createdAt: new Date(nowMs) }).onConflictDoNothing();
  }

  async removeHiddenFingerprint(fingerprint: string): Promise<void> {
    await this.database.db.delete(reviewHiddenFingerprint).where(eq(reviewHiddenFingerprint.fingerprint, fingerprint));
  }

  async hasHiddenFingerprint(fingerprint: string): Promise<boolean> {
    const rows = await this.database.db.select({ fingerprint: reviewHiddenFingerprint.fingerprint }).from(reviewHiddenFingerprint).where(eq(reviewHiddenFingerprint.fingerprint, fingerprint)).limit(1);
    return rows.length > 0;
  }

  async hasActiveNoticeFingerprint(fingerprint: string): Promise<boolean> {
    const rows = await this.database.db
      .select({ id: takedownAction.id })
      .from(takedownAction)
      .where(and(eq(takedownAction.reason, 'NOTICE'), eq(takedownAction.contentFingerprint, fingerprint), isNull(takedownAction.restoredAt)))
      .limit(1);
    return rows.length > 0;
  }

  async moderate(reviewId: string, o: { status?: ReviewRecord['status']; notice?: ReviewRecord['notice']; noticeUntilMs?: number; takedown?: TakedownRecord; restoreTakedowns: boolean; removeFingerprint?: string; outcome: ReportRecord['outcome']; nowMs: number }): Promise<void> {
    await this.database.transaction(async (tx) => {
      if (o.status !== undefined) {
        await tx
          .update(review)
          .set({
            status: o.status,
            notice: o.notice ?? null,
            noticeUntil: o.noticeUntilMs === undefined ? null : new Date(o.noticeUntilMs),
            updatedAt: new Date(o.nowMs),
          })
          .where(eq(review.id, reviewId));
      }
      if (o.takedown) await tx.insert(takedownAction).values(valuesOfTakedown(o.takedown));
      if (o.restoreTakedowns) await tx.update(takedownAction).set({ restoredAt: new Date(o.nowMs) }).where(and(eq(takedownAction.reviewId, reviewId), isNull(takedownAction.restoredAt)));
      if (o.removeFingerprint) await tx.delete(reviewHiddenFingerprint).where(eq(reviewHiddenFingerprint.fingerprint, o.removeFingerprint));
      await tx.update(contentReport).set({ status: 'RESOLVED', outcome: o.outcome ?? null, resolvedAt: new Date(o.nowMs) }).where(eq(contentReport.targetId, reviewId));
    });
  }

  async expireTemporaryBlocks(nowMs: number): Promise<number> {
    return this.database.transaction(async (tx) => {
      const rows = await tx
        .update(review)
        .set({ status: 'VISIBLE', notice: null, noticeUntil: null, updatedAt: new Date(nowMs) })
        .where(and(eq(review.status, 'HIDDEN'), eq(review.notice, 'RIGHTS_TEMP'), isNotNull(review.noticeUntil), lt(review.noticeUntil, new Date(nowMs))))
        .returning({ id: review.id });
      await tx
        .update(takedownAction)
        .set({ restoredAt: new Date(nowMs) })
        .where(and(eq(takedownAction.reason, 'RIGHTS_TEMP'), isNull(takedownAction.restoredAt), isNotNull(takedownAction.endsAt), lt(takedownAction.endsAt, new Date(nowMs))));
      return rows.length;
    });
  }

  async #withProduction(r: ReviewRow): Promise<ReviewRecord> {
    const result = await this.database.db.execute(sql`select production_id from event where id = ${r.eventId}::uuid limit 1`);
    const rows = ((result as unknown as { rows?: { production_id: string }[] }).rows ?? (result as unknown as { production_id: string }[])) as { production_id: string }[];
    return { ...recordOf(r), productionId: rows[0]?.production_id ?? '' };
  }

  async #eventIdsOfProduction(productionId: string): Promise<string[]> {
    const result = await this.database.db.execute(sql`select id from event where production_id = ${productionId}::uuid`);
    const rows = ((result as unknown as { rows?: { id: string }[] }).rows ?? (result as unknown as { id: string }[])) as { id: string }[];
    return rows.map((r) => r.id);
  }
}

const valuesOfTakedown = (t: TakedownRecord) => ({
  id: t.takedownId,
  noticeId: t.noticeId ?? null,
  reviewId: t.reviewId,
  reason: t.reason,
  contentFingerprint: t.contentFingerprint,
  caseId: null,
  hiddenAt: new Date(t.hiddenAtMs),
  endsAt: t.endsAtMs === undefined ? null : new Date(t.endsAtMs),
  restoredAt: t.restoredAtMs === undefined ? null : new Date(t.restoredAtMs),
});
