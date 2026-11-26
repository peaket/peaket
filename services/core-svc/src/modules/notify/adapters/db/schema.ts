// notify Drizzle 스키마(docs/data.md webhook_endpoint·webhook_delivery, BUILD_ORDER BAT-610 서버 잔여).
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

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
    /** 발송 워커 임대 만료(다른 복제가 이 시각 전에는 집지 않는다). docs/data.md §5 webhook_delivery */
    leaseUntil: at('lease_until'),
    createdAt: at('created_at').notNull(),
    finishedAt: at('finished_at'),
    /** thin 본문. 응답 본문은 저장하지 않는다 */
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [
    check('webhook_delivery_status_check', sql`${t.status} in ('PENDING', 'RETRYING', 'SUCCEEDED', 'DEAD')`),
    unique('webhook_delivery_endpoint_event_uq').on(t.endpointId, t.webhookId),
    index('webhook_delivery_endpoint_created_idx').on(t.endpointId, t.createdAt),
    index('webhook_delivery_due_idx').on(t.nextAttemptAt).where(sql`${t.status} in ('PENDING', 'RETRYING')`),
  ],
);

// BAT-455 GAT-250 팬 알림 표(0045, docs/data.md §2 ⑥, notify §2.2).
export const notificationSubscription = pgTable(
  'notification_subscription',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    eventId: uuid('event_id').notNull(),
    kind: text('kind').notNull(),
    nightPush: boolean('night_push').notNull().default(false),
    sentCount: integer('sent_count').notNull().default(0),
    status: text('status').notNull().default('ACTIVE'),
    endReason: text('end_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    check('notification_subscription_kind_check', sql`${t.kind} in ('OPEN', 'CANCELLATION')`),
    check('notification_subscription_status_check', sql`${t.status} in ('ACTIVE', 'ENDED')`),
    check('notification_subscription_end_reason_check', sql`${t.endReason} is null or ${t.endReason} in ('SENT_MAX', 'BOOKED', 'SALE_ENDED')`),
    check('notification_subscription_sent_count_check', sql`${t.sentCount} >= 0`),
    unique('notification_subscription_account_event_kind_uq').on(t.accountId, t.eventId, t.kind),
    index('notification_subscription_event_kind_id_idx').on(t.eventId, t.kind, t.id),
    index('notification_subscription_account_created_idx').on(t.accountId, t.createdAt),
  ],
);

export const pushSubscription = pgTable(
  'push_subscription',
  {
    id: uuid('id').primaryKey(),
    accountId: uuid('account_id').notNull(),
    endpoint: text('endpoint').notNull(),
    endpointHash: text('endpoint_hash').notNull(),
    service: text('service').notNull(),
    p256dh: text('p256dh').notNull(),
    auth: text('auth').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }),
    boundAt: timestamp('bound_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    check('push_subscription_service_check', sql`${t.service} in ('FCM', 'MOZILLA', 'APPLE', 'WNS')`),
    unique('push_subscription_endpoint_uq').on(t.endpoint),
    unique('push_subscription_endpoint_hash_uq').on(t.endpointHash),
    index('push_subscription_account_bound_idx').on(t.accountId, t.boundAt),
  ],
);

export const notificationDedup = pgTable('notification_dedup', {
  dedupKey: text('dedup_key').primaryKey(),
  createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export const notificationJob = pgTable(
  'notification_job',
  {
    dedupKey: text('dedup_key')
      .primaryKey()
      .references(() => notificationDedup.dedupKey, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    accountId: uuid('account_id').notNull(),
    channel: text('channel').notNull(),
    vars: jsonb('vars').$type<Record<string, string | number | boolean | null>>().notNull().default({}),
    templateVersion: text('template_version'),
    status: text('status').notNull().default('PENDING'),
    attempts: integer('attempts').notNull().default(0),
    nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true, mode: 'date' }).notNull(),
    leaseUntil: timestamp('lease_until', { withTimezone: true, mode: 'date' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    check('notification_job_status_check', sql`${t.status} in ('PENDING', 'RETRYING', 'DEAD')`),
    check('notification_job_channel_check', sql`${t.channel} in ('EMAIL', 'WEB_PUSH', 'ALIMTALK', 'SMS')`),
    check('notification_job_attempts_check', sql`${t.attempts} >= 0`),
    index('notification_job_due_idx').on(t.nextAttemptAt).where(sql`${t.status} in ('PENDING', 'RETRYING')`),
  ],
);

export const notificationDelivery = pgTable(
  'notification_delivery',
  {
    dedupKey: text('dedup_key').notNull(),
    sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }).notNull(),
    kind: text('kind').notNull(),
    targetId: text('target_id').notNull(),
    accountId: uuid('account_id').notNull(),
    channel: text('channel').notNull(),
    status: text('status').notNull(),
    providerMessageId: text('provider_message_id'),
    templateVersion: text('template_version'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.dedupKey, t.sentAt] }),
    check('notification_delivery_status_check', sql`${t.status} in ('PENDING', 'SENT', 'FAILED', 'DEAD', 'EXPIRED')`),
  ],
);
