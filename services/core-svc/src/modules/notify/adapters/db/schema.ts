// notify Drizzle 스키마(docs/data.md webhook_endpoint·webhook_delivery, BUILD_ORDER BAT-610 서버 잔여).
import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

const at = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const webhookEndpoint = pgTable(
  'webhook_endpoint',
  {
    id: uuid('id').primaryKey(),
    promoterId: uuid('promoter_id').notNull(),
    url: text('url').notNull(),
    eventTypes: text('event_types').array().notNull(),
    status: text('status').notNull().default('ACTIVE'),
    disabledReason: text('disabled_reason'),
    /** 실제 서명 비밀. 목록·응답에는 원문을 싣지 않는다. 운영은 Secrets Manager 참조로 바꾼다 */
    secret: text('secret').notNull(),
    previousSecret: text('previous_secret'),
    secretIssuedAt: at('secret_issued_at').notNull(),
    previousSecretValidUntil: at('previous_secret_valid_until'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    check('webhook_endpoint_status_check', sql`${t.status} in ('ACTIVE', 'DISABLED')`),
    check('webhook_endpoint_disabled_reason_check', sql`${t.disabledReason} is null or ${t.disabledReason} in ('PARTNER', 'FAILING')`),
    index('webhook_endpoint_promoter_idx').on(t.promoterId, t.secretIssuedAt),
  ],
);

export const webhookDelivery = pgTable(
  'webhook_delivery',
  {
    id: uuid('id').primaryKey(),
    endpointId: uuid('endpoint_id').notNull().references(() => webhookEndpoint.id, { onDelete: 'cascade' }),
    webhookId: text('webhook_id').notNull(),
    eventType: text('event_type').notNull(),
    status: text('status').notNull().default('PENDING'),
    attemptCount: integer('attempt_count').notNull().default(0),
    lastHttpStatus: integer('last_http_status'),
    lastError: text('last_error'),
    nextAttemptAt: at('next_attempt_at'),
    createdAt: at('created_at').notNull(),
    finishedAt: at('finished_at'),
  },
  (t) => [
    check('webhook_delivery_status_check', sql`${t.status} in ('PENDING', 'RETRYING', 'SUCCEEDED', 'DEAD')`),
    unique('webhook_delivery_endpoint_event_uq').on(t.endpointId, t.webhookId),
    index('webhook_delivery_endpoint_created_idx').on(t.endpointId, t.createdAt),
  ],
);
