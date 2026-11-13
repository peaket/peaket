// purchase DB의 회차 취소 일괄 환불 표(BAT-425 GAT-120·GAT-130, docs/features/transfer-refund.md §5).
// drizzle-kit이 이 파일을 읽으므로 도메인 파일을 가져오지 않는다. 상태 목록은 도메인 상수와 같은 차례로 글로 적는다.
import { sql } from 'drizzle-orm';
import { check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const eventCancellationRequest = pgTable(
  'event_cancellation_request',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    kind: text('kind').notNull(),
    status: text('status').notNull(),
    fault: text('fault'),
    fanNoticeReason: text('fan_notice_reason'),
    ruledBy: text('ruled_by'),
    confirmedBy: text('confirmed_by'),
    targetOrders: integer('target_orders').notNull().default(0),
    refundTotal: integer('refund_total').notNull().default(0),
    compensationTargets: integer('compensation_targets').notNull().default(0),
    compensationTotal: integer('compensation_total').notNull().default(0),
    progress: jsonb('progress').notNull().default(sql`'{}'::jsonb`),
    createdAt: at('created_at').notNull(),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('event_cancellation_active_key')
      .on(t.eventId)
      .where(sql`${t.status} in ('REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW')`),
    check('event_cancellation_kind_check', sql`${t.kind} in ('CANCEL', 'POSTPONE')`),
    check(
      'event_cancellation_status_check',
      sql`${t.status} in ('REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW', 'COMPLETED', 'REJECTED')`,
    ),
    check('event_cancellation_fault_check', sql`${t.fault} is null or ${t.fault} in ('ORGANIZER', 'FORCE_MAJEURE', 'CONTENT_CHANGE')`),
    check('event_cancellation_amounts_check', sql`${t.targetOrders} >= 0 and ${t.refundTotal} >= 0 and ${t.compensationTargets} >= 0 and ${t.compensationTotal} >= 0`),
    check('event_cancellation_people_check', sql`${t.ruledBy} is null or ${t.confirmedBy} is null or ${t.ruledBy} <> ${t.confirmedBy}`),
  ],
);

export const eventRefundItem = pgTable(
  'event_refund_item',
  {
    requestId: uuid('request_id')
      .notNull()
      .references(() => eventCancellationRequest.id),
    ticketId: uuid('ticket_id').notNull(),
    orderId: uuid('order_id').notNull(),
    cancellationId: uuid('cancellation_id').notNull(),
    pg: text('pg').notNull(),
    status: text('status').notNull(),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    updatedAt: at('updated_at').notNull(),
  },
  (t) => [
    primaryKey({ name: 'event_refund_item_pkey', columns: [t.requestId, t.ticketId] }),
    uniqueIndex('event_refund_item_cancellation_key').on(t.cancellationId),
    index('event_refund_item_status_idx').on(t.requestId, t.status),
    check('event_refund_item_pg_check', sql`${t.pg} in ('TOSS', 'PORTONE', 'SIMULATOR')`),
    check('event_refund_item_status_check', sql`${t.status} in ('PENDING', 'REFUNDED', 'FAILED', 'UNKNOWN')`),
    check('event_refund_item_attempts_check', sql`${t.attempts} >= 0`),
  ],
);
