// BAT-455 N-T19 통합: 0045 적용·notification_delivery 파티션·core_app/core_notify 권한·동시 임대(실제 PostgreSQL).
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { DrizzleFanNotifyStore } from '../src/modules/notify/index.js';
import type { NotificationJob } from '../src/modules/notify/domain/fan-notify-records.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

const NOW = new Date('2026-11-22T00:00:00.000Z');
const ACCOUNT = randomUUID();
const EVENT = randomUUID();
let pg: PostgresContainer;
let admin: Database;
let app: Database;
let notify: Database;
let notify2: Database;

const job = (): NotificationJob => ({
  dedupKey: `REFUNDED:${randomUUID()}:${ACCOUNT}:EMAIL`,
  kind: 'REFUNDED',
  targetId: randomUUID(),
  accountId: ACCOUNT,
  channel: 'EMAIL',
  vars: { refundAmount: 110_000 },
  status: 'PENDING',
  attempts: 0,
  nextAttemptAt: new Date(NOW.getTime() - 1000),
  leaseUntil: null,
  expiresAt: new Date(NOW.getTime() + 24 * 60 * 60 * 1000),
  createdAt: new Date(NOW.getTime() - 2000),
});

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-fan-notify-int-admin', max: 2 });
  app = await loginFor(admin, pg, 'core_app_login', 'core_app', 2);
  notify = await loginFor(admin, pg, 'core_notify_login', 'core_notify', 2);
  notify2 = await loginFor(admin, pg, 'core_notify_login2', 'core_notify', 2);
}, 180_000);
afterAll(async () => {
  await Promise.all([app?.close(), notify?.close(), notify2?.close()]);
  await admin?.close();
  pg?.stop();
});

describe('BAT-455 팬 알림 원장(0045)', () => {
  test('N-T19 ⑦ core_app은 신청·푸시·중복 키·작업을 쓰고 core_notify는 원장을 집어 결과만 쓴다', async () => {
    const appStore = new DrizzleFanNotifyStore(app);
    const id = randomUUID();
    await appStore.insertSubscription({
      id,
      accountId: ACCOUNT,
      eventId: EVENT,
      kind: 'OPEN',
      nightPush: true,
      sentCount: 0,
      status: 'ACTIVE',
      endReason: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(await appStore.findSubscription(ACCOUNT, EVENT, 'OPEN')).toMatchObject({ id, nightPush: true });
    expect(await appStore.countActiveSubscriptions(ACCOUNT)).toBe(1);

    const pushId = randomUUID();
    await appStore.insertPushSubscription(
      {
        id: pushId,
        accountId: ACCOUNT,
        endpoint: 'https://fcm.googleapis.com/send/int',
        endpointHash: 'h'.repeat(43),
        service: 'FCM',
        p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64)]).toString('base64url'),
        auth: Buffer.alloc(16).toString('base64url'),
        expiresAt: null,
        boundAt: NOW,
        createdAt: NOW,
      },
      10,
    );

    const j = job();
    expect(await appStore.enqueue(j, NOW)).toEqual({ created: true });
    expect(await appStore.enqueue(j, NOW)).toEqual({ created: false });

    const sender = new DrizzleFanNotifyStore(notify);
    const sender2 = new DrizzleFanNotifyStore(notify2);
    expect(await sender.findSubscription(ACCOUNT, EVENT, 'OPEN')).toMatchObject({ id, nightPush: true });
    expect(await sender.listPushSubscriptions(ACCOUNT)).toHaveLength(1);
    // 두 워커가 같은 행을 동시에 집어도 하나만 가져간다
    const [a, b] = await Promise.all([sender.leaseDueJobs(NOW, 10, 120_000), sender2.leaseDueJobs(NOW, 10, 120_000)]);
    expect(a.length + b.length).toBe(1);
    const leased = (a[0] ?? b[0])!;
    expect(leased.leaseUntil).toEqual(new Date(NOW.getTime() + 120_000));

    await sender.insertDelivery({
      dedupKey: j.dedupKey,
      sentAt: NOW,
      kind: j.kind,
      targetId: j.targetId,
      accountId: ACCOUNT,
      channel: 'EMAIL',
      status: 'SENT',
      providerMessageId: 'msg-int',
      createdAt: j.createdAt,
    });
    await sender.deleteJob(j.dedupKey);
    await sender.deletePushSubscriptionById(pushId);

    const rows = await admin.pool.query('select status, provider_message_id, tableoid::regclass::text as part from notification_delivery where dedup_key = $1', [j.dedupKey]);
    expect(rows.rows[0]).toMatchObject({ status: 'SENT', provider_message_id: 'msg-int' });
    expect(rows.rows[0].part).toMatch(/^notification_delivery_p\d{6}$/);
    expect((await admin.pool.query('select 1 from notification_job where dedup_key = $1', [j.dedupKey])).rowCount).toBe(0);
    expect((await admin.pool.query('select 1 from push_subscription where id = $1', [pushId])).rowCount).toBe(0);
  });

  test('N-T19 ⑧ core_notify는 신청의 보낸 횟수만 고치고 다른 칸·다른 표는 고치지 못한다', async () => {
    const sender = new DrizzleFanNotifyStore(notify);
    const sub = await sender.findSubscription(ACCOUNT, EVENT, 'OPEN');
    await sender.saveSubscription({ ...sub!, sentCount: 3, status: 'ENDED', endReason: 'BOOKED', updatedAt: NOW });
    expect(await sender.findSubscription(ACCOUNT, EVENT, 'OPEN')).toMatchObject({ sentCount: 3, status: 'ENDED' });
    await expect(admin.pool.query("update notification_subscription set account_id = gen_random_uuid() where event_id = $1", [EVENT])).resolves.toBeTruthy();
    await expect(notify.pool.query('update notification_subscription set event_id = gen_random_uuid() where event_id = $1', [EVENT])).rejects.toThrow(/42501|permission denied/);
    await expect(notify.pool.query('select 1 from wish limit 1')).rejects.toThrow(/42501|permission denied/);
    await expect(notify.pool.query('update notification_delivery set status = $1', ['FAILED'])).rejects.toThrow(/42501|permission denied/);
  });
});
