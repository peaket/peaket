// F-04-15 support 소명 표(core DB appeal, docs/data.md). migrations/0048가 정본 SQL이다.
import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const appeal = pgTable(
  'appeal',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('SUBMITTED'),
    result: text('result'),
    caseId: uuid('case_id'),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull(),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('appeal_kind_check', sql`${t.kind} in ('RESTRICTION', 'RECLAIM', 'FRAUD_CASE')`),
    check('appeal_status_check', sql`${t.status} in ('SUBMITTED', 'DECIDED', 'INVALID')`),
    check('appeal_result_check', sql`${t.result} is null or ${t.result} in ('LIFTED', 'KEPT', 'NOT_RECLAIMED', 'RECLAIMED', 'ACCEPTED', 'REJECTED')`),
    check('appeal_body_length_check', sql`char_length(${t.body}) <= 2000`),
    index('appeal_account_submitted_idx').on(t.accountId, t.submittedAt),
    index('appeal_target_id_idx').on(t.targetId),
  ],
);
