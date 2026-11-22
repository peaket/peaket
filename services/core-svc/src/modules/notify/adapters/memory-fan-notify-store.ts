// BAT-455 메모리 저장소(단위·HTTP 시험). Drizzle 저장소와 같은 규칙을 지킨다.
import type { NotificationDeliveryRecord, NotificationJob, NotificationSubscription, PushSubscriptionRecord } from '../domain/fan-notify-records.js';
import type { EnqueueResult, FanNotifyStore } from '../domain/fan-notify-ports.js';

export const subscriptionKeyOfRow = (r: { accountId: string; eventId: string; kind: string }): string => `${r.accountId}:${r.eventId}:${r.kind}`;
const cursorOf = (r: NotificationSubscription): string => Buffer.from(`v1:${r.createdAt.getTime()}:${r.id}`, 'utf8').toString('base64url');
const readCursor = (c: string | null): { at: number; id: string } | null => {
  if (!c) return null;
  try {
    const s = Buffer.from(c, 'base64url').toString('utf8');
    const m = /^v1:(\d+):([0-9a-f-]{36})$/i.exec(s);
    return m ? { at: Number(m[1]), id: m[2]! } : null;
  } catch {
    return null;
  }
};

export class MemoryFanNotifyStore implements FanNotifyStore {
  readonly subscriptions = new Map<string, NotificationSubscription>();
  readonly push = new Map<string, PushSubscriptionRecord>();
  readonly dedup = new Map<string, Date>();
  readonly jobs = new Map<string, NotificationJob>();
  readonly deliveries: NotificationDeliveryRecord[] = [];

  async findSubscription(accountId: string, eventId: string, kind: 'OPEN' | 'CANCELLATION') {
    return this.subscriptions.get(`${accountId}:${eventId}:${kind}`);
  }
  async findSubscriptionById(id: string) {
    return [...this.subscriptions.values()].find((s) => s.id === id);
  }
  async listSubscriptions(accountId: string, eventIds: readonly string[] | undefined, cursor: string | null, limit: number) {
    const rows = [...this.subscriptions.values()]
      .filter((s) => s.accountId === accountId && (!eventIds || eventIds.includes(s.eventId)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id));
    if (eventIds) return rows;
    const c = readCursor(cursor);
    const after = c ? rows.filter((r) => r.createdAt.getTime() < c.at || (r.createdAt.getTime() === c.at && r.id < c.id)) : rows;
    return after.slice(0, limit);
  }
  async countActiveSubscriptions(accountId: string) {
    return [...this.subscriptions.values()].filter((s) => s.accountId === accountId && s.status === 'ACTIVE').length;
  }
  async insertSubscription(record: NotificationSubscription) {
    const key = subscriptionKeyOfRow(record);
    if (this.subscriptions.has(key)) throw new Error('이미 있는 신청입니다');
    this.subscriptions.set(key, { ...record });
  }
  async saveSubscription(record: NotificationSubscription) {
    this.subscriptions.set(subscriptionKeyOfRow(record), { ...record });
  }
  async deleteSubscription(accountId: string, eventId: string, kind: 'OPEN' | 'CANCELLATION') {
    return this.subscriptions.delete(`${accountId}:${eventId}:${kind}`);
  }
  async deleteSubscriptionById(id: string) {
    for (const [k, v] of this.subscriptions) {
      if (v.id === id) {
        this.subscriptions.delete(k);
        return true;
      }
    }
    return false;
  }
  async mergeSubscriptions(primaryAccountId: string, absorbedAccountId: string, now: Date) {
    let moved = 0;
    let deduped = 0;
    for (const [key, row] of [...this.subscriptions]) {
      if (row.accountId !== absorbedAccountId) continue;
      const existing = this.subscriptions.get(`${primaryAccountId}:${row.eventId}:${row.kind}`);
      if (existing) {
        this.subscriptions.set(`${primaryAccountId}:${row.eventId}:${row.kind}`, {
          ...existing,
          sentCount: Math.max(existing.sentCount, row.sentCount),
          nightPush: existing.nightPush || row.nightPush,
          status: existing.status === 'ACTIVE' || row.status === 'ACTIVE' ? 'ACTIVE' : 'ENDED',
          endReason: existing.status === 'ACTIVE' ? existing.endReason : row.endReason,
          updatedAt: now,
        });
        this.subscriptions.delete(key);
        deduped += 1;
      } else {
        this.subscriptions.delete(key);
        this.subscriptions.set(`${primaryAccountId}:${row.eventId}:${row.kind}`, { ...row, accountId: primaryAccountId, updatedAt: now });
        moved += 1;
      }
    }
    return { moved, deduped };
  }

