// 관람 후기·게시물 신고·운영자 조치의 순수 규칙(BUILD_ORDER BAT-585, FR-016·FR-033·FR-070, POL-024·POL-042·POL-044, ADR-0066).
// 저장소·HTTP와 분리해 시험한다. 후기 본문은 NFC, 같은 내용 지문은 NFKC 뒤 공백·문장부호를 지워 만든다.
import { createHash } from 'node:crypto';

export const REVIEW_BODY_MIN = 10;
export const REVIEW_BODY_MAX = 1000;
export const REVIEW_DETAIL_MAX = 500;
export const REVIEW_IMAGES_MAX = 3;
export const REPORT_DAILY_LIMIT = 10;
export const TEMP_BLOCK_MAX_DAYS = 30;
/** 법정 통보 처리 기한(공연법 시행령 §3의3 2호 바목): 일반 24시간, 문화체육관광부 고시 10시간 */
export const NOTICE_DEADLINE_MS = { GENERAL: 24 * 60 * 60 * 1000, MINISTRY: 10 * 60 * 60 * 1000 } as const;

export type ReviewStatus = 'VISIBLE' | 'HIDDEN' | 'DELETED';
export type ReviewNotice = 'RIGHTS_TEMP' | 'POLICY';
export type ReviewSort = 'LATEST' | 'RATING_DESC' | 'RATING_ASC';
export type ReportCategory = 'SCALPING' | 'MACRO' | 'ABUSE' | 'RIGHTS' | 'ILLEGAL_FILMING' | 'SPAM' | 'OFF_TOPIC' | 'OTHER';
export type ReportStatus = 'RECEIVED' | 'IN_REVIEW' | 'RESOLVED';
export type ReportOutcome = 'NO_ACTION' | 'TEMP_BLOCKED' | 'BLOCKED';
export type ModerationAction = 'NO_ACTION' | 'TEMP_BLOCK' | 'BLOCK' | 'RELEASE';
export type TakedownReason = 'NOTICE' | 'SAME_CONTENT' | 'RIGHTS_TEMP' | 'POLICY' | 'FILMING_HOLD';
export type NoticeKind = 'GENERAL' | 'MINISTRY';

export interface ReviewRecord {
  readonly reviewId: string;
  readonly eventId: string;
  readonly productionId: string;
  readonly accountId: string;
  readonly basisOrderId: string;
  readonly rating: number;
  readonly body: string;
  readonly status: ReviewStatus;
  readonly notice?: ReviewNotice;
  readonly noticeUntilMs?: number;
  readonly contentFingerprint: string;
  readonly authorDisplay: string;
  readonly createdAtMs: number;
  readonly updatedAtMs: number;
  readonly edited: boolean;
}

export interface ReportRecord {
  readonly reportId: string;
  readonly targetId: string;
  readonly reporterAccountId: string;
  readonly category: ReportCategory;
  readonly detail: string;
  readonly rightsHolder: boolean;
  readonly notifyChannel?: 'APP' | 'EMAIL';
  readonly status: ReportStatus;
  readonly outcome?: ReportOutcome;
  readonly caseId?: string;
  readonly createdAtMs: number;
  readonly resolvedAtMs?: number;
  readonly purgeAtMs: number;
}

export interface TakedownRecord {
  readonly takedownId: string;
  readonly noticeId?: string;
  readonly reviewId: string;
  readonly reason: TakedownReason;
  readonly contentFingerprint: string;
  readonly hiddenAtMs: number;
  readonly endsAtMs?: number;
  readonly restoredAtMs?: number;
}

export interface ReviewWriteInput {
  readonly rating: number;
  readonly body: string;
  readonly images?: readonly { imageId: string; alt?: string }[];
}

export interface ReportInput {
  readonly category: ReportCategory;
  readonly detail?: string;
  readonly rightsHolder?: boolean;
  readonly notifyChannel?: 'APP' | 'EMAIL';
}

export interface ModerationInput {
  readonly action: ModerationAction;
  readonly reason: string;
  readonly violation?: ReportCategory;
  readonly endsAtMs?: number;
}

export interface ReviewView {
  readonly reviewId: string;
  readonly eventId: string;
  readonly authorDisplay: string;
  readonly attendedStartsAt: string;
  readonly rating?: number;
  readonly body?: string;
  readonly createdAt: string;
  readonly edited: boolean;
  readonly mine: boolean;
  readonly reportedByMe: boolean;
  readonly images: readonly never[];
  readonly status: ReviewStatus;
  readonly notice?: ReviewNotice;
  readonly noticeUntil?: string;
  readonly permalink: string;
}

