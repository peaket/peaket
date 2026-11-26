// review 모듈의 포트(도메인이 바깥을 모르게 한다). 어댑터는 메모리(시험)와 Drizzle(운영)이다.
import type { ReportRecord, ReviewRecord, ReviewSort, TakedownRecord } from './review.js';
import type { ReviewImageAttach, ReviewImageRecord } from './review-image.js';

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

/** 손으로 처리(purgeHeldWithdrawal)가 처리한 보류 행 하나 */
export interface HeldWithdrawalRow {
  /** held_event.id(uuid, 보류한 시각과 무작위 값으로 만든 uuidv7이라 사람을 가리키지 않는다) */
  readonly id: string;
  /** 사건의 eventKey. 해독하지 못한 사건(값이 없거나 깨진 사건)이면 null */
  readonly eventKey: string | null;
}

export interface ReviewStore {
  /** 후기 저장과 사진 붙이기를 한 트랜잭션으로 한다. 사진 하나라도 틀리면 후기 행도 남기지 않는다 */
  insertReview(r: ReviewRecord, images?: readonly ReviewImageAttach[]): Promise<void>;
  findReview(reviewId: string): Promise<ReviewRecord | undefined>;
  findReviewByEventAccount(eventId: string, accountId: string): Promise<ReviewRecord | undefined>;
  /** 후기 고치기와 사진 바꾸기를 한 트랜잭션으로 한다. 빠진 사진의 공개 키를 돌려준다 */
  updateReview(reviewId: string, patch: Partial<Pick<ReviewRecord, 'rating' | 'body' | 'status' | 'notice' | 'noticeUntilMs' | 'contentFingerprint' | 'updatedAtMs' | 'edited'>>, images?: readonly ReviewImageAttach[]): Promise<readonly string[]>;
  /** 작성자 지우기. 그 후기 한 행을 파기 칸대로 비우고 사진을 DELETED로 바꾼다. 지운 사진의 공개 키를 돌려준다 */
  softDeleteReview(reviewId: string, nowMs: number): Promise<readonly string[]>;
  listReviews(input: ReviewListInput): Promise<ReviewListResult>;
  /** 같은 공연의 보이는 후기 전부(요약용). 후기 수가 많지 않은 첫 구현에서 쓴다 */
  listVisibleByProduction(productionId: string): Promise<readonly ReviewRecord[]>;
  /** 이 계정이 신고한 후기 ID(목록의 reportedByMe) */
  reportedTargetIds(accountId: string, targetIds: readonly string[]): Promise<ReadonlySet<string>>;

  /** 후기들의 사진 행(삭제 표시 포함). 목록·요약·단건이 한 번에 읽는다 */
  imagesByReviews(reviewIds: readonly string[]): Promise<ReadonlyMap<string, readonly ReviewImageRecord[]>>;
  /** 그 계정의 사진 행 전부(상태 포함). 거절한 업로드가 행을 남기지 않는지와 한도 셈에 쓴다 */
  imageRowsByAccount(accountId: string): Promise<readonly ReviewImageRecord[]>;
  /** 정리 때가 된 행: 붙이지 않은 READY(24시간 지남)와 DELETED */
  imageRowsDueForCleanup(nowMs: number, limit: number): Promise<readonly ReviewImageRecord[]>;
  insertReviewImage(row: ReviewImageRecord): Promise<void>;
  deleteImageRows(imageIds: readonly string[]): Promise<void>;
  /**
   * 한 시간 창의 올리기 시도를 한 트랜잭션으로 세고, 한도 안이면 이번 시도를 넣는다(구현 리뷰 IR-04).
   * 성공 행이 아니라 image-worker를 부른 시도(거절·실패 포함)를 세며, 동시 요청도 한도 안으로 직렬화한다.
   */
  beginImageUpload(accountId: string, nowMs: number, sinceMs: number, limit: number): Promise<boolean>;
  /** 보관 기간이 지난 올리기 시도 행을 지운다(정비 일). 지운 행 수 */
  deleteUploadAttemptsBefore(beforeMs: number): Promise<number>;

  /** 신고 저장과 불법 촬영물 즉시 가림을 한 트랜잭션으로 한다(2.3.3) */
  insertReport(r: ReportRecord, hide?: { takedown: TakedownRecord; status: 'HIDDEN' }): Promise<void>;
  findReportByTargetReporter(targetId: string, reporterAccountId: string): Promise<ReportRecord | undefined>;
  countReportsByReporterSince(reporterAccountId: string, sinceMs: number): Promise<number>;
  reportsByTarget(targetId: string): Promise<readonly ReportRecord[]>;
  resolveReports(targetId: string, outcome: ReportRecord['outcome'], nowMs: number): Promise<void>;

