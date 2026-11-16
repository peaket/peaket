// 메모리 후기 저장소(단위 시험). 운영은 adapters/db/drizzle-review-store.ts를 쓴다.
import { randomUUID } from 'node:crypto';
import { purgedReview, type ReportRecord, type ReviewRecord, type ReviewSort, type TakedownRecord } from '../domain/review.js';
import type { ReportSummary, ReviewListInput, ReviewListResult, ReviewStore } from '../domain/ports.js';

interface Cursor {
  readonly t: number;
  readonly i: string;
  readonly r: number;
}

// 별점이 null인 행(파기한 행, DELETED)은 목록에 오지 않는다. 0으로 셈하는 것은 타입을 맞추려는 것뿐이다
const ratingOf = (r: ReviewRecord): number => r.rating ?? 0;
const encodeCursor = (r: ReviewRecord): string => Buffer.from(JSON.stringify({ t: r.createdAtMs, i: r.reviewId, r: ratingOf(r) }), 'utf8').toString('base64url');
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

/**
 * 이전 판이 남긴 두 꼴(docs/data.md §2 '이전 판이 남긴 행 고치기'): 작성자가 지웠는데 별점·지문·계정 ID가 남은 행,
 * 옛 익명화로 참조만 끊긴 살아 있는 후기(account_id = id). Drizzle 저장소의 WHERE와 같은 뜻이다
 */
const isLegacyRow = (r: ReviewRecord): boolean =>
  r.status === 'DELETED' ? r.rating !== null || r.contentFingerprint !== null || r.accountId !== r.reviewId : r.accountId === r.reviewId;

const visibleTo = (r: ReviewRecord, viewer: string | undefined): boolean => {
  if (r.status === 'DELETED') return false;
  if (r.status === 'HIDDEN' && r.notice === undefined && r.accountId !== viewer) return false;
  return true;
};

const afterCursor = (r: ReviewRecord, c: Cursor | undefined, sort: ReviewSort): boolean => {
  if (!c) return true;
  if (sort === 'LATEST') return r.createdAtMs < c.t || (r.createdAtMs === c.t && r.reviewId < c.i);
  if (sort === 'RATING_DESC') {
    if (ratingOf(r) !== c.r) return ratingOf(r) < c.r;
    return r.createdAtMs < c.t || (r.createdAtMs === c.t && r.reviewId < c.i);
  }
  if (ratingOf(r) !== c.r) return ratingOf(r) > c.r;
  return r.createdAtMs < c.t || (r.createdAtMs === c.t && r.reviewId < c.i);
};

const compare = (a: ReviewRecord, b: ReviewRecord, sort: ReviewSort): number => {
  if (sort === 'RATING_DESC' && ratingOf(a) !== ratingOf(b)) return ratingOf(b) - ratingOf(a);
  if (sort === 'RATING_ASC' && ratingOf(a) !== ratingOf(b)) return ratingOf(a) - ratingOf(b);
  return b.createdAtMs - a.createdAtMs || b.reviewId.localeCompare(a.reviewId);
};

export class MemoryReviewStore implements ReviewStore {
  readonly reviews = new Map<string, ReviewRecord>();
  readonly reports = new Map<string, ReportRecord>();
  readonly takedowns = new Map<string, TakedownRecord>();
  readonly hiddenFingerprints = new Set<string>();
  /** 다시 정리 예약(review_withdrawal_recheck): 계정 ID → 예약 시각·만든 시각(docs/data.md §2 '다시 정리 예약') */
  readonly rechecks = new Map<string, { dueAtMs: number; createdAtMs: number }>();

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
    // 작성자 지우기도 탈퇴 파기와 같은 칸을 비운다(docs/data.md §2 '후기 파기', ADR-0086 ⑧)
    this.reviews.set(reviewId, purgedReview(r, nowMs));
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

  async applyNoticeTakedown(i: { reviewIds: readonly string[]; noticeId: string; nowMs: number }): Promise<{ applied: number }> {
    let applied = 0;
    for (const reviewId of i.reviewIds) {
      const r = this.reviews.get(reviewId);
      if (!r || r.status === 'DELETED' || r.contentFingerprint === null) continue;
      const fingerprint = r.contentFingerprint;
      const already = [...this.takedowns.values()].some((t) => t.noticeId === i.noticeId && t.reviewId === reviewId && t.restoredAtMs === undefined);
      if (already) continue;
      const takedownId = randomUUID();
      this.reviews.set(reviewId, { ...r, status: 'HIDDEN', notice: undefined, noticeUntilMs: undefined, updatedAtMs: i.nowMs });
      this.takedowns.set(takedownId, { takedownId, noticeId: i.noticeId, reviewId, reason: 'NOTICE', contentFingerprint: fingerprint, hiddenAtMs: i.nowMs });
      this.hiddenFingerprints.add(fingerprint);
      applied += 1;
    }
    return { applied };
  }

  async purgeByAccount(accountId: string, nowMs: number): Promise<number> {
    let purged = 0;
    for (const [id, r] of this.reviews) {
      if (r.accountId !== accountId) continue;
      this.reviews.set(id, purgedReview(r, nowMs));
      purged += 1;
    }
    return purged;
  }

  async purgeWithdrawnAccount(accountId: string, o: { nowMs: number; recheckAtMs: number }): Promise<number> {
    const purged = await this.purgeByAccount(accountId, o.nowMs);
    // 같은 계정 예약이 있으면 늦은 예약 시각을 남긴다(만든 시각은 처음 값)
    const before = this.rechecks.get(accountId);
    this.rechecks.set(accountId, before ? { ...before, dueAtMs: Math.max(before.dueAtMs, o.recheckAtMs) } : { dueAtMs: o.recheckAtMs, createdAtMs: o.nowMs });
    return purged;
  }

  async runDueRechecks(nowMs: number, limit: number): Promise<{ accounts: number; purged: number }> {
    // 예약 시각 차례(docs/data.md §5.1 'ORDER BY due_at'), 예약 시각 정각도 때가 됐다
    const due = [...this.rechecks.entries()]
      .filter(([, v]) => v.dueAtMs <= nowMs)
      .sort((a, b) => a[1].dueAtMs - b[1].dueAtMs || a[0].localeCompare(b[0]))
      .slice(0, limit);
    let purged = 0;
    for (const [accountId] of due) {
      purged += await this.purgeByAccount(accountId, nowMs);
      this.rechecks.delete(accountId);
    }
    return { accounts: due.length, purged };
  }

  async oldestOverdueRecheckMs(nowMs: number): Promise<number> {
    let oldest: number | undefined;
    for (const v of this.rechecks.values()) if (oldest === undefined || v.dueAtMs < oldest) oldest = v.dueAtMs;
    return oldest === undefined ? 0 : Math.max(0, nowMs - oldest);
  }

  async purgeLegacyRows(o: { nowMs: number; limit: number; after?: string }): Promise<{ purged: number; last?: string }> {
    // id 차례(PostgreSQL uuid 차례는 소문자 16진 글자 차례와 같다)로 after보다 큰 이전 판 행을 limit개
    const rows = [...this.reviews.values()]
      .filter((r) => isLegacyRow(r) && (o.after === undefined || r.reviewId > o.after))
      .sort((a, b) => (a.reviewId < b.reviewId ? -1 : a.reviewId > b.reviewId ? 1 : 0))
      .slice(0, o.limit);
    for (const r of rows) this.reviews.set(r.reviewId, purgedReview(r, o.nowMs));
    const last = rows[rows.length - 1];
    return last ? { purged: rows.length, last: last.reviewId } : { purged: 0 };
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
