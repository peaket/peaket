// F-05-3 IR-03 재현·회귀: 대조가 100개를 넘어도 다음 틱에 뒤쪽 권리까지 보낸다(GAT-135, S-T37 ⑯, ADR-0385).
// 실제 PostgreSQL의 priority_grant 150행을 두고 PriorityGrantSync를 두 번 돌린다. 실패한 행은 다음 틱에 다시 온다.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { PriorityGrantSync } from '../src/modules/priority/application/sync-priority-grants.js';
import { DrizzlePriorityGrantStore } from '../src/modules/priority/adapters/db/drizzle-priority-grant-store.js';
import type { QueuePriorityGrants } from '../src/modules/priority/domain/ports.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-24T02:00:00.000Z');
const DAY = 86_400_000;

let pg: PostgresContainer;
let database: Database;
let store: DrizzlePriorityGrantStore;

class Copies implements QueuePriorityGrants {
  readonly calls = new Map<string, number>();
  readonly failOnce = new Set<string>();

  async set(i: Parameters<QueuePriorityGrants['set']>[0]): Promise<{ changed: boolean }> {
    if (this.failOnce.delete(i.grantId)) throw new Error('queue down');
    this.calls.set(i.grantId, (this.calls.get(i.grantId) ?? 0) + 1);
    return { changed: true };
  }
}

const syncOf = (copies: Copies) =>
  new PriorityGrantSync({
    grants: store,
    copies,
    clock: { now: () => NOW },
    logger: { warn: () => undefined, error: () => undefined },
    signals: { sync: () => undefined, expire: () => undefined },
  });

async function createGrant(): Promise<string> {
  const g = await store.create({
    grantId: randomUUID(),
    eventId: randomUUID(),
    accountId: randomUUID(),
    fraudCaseId: randomUUID(),
    cancelledTicketId: randomUUID(),
    grantKind: 'SAME_SEAT',
    seatId: randomUUID(),
    tierId: 'R',
    price: 110_000,
    expiresAtMs: NOW + DAY,
    nowMs: NOW,
  });
  return g.grantId;
}

beforeAll(async () => {
  pg = await startPostgres();
  await migratePurchase(pg.url);
  database = createDatabase({ url: pg.url, profile: 'general', max: 8, applicationName: 'purchase-priority-cursor-int' });
  store = new DrizzlePriorityGrantStore(database);
}, 180_000);

// 앞 시험이 남긴 150행이 다음 시험의 목록 앞을 차지해 두 틱 안에 새 행이 오지 않는다(CI 실행 45250324076).
// 시험마다 표를 비워 각 시험이 자기 행만 본다.
beforeEach(async () => {
  await database.pool.query('delete from priority_grant');
});

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

describe('F-05-3 IR-03 대조 목록 진행 [GAT-135, S-T37 ⑯]', () => {
  test('S-T37 ⑯ 대조가 150행을 두 틱 안에 모두 보낸다(앞 100행만 반복하지 않는다)', async () => {
    const copies = new Copies();
    const ids: string[] = [];
    for (let i = 0; i < 150; i++) ids.push(await createGrant());

    const sync = syncOf(copies);
    await sync.runOnce();
    await sync.runOnce();

    expect(ids.filter((id) => !copies.calls.has(id))).toEqual([]);
    expect(copies.calls.size).toBe(150);
  }, 120_000);

  test('S-T37 ⑯ 실패한 행은 다음 틱에 다시 온다', async () => {
    const copies = new Copies();
    const ids = [await createGrant(), await createGrant(), await createGrant()];
    copies.failOnce.add(ids[0]!);

    const sync = syncOf(copies);
    await sync.runOnce();
    await sync.runOnce();

    expect(copies.calls.has(ids[0]!)).toBe(true);
    expect(ids.every((id) => copies.calls.has(id))).toBe(true);
  }, 60_000);
});
