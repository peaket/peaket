// OPS-02 회귀(실제 PostgreSQL 18): 두 복제가 동시에 집어도 같은 발송 행을 두 번 집지 않고,
// 집은 행에는 lease_until이 걸리며 만료 뒤에만 다른 복제가 다시 집는다.
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { eq, inArray } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleWebhookStore } from '../src/modules/notify/adapters/db/drizzle-webhook-store.js';
import { webhookDelivery } from '../src/modules/notify/adapters/db/schema.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = new Date('2026-11-15T00:00:00.000Z');
const PROMOTER = randomUUID();
const ENDPOINT = randomUUID();

let pg: PostgresContainer;
let db: Database;
let first: DrizzleWebhookStore;
let second: DrizzleWebhookStore;

const delivery = (id: string, nextAttemptAt: Date) => ({
  deliveryId: id,
  endpointId: ENDPOINT,
  webhookId: `wh-${id}`,
  eventType: 'order.confirmed',
  status: 'PENDING' as const,
  attemptCount: 0,
  lastHttpStatus: null,
  lastError: null,
  nextAttemptAt,
  createdAt: NOW,
  finishedAt: null,
  payload: {},
});

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  db = createDatabase({ url: pg.url, applicationName: 'core-webhook-lease-concurrent-int', max: 4 });
  first = new DrizzleWebhookStore(db);
  second = new DrizzleWebhookStore(db);
  await first.insertEndpoint({
    endpointId: ENDPOINT,
    promoterId: PROMOTER,
    url: 'https://partner.example.com/hook',
    eventTypes: ['order.confirmed'],
    status: 'ACTIVE',
    disabledReason: null,
    secret: 'whsec_test',
    previousSecret: null,
    secretIssuedAt: NOW,
    previousSecretValidUntil: null,
    version: 1,
  });
});

afterAll(async () => {
  await db?.close();
  pg?.stop();
});

describe('OPS-02 웹훅 임대 동시성', () => {
  test('두 복제가 동시에 집어도 행은 한 번만 임대되고, 임대 만료 전에는 다시 집히지 않는다', async () => {
    const a = randomUUID();
    const b = randomUUID();
    await first.insertDeliveries([delivery(a, NOW), delivery(b, NOW)]);

    const [left, right] = await Promise.all([first.listDueDeliveries(NOW, 10), second.listDueDeliveries(NOW, 10)]);
    const claimed = [...left, ...right];
    expect(claimed).toHaveLength(2);
    expect(new Set(claimed.map((d) => d.deliveryId)).size).toBe(2);

    const rows = await db.db.select().from(webhookDelivery).where(inArray(webhookDelivery.id, [a, b]));
    for (const row of rows) {
      expect(row.leaseUntil?.getTime()).toBe(NOW.getTime() + 2 * 60_000);
    }

    expect(await first.listDueDeliveries(new Date(NOW.getTime() + 60_000), 10)).toHaveLength(0);
    const later = await second.listDueDeliveries(new Date(NOW.getTime() + 2 * 60_000 + 1), 10);
    expect(later).toHaveLength(2);
    const reclaimed = await db.db.select().from(webhookDelivery).where(inArray(webhookDelivery.id, [a, b]));
    for (const row of reclaimed) {
      expect(row.leaseUntil?.getTime()).toBe(NOW.getTime() + 4 * 60_000 + 1);
    }
  });

  test('터미널 상태가 된 행은 늦은 워커의 RETRYING 저장으로 되돌아가지 않는다', async () => {
    const id = randomUUID();
    await first.insertDeliveries([delivery(id, NOW)]);
    const [claimed] = await first.listDueDeliveries(NOW, 1);
    expect(claimed).toBeDefined();
    await first.saveDelivery({ ...claimed!, status: 'SUCCEEDED', attemptCount: 1, lastHttpStatus: 200, lastError: null, nextAttemptAt: null, finishedAt: NOW });
    await second.saveDelivery({ ...claimed!, status: 'RETRYING', attemptCount: 1, lastHttpStatus: 500, lastError: 'http-500', nextAttemptAt: new Date(NOW.getTime() + 60_000), finishedAt: null });

    const row = (await db.db.select().from(webhookDelivery).where(eq(webhookDelivery.id, id)))[0]!;
    expect(row.status).toBe('SUCCEEDED');
    expect(row.leaseUntil).toBeNull();
  });

  test('다시 보내기는 만료되지 않은 옛 임대를 지워 바로 집히게 한다', async () => {
    const id = randomUUID();
    await db.pool.query(
      "insert into webhook_delivery (id, endpoint_id, webhook_id, event_type, status, attempt_count, created_at, lease_until) values ($1, $2, 'wh-stale', 'order.confirmed', 'DEAD', 7, $3, $4)",
      [id, ENDPOINT, NOW, new Date(NOW.getTime() + 60 * 60_000)],
    );
    const re = await first.redeliver(PROMOTER, id, NOW);
    expect(re).toMatchObject({ deliveryId: id, status: 'PENDING' });
    const row = (await db.db.select().from(webhookDelivery).where(eq(webhookDelivery.id, id)))[0]!;
    expect(row.leaseUntil).toBeNull();
    const due = await first.listDueDeliveries(NOW, 10);
    expect(due.map((d) => d.deliveryId)).toEqual([id]);
  });
});