export interface ReviewPage {
  readonly items: readonly ReviewView[];
  readonly nextCursor: string | null;
}

export interface ReviewSummary {
  readonly averageRating: number | null;
  readonly count: number;
  readonly recent: readonly ReviewView[];
}

export interface EligibilityView {
  readonly eligible: boolean;
  readonly reason?: 'NOT_ENDED' | 'NOT_PURCHASER' | 'EVENT_CANCELLED' | 'ALREADY_WRITTEN';
  readonly myReviewId?: string;
}

/** 잘못된 입력·권한·상태. 받는 층이 Problem으로 바꾼다 */
export class ReviewProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
    readonly extensions: Record<string, unknown> = {},
  ) {
    super(title);
    this.name = 'ReviewProblem';
  }
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;
const PUNCT_SPACE = /[\p{P}\p{Z}\p{C}]/gu;
const SEGMENTER = new Intl.Segmenter('ko', { granularity: 'grapheme' });

export function graphemes(text: string): string[] {
  return [...SEGMENTER.segment(text)].map((s) => s.segment);
}

/** NFC 정규화 뒤 제어·양방향 제어 문자를 지운다(POL-042 ③, catalog-review 1.3.3) */
export function normalizeText(raw: string): string {
  return raw.normalize('NFC').replace(CONTROL, '');
}

export function validateReviewWrite(input: ReviewWriteInput): { rating: number; body: string } {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5) throw new ReviewProblem('review-invalid', 422, '별점은 1~5점이어야 합니다');
  if (input.images !== undefined && input.images.length > 0) throw new ReviewProblem('review-images-unavailable', 422, '후기 사진은 아직 받지 않습니다');
  const body = normalizeText(input.body);
  const n = graphemes(body).length;
  if (n < REVIEW_BODY_MIN || n > REVIEW_BODY_MAX) throw new ReviewProblem('review-invalid', 422, `후기 본문은 ${REVIEW_BODY_MIN}~${REVIEW_BODY_MAX}자여야 합니다`);
  return { rating: input.rating, body };
}

export function validateReport(input: ReportInput): { category: ReportCategory; detail: string; rightsHolder: boolean; notifyChannel?: 'APP' | 'EMAIL' } {
  const categories: readonly ReportCategory[] = ['SCALPING', 'MACRO', 'ABUSE', 'RIGHTS', 'ILLEGAL_FILMING', 'SPAM', 'OFF_TOPIC', 'OTHER'];
  if (!categories.includes(input.category)) throw new ReviewProblem('report-invalid', 422, '신고 사유를 골라 주세요');
  const detail = normalizeText(input.detail ?? '');
  if (graphemes(detail).length > REVIEW_DETAIL_MAX) throw new ReviewProblem('report-invalid', 422, `자세한 내용은 ${REVIEW_DETAIL_MAX}자까지 쓸 수 있습니다`);
  const rightsHolder = input.category === 'RIGHTS' ? input.rightsHolder === true : false;
  if (input.category === 'RIGHTS' && input.rightsHolder === undefined) throw new ReviewProblem('report-invalid', 422, '권리를 침해받은 본인인지 골라 주세요');
  if ((rightsHolder || input.category === 'OTHER') && detail.length === 0) throw new ReviewProblem('report-invalid', 422, '자세한 내용을 적어 주세요');
  if (rightsHolder && input.notifyChannel === undefined) throw new ReviewProblem('report-invalid', 422, '처리 결과를 받을 곳을 골라 주세요');
  return { category: input.category, detail, rightsHolder, ...(input.notifyChannel ? { notifyChannel: input.notifyChannel } : {}) };
}

/** 같은 내용 지문: NFKC 뒤 공백·문장부호·제어 문자를 지우고 소문자로 만든 SHA-256(FR-033 2호 마목, POL-024) */
export function contentFingerprint(body: string): string {
  const normalized = normalizeText(body).normalize('NFKC').replace(PUNCT_SPACE, '').toLowerCase();
  return createHash('sha256').update(normalized, 'utf8').digest('hex');
}

