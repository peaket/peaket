// 메모리 후기 저장소(단위 시험). 운영은 adapters/db/drizzle-review-store.ts를 쓴다.
import type { ReportRecord, ReviewRecord, ReviewSort, TakedownRecord } from '../domain/review.js';
import type { ReportSummary, ReviewListInput, ReviewListResult, ReviewStore } from '../domain/ports.js';

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

const visibleTo = (r: ReviewRecord, viewer: string | undefined): boolean => {
  if (r.status === 'DELETED') return false;
  if (r.status === 'HIDDEN' && r.notice === undefined && r.accountId !== viewer) return false;
  return true;
};

const afterCursor = (r: ReviewRecord, c: Cursor | undefined, sort: ReviewSort): boolean => {
  if (!c) return true;
  if (sort === 'LATEST') return r.createdAtMs < c.t || (r.createdAtMs === c.t && r.reviewId < c.i);
  if (sort === 'RATING_DESC') {
    if (r.rating !== c.r) return r.rating < c.r;
    return r.createdAtMs < c.t || (r.createdAtMs === c.t && r.reviewId < c.i);
  }
  if (r.rating !== c.r) return r.rating > c.r;
  return r.createdAtMs < c.t || (r.createdAtMs === c.t && r.reviewId < c.i);
};

const compare = (a: ReviewRecord, b: ReviewRecord, sort: ReviewSort): number => {
  if (sort === 'RATING_DESC' && a.rating !== b.rating) return b.rating - a.rating;
  if (sort === 'RATING_ASC' && a.rating !== b.rating) return a.rating - b.rating;
  return b.createdAtMs - a.createdAtMs || b.reviewId.localeCompare(a.reviewId);
};

export class MemoryReviewStore implements ReviewStore {
  readonly reviews = new Map<string, ReviewRecord>();
  readonly reports = new Map<string, ReportRecord>();
  readonly takedowns = new Map<string, TakedownRecord>();
  readonly hiddenFingerprints = new Set<string>();

  async insertReview(r: ReviewRecord): Promise<void> {
    this.reviews.set(r.reviewId, { ...r });
  }

  async findReview(reviewId: string): Promise<ReviewRecord | undefined> {
    const r = this.reviews.get(reviewId);
    return r ? { ...r } : undefined;
  }

  async findReviewByEventAccount(eventId: string, accountId: string): Promise<ReviewRecord | undefined> {
    for (const r of this.reviews.values()) if (r.eventId === eventId && r.accountId === accountId && r.status !== 'DELETED') return { ...r };
    return undefined;
  }

  async updateReview(reviewId: string, patch: Partial<Pick<ReviewRecord, 'rating' | 'body' | 'status' | 'notice' | 'noticeUntilMs' | 'contentFingerprint' | 'updatedAtMs' | 'edited'>>): Promise<void> {
    const r = this.reviews.get(reviewId);
    if (!r) return;
    this.reviews.set(reviewId, { ...r, ...patch });
  }

  async softDeleteReview(reviewId: string, nowMs: number): Promise<void> {
    const r = this.reviews.get(reviewId);
    if (!r) return;
    this.reviews.set(reviewId, { ...r, status: 'DELETED', body: '', rating: 0, authorDisplay: '***', updatedAtMs: nowMs });
  }

  async listReviews(input: ReviewListInput): Promise<ReviewListResult> {
    const c = decodeCursor(input.cursor);
    const all = [...this.reviews.values()]
      .filter((r) => r.productionId === input.productionId && visibleTo(r, input.viewerAccountId) && afterCursor(r, c, input.sort))
      .sort((a, b) => compare(a, b, input.sort));
    const page = all.slice(0, input.limit);
    const last = page[page.length - 1];
    return { items: page.map((r) => ({ ...r })), ...(all.length > input.limit && last ? { nextCursor: encodeCursor(last) } : {}) };
  }

  async listVisibleByProduction(productionId: string): Promise<readonly ReviewRecord[]> {
    return [...this.reviews.values()].filter((r) => r.productionId === productionId && r.status === 'VISIBLE').map((r) => ({ ...r }));
  }

  async reportedTargetIds(accountId: string, targetIds: readonly string[]): Promise<ReadonlySet<string>> {
    const wanted = new Set(targetIds);
    const out = new Set<string>();
    for (const r of this.reports.values()) if (r.reporterAccountId === accountId && wanted.has(r.targetId)) out.add(r.targetId);
    return out;
  }

  async insertReport(r: ReportRecord, hide?: { takedown: TakedownRecord; status: 'HIDDEN' }): Promise<void> {
    this.reports.set(r.reportId, { ...r });
    if (hide) {
      this.takedowns.set(hide.takedown.takedownId, { ...hide.takedown });
      const review = this.reviews.get(r.targetId);
      if (review) this.reviews.set(r.targetId, { ...review, status: hide.status });
    }
  }

