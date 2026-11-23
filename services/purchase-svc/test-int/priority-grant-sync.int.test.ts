// F-05-3 우선 구매 권리 대조 실제 PostgreSQL·gRPC 통합 시험(GAT-135, S-T37 ⑩~⑫).
// purchase-svc 대조가 실제 DB의 기한 지난 OFFERED를 EXPIRED로 고치고, queue-svc PriorityGrantService(실제 gRPC)에
// OFFERED·USED·WITHDRAWN 사본을 판 번호·만료와 함께 다시 보내는지 본다. 구현 전에는 새 모듈이 없어 실패한다.
import { randomUUID } from 'node:crypto';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzlePriorityGrantStore } from '../src/modules/priority/adapters/db/drizzle-priority-grant-store.js';
import type { PriorityGrant } from '../src/modules/priority/domain/priority-grant.js';
import { queuePackage } from '../../queue-svc/src/grpc-package.js';
import { startGrpcServer } from '../../queue-svc/src/grpc-server.js';
import { MemoryPriorityGrantStore } from '../../queue-svc/src/modules/admission/adapters/memory-priority-grants.js';
import { SetPriorityGrant } from '../../queue-svc/src/modules/admission/application/set-priority-grant.js';
import { priorityGrantHandlers } from '../../queue-svc/src/modules/admission/inbound/priority-grant.grpc.js';
import { QueueStoreUnavailable } from '../../queue-svc/src/modules/entry/domain/queue.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-24T02:00:00.000Z');
const HOUR = 3600_000;

let pg: PostgresContainer;
let database: Database;
let store: DrizzlePriorityGrantStore;

async function loadModules() {
  const [sync, client] = await Promise.all([
    import('../src/modules/priority/application/sync-priority-grants.js').catch(() => undefined),
    import('../src/modules/priority/adapters/grpc-queue-priority-grants.js').catch(() => undefined),
  ]);
  expect(sync?.PriorityGrantSync, 'PriorityGrantSync 모듈이 없다(F-05-3 구현 전)').toBeDefined();
  expect(client?.GrpcQueuePriorityGrants, 'GrpcQueuePriorityGrants 모듈이 없다(F-05-3 구현 전)').toBeDefined();
  return { PriorityGrantSync: sync!.PriorityGrantSync, GrpcQueuePriorityGrants: client!.GrpcQueuePriorityGrants };
}

async function createGrant(over: Partial<Parameters<DrizzlePriorityGrantStore['create']>[0]> = {}): Promise<PriorityGrant> {
  return store.create({
    grantId: randomUUID(),
    eventId: randomUUID(),
    accountId: randomUUID(),
    fraudCaseId: randomUUID(),
    cancelledTicketId: randomUUID(),
    grantKind: 'SAME_SEAT',
    seatId: randomUUID(),
    tierId: 'R',
    price: 110_000,
    expiresAtMs: NOW + 48 * HOUR,
    nowMs: NOW,
    ...over,
  });
}

