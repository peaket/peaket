// 후기·신고·조치 유스케이스(BUILD_ORDER BAT-585, FR-016·FR-033·FR-070, POL-024·POL-042·POL-044, ADR-0066).
// 자격은 ticket-svc에 묻고, 같은 공연의 후기 모으기·가림·신고 처리·같은 내용 차단은 core DB에서 한다.
import { ProblemError, uuidv7, type Clock } from '@peaket/platform';
import {
  contentFingerprint,
  type EligibilityView,
  maskAuthor,
  moderationEffect,
  type ModerationInput,
  noticeDeadlineMs,
  type NoticeKind,
  type ReportInput,
  type ReportRecord,
  REPORT_DAILY_LIMIT,
  type ReviewPage,
  ReviewProblem,
  type ReviewRecord,
  type ReviewSort,
  type ReviewSummary,
  type ReviewView,
  type ReviewWriteInput,
  reviewView,
  summaryOf,
  type TakedownRecord,
  validateReport,
  validateReviewWrite,
} from '../domain/review.js';
import type { FanProfile, ReviewCaseSink, ReviewEligibility, ReviewEvent, ReviewEventDirectory, ReviewNotifier, ReviewStore } from '../domain/ports.js';
import { ReviewEligibilityUnavailable } from '../domain/ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ReviewServiceDeps {
  readonly store: ReviewStore;
  readonly events: ReviewEventDirectory;
  readonly eligibility: ReviewEligibility;
  readonly fanProfile: FanProfile;
  readonly notifier: ReviewNotifier;
  readonly cases: ReviewCaseSink;
  readonly clock: Clock;
}

const problem = (e: ReviewProblem): ProblemError => new ProblemError({ type: e.type, status: e.status, title: e.title, extensions: e.extensions });
/** PostgreSQL 유일 인덱스 위반. 동시에 같은 후기·신고를 넣은 쪽을 409로 답한다 */
const isUniqueViolation = (e: unknown): boolean => {
  const code = (e as { code?: unknown; cause?: { code?: unknown } } | undefined)?.code ?? (e as { cause?: { code?: unknown } } | undefined)?.cause?.code;
  return code === '23505';
};
const guard = async <T>(fn: () => Promise<T>): Promise<T> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ReviewProblem) throw problem(e);
    throw e;
  }
};

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '후기를 찾을 수 없습니다' });
const notAuthor = () => new ProblemError({ type: 'review-not-author', status: 403, title: '내 후기만 고칠 수 있습니다' });
const selfReport = () => new ProblemError({ type: 'review-self-report', status: 403, title: '내 후기는 신고할 수 없습니다' });
const alreadyReported = () => new ProblemError({ type: 'already-reported', status: 409, title: '이미 신고한 후기입니다' });
const reportLimited = (retryAfterSeconds: number) => new ProblemError({ type: 'report-limited', status: 429, title: '오늘은 더 신고할 수 없습니다', retryAfterSeconds });
const eligibilityUnavailable = () => new ProblemError({ type: 'review-eligibility-unavailable', status: 503, title: '후기 자격을 잠시 확인할 수 없습니다', retryAfterSeconds: 5 });
const hiddenByNotice = () => new ProblemError({ type: 'review-hidden-by-notice', status: 409, title: '통보로 가린 후기는 고칠 수 없습니다' });
const eventNotFound = () => new ProblemError({ type: 'not-found', status: 404, title: '공연을 찾을 수 없습니다' });

type EventInfo = Omit<ReviewEvent, 'rounds'> & { readonly rounds: ReadonlyMap<string, number> };

export class Reviews {
  constructor(private readonly d: ReviewServiceDeps) {}

  async list(eventId: string, viewerAccountId: string | undefined, sort: ReviewSort, cursor: string | undefined, limit: number): Promise<ReviewPage> {
    return guard(async () => {
      const e = await this.#event(eventId);
      const page = await this.d.store.listReviews({ productionId: e.productionId, sort, ...(cursor ? { cursor } : {}), limit, ...(viewerAccountId ? { viewerAccountId } : {}) });
      const reported = viewerAccountId ? await this.d.store.reportedTargetIds(viewerAccountId, page.items.map((r) => r.reviewId)) : new Set<string>();
      const items = page.items.flatMap((r) => {
        const view = reviewView(r, viewerAccountId, reported.has(r.reviewId), new Date(e.rounds.get(r.eventId) ?? e.startsAtMs).toISOString());
        return view ? [view] : [];
      });
      return { items, nextCursor: page.nextCursor ?? null };
    });
  }

