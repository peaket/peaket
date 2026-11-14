// notify Drizzle 저장소(docs/data.md webhook_endpoint·webhook_delivery). 파트너 경로는 core_partner 역할(RLS)로 읽고 쓴다.
// RLS는 트랜잭션의 app.tenant_id로 거르므로 모든 질의를 테넌트 트랜잭션 안에서 한다(ADR-0241, authz-matrix §5.3).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { WebhookStore } from '../../domain/ports.js';
import type { DeliveryStatus, WebhookDeliveryRecord, WebhookEndpointRecord } from '../../domain/webhook.js';
import { webhookDelivery, webhookEndpoint } from './schema.js';

const endpointRecord = (r: typeof webhookEndpoint.$inferSelect): WebhookEndpointRecord => ({
  endpointId: r.id,
  promoterId: r.promoterId,
  url: r.url,
  eventTypes: r.eventTypes as WebhookEndpointRecord['eventTypes'],
  status: r.status as WebhookEndpointRecord['status'],
  disabledReason: r.disabledReason as WebhookEndpointRecord['disabledReason'],
  secret: r.secret,
  previousSecret: r.previousSecret,
  secretIssuedAt: r.secretIssuedAt,
  previousSecretValidUntil: r.previousSecretValidUntil,
  version: r.version,
});
const deliveryRecord = (r: typeof webhookDelivery.$inferSelect): WebhookDeliveryRecord => ({
  deliveryId: r.id,
  endpointId: r.endpointId,
  webhookId: r.webhookId,
  eventType: r.eventType,
  status: r.status as DeliveryStatus,
  attemptCount: r.attemptCount,
  lastHttpStatus: r.lastHttpStatus,
  lastError: r.lastError,
  nextAttemptAt: r.nextAttemptAt,
  createdAt: r.createdAt,
  finishedAt: r.finishedAt,
});

export class DrizzleWebhookStore implements WebhookStore {
  constructor(private readonly db: Database) {}

  async listEndpoints(promoterId: string) {
    return this.db.transaction(
      async (tx) => {
        const rows = await tx.select().from(webhookEndpoint).where(eq(webhookEndpoint.promoterId, promoterId)).orderBy(desc(webhookEndpoint.secretIssuedAt));
        return rows.map(endpointRecord);
      },
      { tenantId: promoterId, accessMode: 'read only' },
    );
  }

  async findEndpoint(promoterId: string, endpointId: string) {
    return this.db.transaction(
      async (tx) => {
        const rows = await tx.select().from(webhookEndpoint).where(and(eq(webhookEndpoint.id, endpointId), eq(webhookEndpoint.promoterId, promoterId))).limit(1);
        return rows[0] ? endpointRecord(rows[0]) : undefined;
      },
      { tenantId: promoterId, accessMode: 'read only' },
    );
  }

  async insertEndpoint(record: WebhookEndpointRecord) {
    await this.db.transaction(
      async (tx) => {
        await tx.insert(webhookEndpoint).values({
          id: record.endpointId,
          promoterId: record.promoterId,
          url: record.url,
          eventTypes: record.eventTypes,
          status: record.status,
          disabledReason: record.disabledReason,
          secret: record.secret,
          previousSecret: record.previousSecret,
          secretIssuedAt: record.secretIssuedAt,
          previousSecretValidUntil: record.previousSecretValidUntil,
          version: record.version,
        });
      },
      { tenantId: record.promoterId },
    );
  }

  async saveEndpoint(promoterId: string, record: WebhookEndpointRecord, expectedVersion: number) {
    return this.db.transaction(
      async (tx) => {
        const rows = await tx
          .update(webhookEndpoint)
          .set({
            url: record.url,
            eventTypes: record.eventTypes,
            status: record.status,
            disabledReason: record.disabledReason,
            secret: record.secret,
            previousSecret: record.previousSecret,
            secretIssuedAt: record.secretIssuedAt,
            previousSecretValidUntil: record.previousSecretValidUntil,
            version: sql`${webhookEndpoint.version} + 1`,
          })
          .where(and(eq(webhookEndpoint.id, record.endpointId), eq(webhookEndpoint.promoterId, promoterId), eq(webhookEndpoint.version, expectedVersion)))
          .returning();
        return rows[0] ? endpointRecord(rows[0]) : 'conflict';
      },
      { tenantId: promoterId },
    );
  }

  async listDeliveries(promoterId: string, endpointId: string, status: readonly DeliveryStatus[] | undefined, limit: number) {
    return this.db.transaction(
      async (tx) => {
        const endpoint = await tx.select({ id: webhookEndpoint.id }).from(webhookEndpoint).where(and(eq(webhookEndpoint.id, endpointId), eq(webhookEndpoint.promoterId, promoterId))).limit(1);
        if (!endpoint[0]) return [];
        const conditions = [eq(webhookDelivery.endpointId, endpointId)];
        if (status && status.length > 0) conditions.push(inArray(webhookDelivery.status, status));
        const rows = await tx.select().from(webhookDelivery).where(and(...conditions)).orderBy(desc(webhookDelivery.createdAt)).limit(limit);
        return rows.map(deliveryRecord);
      },
      { tenantId: promoterId, accessMode: 'read only' },
    );
  }

  async findDelivery(promoterId: string, deliveryId: string) {
    return this.db.transaction(
      async (tx) => {
        const rows = await tx
          .select({ delivery: webhookDelivery })
          .from(webhookDelivery)
          .innerJoin(webhookEndpoint, eq(webhookEndpoint.id, webhookDelivery.endpointId))
          .where(and(eq(webhookDelivery.id, deliveryId), eq(webhookEndpoint.promoterId, promoterId)))
          .limit(1);
        return rows[0] ? deliveryRecord(rows[0].delivery) : undefined;
      },
      { tenantId: promoterId, accessMode: 'read only' },
    );
  }

  async redeliver(promoterId: string, deliveryId: string, now: Date) {
    return this.db.transaction(
      async (tx) => {
        const current = await tx
          .select({ delivery: webhookDelivery })
          .from(webhookDelivery)
          .innerJoin(webhookEndpoint, eq(webhookEndpoint.id, webhookDelivery.endpointId))
          .where(and(eq(webhookDelivery.id, deliveryId), eq(webhookEndpoint.promoterId, promoterId)))
          .limit(1);
        if (!current[0]) return 'not-found';
        if (current[0].delivery.status === 'PENDING' || current[0].delivery.status === 'RETRYING') return 'conflict';
        const rows = await tx
          .update(webhookDelivery)
          .set({ status: 'PENDING', attemptCount: sql`${webhookDelivery.attemptCount} + 1`, nextAttemptAt: now, finishedAt: null })
          .where(and(eq(webhookDelivery.id, deliveryId), inArray(webhookDelivery.status, ['SUCCEEDED', 'DEAD'])))
          .returning();
        return rows[0] ? deliveryRecord(rows[0]) : 'conflict';
      },
      { tenantId: promoterId },
    );
  }
}
