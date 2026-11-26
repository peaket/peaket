// 법정 통보 표(F-07-11, docs/data.md §2 takedown_notice·takedown_notice_action, ops 0040).
// ops 논리 DB다. core-svc의 takedown_action과는 외래키 없이 noticeId만 맞춘다.
import { sql } from 'drizzle-orm';
import { check, customType, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const bytea = customType<{ data: Uint8Array; driverData: Buffer }>({ dataType: () => 'bytea' });

export const takedownNotice = pgTable(
  'takedown_notice',
  {
    id: uuid('id').primaryKey(),
    requestedBy: text('requested_by').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: text('request_hash').notNull(),
    requester: text('requester').notNull(),
    agencyName: text('agency_name').notNull(),
    receivedAt: at('received_at').notNull(),
    deadline: text('deadline').notNull(),
    dueAt: at('due_at').notNull(),
    reviewIds: jsonb('review_ids').$type<string[]>().notNull(),
    summary: text('summary').notNull().default(''),
    status: text('status').notNull().default('OPEN'),
    takenDownAt: at('taken_down_at'),
    withdrawnAt: at('withdrawn_at'),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    check('takedown_notice_status_check', sql`${t.status} in ('OPEN', 'TAKEN_DOWN', 'WITHDRAWN')`),
    check('takedown_notice_deadline_check', sql`${t.deadline} in ('H24', 'H10')`),
    check('takedown_notice_requester_check', sql`${t.requester} in ('AGENCY', 'POLICE')`),
    check('takedown_notice_agency_check', sql`char_length(${t.agencyName}) between 1 and 100`),
    check('takedown_notice_summary_check', sql`char_length(${t.summary}) <= 2000`),
    uniqueIndex('takedown_notice_requested_idempotency_uq').on(t.requestedBy, t.idempotencyKey),
    index('takedown_notice_status_due_idx').on(t.status, t.dueAt),
    index('takedown_notice_due_idx').on(t.dueAt),
  ],
);

export const takedownNoticeAction = pgTable(
  'takedown_notice_action',
  {
    id: uuid('id').primaryKey(),
    noticeId: uuid('notice_id').notNull(),
    action: text('action').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestHash: bytea('request_hash').notNull(),
    reason: text('reason').notNull(),
    actorRef: uuid('actor_ref').notNull(),
    createdAt: at('created_at').notNull(),
  },
  (t) => [
    check('takedown_notice_action_action_check', sql`${t.action} in ('TAKEDOWN', 'WITHDRAWAL')`),
    check('takedown_notice_action_reason_check', sql`char_length(${t.reason}) between 1 and 2000`),
    uniqueIndex('takedown_notice_action_notice_action_key_uq').on(t.noticeId, t.action, t.idempotencyKey),
  ],
);
