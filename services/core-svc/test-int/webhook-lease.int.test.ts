// 웹훅 발송 워커 임대 시험(OPS-02, docs/data.md §5 webhook_delivery). 실제 PostgreSQL 18에서 SKIP LOCKED·lease_until·터미널 상태 역행 방지를 본다.
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleWebhookStore } from '../src/modules/notify/adapters/db/drizzle-webhook-store.js';
import { webhookDelivery } from '../src/modules/notify/adapters/db/schema.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = new Date('2026-11-15T00:00:00.000Z');
const PROMOTER = randomUUID();
const ENDPOINT = randomUUID();
const DELIVERY = randomUUID();

let pg: PostgresContainer;
let db: Database;
let first: DrizzleWebhookStore;
let second: DrizzleWebhookStore;

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  db = createDatabase({ url: pg.url, applicationName: 'core-webhook-lease-int', max: 2 });
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
  await first.insertDeliveries([
    {
      deliveryId: DELIVERY,
      endpointId: ENDPOINT,
      webhookId: 'wh-1',
      eventType: 'order.confirmed',
      status: 'PENDING',
      attemptCount: 0,
      lastHttpStatus: null,
      lastError: null,
      nextAttemptAt: NOW,
      createdAt: NOW,
      finishedAt: null,
      payload: {},
    },
  ]);
});

afterAll(async () => {
  await db?.close();
  pg?.stop();
});

describe('OPS-02 웹훅 임대', () => {
  test('한 복제가 집은 행은 임대 전 다른 복제가 못 집고, 만료 뒤 다시 집는다', async () => {
    const a = await first.listDueDeliveries(NOW, 10);
    expect(a).toHaveLength(1);
    expect(await second.listDueDeliveries(NOW, 10)).toHaveLength(0);

    const later = new Date(NOW.getTime() + 3 * 60_000);
    const b = await second.listDueDeliveries(later, 10);
    expect(b).toHaveLength(1);

    // 임대가 끝난 뒤 늦게 돌아온 첫 워커가 SUCCEEDED를 RETRYING으로 되돌리지 못한다
    await second.saveDelivery({ ...b[0]!, status: 'SUCCEEDED', attemptCount: 1, lastHttpStatus: 200, lastError: null, nextAttemptAt: null, finishedAt: later });
    await first.saveDelivery({ ...a[0]!, status: 'RETRYING', attemptCount: 1, lastHttpStatus: 500, lastError: 'http-500', nextAttemptAt: new Date(later.getTime() + 60_000), finishedAt: null });

    const row = (await db.db.select().from(webhookDelivery).where(eq(webhookDelivery.id, DELIVERY)))[0]!;
    expect(row.status).toBe('SUCCEEDED');
    expect(row.leaseUntil).toBeNull();
  });
});