  async get(reviewId: string, viewerAccountId: string | undefined): Promise<ReviewView> {
    return guard(async () => {
      if (!UUID.test(reviewId)) throw notFound();
      const r = await this.d.store.findReview(reviewId);
      if (!r || r.status === 'DELETED') throw notFound();
      const e = await this.#event(r.eventId);
      const reported = viewerAccountId ? await this.d.store.reportedTargetIds(viewerAccountId, [reviewId]) : new Set<string>();
      const view = reviewView(r, viewerAccountId, reported.has(reviewId), new Date(e.startsAtMs).toISOString());
      if (!view) throw notFound();
      return view;
    });
  }

  async summary(eventId: string): Promise<ReviewSummary> {
    return guard(async () => {
      const e = await this.#event(eventId);
      const all = await this.d.store.listVisibleByProduction(e.productionId);
      const s = summaryOf(all);
      const recent = [...all].sort((a, b) => b.createdAtMs - a.createdAtMs || b.reviewId.localeCompare(a.reviewId)).slice(0, 2);
      return {
        averageRating: s.averageRating,
        count: s.count,
        recent: recent.flatMap((r) => {
          const v = reviewView(r, undefined, false, new Date(e.rounds.get(r.eventId) ?? e.startsAtMs).toISOString());
          return v ? [v] : [];
        }),
      };
    });
  }

  async eligibility(eventId: string, accountId: string): Promise<EligibilityView> {
    return guard(async () => {
      const e = await this.#event(eventId);
      const existing = await this.d.store.findReviewByEventAccount(e.eventId, accountId);
      if (existing) return { eligible: false, reason: 'ALREADY_WRITTEN', myReviewId: existing.reviewId };
      if (e.cancelled) return { eligible: false, reason: 'EVENT_CANCELLED' };
      const r = await this.#checkEligibility(accountId, e);
      return r.eligible ? { eligible: true } : { eligible: false, reason: r.reason === 'NOT_ENDED' ? 'NOT_ENDED' : 'NOT_PURCHASER' };
    });
  }

