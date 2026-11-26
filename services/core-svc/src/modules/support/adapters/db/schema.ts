// core-svc support 표의 Drizzle 매핑(F-06-4, 0049). appeal 표와 기존 outbox 표를 쓴다.
import { customType, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const bytea = customType<{ data: Buffer; notNull: true; default: false }>({
  dataType: () => 'bytea',
});

export const appeal = pgTable('appeal', {
  id: uuid('id').primaryKey(),
  accountId: uuid('account_id').notNull(),
  kind: text('kind').notNull(),
  targetId: text('target_id').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull(),
  result: text('result'),
  resultNote: text('result_note'),
  caseId: text('case_id'),
  submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  dispatchState: text('dispatch_state').notNull().default('PENDING'),
  dispatchAttempts: integer('dispatch_attempts').notNull().default(0),
  nextDispatchAt: timestamp('next_dispatch_at', { withTimezone: true }),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
});

export const outbox = pgTable('outbox', {
  id: uuid('id').primaryKey(),
  topic: text('topic').notNull(),
  msgKey: text('msg_key').notNull(),
  payload: bytea('payload').notNull(),
  headers: jsonb('headers').notNull().default({}),
});

export type AppealDbRow = typeof appeal.$inferSelect;

// F-06-5 문의(0055). 저장값은 계좌번호를 바꾸지 않고, 응답 가림은 ops·화면이 한다.
export const inquiry = pgTable('inquiry', {
  id: uuid('id').primaryKey(),
  number: text('number').notNull().unique(),
  accountId: uuid('account_id').notNull(),
  category: text('category').notNull(),
  orderRef: text('order_ref'),
  orderSummary: text('order_summary'),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').notNull(),
  caseId: uuid('case_id'),
  requestKey: text('request_key').notNull(),
  requestHash: text('request_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
  answeredAt: timestamp('answered_at', { withTimezone: true }),
  fanViewedAt: timestamp('fan_viewed_at', { withTimezone: true }),
  closedAt: timestamp('closed_at', { withTimezone: true }),
  purgeAt: timestamp('purge_at', { withTimezone: true }),
  progressDueAt: timestamp('progress_due_at', { withTimezone: true }),
  resultDueAt: timestamp('result_due_at', { withTimezone: true }).notNull(),
});

export const inquiryMessage = pgTable('inquiry_message', {
  id: uuid('id').primaryKey(),
  inquiryId: uuid('inquiry_id').notNull(),
  authorKind: text('author_kind').notNull(),
  kind: text('kind').notNull(),
  body: text('body').notNull(),
  requestKey: text('request_key'),
  requestHash: text('request_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull(),
});

export type InquiryDbRow = typeof inquiry.$inferSelect;
export type InquiryMessageDbRow = typeof inquiryMessage.$inferSelect;

