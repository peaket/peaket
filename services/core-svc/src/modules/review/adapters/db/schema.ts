// review 모듈 표(BUILD_ORDER BAT-585, docs/data.md `review`·`content_report`·`takedown_action`, ADR-0066).
// 스키마 원본은 migrations/0013_review.sql이다. 후기 사진(review_image)은 사진 올리기 단계가 더한다.
import { sql } from 'drizzle-orm';
import { boolean, check, index, pgTable, smallint, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const review = pgTable(
  'review',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    accountId: uuid('account_id').notNull(),
    basisOrderId: uuid('basis_order_id').notNull(),
    rating: smallint('rating').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('VISIBLE'),
    /** 신고 처리로 가린 경우에만 RIGHTS_TEMP·POLICY. 통보·같은 내용·불법 촬영물 가림은 NULL이다 */
    notice: text('notice'),
    noticeUntil: at('notice_until'),
    /** NFKC 뒤 공백·문장부호를 지운 본문의 SHA-256(같은 내용 자동 가림, POL-024 2호 마목) */
    contentFingerprint: text('content_fingerprint').notNull(),
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
    // 지운 후기는 같은 회차에 다시 쓸 수 있으므로 부분 유일 인덱스다(POL-042 ②)
    uniqueIndex('review_event_account_uq').on(t.eventId, t.accountId).where(sql`${t.status} <> 'DELETED'`),
    index('review_event_idx').on(t.eventId),
    index('review_fingerprint_idx').on(t.contentFingerprint),
    index('review_created_idx').on(t.createdAt, t.id),
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
    index('takedown_action_review_idx').on(t.reviewId),
    index('takedown_action_fingerprint_idx').on(t.contentFingerprint),
  ],
);

export const reviewHiddenFingerprint = pgTable('review_hidden_fingerprint', {
  fingerprint: text('fingerprint').primaryKey(),
  noticeId: uuid('notice_id'),
  createdAt: at('created_at').notNull(),
});
