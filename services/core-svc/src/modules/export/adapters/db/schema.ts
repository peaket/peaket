// export Drizzle 스키마(attendee_export, docs/data.md 예매자 명단 내려받기 이력).
import { check, index, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const attendeeExport = pgTable(
  'attendee_export',
  {
    id: uuid('id').primaryKey(),
    promoterId: uuid('promoter_id').notNull(),
    eventId: uuid('event_id').notNull(),
    actorAccountId: uuid('actor_account_id').notNull(),
    actorDisplayName: text('actor_display_name').notNull(),
    actorRole: text('actor_role').notNull(),
    reason: text('reason').notNull(),
    format: text('format').notNull(),
    count: integer('count').notNull(),
    result: text('result').notNull(),
    createdAt: at('created_at').notNull(),
    expiresAt: at('expires_at').notNull(),
  },
  (t) => [
    check('attendee_export_format_check', sql`${t.format} in ('CSV', 'XLSX', 'PDF')`),
    check('attendee_export_result_check', sql`${t.result} in ('COMPLETED', 'FAILED')`),
    check('attendee_export_count_check', sql`${t.count} >= 0`),
    index('attendee_export_promoter_event_idx').on(t.promoterId, t.eventId, t.createdAt),
  ],
);
