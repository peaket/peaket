// review 모듈 표(BUILD_ORDER BAT-585, docs/data.md `review`·`content_report`·`takedown_action`, ADR-0066).
// 스키마 원본은 migrations/0013_review.sql이다. 후기 사진(review_image)은 사진 올리기 단계가 더한다.
// 0026(소유자 결정 2026-11-16 OPEN[42]·[44], ADR-0278): 파기한 행의 별점·내용 지문 NULL, 살아 있는 행 CHECK(NOT VALID), 다시 정리 예약 표.
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const review = pgTable(
  'review',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    accountId: uuid('account_id').notNull(),
    basisOrderId: uuid('basis_order_id').notNull(),
    /** 파기한 행(DELETED)에서만 NULL(docs/data.md §2 '후기 파기'). 살아 있는 행은 review_live_complete_check가 막는다 */
    rating: smallint('rating'),
    body: text('body').notNull(),
    status: text('status').notNull().default('VISIBLE'),
    /** 신고 처리로 가린 경우에만 RIGHTS_TEMP·POLICY. 통보·같은 내용·불법 촬영물 가림은 NULL이다 */
    notice: text('notice'),
    noticeUntil: at('notice_until'),
    /** NFKC 뒤 공백·문장부호를 지운 본문의 SHA-256(같은 내용 자동 가림, POL-024 2호 마목). 파기한 행(DELETED)에서만 NULL */
    contentFingerprint: text('content_fingerprint'),
    /** 작성자 표시(닉네임 첫 글자 + '**'). identity 팬 프로필 조회가 생기기 전에는 '***'다 */
    authorDisplay: text('author_display').notNull(),
    /** 팬이 고친 적이 있으면 true. 운영자 조치와 구분한다 */
    edited: boolean('edited').notNull().default(false),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
    deletedAt: at('deleted_at'),
  },
  (t) => [
    check('review_rating_check', sql`${t.rating} between 1 and 5`),
    check('review_status_check', sql`${t.status} in ('VISIBLE', 'HIDDEN', 'DELETED')`),
    check('review_notice_check', sql`${t.notice} is null or ${t.notice} in ('RIGHTS_TEMP', 'POLICY')`),
    // 살아 있는 행은 별점·지문이 있다(0026에서 NOT VALID로 더함. VALIDATE는 다음 출시, docs/data.md §2 '후기 파기' 마이그레이션 나눔)
    check('review_live_complete_check', sql`${t.status} = 'DELETED' or (${t.rating} is not null and ${t.contentFingerprint} is not null)`),
    // 지운 후기는 같은 회차에 다시 쓸 수 있으므로 부분 유일 인덱스다(POL-042 ②)
    uniqueIndex('review_event_account_uq').on(t.eventId, t.accountId).where(sql`${t.status} <> 'DELETED'`),
    index('review_event_idx').on(t.eventId),
    index('review_fingerprint_idx').on(t.contentFingerprint),
    index('review_created_idx').on(t.createdAt, t.id),
    // 탈퇴 파기(update … where account_id = …)가 표 전체를 훑지 않게(0022, docs/data.md §5.1 '탈퇴 파기', W7-audit 리뷰 K2)
    index('review_account_idx').on(t.accountId),
  ],
);

export const contentReport = pgTable(
  'content_report',
  {
    id: uuid('id').primaryKey(),
    targetKind: text('target_kind').notNull().default('REVIEW'),
    targetId: uuid('target_id').notNull(),
    reporterAccountId: uuid('reporter_account_id').notNull(),
    category: text('category').notNull(),
    detail: text('detail').notNull().default(''),
    rightsHolder: boolean('rights_holder').notNull().default(false),
    notifyChannel: text('notify_channel'),
    status: text('status').notNull().default('RECEIVED'),
    outcome: text('outcome'),
    caseId: uuid('case_id'),
    createdAt: at('created_at').notNull(),
    resolvedAt: at('resolved_at'),
    purgeAt: at('purge_at').notNull(),
  },
  (t) => [
    check('content_report_target_kind_check', sql`${t.targetKind} = 'REVIEW'`),
    check('content_report_category_check', sql`${t.category} in ('SCALPING', 'MACRO', 'ABUSE', 'RIGHTS', 'ILLEGAL_FILMING', 'SPAM', 'OFF_TOPIC', 'OTHER')`),
    check('content_report_status_check', sql`${t.status} in ('RECEIVED', 'IN_REVIEW', 'RESOLVED')`),
    check('content_report_outcome_check', sql`${t.outcome} is null or ${t.outcome} in ('NO_ACTION', 'TEMP_BLOCKED', 'BLOCKED')`),
    check('content_report_notify_check', sql`${t.notifyChannel} is null or ${t.notifyChannel} in ('APP', 'EMAIL')`),
    uniqueIndex('content_report_target_reporter_uq').on(t.targetId, t.reporterAccountId),
    index('content_report_reporter_created_idx').on(t.reporterAccountId, t.createdAt),
    index('content_report_target_idx').on(t.targetId),
  ],
);

