// 지급 승인 업무 Drizzle 스키마(ops DB payout_approval).
import { sql } from 'drizzle-orm';
import { bigint, check, date, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const amount = (name: string) => bigint(name, { mode: 'number' });

export const payoutApproval = pgTable(
  'payout_approval',
  {
    id: uuid('id').primaryKey(),
    batchId: uuid('batch_id').notNull(),
    pg: text('pg').notNull(),
    pgStore: text('pg_store').notNull(),
    payoutDate: date('payout_date', { mode: 'string' }).notNull(),
    amount: amount('amount').notNull(),
    statementCount: integer('statement_count').notNull(),
    status: text('status').notNull().default('PENDING_APPROVAL'),
    requesterId: uuid('requester_id').notNull(),
    requesterRole: text('requester_role').notNull(),
    approverId: uuid('approver_id'),
    reasonText: text('reason_text').notNull().default(''),
    failure: text('failure'),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
    approvedAt: at('approved_at'),
    executedAt: at('executed_at'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('payout_approval_pg_check', sql`${t.pg} in ('TOSS', 'PORTONE')`),
    check('payout_approval_pg_store_check', sql`${t.pgStore} in ('STANDARD', 'ESCROW')`),
    check('payout_approval_status_check', sql`${t.status} in ('PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'EXECUTING', 'DONE', 'FAILED')`),
    check('payout_approval_amount_check', sql`${t.amount} >= 0 and ${t.statementCount} >= 0`),
    check('payout_approval_version_check', sql`${t.version} >= 1`),
    index('payout_approval_status_idx').on(t.status, t.createdAt),
    index('payout_approval_batch_idx').on(t.batchId),
  ],
);