  async create(eventId: string, accountId: string, input: ReviewWriteInput): Promise<ReviewView> {
    return guard(async () => {
      const e = await this.#event(eventId);
      const existing = await this.d.store.findReviewByEventAccount(e.eventId, accountId);
      if (existing) throw new ProblemError({ type: 'review-already-written', status: 409, title: '이미 후기를 썼습니다', extensions: { myReviewId: existing.reviewId } });
      if (e.cancelled) throw new ProblemError({ type: 'review-event-cancelled', status: 403, title: '취소된 회차에는 후기를 쓸 수 없습니다' });
      const eligible = await this.#checkEligibility(accountId, e);
      if (!eligible.eligible) {
        if (eligible.reason === 'NOT_ENDED') throw new ProblemError({ type: 'review-not-ended', status: 403, title: '공연이 끝난 뒤 후기를 쓸 수 있습니다' });
        throw new ProblemError({ type: 'review-not-purchaser', status: 403, title: '이 회차를 예매한 분만 후기를 쓸 수 있습니다' });
      }
      // 자격 답에 근거 주문이 없으면 저장하지 않는다(빈 UUID로 DB 오류를 내지 않는다)
      if (!eligible.basisOrderId) throw eligibilityUnavailable();
      const { rating, body } = validateReviewWrite(input);
      const fingerprint = contentFingerprint(body);
      const hidden = await this.d.store.hasHiddenFingerprint(fingerprint);
      const now = this.d.clock.now();
      const id = uuidv7(this.d.clock);
      const authorDisplay = maskAuthor(await this.d.fanProfile.nickname(accountId));
      const review: ReviewRecord = {
        reviewId: id,
        eventId: e.eventId,
        productionId: e.productionId,
        accountId,
        basisOrderId: eligible.basisOrderId ?? '',
        rating,
        body,
        status: hidden ? 'HIDDEN' : 'VISIBLE',
        contentFingerprint: fingerprint,
        authorDisplay,
        createdAtMs: now,
        updatedAtMs: now,
        edited: false,
      };
      try {
        await this.d.store.insertReview(review);
      } catch (e) {
        if (isUniqueViolation(e)) throw new ProblemError({ type: 'review-already-written', status: 409, title: '이미 후기를 썼습니다' });
        throw e;
      }
      if (hidden) await this.d.store.insertTakedown(this.#takedown(id, 'SAME_CONTENT', fingerprint, now));
      return reviewView(review, accountId, false, new Date(e.rounds.get(e.eventId) ?? e.startsAtMs).toISOString())!;
    });
  }

  async update(reviewId: string, accountId: string, input: ReviewWriteInput): Promise<ReviewView> {
    return guard(async () => {
      const r = await this.#mine(reviewId, accountId);
      const takedowns = await this.d.store.takedownsByReview(reviewId);
      if (r.notice !== undefined || takedowns.some((t) => t.reason === 'NOTICE' && t.restoredAtMs === undefined)) throw hiddenByNotice();
      const { rating, body } = validateReviewWrite(input);
      const fingerprint = contentFingerprint(body);
      const hidden = await this.d.store.hasHiddenFingerprint(fingerprint);
      const now = this.d.clock.now();
      await this.d.store.updateReview(reviewId, { rating, body, status: hidden ? 'HIDDEN' : 'VISIBLE', notice: undefined, noticeUntilMs: undefined, contentFingerprint: fingerprint, updatedAtMs: now, edited: true });
      const same = takedowns.filter((t) => t.reason === 'SAME_CONTENT' && t.restoredAtMs === undefined);
      if (hidden && same.length === 0) await this.d.store.insertTakedown(this.#takedown(reviewId, 'SAME_CONTENT', fingerprint, now));
      if (!hidden && same.length > 0) await this.d.store.restoreTakedowns(reviewId, now);
      const updated = (await this.d.store.findReview(reviewId))!;
      const e = await this.#event(updated.eventId);
      return reviewView(updated, accountId, false, new Date(e.startsAtMs).toISOString())!;
    });
  }

  async delete(reviewId: string, accountId: string): Promise<void> {
    return guard(async () => {
      await this.#mine(reviewId, accountId);
      await this.d.store.softDeleteReview(reviewId, this.d.clock.now());
    });
  }

  async report(reviewId: string, reporterAccountId: string, input: ReportInput): Promise<{ reportId: string }> {
    return guard(async () => {
      if (!UUID.test(reviewId)) throw notFound();
      const r = await this.d.store.findReview(reviewId);
      if (!r || r.status !== 'VISIBLE') throw notFound();
      if (r.accountId === reporterAccountId) throw selfReport();
      const v = validateReport(input);
      if (await this.d.store.findReportByTargetReporter(reviewId, reporterAccountId)) throw alreadyReported();
      const now = this.d.clock.now();
      const since = now - DAY_MS;
      if ((await this.d.store.countReportsByReporterSince(reporterAccountId, since)) >= REPORT_DAILY_LIMIT) throw reportLimited(Math.max(1, Math.ceil((since + DAY_MS - now) / 1000)));
      const reportId = uuidv7(this.d.clock);
      const report: ReportRecord = {
        reportId,
        targetId: reviewId,
        reporterAccountId,
        category: v.category,
        detail: v.detail,
        rightsHolder: v.rightsHolder,
        ...(v.notifyChannel ? { notifyChannel: v.notifyChannel } : {}),
        status: 'RECEIVED',
        createdAtMs: now,
        purgeAtMs: now + 365 * DAY_MS,
      };
      const hide = v.category === 'ILLEGAL_FILMING' ? { status: 'HIDDEN' as const, takedown: this.#takedown(reviewId, 'FILMING_HOLD', r.contentFingerprint, now) } : undefined;
      try {
        await this.d.store.insertReport(report, hide);
      } catch (e) {
        if (isUniqueViolation(e)) throw alreadyReported();
        throw e;
      }
      const kind = v.rightsHolder ? 'RIGHTS_REQUEST' : 'CONTENT_REPORT';
      const dueAtMs = now + (v.rightsHolder ? DAY_MS : 3 * DAY_MS);
      await this.d.cases.request({ kind, targetId: reviewId, dueAtMs });
      await this.d.notifier.reportReceived(report);
      return { reportId };
    });
  }

  async moderate(reviewId: string, input: ModerationInput): Promise<{ applied: true }> {
    return guard(async () => {
      if (!UUID.test(reviewId)) throw notFound();
      const r = await this.d.store.findReview(reviewId);
      if (!r || r.status === 'DELETED') throw notFound();
      const now = this.d.clock.now();
      const effect = moderationEffect(input, now);
      await this.d.store.moderate(reviewId, {
        ...(effect.status !== undefined ? { status: effect.status } : {}),
        ...(effect.notice !== undefined ? { notice: effect.notice } : {}),
        ...(effect.noticeUntilMs !== undefined ? { noticeUntilMs: effect.noticeUntilMs } : {}),
        ...(effect.takedown ? { takedown: this.#takedown(reviewId, effect.takedown.reason, r.contentFingerprint, now, effect.takedown.endsAtMs) } : {}),
        restoreTakedowns: effect.restoreTakedowns,
        outcome: effect.outcome,
        nowMs: now,
      });
      // 같은 지문에 다른 통보가 살아 있으면 지문을 지우지 않는다(하나를 풀었다고 같은 내용 차단이 풀리면 안 된다)
      if (effect.restoreTakedowns && !(await this.d.store.hasActiveNoticeFingerprint(r.contentFingerprint))) await this.d.store.removeHiddenFingerprint(r.contentFingerprint);
      const updated = (await this.d.store.findReview(reviewId))!;
      await this.d.notifier.moderationApplied(updated, input.action, input.reason);
      return { applied: true };
    });
  }

  /** 법정 통보(명령 10): 게시물을 가리고 같은 내용 지문을 등록해 앞으로의 같은 내용도 바로 가린다. 기한은 24시간/10시간이다 */
  async applyNoticeTakedown(input: { reviewIds: readonly string[]; noticeId: string; receivedAtMs: number; kind: NoticeKind; reason: string }): Promise<{ applied: number; deadlineAt: string }> {
    return guard(async () => {
      if (!UUID.test(input.noticeId)) throw new ReviewProblem('notice-invalid', 422, '통보 문서 ID가 올바르지 않습니다');
      if (input.reason.trim().length === 0) throw new ReviewProblem('notice-invalid', 422, '통보 사유를 적어 주세요');
      const now = this.d.clock.now();
      const deadline = noticeDeadlineMs(input.receivedAtMs, input.kind);
      let applied = 0;
      for (const reviewId of input.reviewIds) {
        if (!UUID.test(reviewId)) throw new ReviewProblem('review-invalid', 422, '후기 ID가 올바르지 않습니다');
        const r = await this.d.store.findReview(reviewId);
        if (!r || r.status === 'DELETED') continue;
        await this.d.store.updateReview(reviewId, { status: 'HIDDEN', notice: undefined, noticeUntilMs: undefined, updatedAtMs: now });
        await this.d.store.insertTakedown({ ...this.#takedown(reviewId, 'NOTICE', r.contentFingerprint, now), noticeId: input.noticeId });
        await this.d.store.addHiddenFingerprint(r.contentFingerprint, input.noticeId, now);
        applied += 1;
      }
      return { applied, deadlineAt: new Date(deadline).toISOString() };
    });
  }

  /** CS 처리함 상세: 신고자 계정은 싣지 않고 사유별 수·신고 내용·후기 본문을 준다 */
  async reportedReview(reviewId: string): Promise<{ review: ReviewRecord; summary: { total: number; byCategory: Record<string, number>; reports: readonly { category: string; detail: string; rightsHolder: boolean; notifyChannel?: string; createdAt: string }[] } }> {
    return guard(async () => {
      if (!UUID.test(reviewId)) throw notFound();
      const r = await this.d.store.findReview(reviewId);
      if (!r || r.status === 'DELETED') throw notFound();
      const reports = await this.d.store.reportsByTarget(reviewId);
      const byCategory: Record<string, number> = {};
      for (const x of reports) byCategory[x.category] = (byCategory[x.category] ?? 0) + 1;
      return {
        review: r,
        summary: {
          total: reports.length,
          byCategory,
          reports: reports.map((x) => ({ category: x.category, detail: x.detail, rightsHolder: x.rightsHolder, ...(x.notifyChannel ? { notifyChannel: x.notifyChannel } : {}), createdAt: new Date(x.createdAtMs).toISOString() })),
        },
      };
    });
  }

  async #event(eventId: string): Promise<EventInfo> {
    if (!UUID.test(eventId)) throw eventNotFound();
    const row = await this.d.events.find(eventId.toLowerCase());
    if (!row) throw eventNotFound();
    if (row.saleApprovedAtMs === null || (row.saleReview !== 'APPROVED' && row.saleReview !== 'SUSPENDED')) throw eventNotFound();
    return { ...row, rounds: new Map(row.rounds.map((r) => [r.eventId, r.startsAtMs])) };
  }

  async #checkEligibility(accountId: string, e: EventInfo): Promise<{ eligible: boolean; basisOrderId?: string; reason?: 'NOT_ENDED' | 'NOT_PURCHASER' | 'NO_VALID_TICKET' }> {
    try {
      return await this.d.eligibility.check({ accountId, eventId: e.eventId, eventEndsAtMs: e.endsAtMs });
    } catch (err) {
      if (err instanceof ReviewEligibilityUnavailable) throw eligibilityUnavailable();
      throw err;
    }
  }

  async #mine(reviewId: string, accountId: string): Promise<ReviewRecord> {
    if (!UUID.test(reviewId)) throw notFound();
    const r = await this.d.store.findReview(reviewId);
    if (!r || r.status === 'DELETED') throw notFound();
    if (r.accountId !== accountId) throw notAuthor();
    return r;
  }

  #takedown(reviewId: string, reason: TakedownRecord['reason'], fingerprint: string, nowMs: number, endsAtMs?: number): TakedownRecord {
    return {
      takedownId: uuidv7(this.d.clock),
      reviewId,
      reason,
      contentFingerprint: fingerprint,
      hiddenAtMs: nowMs,
      ...(endsAtMs !== undefined ? { endsAtMs } : {}),
    };
  }
}
