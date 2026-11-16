// 운영 후기 저장소(BUILD_ORDER BAT-585). 후기 목록은 event를 조인해 공연 단위로 모으고,
// 신고 저장·불법 촬영물 즉시 가림은 한 트랜잭션으로 한다(ASVS 2.3.3).
// 작성자 지우기·탈퇴 파기는 docs/data.md §2 '후기 파기'의 칸을 한 문장으로 비우고, 탈퇴 사건은 파기와 다시 정리 예약을 한 트랜잭션에 쓴다(ADR-0278).
import { randomUUID } from 'node:crypto';
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
// 별점이 null인 행(파기한 행, DELETED)은 목록에 오지 않는다. 0은 타입을 맞추려는 것뿐이다
const encodeCursor = (r: ReviewRecord): string => Buffer.from(JSON.stringify({ t: r.createdAtMs, i: r.reviewId, r: r.rating ?? 0 }), 'utf8').toString('base64url');
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
  ...(r.deletedAt ? { deletedAtMs: r.deletedAt.getTime() } : {}),
});

/**
 * docs/data.md §2 '후기 파기'의 칸(작성자 지우기·탈퇴 파기가 같이 쓴다). 지운 시각은 처음 지운 시각(이미 있으면 그대로)이다.
 * 계정·주문 참조는 그 후기 ID로 바꿔 끊는다(NOT NULL과 회차·계정 부분 유일 색인을 그대로 둔다). 0022의 core_app UPDATE 칸 목록이 이 칸을 모두 덮는다
 */
const purgeSet = (nowMs: number) => sql`
  status = 'DELETED', body = '', rating = null, content_fingerprint = null, author_display = '', notice = null, notice_until = null,
  account_id = id, basis_order_id = id, deleted_at = coalesce(deleted_at, ${new Date(nowMs)}::timestamptz), updated_at = ${new Date(nowMs)}::timestamptz`;

/**
 * 이전 판이 남긴 두 꼴(docs/data.md §2 '이전 판이 남긴 행 고치기'): 작성자가 지웠는데 별점·지문·계정 ID가 남은 행, 옛 익명화로 참조만 끊긴 살아 있는 후기.
 * 고치기(purgeLegacyRows)와 세기(countLegacyRows)가 같은 글을 쓴다(웨이브 끝 정확성 리뷰 C2)
 */
const LEGACY_ROWS = sql`((status = 'DELETED' and (rating is not null or content_fingerprint is not null or account_id <> id)) or (status <> 'DELETED' and account_id = id))`;

/** 이전 판 행 고치기 한 묶음의 잠금 대기 한도 2초 [가정](docs/data.md §2 '이전 판이 남긴 행 고치기') */
const LEGACY_LOCK_TIMEOUT_MS = 2_000;

const ACCOUNTS_WITHDRAWN = 'identity.accounts-withdrawn';

