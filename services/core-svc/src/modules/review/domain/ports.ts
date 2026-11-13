// review 모듈의 포트(도메인이 바깥을 모르게 한다). 어댑터는 메모리(시험)와 Drizzle(운영)이다.
import type { ReportRecord, ReviewRecord, ReviewSort, TakedownRecord } from './review.js';

export interface ReviewListInput {
  readonly productionId: string;
  readonly sort: ReviewSort;
  readonly cursor?: string;
  readonly limit: number;
  /** 팬이 부르면 그 계정의 후기·신고 여부를 채운다. 공개 호출이면 없다 */
  readonly viewerAccountId?: string;
}

export interface ReviewListResult {
  readonly items: readonly ReviewRecord[];
  readonly nextCursor?: string;
}

export interface ReportSummary {
  readonly total: number;
  readonly byCategory: Readonly<Record<string, number>>;
  readonly reports: readonly ReportRecord[];
}

export interface ReviewStore {
  insertReview(r: ReviewRecord): Promise<void>;
  findReview(reviewId: string): Promise<ReviewRecord | undefined>;
  findReviewByEventAccount(eventId: string, accountId: string): Promise<ReviewRecord | undefined>;
  updateReview(reviewId: string, patch: Partial<Pick<ReviewRecord, 'rating' | 'body' | 'status' | 'notice' | 'noticeUntilMs' | 'contentFingerprint' | 'updatedAtMs' | 'edited'>>): Promise<void>;
  softDeleteReview(reviewId: string, nowMs: number): Promise<void>;
  listReviews(input: ReviewListInput): Promise<ReviewListResult>;
  /** 같은 공연의 보이는 후기 전부(요약용). 후기 수가 많지 않은 첫 구현에서 쓴다 */
  listVisibleByProduction(productionId: string): Promise<readonly ReviewRecord[]>;
  /** 이 계정이 신고한 후기 ID(목록의 reportedByMe) */
  reportedTargetIds(accountId: string, targetIds: readonly string[]): Promise<ReadonlySet<string>>;

  /** 신고 저장과 불법 촬영물 즉시 가림을 한 트랜잭션으로 한다(2.3.3) */
  insertReport(r: ReportRecord, hide?: { takedown: TakedownRecord; status: 'HIDDEN' }): Promise<void>;
  findReportByTargetReporter(targetId: string, reporterAccountId: string): Promise<ReportRecord | undefined>;
  countReportsByReporterSince(reporterAccountId: string, sinceMs: number): Promise<number>;
  reportsByTarget(targetId: string): Promise<readonly ReportRecord[]>;
  resolveReports(targetId: string, outcome: ReportRecord['outcome'], nowMs: number): Promise<void>;

  insertTakedown(t: TakedownRecord): Promise<void>;
  takedownsByReview(reviewId: string): Promise<readonly TakedownRecord[]>;
  restoreTakedowns(reviewId: string, nowMs: number): Promise<void>;
  addHiddenFingerprint(fingerprint: string, noticeId: string | undefined, nowMs: number): Promise<void>;
  removeHiddenFingerprint(fingerprint: string): Promise<void>;
  hasHiddenFingerprint(fingerprint: string): Promise<boolean>;
  /** 같은 지문에 아직 살아 있는 통보(NOTICE) 조치가 있는지. 하나를 해제해도 다른 통보가 남아 있으면 지문을 지우지 않는다 */
  hasActiveNoticeFingerprint(fingerprint: string): Promise<boolean>;
  /** 끝 시각이 지난 임시조치(RIGHTS_TEMP)를 풀고 조치 기록을 복원한다. 정비 일이 부른다 */
  expireTemporaryBlocks(nowMs: number): Promise<number>;
  /** 후기 조치·조치 기록·신고 처리 완료를 한 트랜잭션으로 반영한다(ASVS 2.3.3) */
  moderate(reviewId: string, o: { status?: ReviewRecord['status']; notice?: ReviewRecord['notice']; noticeUntilMs?: number; takedown?: TakedownRecord; restoreTakedowns: boolean; removeFingerprint?: string; outcome: ReportRecord['outcome']; nowMs: number }): Promise<void>;
}

export const REVIEW_STORE = Symbol('REVIEW_STORE');

/** 후기 목록·자격에 필요한 회차·공연 정보(카탈로그 논리 DB). 후기 모듈은 카탈로그 모듈을 직접 부르지 않는다 */
export interface ReviewEvent {
  readonly eventId: string;
  readonly productionId: string;
  readonly startsAtMs: number;
  readonly endsAtMs: number;
  readonly cancelled: boolean;
  readonly saleReview: string;
  readonly saleApprovedAtMs: number | null;
  readonly rounds: readonly { eventId: string; startsAtMs: number }[];
}

export interface ReviewEventDirectory {
  find(eventId: string): Promise<ReviewEvent | undefined>;
}

export const REVIEW_EVENT_DIRECTORY = Symbol('REVIEW_EVENT_DIRECTORY');

/** 후기 작성 자격(ticket-svc CheckReviewEligibility). unavailable면 503이다 */
export interface ReviewEligibility {
  check(input: { accountId: string; eventId: string; eventEndsAtMs: number }): Promise<{ eligible: boolean; basisOrderId?: string; reason?: 'NOT_ENDED' | 'NOT_PURCHASER' | 'NO_VALID_TICKET' }>;
}

export class ReviewEligibilityUnavailable extends Error {
  constructor(readonly why: string) {
    super(`후기 자격을 확인할 수 없습니다: ${why}`);
    this.name = 'ReviewEligibilityUnavailable';
  }
}

export const REVIEW_ELIGIBILITY = Symbol('REVIEW_ELIGIBILITY');

/** 작성자 표시에 쓸 닉네임. identity-svc 팬 프로필 조회가 아직 없어 운영 어댑터는 '***'를 돌려준다 */
export interface FanProfile {
  nickname(accountId: string): Promise<string | undefined>;
}

export const FAN_PROFILE = Symbol('FAN_PROFILE');

/** 신고·조치 알림. 운영 어댑터는 로그 한 줄을 남긴다(notify 모듈 연결은 뒤 단계) */
export interface ReviewNotifier {
  reportReceived(r: ReportRecord): Promise<void>;
  reportResolved(r: ReportRecord, outcome: ReportRecord['outcome']): Promise<void>;
  moderationApplied(r: ReviewRecord, action: string, reason: string): Promise<void>;
}

export const REVIEW_NOTIFIER = Symbol('REVIEW_NOTIFIER');

/** CS 처리함 건 요청(support.cases-requested). ops-svc가 없어 운영 어댑터는 로그만 남긴다 */
export interface ReviewCaseSink {
  request(input: { kind: 'CONTENT_REPORT' | 'RIGHTS_REQUEST'; targetId: string; dueAtMs: number }): Promise<void>;
}

export const REVIEW_CASE_SINK = Symbol('REVIEW_CASE_SINK');