  async findReportByTargetReporter(targetId: string, reporterAccountId: string): Promise<ReportRecord | undefined> {
    for (const r of this.reports.values()) if (r.targetId === targetId && r.reporterAccountId === reporterAccountId) return { ...r };
    return undefined;
  }

  async countReportsByReporterSince(reporterAccountId: string, sinceMs: number): Promise<number> {
    let n = 0;
    for (const r of this.reports.values()) if (r.reporterAccountId === reporterAccountId && r.createdAtMs >= sinceMs) n += 1;
    return n;
  }

  async reportsByTarget(targetId: string): Promise<readonly ReportRecord[]> {
    return [...this.reports.values()].filter((r) => r.targetId === targetId).sort((a, b) => a.createdAtMs - b.createdAtMs).map((r) => ({ ...r }));
  }

  async resolveReports(targetId: string, outcome: ReportRecord['outcome'], nowMs: number): Promise<void> {
    for (const [id, r] of this.reports) if (r.targetId === targetId) this.reports.set(id, { ...r, status: 'RESOLVED', ...(outcome ? { outcome } : {}), resolvedAtMs: nowMs });
  }

  async insertTakedown(t: TakedownRecord): Promise<void> {
    this.takedowns.set(t.takedownId, { ...t });
  }

  async takedownsByReview(reviewId: string): Promise<readonly TakedownRecord[]> {
    return [...this.takedowns.values()].filter((t) => t.reviewId === reviewId).map((t) => ({ ...t }));
  }

  async restoreTakedowns(reviewId: string, nowMs: number): Promise<void> {
    for (const [id, t] of this.takedowns) if (t.reviewId === reviewId && t.restoredAtMs === undefined) this.takedowns.set(id, { ...t, restoredAtMs: nowMs });
  }

  async addHiddenFingerprint(fingerprint: string, _noticeId: string | undefined, _nowMs: number): Promise<void> {
    this.hiddenFingerprints.add(fingerprint);
  }

  async removeHiddenFingerprint(fingerprint: string): Promise<void> {
    this.hiddenFingerprints.delete(fingerprint);
  }

  async hasHiddenFingerprint(fingerprint: string): Promise<boolean> {
    return this.hiddenFingerprints.has(fingerprint);
  }

  async hasActiveNoticeFingerprint(fingerprint: string): Promise<boolean> {
    return [...this.takedowns.values()].some((t) => t.reason === 'NOTICE' && t.restoredAtMs === undefined && t.contentFingerprint === fingerprint);
  }

  async moderate(reviewId: string, o: { status?: ReviewRecord['status']; notice?: ReviewRecord['notice']; noticeUntilMs?: number; takedown?: TakedownRecord; restoreTakedowns: boolean; removeFingerprint?: string; outcome: ReportRecord['outcome']; nowMs: number }): Promise<void> {
    if (o.status !== undefined) await this.updateReview(reviewId, { status: o.status, notice: o.notice, noticeUntilMs: o.noticeUntilMs, updatedAtMs: o.nowMs });
    if (o.takedown) await this.insertTakedown(o.takedown);
    if (o.restoreTakedowns) await this.restoreTakedowns(reviewId, o.nowMs);
    if (o.removeFingerprint) await this.removeHiddenFingerprint(o.removeFingerprint);
    await this.resolveReports(reviewId, o.outcome, o.nowMs);
  }

  async expireTemporaryBlocks(nowMs: number): Promise<number> {
    let n = 0;
    for (const [id, r] of this.reviews) {
      if (r.notice === 'RIGHTS_TEMP' && r.noticeUntilMs !== undefined && r.noticeUntilMs <= nowMs) {
        this.reviews.set(id, { ...r, status: 'VISIBLE', notice: undefined, noticeUntilMs: undefined, updatedAtMs: nowMs });
        n += 1;
      }
    }
    for (const [id, t] of this.takedowns) {
      if (t.reason === 'RIGHTS_TEMP' && t.restoredAtMs === undefined && t.endsAtMs !== undefined && t.endsAtMs <= nowMs) this.takedowns.set(id, { ...t, restoredAtMs: nowMs });
    }
    return n;
  }

  /** 시험용: 한 후기의 신고 요약 */
  summaryOfReports(targetId: string): ReportSummary {
    const reports = [...this.reports.values()].filter((r) => r.targetId === targetId);
    const byCategory: Record<string, number> = {};
    for (const r of reports) byCategory[r.category] = (byCategory[r.category] ?? 0) + 1;
    return { total: reports.length, byCategory, reports };
  }
}