beforeAll(async () => {
  pg = await startPostgres();
  await migratePurchase(pg.url);
  database = createDatabase({ url: pg.url, profile: 'general', max: 8, applicationName: 'purchase-priority-sync-int' });
  store = new DrizzlePriorityGrantStore(database);
}, 180_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

describe('F-05-3 우선 구매 권리 대조 [GAT-135, S-T37]', () => {
  test('S-T37 ⑫ 실제 DB에서 기한 지난 OFFERED를 EXPIRED로 바꾸고, 대조 목록에서 뺀다', async () => {
    expect(typeof store.expireDue, 'expireDue가 없다(F-05-3 구현 전)').toBe('function');
    expect(typeof store.listSyncable, 'listSyncable이 없다(F-05-3 구현 전)').toBe('function');
    const stale = await createGrant({ expiresAtMs: NOW - 1 });
    const active = await createGrant({ expiresAtMs: NOW + HOUR });

    const due = await store.expireDue(NOW, 100);
    expect(due.map((g) => g.grantId)).toContain(stale.grantId);
    expect(await store.find(stale.grantId)).toMatchObject({ status: 'EXPIRED', version: 2 });
    expect(await store.find(active.grantId)).toMatchObject({ status: 'OFFERED', version: 1 });

    const syncable = await store.listSyncable(NOW, 100);
    expect(syncable.map((g) => g.grantId)).toContain(active.grantId);
    expect(syncable.map((g) => g.grantId)).not.toContain(stale.grantId);
  });

  test('S-T37 ⑫b 만료 DB 실패(트리거) 뒤 대조가 실제 DB에서 고친다', async () => {
    const g = await createGrant({ expiresAtMs: NOW - 1 });
    await database.pool.query(`create or replace function f053_fail() returns trigger language plpgsql as $$ begin raise exception 'f053 failure'; end $$`);
    await database.pool.query(
      `create trigger f053_fail before update on priority_grant for each row when (old.id = '${g.grantId}'::uuid) execute function f053_fail()`,
    );
    try {
      await expect(store.expire(g.grantId, NOW)).rejects.toThrow();
    } finally {
      await database.pool.query('drop trigger if exists f053_fail on priority_grant');
    }
    expect(await store.find(g.grantId)).toMatchObject({ status: 'OFFERED', version: 1 });

    await store.expireDue(NOW, 100);
    expect(await store.find(g.grantId)).toMatchObject({ status: 'EXPIRED', version: 2 });
  });

  test('S-T37 ⑩⑪ 실제 gRPC로 OFFERED·USED·WITHDRAWN을 보내고, UNAVAILABLE이면 다음 틱에 다시 보낸다', async () => {
    const { PriorityGrantSync, GrpcQueuePriorityGrants } = await loadModules();
    const memory = new MemoryPriorityGrantStore();
    const set = new SetPriorityGrant(memory, fakeClock({ now: NOW }));
    let failNext = 0;
    const server = await startGrpcServer({
      host: '127.0.0.1',
      port: 0,
      services: [
        {
          definition: queuePackage().PriorityGrantService.service,
          handlers: priorityGrantHandlers(
            {
              run: (i) => {
                if (failNext > 0) {
                  failNext -= 1;
                  return Promise.reject(new QueueStoreUnavailable(new Error('queue down')));
                }
                return set.run(i);
              },
            },
            () => undefined,
          ),
        },
      ],
    });
    const copies = new GrpcQueuePriorityGrants(`127.0.0.1:${server.port}`);
    try {
      const offered = await createGrant();
      const used = await createGrant();
      expect(await store.markUsed(used.grantId, randomUUID(), NOW)).toMatchObject({ status: 'USED', version: 2 });
      const withdrawn = await createGrant();
      expect(await store.withdraw(withdrawn.grantId, 'operator-1', NOW)).toMatchObject({ status: 'WITHDRAWN', version: 2 });

      const signals: string[] = [];
      const logs: string[] = [];
      const sync = new PriorityGrantSync({
        grants: store,
        copies,
        clock: { now: () => NOW },
        logger: { warn: (_o: object, msg: string) => logs.push(msg), error: (_o: object, msg: string) => logs.push(msg) },
        signals: { sync: (r: string) => signals.push(`sync:${r}`), expire: (r: string) => signals.push(`expire:${r}`) },
      });

      // 첫 틱은 사본 하나를 일부러 실패시킨다(UNAVAILABLE). 다음 틱이 다시 보낸다
      failNext = 1;
      await expect(sync.runOnce()).resolves.toBeUndefined();
      expect(signals).toContain('sync:failed');
      await sync.runOnce();
      expect(signals).toContain('sync:ok');

      for (const g of [offered, used, withdrawn]) {
        expect(await memory.get({ accountId: g.accountId, eventId: g.eventId, grantId: g.grantId })).toMatchObject({
          grantId: g.grantId,
          state: g.status,
          version: g.version,
          expiresAtMs: g.expiresAtMs,
        });
      }
    } finally {
      (copies as unknown as { close?: () => void }).close?.();
      await server.close();
    }
  }, 60_000);
});
