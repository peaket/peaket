// export Drizzle 스키마(attendee_export, docs/data.md 예매자 명단 내려받기 이력).
import { check, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
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

/**
 * 예매자 명단 접속기록(2년 보존, A2-19). attendee_export(30일)와 별도로 남긴다(docs/data.md §2 '예매자 명단 내려받기 이력과 접속기록').
 * 내려받기(DOWNLOAD)는 행위자·사유·건수·형식을, 명단 보기(LIST)는 행위자·보인 건수·조건(filter)을 남긴다(0021, W7-audit A2-19)
 */
export const attendeeExportAudit = pgTable(
  'attendee_export_audit',
  {
    id: uuid('id').primaryKey(),
    action: text('action').notNull().default('DOWNLOAD'),
    exportId: uuid('export_id'),
    promoterId: uuid('promoter_id').notNull(),
    eventId: uuid('event_id').notNull(),
    actorAccountId: uuid('actor_account_id').notNull(),
    actorDisplayName: text('actor_display_name').notNull(),
    actorRole: text('actor_role').notNull(),
    reason: text('reason'),
    format: text('format'),
    count: integer('count').notNull(),
    filter: jsonb('filter').$type<{ limit?: number; cursor?: string }>().notNull().default({}),
    createdAt: at('created_at').notNull(),
    retainUntil: at('retain_until').notNull(),
  },
  (t) => [
    check('attendee_export_audit_format_check', sql`${t.format} in ('CSV', 'XLSX', 'PDF')`),
    check('attendee_export_audit_count_check', sql`${t.count} >= 0`),
    check('attendee_export_audit_action_check', sql`${t.action} in ('LIST', 'DOWNLOAD')`),
    check(
      'attendee_export_audit_shape_check',
      sql`(${t.action} = 'DOWNLOAD' and ${t.exportId} is not null and ${t.reason} is not null and ${t.format} is not null) or (${t.action} = 'LIST' and ${t.exportId} is null and ${t.reason} is null and ${t.format} is null)`,
    ),
    index('attendee_export_audit_promoter_event_idx').on(t.promoterId, t.eventId, t.createdAt),
  ],
);