/** 작성자 표시: 닉네임 첫 grapheme + '**'(POL-042 ④). 닉네임을 모르면 '***' */
export function maskAuthor(nickname: string | undefined): string {
  if (!nickname) return '***';
  const first = graphemes(normalizeText(nickname))[0];
  return first ? `${first}**` : '***';
}

export function noticeDeadlineMs(receivedAtMs: number, kind: NoticeKind): number {
  return receivedAtMs + NOTICE_DEADLINE_MS[kind];
}

export interface ModerationEffect {
  /** NO_ACTION이면 바꾸지 않는다 */
  readonly status?: ReviewStatus;
  readonly notice?: ReviewNotice;
  readonly noticeUntilMs?: number;
  readonly takedown?: { reason: TakedownReason; endsAtMs?: number };
  readonly restoreTakedowns: boolean;
  readonly outcome: ReportOutcome;
}

/** 신고 처리 조치의 효과(POL-044 ③). 임시조치는 30일 이내, 노출 차단은 위반 사유가 필수다 */
export function moderationEffect(input: ModerationInput, nowMs: number): ModerationEffect {
  if (input.reason.trim().length === 0) throw new ReviewProblem('moderation-invalid', 422, '조치 사유를 적어 주세요');
  switch (input.action) {
    case 'NO_ACTION':
      return { restoreTakedowns: false, outcome: 'NO_ACTION' };
    case 'TEMP_BLOCK': {
      if (!input.violation) throw new ReviewProblem('moderation-invalid', 422, '위반 사유를 골라 주세요');
      if (input.endsAtMs === undefined || input.endsAtMs <= nowMs) throw new ReviewProblem('moderation-invalid', 422, '임시조치 끝 시각을 골라 주세요');
      if (input.endsAtMs > nowMs + TEMP_BLOCK_MAX_DAYS * 24 * 60 * 60 * 1000) throw new ReviewProblem('moderation-invalid', 422, '임시조치는 30일을 넘을 수 없습니다');
      return { status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntilMs: input.endsAtMs, takedown: { reason: 'RIGHTS_TEMP', endsAtMs: input.endsAtMs }, restoreTakedowns: false, outcome: 'TEMP_BLOCKED' };
    }
    case 'BLOCK':
      if (!input.violation) throw new ReviewProblem('moderation-invalid', 422, '위반 사유를 골라 주세요');
      return { status: 'HIDDEN', notice: 'POLICY', takedown: { reason: 'POLICY' }, restoreTakedowns: false, outcome: 'BLOCKED' };
    case 'RELEASE':
      return { status: 'VISIBLE', restoreTakedowns: true, outcome: 'NO_ACTION' };
  }
}

/** 목록에 보일 모양. 남에게는 가린 후기를 빼고, 신고 처리로 가린 후기는 notice만 보인다(POL-042 ⑦, POL-044 ⑤) */
export function reviewView(r: ReviewRecord, viewerAccountId: string | undefined, reportedByMe: boolean, attendedStartsAt: string): ReviewView | undefined {
  const mine = viewerAccountId === r.accountId;
  if (r.status === 'DELETED') return undefined;
  if (r.status === 'HIDDEN') {
    if (r.notice) return { reviewId: r.reviewId, eventId: r.eventId, authorDisplay: r.authorDisplay, attendedStartsAt, createdAt: new Date(r.createdAtMs).toISOString(), edited: r.edited, mine, reportedByMe, images: [], status: 'HIDDEN', notice: r.notice, ...(r.noticeUntilMs ? { noticeUntil: new Date(r.noticeUntilMs).toISOString() } : {}), permalink: `/reviews/${r.reviewId}` };
    if (!mine) return undefined;
  }
  return {
    reviewId: r.reviewId,
    eventId: r.eventId,
    authorDisplay: r.authorDisplay,
    attendedStartsAt,
    rating: r.rating,
    body: r.body,
    createdAt: new Date(r.createdAtMs).toISOString(),
    edited: r.edited,
    mine,
    reportedByMe,
    images: [],
    status: r.status,
    permalink: `/reviews/${r.reviewId}`,
  };
}

export function summaryOf(items: readonly ReviewRecord[]): { averageRating: number | null; count: number } {
  const visible = items.filter((r) => r.status === 'VISIBLE');
  if (visible.length === 0) return { averageRating: null, count: 0 };
  const avg = visible.reduce((s, r) => s + r.rating, 0) / visible.length;
  return { averageRating: Math.round(avg * 10) / 10, count: visible.length };
}
