// BAT-455 Drizzle 저장소(0045): 신청·푸시 구독·발송 원장(core_app·core_notify, docs/data.md §2 ⑥).
// 원장은 중복 키를 먼저 넣고 들어갔을 때만 작업을 적는다(ADR-0109). 임대는 짧은 트랜잭션에서 FOR UPDATE SKIP LOCKED로 건다.
import { and, asc, desc, eq, inArray, isNull, lt, lte, or, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { EnqueueResult, FanNotifyStore } from '../../domain/fan-notify-ports.js';
import type { NotificationDeliveryRecord, NotificationJob, NotificationSubscription, PushSubscriptionRecord } from '../../domain/fan-notify-records.js';
import { notificationDedup, notificationDelivery, notificationJob, notificationSubscription, pushSubscription } from './schema.js';

const sub = (r: typeof notificationSubscription.$inferSelect): NotificationSubscription => ({
  id: r.id,
  accountId: r.accountId,
  eventId: r.eventId,
  kind: r.kind as NotificationSubscription['kind'],
  nightPush: r.nightPush,
  sentCount: r.sentCount,
  status: r.status as NotificationSubscription['status'],
  endReason: r.endReason as NotificationSubscription['endReason'],
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
});
const push = (r: typeof pushSubscription.$inferSelect): PushSubscriptionRecord => ({
  id: r.id,
  accountId: r.accountId,
  endpoint: r.endpoint,
  endpointHash: r.endpointHash,
  service: r.service as PushSubscriptionRecord['service'],
  p256dh: r.p256dh,
  auth: r.auth,
  expiresAt: r.expiresAt,
  boundAt: r.boundAt,
  createdAt: r.createdAt,
});
const job = (r: typeof notificationJob.$inferSelect): NotificationJob => ({
  dedupKey: r.dedupKey,
  kind: r.kind,
  targetId: r.targetId,
  accountId: r.accountId,
  channel: r.channel as NotificationJob['channel'],
  vars: r.vars,
  status: r.status as NotificationJob['status'],
  attempts: r.attempts,
  nextAttemptAt: r.nextAttemptAt,
  leaseUntil: r.leaseUntil,
  expiresAt: r.expiresAt,
  createdAt: r.createdAt,
});
const delivery = (r: typeof notificationDelivery.$inferSelect): NotificationDeliveryRecord => ({
  dedupKey: r.dedupKey,
  sentAt: r.sentAt,
  kind: r.kind,
  targetId: r.targetId,
  accountId: r.accountId,
  channel: r.channel as NotificationDeliveryRecord['channel'],
  status: r.status as NotificationDeliveryRecord['status'],
  providerMessageId: r.providerMessageId,
  createdAt: r.createdAt,
});

export class DrizzleFanNotifyStore implements FanNotifyStore {
  constructor(private readonly db: Database) {}

  async findSubscription(accountId: string, eventId: string, kind: 'OPEN' | 'CANCELLATION') {
    const rows = await this.db.db.select().from(notificationSubscription).where(and(eq(notificationSubscription.accountId, accountId), eq(notificationSubscription.eventId, eventId), eq(notificationSubscription.kind, kind))).limit(1);
    return rows[0] ? sub(rows[0]) : undefined;
  }
  async findSubscriptionById(id: string) {
    const rows = await this.db.db.select().from(notificationSubscription).where(eq(notificationSubscription.id, id)).limit(1);
    return rows[0] ? sub(rows[0]) : undefined;
  }
  async listSubscriptions(accountId: string, eventIds: readonly string[] | undefined, cursor: string | null, limit: number) {
    const c = cursor ? readCursor(cursor) : null;
    const where = [eq(notificationSubscription.accountId, accountId)];
    if (eventIds) where.push(inArray(notificationSubscription.eventId, [...eventIds]));
    if (c) where.push(or(lt(notificationSubscription.createdAt, new Date(c.at)), and(eq(notificationSubscription.createdAt, new Date(c.at)), lt(notificationSubscription.id, c.id)))!);
    const rows = await this.db.db
      .select()
      .from(notificationSubscription)
      .where(and(...where))
      .orderBy(desc(notificationSubscription.createdAt), desc(notificationSubscription.id))
      .limit(limit);
    return rows.map(sub);
  }
  async countActiveSubscriptions(accountId: string) {
    const rows = await this.db.db.select({ n: sql<number>`count(*)::int` }).from(notificationSubscription).where(and(eq(notificationSubscription.accountId, accountId), eq(notificationSubscription.status, 'ACTIVE')));
    return rows[0]?.n ?? 0;
  }
  async insertSubscription(r: NotificationSubscription) {
    await this.db.db.insert(notificationSubscription).values({ ...r });
  }
  async saveSubscription(r: NotificationSubscription) {
    await this.db.db.update(notificationSubscription).set({ nightPush: r.nightPush, sentCount: r.sentCount, status: r.status, endReason: r.endReason, updatedAt: r.updatedAt }).where(eq(notificationSubscription.id, r.id));
  }
  async deleteSubscription(accountId: string, eventId: string, kind: 'OPEN' | 'CANCELLATION') {
    const rows = await this.db.db.delete(notificationSubscription).where(and(eq(notificationSubscription.accountId, accountId), eq(notificationSubscription.eventId, eventId), eq(notificationSubscription.kind, kind))).returning({ id: notificationSubscription.id });
    return rows.length > 0;
  }
  async deleteSubscriptionById(id: string) {
    const rows = await this.db.db.delete(notificationSubscription).where(eq(notificationSubscription.id, id)).returning({ id: notificationSubscription.id });
    return rows.length > 0;
  }
  async mergeSubscriptions(primaryAccountId: string, absorbedAccountId: string, now: Date) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(notificationSubscription).where(eq(notificationSubscription.accountId, absorbedAccountId));
      let moved = 0;
      let deduped = 0;
      for (const row of rows) {
        const existing = await tx.select().from(notificationSubscription).where(and(eq(notificationSubscription.accountId, primaryAccountId), eq(notificationSubscription.eventId, row.eventId), eq(notificationSubscription.kind, row.kind))).limit(1);
        if (existing[0]) {
          const x = existing[0];
          await tx.update(notificationSubscription).set({
            sentCount: Math.max(x.sentCount, row.sentCount),
            nightPush: x.nightPush || row.nightPush,
            status: x.status === 'ACTIVE' || row.status === 'ACTIVE' ? 'ACTIVE' : 'ENDED',
            endReason: x.status === 'ACTIVE' ? x.endReason : row.endReason,
            updatedAt: now,
          }).where(eq(notificationSubscription.id, x.id));
          await tx.delete(notificationSubscription).where(eq(notificationSubscription.id, row.id));
          deduped += 1;
        } else {
          await tx.update(notificationSubscription).set({ accountId: primaryAccountId, updatedAt: now }).where(eq(notificationSubscription.id, row.id));
          moved += 1;
        }
      }
      return { moved, deduped };
    });
  }

  async listPushSubscriptions(accountId: string) {
    const rows = await this.db.db.select().from(pushSubscription).where(eq(pushSubscription.accountId, accountId)).orderBy(asc(pushSubscription.boundAt));
    return rows.map(push);
  }
  async findPushSubscriptionByEndpoint(endpoint: string) {
    const rows = await this.db.db.select().from(pushSubscription).where(eq(pushSubscription.endpoint, endpoint)).limit(1);
    return rows[0] ? push(rows[0]) : undefined;
  }
  async insertPushSubscription(r: PushSubscriptionRecord, limit: number) {
    return this.db.transaction(async (tx) => {
      await tx.insert(pushSubscription).values({ ...r });
      const rows = await tx.select({ id: pushSubscription.id }).from(pushSubscription).where(eq(pushSubscription.accountId, r.accountId)).orderBy(asc(pushSubscription.boundAt));
      const extra = rows.slice(0, Math.max(0, rows.length - limit)).map((x) => x.id);
      if (extra.length > 0) await tx.delete(pushSubscription).where(inArray(pushSubscription.id, extra));
      return extra;
    });
  }
  async savePushSubscription(r: PushSubscriptionRecord) {
    await this.db.db.update(pushSubscription).set({ accountId: r.accountId, endpointHash: r.endpointHash, service: r.service, p256dh: r.p256dh, auth: r.auth, expiresAt: r.expiresAt, boundAt: r.boundAt }).where(eq(pushSubscription.id, r.id));
  }
  async deletePushSubscription(accountId: string, subscriptionKey: string) {
    const rows = await this.db.db.delete(pushSubscription).where(and(eq(pushSubscription.accountId, accountId), eq(pushSubscription.endpointHash, subscriptionKey))).returning({ id: pushSubscription.id });
    return rows.length > 0;
  }
  async deletePushSubscriptionById(id: string) {
    await this.db.db.delete(pushSubscription).where(eq(pushSubscription.id, id));
  }
  async mergePushSubscriptions(primaryAccountId: string, absorbedAccountId: string, now: Date) {
    return this.db.transaction(async (tx) => {
      const rows = await tx.select().from(pushSubscription).where(eq(pushSubscription.accountId, absorbedAccountId));
      let moved = 0;
      let deduped = 0;
      for (const row of rows) {
        const existing = await tx.select({ id: pushSubscription.id }).from(pushSubscription).where(and(eq(pushSubscription.accountId, primaryAccountId), eq(pushSubscription.endpoint, row.endpoint))).limit(1);
        if (existing[0]) {
          await tx.delete(pushSubscription).where(eq(pushSubscription.id, row.id));
          deduped += 1;
        } else {
          await tx.update(pushSubscription).set({ accountId: primaryAccountId, boundAt: now }).where(eq(pushSubscription.id, row.id));
          moved += 1;
        }
      }
      return { moved, deduped };
    });
  }

  async enqueue(r: NotificationJob, now: Date): Promise<EnqueueResult> {
    return this.db.transaction(async (tx) => {
      const inserted = await tx.insert(notificationDedup).values({ dedupKey: r.dedupKey, createdAt: now }).onConflictDoNothing().returning({ key: notificationDedup.dedupKey });
      if (inserted.length === 0) return { created: false };
      await tx.insert(notificationJob).values({ ...r });
      return { created: true };
    });
  }
  async findJob(dedupKey: string) {
    const rows = await this.db.db.select().from(notificationJob).where(eq(notificationJob.dedupKey, dedupKey)).limit(1);
    return rows[0] ? job(rows[0]) : undefined;
  }
  async leaseDueJobs(now: Date, limit: number, leaseMs: number) {
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(notificationJob)
        .where(and(inArray(notificationJob.status, ['PENDING', 'RETRYING']), lte(notificationJob.nextAttemptAt, now), or(isNull(notificationJob.leaseUntil), lt(notificationJob.leaseUntil, now))))
        .orderBy(asc(notificationJob.nextAttemptAt))
        .limit(limit)
        .for('update', { skipLocked: true });
      const lease = new Date(now.getTime() + leaseMs);
      for (const r of rows) await tx.update(notificationJob).set({ leaseUntil: lease }).where(eq(notificationJob.dedupKey, r.dedupKey));
      return rows.map((r) => ({ ...job(r), leaseUntil: lease }));
    });
  }
  async saveJob(r: NotificationJob) {
    await this.db.db.update(notificationJob).set({ status: r.status, attempts: r.attempts, nextAttemptAt: r.nextAttemptAt, leaseUntil: r.leaseUntil }).where(eq(notificationJob.dedupKey, r.dedupKey));
  }
  async deleteJob(dedupKey: string) {
    await this.db.db.delete(notificationJob).where(eq(notificationJob.dedupKey, dedupKey));
  }
  async insertDelivery(r: NotificationDeliveryRecord) {
    await this.db.db.insert(notificationDelivery).values({ ...r });
  }
  async findDelivery(dedupKey: string) {
    const rows = await this.db.db.select().from(notificationDelivery).where(eq(notificationDelivery.dedupKey, dedupKey)).orderBy(desc(notificationDelivery.sentAt)).limit(1);
    return rows[0] ? delivery(rows[0]) : undefined;
  }
  async listDeliveries(accountId: string, limit: number) {
    const rows = await this.db.db.select().from(notificationDelivery).where(eq(notificationDelivery.accountId, accountId)).orderBy(desc(notificationDelivery.sentAt)).limit(limit);
    return rows.map(delivery);
  }
  async purgeDedupBefore(cutoff: Date) {
    const rows = await this.db.db.delete(notificationDedup).where(lt(notificationDedup.createdAt, cutoff)).returning({ key: notificationDedup.dedupKey });
    return rows.length;
  }
}

const readCursor = (c: string): { at: number; id: string } | null => {
  try {
    const m = /^v1:(\d+):([0-9a-f-]{36})$/i.exec(Buffer.from(c, 'base64url').toString('utf8'));
    return m ? { at: Number(m[1]), id: m[2]! } : null;
  } catch {
    return null;
  }
};