  /** 법정 통보 하나를 후기들에 한 트랜잭션으로 적용한다. 같은 noticeId·reviewId는 다시 적용하지 않는다(멱등) */
  applyNoticeTakedown(input: { reviewIds: readonly string[]; noticeId: string; nowMs: number }): Promise<{ applied: number }>;
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

  // 탈퇴 후기 파기와 다시 정리(소유자 결정 2026-11-16 OPEN[42]·[44], ADR-0278, docs/features/identity.md §8 '후기 파기'·'다시 정리')
  /** 파기(docs/data.md §2 '후기 파기'의 칸)와 다시 정리 예약 쓰기를 한 트랜잭션에. 예약이 있으면 늦은 시각을 남긴다. 둘 중 하나라도 실패하면 둘 다 없다 */
  purgeWithdrawnAccount(accountId: string, o: { nowMs: number; recheckAtMs: number }): Promise<number>;
  /** due_at <= nowMs인 예약을 limit개까지 SKIP LOCKED로 잠가 그 계정들을 파기하고 예약을 지운다(한 트랜잭션) */
  runDueRechecks(nowMs: number, limit: number): Promise<{ accounts: number; purged: number }>;
  /** 가장 오래 밀린 예약이 예약 시각을 넘긴 시간(ms). 없거나 밀리지 않았으면 0 */
  oldestOverdueRecheckMs(nowMs: number): Promise<number>;
  /**
   * 이전 판이 남긴 두 꼴(docs/data.md §2 '이전 판이 남긴 행 고치기')을 id가 after보다 큰 것부터 limit개 잡아 파기 칸으로 고친다(한 트랜잭션, SKIP LOCKED).
   * 고친 행 수와 그 묶음에서 고친 마지막 id(다음 묶음의 커서). 0건이면 커서가 없다(정비 일은 커서가 없을 때까지 이어 부른다)
   */
  purgeLegacyRows(o: { nowMs: number; limit: number; after?: string }): Promise<{ purged: number; last?: string }>;

  // 웨이브 끝 리뷰 S1(손으로 처리)·C2(남은 대상 수)
  /**
   * 그 계정의 보류된 탈퇴 사건(held_event, 토픽 identity.accounts-withdrawn, lower(business_key) 또는 lower(msg_key)가 그 계정, reprocessed_at IS NULL)이 있으면
   * 한 트랜잭션에서: 보류 행을 보류 행 ID(held_event.id) 차례로 limit개까지 잠금 → 다시 정리 예약(recheckAtMs) → 파기 → 그 행들 reprocessed_at = nowMs.
   * held는 처리한(reprocessed_at을 적은) 행 전부다(ID 차례, 해독하지 못해 eventKey가 없는 행 포함, W8-audit2a 다시 보기 N1).
   * 보류된 사건이 없으면 아무것도 바꾸지 않고 undefined
   */
  purgeHeldWithdrawal(accountId: string, o: { nowMs: number; recheckAtMs: number; limit: number }): Promise<{ purged: number; held: HeldWithdrawalRow[] } | undefined>;
  /** 이전 판이 남긴 두 꼴(purgeLegacyRows와 같은 조건)의 행 수. 잠그지 않는다 */
  countLegacyRows(): Promise<number>;
}

export const REVIEW_STORE = Symbol('REVIEW_STORE');

/** 후기 사진 공개 객체 지우기와 업로드가 쓰는 저장소(운영은 S3, 시험은 메모리) */
export interface ReviewImageObjects {
  putQuarantine(key: string, bytes: Uint8Array): Promise<void>;
  deleteQuarantine(key: string): Promise<void>;
  readStaging(key: string): Promise<Uint8Array | undefined>;
  stagingSize(key: string): Promise<number | undefined>;
  deleteStaging(key: string): Promise<void>;
  putPublic(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  deletePublic(key: string): Promise<void>;
}

export interface ReviewImageWiring {
  readonly origin: string;
  readonly objects: ReviewImageObjects;
  readonly processing: { process(q: { sourceKey: string; kind: string; timeoutMs: number }): Promise<{ status: string; reason?: string; width?: number; height?: number; derivativeKeys?: string[] }> };
}

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
