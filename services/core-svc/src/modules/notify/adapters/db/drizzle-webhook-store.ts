// notify Drizzle 저장소(docs/data.md webhook_endpoint·webhook_delivery). 파트너 경로는 core_partner 역할(RLS)로 읽고 쓴다.
// RLS는 트랜잭션의 app.tenant_id로 거르므로 모든 질의를 테넌트 트랜잭션 안에서 한다(ADR-0241, authz-matrix §5.3).
// 파트너 역할은 끝점의 아홉 칸만 고친다(끝점 ID·판매자 칸은 못 고친다). 발송기 연결은 core_notify이고(ADR-0350), 이 표에서는 모든 끝점을 읽되
// 켜진 끝점을 FAILING으로 끄는 세 칸(status·disabled_reason·version)만 고친다(ADR-0338 결정 1·2). 칸을 더 SET하거나 꺼진 끝점을 고치면 DB가 거절한다.
import { and, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
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
  payload: r.payload ?? {},
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
          .set({ status: 'PENDING', attemptCount: sql`${webhookDelivery.attemptCount} + 1`, nextAttemptAt: now, finishedAt: null, leaseUntil: null })
          .where(and(eq(webhookDelivery.id, deliveryId), inArray(webhookDelivery.status, ['SUCCEEDED', 'DEAD'])))
          .returning();
        return rows[0] ? deliveryRecord(rows[0]) : 'conflict';
      },
      { tenantId: promoterId },
    );
  }

  async listActiveEndpoints(promoterId: string) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(webhookEndpoint).where(and(eq(webhookEndpoint.promoterId, promoterId), eq(webhookEndpoint.status, 'ACTIVE')));
      return rows.map(endpointRecord);
    });
  }

  async findEndpointById(endpointId: string) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(webhookEndpoint).where(eq(webhookEndpoint.id, endpointId)).limit(1);
      return rows[0] ? endpointRecord(rows[0]) : undefined;
    });
  }

  async insertDeliveries(records: readonly WebhookDeliveryRecord[]) {
    if (records.length === 0) return;
    await this.db.transaction(async (tx) => {
      await tx.insert(webhookDelivery).values(
        records.map((r) => ({
          id: r.deliveryId,
          endpointId: r.endpointId,
          webhookId: r.webhookId,
          eventType: r.eventType,
          status: r.status,
          attemptCount: r.attemptCount,
          lastHttpStatus: r.lastHttpStatus,
          lastError: r.lastError,
          nextAttemptAt: r.nextAttemptAt,
          createdAt: r.createdAt,
          finishedAt: r.finishedAt,
          payload: r.payload,
        })),
      );
    });
  }

  async listDueDeliveries(now: Date, limit: number) {
    // docs/data.md §5: 보낼 때가 된 행을 짧은 트랜잭션에서 FOR UPDATE SKIP LOCKED로 집고 lease_until을 건다.
    // 여러 복제가 같은 행을 집지 않으며, 임대가 끝난 행은 다른 복제가 다시 집는다.
    const leaseUntil = new Date(now.getTime() + 2 * 60_000);
    return this.db.transaction(async (tx) => {
      const picked = await tx
        .select({ id: webhookDelivery.id })
        .from(webhookDelivery)
        .where(
          and(
            inArray(webhookDelivery.status, ['PENDING', 'RETRYING']),
            lte(webhookDelivery.nextAttemptAt, now),
            or(isNull(webhookDelivery.leaseUntil), lt(webhookDelivery.leaseUntil, now)),
          ),
        )
        .orderBy(webhookDelivery.nextAttemptAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      if (picked.length === 0) return [];
      const rows = await tx
        .update(webhookDelivery)
        .set({ leaseUntil })
        .where(inArray(webhookDelivery.id, picked.map((r) => r.id)))
        .returning();
      return rows.map(deliveryRecord);
    });
  }

  async saveDelivery(record: WebhookDeliveryRecord) {
    await this.db.transaction(async (tx) => {
      // 임대가 끝난 뒤 늦게 돌아온 워커가 SUCCEEDED/DEAD를 RETRYING으로 되돌리지 않게 한다(터미널 상태는 다시 쓰지 않는다).
      await tx
        .update(webhookDelivery)
        .set({ status: record.status, attemptCount: record.attemptCount, lastHttpStatus: record.lastHttpStatus, lastError: record.lastError, nextAttemptAt: record.nextAttemptAt, finishedAt: record.finishedAt, leaseUntil: null })
        .where(and(eq(webhookDelivery.id, record.deliveryId), inArray(webhookDelivery.status, ['PENDING', 'RETRYING'])));
    });
  }

  async countDeadSince(endpointId: string, since: Date) {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ n: sql<number>`count(*)::int` })
        .from(webhookDelivery)
        .where(and(eq(webhookDelivery.endpointId, endpointId), eq(webhookDelivery.status, 'DEAD'), sql`coalesce(${webhookDelivery.finishedAt}, ${webhookDelivery.createdAt}) >= ${since}`));
      return rows[0]?.n ?? 0;
    });
  }

  async lastSuccessAt(endpointId: string) {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select({ at: sql<Date | null>`max(${webhookDelivery.finishedAt})` })
        .from(webhookDelivery)
        .where(and(eq(webhookDelivery.endpointId, endpointId), eq(webhookDelivery.status, 'SUCCEEDED')));
      const at = rows[0]?.at;
      return at ? new Date(at) : null;
    });
  }

  async disableEndpoint(endpointId: string, _now: Date) {
    // core_app은 이 세 칸만, 켜진 끝점만 고친다(정책 webhook_endpoint_app_disable, ADR-0338 결정 1).
    // 이미 꺼진 끝점(파트너가 끈 것)에는 0행이라 사유 PARTNER와 판이 그대로 남는다. 다른 칸을 더하면 DB가 거절한다(42501)
    await this.db.transaction(async (tx) => {
      await tx
        .update(webhookEndpoint)
        .set({ status: 'DISABLED', disabledReason: 'FAILING', version: sql`${webhookEndpoint.version} + 1` })
        .where(eq(webhookEndpoint.id, endpointId));
    });
  }
}
