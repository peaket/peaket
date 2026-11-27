// F-04-19 연구 내보내기·가명정보 처리 기록 Drizzle 스키마(ops DB, 마이그레이션 0040, 동결 로컬).
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import type { PseudonymizationUsage } from '../../domain/research-export.js';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const researchExport = pgTable(
  'research_export',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    createdBy: uuid('created_by').notNull(),
    createdBySessionId: text('created_by_session_id').notNull(),
    createdByRole: text('created_by_role').notNull(),
    fromMs: bigint('from_ms', { mode: 'number' }).notNull(),
    toMs: bigint('to_ms', { mode: 'number' }).notNull(),
    reason: text('reason').notNull(),
    allowlistVersion: text('allowlist_version').notNull(),
    keyVersion: text('key_version').notNull(),
    status: text('status').$type<'PENDING' | 'READY' | 'FAILED'>().notNull(),
    createdAt: at('created_at').notNull(),
    readyAt: at('ready_at'),
    expiresAt: at('expires_at').notNull(),
    rowCount: integer('row_count').notNull(),
    columns: jsonb('columns').$type<string[]>().notNull(),
    failureType: text('failure_type'),
    saleEndsAt: bigint('sale_ends_at', { mode: 'number' }).notNull(),
  },
  (t) => [
    index('research_export_creator_created_idx').on(t.createdBy, t.createdAt),
    index('research_export_status_expires_idx').on(t.status, t.expiresAt),
  ],
);

export const researchExportDenial = pgTable(
  'research_export_denial',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    at: at('at').notNull(),
    problemType: text('problem_type').notNull(),
  },
  (t) => [index('research_export_denial_account_at_idx').on(t.accountId, t.at)],
);

export const pseudonymizationLog = pgTable(
  'pseudonymization_log',
  {
    id: uuid('id').primaryKey(),
    eventId: uuid('event_id').notNull(),
    purpose: text('purpose').$type<'STATISTICS' | 'SCIENTIFIC_RESEARCH'>().notNull(),
    items: text('items').notNull(),
    keyVersion: text('key_version').notNull(),
    usage: jsonb('usage').$type<PseudonymizationUsage>().notNull(),
    processedFrom: at('processed_from').notNull(),
    destroyDueAt: at('destroy_due_at').notNull(),
    destroyedAt: at('destroyed_at'),
  },
  (t) => [index('pseudonymization_log_event_purpose_idx').on(t.eventId, t.purpose)],
);
