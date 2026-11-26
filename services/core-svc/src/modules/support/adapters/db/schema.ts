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