/** 그 계정의 후기를 상태와 관계없이 모두 파기한다(색인 review_account_idx). 바꾼 행 수 */
async function purgeAccountRows(db: Db, accountId: string, nowMs: number): Promise<number> {
  const r = await db.execute(sql`update review set ${purgeSet(nowMs)} where account_id = ${accountId}::uuid returning id`);
  return r.rows.length;
}

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
    // 작성자 지우기도 탈퇴 파기와 같은 칸을 비운다(docs/data.md §2 '후기 파기', ADR-0086 ⑧)
    await this.database.db.execute(sql`update review set ${purgeSet(nowMs)} where id = ${reviewId}::uuid`);
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

  async applyNoticeTakedown(i: { reviewIds: readonly string[]; noticeId: string; nowMs: number }): Promise<{ applied: number }> {
    return this.database.transaction(async (tx) => {
      let applied = 0;
      for (const reviewId of i.reviewIds) {
        const found = await tx.execute(sql`select id, content_fingerprint from review where id = ${reviewId}::uuid and status <> 'DELETED' for update`);
        const r = found.rows[0] as { id: string; content_fingerprint: string | null } | undefined;
        // 살아 있는 행은 지문이 있다(review_live_complete_check). 없으면 가릴 내용도 없다
        if (!r || r.content_fingerprint === null) continue;
        const dup = await tx.execute(sql`select 1 from takedown_action where notice_id = ${i.noticeId}::uuid and review_id = ${reviewId}::uuid and restored_at is null limit 1`);
        if (dup.rows[0]) continue;
        await tx.execute(sql`update review set status = 'HIDDEN', notice = null, notice_until = null, updated_at = ${new Date(i.nowMs)}::timestamptz where id = ${reviewId}::uuid`);
        const takedownId = randomUUID();
        await tx.execute(sql`
          insert into takedown_action (id, notice_id, review_id, reason, content_fingerprint, hidden_at)
          values (${takedownId}::uuid, ${i.noticeId}::uuid, ${reviewId}::uuid, 'NOTICE', ${r.content_fingerprint}, ${new Date(i.nowMs)}::timestamptz)`);
        await tx.execute(sql`
          insert into review_hidden_fingerprint (fingerprint, notice_id, created_at)
          values (${r.content_fingerprint}, ${i.noticeId}::uuid, ${new Date(i.nowMs)}::timestamptz)
          on conflict do nothing`);
        applied += 1;
      }
      return { applied };
    });
  }

  async purgeWithdrawnAccount(accountId: string, o: { nowMs: number; recheckAtMs: number }): Promise<number> {
    // 파기와 다시 정리 예약을 한 트랜잭션에 쓴다: 예약 쓰기가 실패하면 파기도 되돌려 사건을 다시 받게 한다(docs/features/identity.md §8 '다시 정리')
    return this.database.transaction(async (tx) => {
      // 같은 계정 예약이 있으면 늦은 예약 시각을 남긴다(만든 시각은 처음 값. core_app은 due_at만 고칠 수 있다).
      // 예약 행을 후기보다 먼저 잡는다: 다시 정리 반복(runDueRechecks)도 예약 행 → 후기 차례로 잠가, 같은 계정을 겹쳐 처리해도 서로 기다리다 막히지(교착) 않는다
      await tx.execute(sql`
        insert into review_withdrawal_recheck (account_id, due_at, created_at)
        values (${accountId}::uuid, ${new Date(o.recheckAtMs)}::timestamptz, ${new Date(o.nowMs)}::timestamptz)
        on conflict (account_id) do update set due_at = greatest(review_withdrawal_recheck.due_at, excluded.due_at)`);
      return purgeAccountRows(tx, accountId, o.nowMs);
    });
  }

  async runDueRechecks(nowMs: number, limit: number): Promise<{ accounts: number; purged: number }> {
    return this.database.transaction(async (tx) => {
      // 때가 된 예약을 예약 시각 차례로 잠근다. 다른 반복이 잠근 행은 건너뛴다(겹쳐 돌아도 한 예약은 한 번만, docs/data.md §5.1 '탈퇴 파기')
      const due = await tx.execute(sql`
        select account_id from review_withdrawal_recheck
         where due_at <= ${new Date(nowMs)}::timestamptz
         order by due_at
         limit ${limit}::int
         for update skip locked`);
      const ids = (due.rows as { account_id: string }[]).map((r) => r.account_id);
      if (ids.length === 0) return { accounts: 0, purged: 0 };
      const purgedRows = await tx.execute(sql`update review set ${purgeSet(nowMs)} where account_id = any(${sql.param(ids)}::uuid[]) returning id`);
      // 처리한 예약은 지운다(계정 ID가 남지 않게)
      await tx.execute(sql`delete from review_withdrawal_recheck where account_id = any(${sql.param(ids)}::uuid[])`);
      return { accounts: ids.length, purged: purgedRows.rows.length };
    });
  }

  async oldestOverdueRecheckMs(nowMs: number): Promise<number> {
    // 가장 이른 예약 시각을 유닉스 ms로 읽는다(색인 review_withdrawal_recheck_due_idx). 시각 글자 모양에 기대지 않으려고 DB에서 숫자로 바꾼다
    const r = await this.database.db.execute(sql`select (extract(epoch from min(due_at)) * 1000)::float8 as due_ms from review_withdrawal_recheck`);
    const raw = (r.rows[0] as { due_ms: number | string | null } | undefined)?.due_ms ?? null;
    if (raw === null) return 0;
    return Math.max(0, nowMs - Math.round(Number(raw)));
  }

  async purgeHeldWithdrawal(accountId: string, o: { nowMs: number; recheckAtMs: number }): Promise<{ purged: number; heldEventKeys: string[] } | undefined> {
    // 손으로 처리(웨이브 끝 보안 리뷰 S1, docs/features/identity.md §8 '손으로 처리'). 한 트랜잭션: 보류 행 잠금 → 예약(늦은 쪽) → 파기 → 보류 행 다시 처리 표시.
    // 예약을 파기보다 먼저 쓰는 것은 다시 정리 반복과 잠금 차례(예약 행 → 후기)를 맞추려는 것이다. 보류 행이 없으면 아무것도 쓰지 않는다
    return this.database.transaction(async (tx) => {
      const found = await tx.execute(sql`
        select id::text as id, event_key from held_event
         where topic = ${ACCOUNTS_WITHDRAWN}
           and reprocessed_at is null
           and (lower(business_key) = ${accountId} or lower(msg_key) = ${accountId})
         order by id
         for update`);
      const held = found.rows as { id: string; event_key: string | null }[];
      if (held.length === 0) return undefined;
      await tx.execute(sql`
        insert into review_withdrawal_recheck (account_id, due_at, created_at)
        values (${accountId}::uuid, ${new Date(o.recheckAtMs)}::timestamptz, ${new Date(o.nowMs)}::timestamptz)
        on conflict (account_id) do update set due_at = greatest(review_withdrawal_recheck.due_at, excluded.due_at)`);
      const purged = await purgeAccountRows(tx, accountId, o.nowMs);
      await tx.execute(sql`update held_event set reprocessed_at = ${new Date(o.nowMs)}::timestamptz where id = any(${sql.param(held.map((h) => h.id))}::uuid[])`);
      return { purged, heldEventKeys: held.flatMap((h) => (h.event_key === null ? [] : [h.event_key])) };
    });
  }

  async countLegacyRows(): Promise<number> {
    // 잠그지 않고 센다(다른 트랜잭션이 잡은 행도 남은 대상이다). 정비 역할이 읽는 칸만 쓴다
    const r = await this.database.db.execute(sql`select count(*)::int as n from review where ${LEGACY_ROWS}`);
    return Number((r.rows[0] as { n: number | string } | undefined)?.n ?? 0);
  }

  async purgeLegacyRows(o: { nowMs: number; limit: number; after?: string }): Promise<{ purged: number; last?: string }> {
    // 정비 일 review-purge-legacy(정비 역할 core_maintenance, W8-audit2a 리뷰 A2): 묶음 하나를 한 트랜잭션으로. 잠긴 행은 건너뛰고(SKIP LOCKED) 잠금 대기는 2초 [가정]까지.
    // 찾기는 0022·0026이 정비 역할에 준 칸(id·status·rating·content_fingerprint·account_id)만 읽고, 고치기(purgeSet)가 읽는 칸은 id·deleted_at뿐이다(본문은 읽지 않는다)
    return this.database.transaction(async (tx) => {
      await tx.execute(sql`select set_config('lock_timeout', ${`${LEGACY_LOCK_TIMEOUT_MS}ms`}, true)`);
      const found = await tx.execute(sql`
        select id::text as id from review
         where ${LEGACY_ROWS}
           ${o.after === undefined ? sql`` : sql`and id > ${o.after}::uuid`}
         order by id
         limit ${o.limit}::int
         for update skip locked`);
      const ids = (found.rows as { id: string }[]).map((r) => r.id);
      const last = ids[ids.length - 1];
      if (last === undefined) return { purged: 0 };
      const purged = await tx.execute(sql`update review set ${purgeSet(o.nowMs)} where id = any(${sql.param(ids)}::uuid[]) returning id`);
      return { purged: purged.rows.length, last };
    });
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
