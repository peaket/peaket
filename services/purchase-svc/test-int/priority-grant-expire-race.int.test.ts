// F-05-3 IR-02 재현·회귀: expireDue가 늦게 잠금을 얻어도 동시 주문의 active_order_id를 덮지 않는다(GAT-135, S-T37 ⑮, ADR-0385).
// 두 세션: A가 active_order_id를 커밋하지 않은 채 잡고, B(expireDue)가 잠금을 기다린다. A가 커밋하면
// 고친 UPDATE는 같은 조건(status OFFERED·active null)을 다시 보고 0행, 결제 승인 USED 기록은 1행이어야 한다.
import { randomUUID } from 'node:crypto';
import { createDatabase, type Database } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzlePriorityGrantStore } from '../src/modules/priority/adapters/db/drizzle-priority-grant-store.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const NOW = Date.parse('2026-11-24T02:00:00.000Z');
const HOUR = 3600_000;

let pg: PostgresContainer;
let database: Database;
let store: DrizzlePriorityGrantStore;

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
    expiresAtMs: NOW - 1,
    nowMs: NOW,
  });
  return g.grantId;
}

/** expireDue의 UPDATE가 행 잠금을 기다리는 상태가 될 때까지 기다린다(고정 대기 없이 pg_locks로 본다) */
async function waitForWaitingLock(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    const r = await database.pool.query('select 1 from pg_locks where not granted limit 1');
    if ((r.rowCount ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('expireDue가 행 잠금을 기다리는 상태가 되지 않았다');
}

beforeAll(async () => {
  pg = await startPostgres();
  await migratePurchase(pg.url);
  database = createDatabase({ url: pg.url, profile: 'general', max: 8, applicationName: 'purchase-priority-expire-race-int' });
  store = new DrizzlePriorityGrantStore(database);
}, 180_000);

afterAll(async () => {
  await database?.close();
  pg?.stop();
});

describe('F-05-3 IR-02 expireDue 동시 주문 덮어쓰기 [GAT-135, S-T37 ⑮]', () => {
  test('S-T37 ⑮ expireDue가 늦게 잠금을 얻어도 active_order_id를 덮지 않고, 결제 승인 USED가 1행 남는다', async () => {
    const grantId = await createGrant();
    const orderId = randomUUID();
    const a = await database.pool.connect();
    try {
      await a.query('begin');
      await a.query('update priority_grant set active_order_id = $2 where id = $1', [grantId, orderId]);

      const pending = store.expireDue(NOW, 100);
      await waitForWaitingLock();
      await a.query('commit');

      const due = await pending;
      // 고친 꼴: 늦게 잠금을 얻은 UPDATE는 같은 조건을 다시 보아 0행이고, 주문 표시가 살아 있다
      expect(due).toHaveLength(0);
      expect(await store.find(grantId)).toMatchObject({ status: 'OFFERED', activeOrderId: orderId });

      // 결제 승인 USED 기록이 0행이 되지 않는다(같은 트랜잭션 밖에서 조건부 UPDATE로 확인)
      const used = await database.pool.query(
        `update priority_grant set status = 'USED', active_order_id = null, used_order_id = $2, version = version + 1
         where id = $1 and status = 'OFFERED' and active_order_id = $2`,
        [grantId, orderId],
      );
      expect(used.rowCount).toBe(1);
      expect((await store.find(grantId))?.status).toBe('USED');
    } finally {
      await a.query('rollback').catch(() => undefined);
      a.release();
    }
  });
});