  async listPushSubscriptions(accountId: string) {
    return [...this.push.values()].filter((p) => p.accountId === accountId).sort((a, b) => a.boundAt.getTime() - b.boundAt.getTime());
  }
  async findPushSubscriptionByEndpoint(endpoint: string) {
    return [...this.push.values()].find((p) => p.endpoint === endpoint);
  }
  async insertPushSubscription(record: PushSubscriptionRecord, limit: number) {
    this.push.set(record.id, { ...record });
    const mine = await this.listPushSubscriptions(record.accountId);
    const evicted: string[] = [];
    for (const old of mine.slice(0, Math.max(0, mine.length - limit))) {
      this.push.delete(old.id);
      evicted.push(old.id);
    }
    return evicted;
  }
  async savePushSubscription(record: PushSubscriptionRecord) {
    this.push.set(record.id, { ...record });
  }
  async deletePushSubscription(accountId: string, subscriptionKey: string) {
    for (const [id, p] of this.push) {
      if (p.accountId === accountId && p.endpointHash === subscriptionKey) {
        this.push.delete(id);
        return true;
      }
    }
    return false;
  }
  async deletePushSubscriptionById(id: string) {
    this.push.delete(id);
  }
  async mergePushSubscriptions(primaryAccountId: string, absorbedAccountId: string, now: Date) {
    let moved = 0;
    let deduped = 0;
    for (const [id, row] of [...this.push]) {
      if (row.accountId !== absorbedAccountId) continue;
      const existing = [...this.push.values()].find((p) => p.id !== id && p.accountId === primaryAccountId && p.endpoint === row.endpoint);
      if (existing) {
        this.push.delete(id);
        deduped += 1;
      } else {
        this.push.set(id, { ...row, accountId: primaryAccountId, boundAt: now });
        moved += 1;
      }
    }
    return { moved, deduped };
  }

  async enqueue(record: NotificationJob, now: Date): Promise<EnqueueResult> {
    if (this.dedup.has(record.dedupKey)) return { created: false };
    this.dedup.set(record.dedupKey, now);
    this.jobs.set(record.dedupKey, { ...record });
    return { created: true };
  }
  async findJob(dedupKey: string) {
    return this.jobs.get(dedupKey);
  }
  async leaseDueJobs(now: Date, limit: number, leaseMs: number) {
    const due = [...this.jobs.values()]
      .filter((j) => j.status !== 'DEAD' && j.nextAttemptAt.getTime() <= now.getTime() && (j.leaseUntil === null || j.leaseUntil.getTime() < now.getTime()))
      .sort((a, b) => a.nextAttemptAt.getTime() - b.nextAttemptAt.getTime())
      .slice(0, limit);
    return due.map((j) => {
      const leased = { ...j, leaseUntil: new Date(now.getTime() + leaseMs) };
      this.jobs.set(j.dedupKey, leased);
      return { ...leased };
    });
  }
  async saveJob(record: NotificationJob) {
    this.jobs.set(record.dedupKey, { ...record });
  }
  async deleteJob(dedupKey: string) {
    this.jobs.delete(dedupKey);
  }
  async insertDelivery(record: NotificationDeliveryRecord) {
    this.deliveries.push({ ...record });
  }
  async findDelivery(dedupKey: string) {
    return this.deliveries.find((d) => d.dedupKey === dedupKey);
  }
  async listDeliveries(accountId: string, limit: number) {
    return this.deliveries.filter((d) => d.accountId === accountId).sort((a, b) => b.sentAt.getTime() - a.sentAt.getTime()).slice(0, limit);
  }
  async purgeDedupBefore(cutoff: Date) {
    let n = 0;
    for (const [k, t] of this.dedup) {
      if (t.getTime() < cutoff.getTime()) {
        this.dedup.delete(k);
        n += 1;
      }
    }
    return n;
  }
}

export { cursorOf as subscriptionCursorOf };
