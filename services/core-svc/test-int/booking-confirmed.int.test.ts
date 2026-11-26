// F-06-8 core PostgreSQL 통합: 0048 적용, dedup 유일성, template_version, held_event 위치·재처리.
import { randomUUID } from 'node:crypto';
import { createDatabase, ensureMonthlyPartitions, systemClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { sql } from 'drizzle-orm';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleFanNotifyStore, DrizzleNotifyHeldEvents, type NotificationJob } from '../src/modules/notify/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pg: PostgresContainer;
let db: Database;
const ACCOUNT = randomUUID();
const NOW = new Date('2026-11-27T03:00:00.000Z');

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  db = createDatabase({ url: pg.url, applicationName: 'f068-notify-int', max: 3 });
  await ensureMonthlyPartitions(db, systemClock, { table: 'notification_delivery', key: 'timestamptz' });
}, 180_000);

afterAll(async () => {
  await db?.close();
  pg?.stop();
});

const job = (): NotificationJob & { templateVersion?: string } => ({
  dedupKey: `BOOKING_CONFIRMED:${randomUUID()}:CONFIRMED:${ACCOUNT}:EMAIL`,
  kind: 'BOOKING_CONFIRMED',
  targetId: randomUUID(),
  accountId: ACCOUNT,
  channel: 'EMAIL',
  vars: { productionName: '겨울 콘서트', amount: 220000 },
  templateVersion: 'v1',
  status: 'PENDING',
  attempts: 0,
  nextAttemptAt: new Date(NOW.getTime() - 1000),
  leaseUntil: null,
  expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
  createdAt: new Date(NOW.getTime() - 2000),
});

describe('F-06-8 core PostgreSQL', () => {
  test('notification_dedup은 한 번, job·delivery가 template_version을 읽고 쓴다', async () => {
    const store = new DrizzleFanNotifyStore(db);
    const j = job();
    expect(await store.enqueue(j, NOW)).toEqual({ created: true });
    expect(await store.enqueue(j, NOW)).toEqual({ created: false });
    const found = await store.findJob(j.dedupKey);
    expect(found).toMatchObject({ kind: 'BOOKING_CONFIRMED', templateVersion: 'v1' });

    await store.insertDelivery({
      dedupKey: j.dedupKey,
      sentAt: NOW,
      kind: j.kind,
      targetId: j.targetId,
      accountId: j.accountId,
      channel: 'EMAIL',
      status: 'SENT',
      providerMessageId: 'ses-1',
      templateVersion: 'v1',
      createdAt: j.createdAt,
    });
    expect(await store.findDelivery(j.dedupKey)).toMatchObject({ status: 'SENT', templateVersion: 'v1', providerMessageId: 'ses-1' });
    await store.deleteJob(j.dedupKey);
  });

  test('held_event에 실제 위치를 쓰고 같은 eventKey는 재처리하지 않는다', async () => {
    const held = new DrizzleNotifyHeldEvents(db);
    const a = `booking:${randomUUID()}`;
    const b = `booking:${randomUUID()}`;
    await held.hold({ eventKey: a, kind: 'BOOKING_CONFIRMED', payload: { orderId: randomUUID() }, attempts: 3, partition: 2, kafkaOffset: 10 }, NOW);
    await held.hold({ eventKey: b, kind: 'BOOKING_CONFIRMED', payload: { orderId: randomUUID() }, attempts: 3, partition: 2, kafkaOffset: 11 }, NOW);
    expect(await held.find(a)).toBe(true);
    expect(await held.find(b)).toBe(true);

    // 같은 eventKey는 event_key 유일 색인이 막고, 다른 위치의 다른 사건은 남는다
    await held.hold({ eventKey: a, kind: 'BOOKING_CONFIRMED', payload: { orderId: randomUUID() }, attempts: 3, partition: 3, kafkaOffset: 12 }, NOW);
    const count = await db.db.execute(sql`select count(*)::int as n from held_event where topic = 'trade.orders' and event_key in (${a}, ${b})`);
    expect((count as unknown as { rows: { n: number }[] }).rows[0]?.n).toBe(2);
  });
});