export const takedownAction = pgTable(
  'takedown_action',
  {
    id: uuid('id').primaryKey(),
    noticeId: uuid('notice_id'),
    reviewId: uuid('review_id').notNull(),
    reason: text('reason').notNull(),
    contentFingerprint: text('content_fingerprint').notNull(),
    caseId: uuid('case_id'),
    hiddenAt: at('hidden_at').notNull(),
    endsAt: at('ends_at'),
    restoredAt: at('restored_at'),
  },
  (t) => [
    check('takedown_action_reason_check', sql`${t.reason} in ('NOTICE', 'SAME_CONTENT', 'RIGHTS_TEMP', 'POLICY', 'FILMING_HOLD')`),
    uniqueIndex('takedown_action_notice_review_uq').on(t.noticeId, t.reviewId).where(sql`${t.noticeId} is not null`),
    index('takedown_action_review_idx').on(t.reviewId),
    index('takedown_action_fingerprint_idx').on(t.contentFingerprint),
  ],
);

export const reviewHiddenFingerprint = pgTable('review_hidden_fingerprint', {
  fingerprint: text('fingerprint').primaryKey(),
  noticeId: uuid('notice_id'),
  createdAt: at('created_at').notNull(),
});

/**
 * 탈퇴 후기 다시 정리 예약(소유자 결정 2026-11-16 OPEN[44], ADR-0278, docs/data.md §2 '다시 정리 예약'). 계정 ID·예약 시각·만든 시각만 둔다(pid·후기 내용 없음).
 * 탈퇴 사건 처리 트랜잭션이 파기와 함께 넣고, core-svc 소비자 파드의 반복이 예약 시각에 다시 파기하며 지운다
 */
export const reviewWithdrawalRecheck = pgTable(
  'review_withdrawal_recheck',
  {
    accountId: uuid('account_id').primaryKey(),
    dueAt: at('due_at').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [index('review_withdrawal_recheck_due_idx').on(t.dueAt)],
);

/** 후기 사진(F-07-10, docs/data.md §2 review_image, ADR-0066). 원본 키는 두지 않고 파생본 두 개의 키만 둔다 */
export const reviewImage = pgTable(
  'review_image',
  {
    id: uuid('id').primaryKey(),
    reviewId: uuid('review_id'),
    accountId: uuid('account_id').notNull(),
    status: text('status').notNull(),
    rejectReason: text('reject_reason'),
    altText: text('alt_text').notNull().default(''),
    width: integer('width').notNull(),
    height: integer('height').notNull(),
    sort: smallint('sort').notNull().default(0),
    thumbKey: text('thumb_key').notNull(),
    viewKey: text('view_key').notNull(),
    createdAt: at('created_at').notNull(),
    attachedAt: at('attached_at'),
    deletedAt: at('deleted_at'),
  },
  (t) => [
    check('review_image_status_check', sql`${t.status} in ('UPLOADED', 'SCANNING', 'READY', 'REJECTED', 'DELETED')`),
    check('review_image_reject_check', sql`${t.rejectReason} is null or ${t.rejectReason} in ('UNSUPPORTED_TYPE', 'TOO_LARGE', 'TOO_SMALL', 'MALWARE')`),
    check('review_image_alt_check', sql`char_length(${t.altText}) <= 100`),
    check('review_image_sort_check', sql`${t.sort} between 0 and 2`),
    check('review_image_attach_check', sql`(${t.reviewId} is null) = (${t.attachedAt} is null)`),
    uniqueIndex('review_image_review_sort_uq').on(t.reviewId, t.sort).where(sql`${t.reviewId} is not null`),
    index('review_image_account_created_idx').on(t.accountId, t.createdAt),
    index('review_image_review_idx').on(t.reviewId),
    index('review_image_status_created_idx').on(t.status, t.createdAt),
  ],
);
