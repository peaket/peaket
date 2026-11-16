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
  WITHDRAWAL_RECHECK_DELAY_MS,
  withdrawalRecheckAt,
} from '../domain/review.js';
import type { FanProfile, ReviewCaseSink, ReviewEligibility, ReviewEvent, ReviewEventDirectory, ReviewNotifier, ReviewStore } from '../domain/ports.js';
import { ReviewEligibilityUnavailable } from '../domain/ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 24 * 60 * 60 * 1000;
/** 탈퇴 후기 다시 정리 한 번에 잡는 예약 수 100개 [가정](docs/features/identity.md §8 '다시 정리') */
const WITHDRAWAL_RECHECK_BATCH = 100;

export interface ReviewServiceDeps {
  readonly store: ReviewStore;
  readonly events: ReviewEventDirectory;
  readonly eligibility: ReviewEligibility;
  readonly fanProfile: FanProfile;
  readonly notifier: ReviewNotifier;
  readonly cases: ReviewCaseSink;
  readonly clock: Clock;
  /** 손으로 처리의 운영 줄(review-purge-manual). 없으면 남기지 않는다(소비자 조립·단위 시험) */
  readonly logger?: { info(o: object, msg?: string): void };
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

const notFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const notAuthor = () => new ProblemError({ type: 'review-not-author', status: 403, title: '내 후기만 고칠 수 있습니다' });
const selfReport = () => new ProblemError({ type: 'review-self-report', status: 403, title: '내 후기는 신고할 수 없습니다' });
const alreadyReported = () => new ProblemError({ type: 'already-reported', status: 409, title: '이미 신고한 후기입니다' });
const reportLimited = (retryAfterSeconds: number) => new ProblemError({ type: 'report-limited', status: 429, title: '오늘은 더 신고할 수 없습니다', retryAfterSeconds });
const eligibilityUnavailable = () => new ProblemError({ type: 'review-eligibility-unavailable', status: 503, title: '후기 자격을 잠시 확인할 수 없습니다', retryAfterSeconds: 5 });
const hiddenByNotice = () => new ProblemError({ type: 'review-hidden-by-notice', status: 409, title: '통보로 가린 후기는 고칠 수 없습니다' });
const eventNotFound = () => new ProblemError({ type: 'not-found', status: 404, title: '찾을 수 없습니다' });
const invalidAccount = () => new ReviewProblem('review-invalid', 422, '계정 ID가 올바르지 않습니다');

/** 살아 있는 후기(VISIBLE·HIDDEN)의 별점·지문. 파기한 행(DELETED)에서만 null이라 여기서 null이면 없는 후기로 본다(review_live_complete_check) */
const live = (r: ReviewRecord): { rating: number; contentFingerprint: string } => {
  if (r.status === 'DELETED' || r.rating === null || r.contentFingerprint === null) throw notFound();
  return { rating: r.rating, contentFingerprint: r.contentFingerprint };
};

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
      if (existing) throw new ProblemError({ type: 'review-already-written', status: 409, title: '이 회차의 후기를 이미 썼습니다', extensions: { myReviewId: existing.reviewId } });
      if (e.cancelled) throw new ProblemError({ type: 'review-event-cancelled', status: 403, title: '취소된 회차에는 후기를 쓸 수 없습니다' });
      const eligible = await this.#checkEligibility(accountId, e);
      if (!eligible.eligible) {
        if (eligible.reason === 'NOT_ENDED') throw new ProblemError({ type: 'review-not-ended', status: 403, title: '공연이 끝난 뒤에 후기를 쓸 수 있습니다' });
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
        if (isUniqueViolation(e)) throw new ProblemError({ type: 'review-already-written', status: 409, title: '이 회차의 후기를 이미 썼습니다' });
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
      const { contentFingerprint: fingerprint } = live(r);
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
      const hide = v.category === 'ILLEGAL_FILMING' ? { status: 'HIDDEN' as const, takedown: this.#takedown(reviewId, 'FILMING_HOLD', fingerprint, now) } : undefined;
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
      const { contentFingerprint: fingerprint } = live(r);
      const now = this.d.clock.now();
      const effect = moderationEffect(input, now);
      await this.d.store.moderate(reviewId, {
        ...(effect.status !== undefined ? { status: effect.status } : {}),
        ...(effect.notice !== undefined ? { notice: effect.notice } : {}),
        ...(effect.noticeUntilMs !== undefined ? { noticeUntilMs: effect.noticeUntilMs } : {}),
        ...(effect.takedown ? { takedown: this.#takedown(reviewId, effect.takedown.reason, fingerprint, now, effect.takedown.endsAtMs) } : {}),
        restoreTakedowns: effect.restoreTakedowns,
        outcome: effect.outcome,
        nowMs: now,
      });
      // 같은 지문에 다른 통보가 살아 있으면 지문을 지우지 않는다(하나를 풀었다고 같은 내용 차단이 풀리면 안 된다)
      if (effect.restoreTakedowns && !(await this.d.store.hasActiveNoticeFingerprint(fingerprint))) await this.d.store.removeHiddenFingerprint(fingerprint);
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
      for (const reviewId of input.reviewIds) if (!UUID.test(reviewId)) throw new ReviewProblem('review-invalid', 422, '후기 ID가 올바르지 않습니다');
      // 후기 갱신·조치 기록·지문 등록을 저장소 한 트랜잭션으로 묶고, 같은 통보·후기는 다시 적용하지 않는다
      const { applied } = await this.d.store.applyNoticeTakedown({ reviewIds: input.reviewIds, noticeId: input.noticeId, nowMs: now });
      return { applied, deadlineAt: new Date(deadline).toISOString() };
    });
  }

  /** CS 처리함 상세: 신고자 계정은 싣지 않고 사유별 수·신고 내용·후기 본문을 준다 */
  async reportedReview(reviewId: string): Promise<{
    review: { reviewId: string; eventId: string; rating: number; body: string; status: ReviewRecord['status']; notice?: ReviewRecord['notice']; noticeUntil?: string; authorDisplay: string; createdAt: string; edited: boolean };
    summary: { total: number; byCategory: Record<string, number>; reports: readonly { category: string; detail: string; rightsHolder: boolean; notifyChannel?: string; createdAt: string }[] };
  }> {
    return guard(async () => {
      if (!UUID.test(reviewId)) throw notFound();
      const r = await this.d.store.findReview(reviewId);
      if (!r || r.status === 'DELETED') throw notFound();
      const { rating } = live(r);
      const reports = await this.d.store.reportsByTarget(reviewId);
      const byCategory: Record<string, number> = {};
      for (const x of reports) byCategory[x.category] = (byCategory[x.category] ?? 0) + 1;
      return {
        review: {
          reviewId: r.reviewId,
          eventId: r.eventId,
          rating,
          body: r.body,
          status: r.status,
          ...(r.notice !== undefined ? { notice: r.notice } : {}),
          ...(r.noticeUntilMs !== undefined ? { noticeUntil: new Date(r.noticeUntilMs).toISOString() } : {}),
          authorDisplay: r.authorDisplay,
          createdAt: new Date(r.createdAtMs).toISOString(),
          edited: r.edited,
        },
        summary: {
          total: reports.length,
          byCategory,
          reports: reports.map((x) => ({ category: x.category, detail: x.detail, rightsHolder: x.rightsHolder, ...(x.notifyChannel ? { notifyChannel: x.notifyChannel } : {}), createdAt: new Date(x.createdAtMs).toISOString() })),
        },
      };
    });
  }

  // 탈퇴 후기 파기와 다시 정리(소유자 결정 2026-11-16 OPEN[42]·[44], ADR-0278, docs/features/identity.md §8 '후기 파기'·'다시 정리').
  // 파기 칸은 docs/data.md §2 '후기 파기'다(본문·별점·내용 지문을 비우고 DELETED, 계정·주문 참조는 후기 ID로). 상태가 DELETED라 목록·요약·상세에서 빠진다.

  /**
   * 손으로 처리(내부 경로 POST /internal/v1/reviews/accounts/{accountId}/purge, 웨이브 끝 보안 리뷰 S1, docs/features/identity.md §8 '손으로 처리').
   * 그 계정의 처리 안 한 탈퇴 보류 사건(held_event)이 있을 때만, 한 트랜잭션에서 보류 행 잠금 → 다시 정리 예약(지금 + 16분) → 파기 → 보류 행 다시 처리 표시를 한다.
   * 커밋한 뒤 운영 줄 review-purge-manual에 요청자·사유·보류 사건 eventKey·파기 수를 남긴다(계정 ID 없음).
   * @throws ReviewProblem('review-invalid', 422) 계정 ID가 UUID가 아님
   * @throws ReviewProblem('withdrawal-not-held', 409) 그 계정의 보류된 탈퇴 사건이 없음(아무것도 바꾸지 않는다)
   */
  async purgeHeldWithdrawal(accountId: string, by: { reason: string; requestedBy: string }): Promise<{ purged: number; heldEvents: number }> {
    if (!UUID.test(accountId)) throw invalidAccount();
    const nowMs = this.d.clock.now();
    const r = await this.d.store.purgeHeldWithdrawal(accountId.toLowerCase(), { nowMs, recheckAtMs: nowMs + WITHDRAWAL_RECHECK_DELAY_MS });
    if (!r) throw new ReviewProblem('withdrawal-not-held', 409, '이 계정에는 처리하지 않은 탈퇴 보류 사건이 없습니다');
    this.d.logger?.info({ kind: 'review-purge-manual', requestedBy: by.requestedBy, reason: by.reason, heldEventKeys: r.heldEventKeys, purged: r.purged }, '보류된 탈퇴 사건을 손으로 처리했다');
    return { purged: r.purged, heldEvents: r.heldEventKeys.length };
  }

  /**
   * 탈퇴 사건 처리: 그 계정 후기를 파기하고, 같은 트랜잭션에 다시 정리 예약(min(withdrawnAt, 지금) + 16분)을 쓴다.
   * 탈퇴 전에 받은 액세스 토큰(최대 15분)으로 그 뒤에 쓴 후기를 예약 시각에 다시 파기하려는 것이다.
   * 예약 셈이 탈퇴 시각을 읽지 못하면 예약을 처리 시각 + 16분으로 하고 파기는 그대로 한다(법정 파기가 빠지지 않게, 웨이브 끝 정확성 리뷰 C1).
   * 그때 결과에 recheckFallback: true를 실어 처리기가 경고 한 줄(값 없음)을 남기게 한다.
   * @throws ReviewProblem('review-invalid', 422) 계정 ID가 UUID가 아님
   */
  async purgeWithdrawn(e: { accountId: string; withdrawnAt: string }): Promise<{ purged: number; recheckFallback?: true }> {
    if (!UUID.test(e.accountId)) throw invalidAccount();
    const nowMs = this.d.clock.now();
    let recheckAtMs: number;
    let fallback = false;
    try {
      recheckAtMs = withdrawalRecheckAt(e.withdrawnAt, nowMs);
    } catch {
      recheckAtMs = nowMs + WITHDRAWAL_RECHECK_DELAY_MS;
      fallback = true;
    }
    const purged = await this.d.store.purgeWithdrawnAccount(e.accountId.toLowerCase(), { nowMs, recheckAtMs });
    return fallback ? { purged, recheckFallback: true } : { purged };
  }

  /** 다시 정리 반복 한 번의 몸통: 때가 된 예약을 limit개(기본 100 [가정])까지 잡아 그 계정을 다시 파기하고 예약을 지운다 */
  async runWithdrawalRechecks(limit: number = WITHDRAWAL_RECHECK_BATCH): Promise<{ accounts: number; purged: number }> {
    return this.d.store.runDueRechecks(this.d.clock.now(), limit);
  }

  /** 가장 오래 밀린 다시 정리 예약이 예약 시각을 넘긴 시간(ms). 없거나 밀리지 않았으면 0 */
  async oldestOverdueRecheckMs(): Promise<number> {
    return this.d.store.oldestOverdueRecheckMs(this.d.clock.now());
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
