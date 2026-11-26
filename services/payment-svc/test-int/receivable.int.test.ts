// F-07-15 I-01 payment 미수금 수동 전이의 실제 PostgreSQL 시험.
// 0034 마이그레이션(표·CHECK·색인·nullable statement_id·권한), Drizzle 조건부 갱신,
// receivable_action과 receivable_movement의 한 트랜잭션을 실제 DB로 본다.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createDatabase, fakeClock, type Database } from '@peaket/platform';
import { migratePayment } from '../scripts/migrate.mjs';
import { DrizzleSettlementStore } from '../src/modules/settlement/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

const NOW = Date.parse('2026-11-27T03:00:00.000Z');

let pgc: PostgresContainer;
let db: Database;
let store: DrizzleSettlementStore;

beforeAll(async () => {
  pgc = await startPostgres();
  await migratePayment(pgc.url);
  db = createDatabase({ url: pgc.url, profile: 'general', max: 4, applicationName: 'f0715-receivable' });
  store = new DrizzleSettlementStore(db, fakeClock({ now: NOW }));
}, 180_000);

afterAll(async () => {
  await db?.close();
  pgc?.stop();
});

const q = async <T extends Record<string, unknown>>(text: string, values: unknown[] = []) => (await db.pool.query<T>(text, values)).rows;

async function receivable(remaining = 445_000): Promise<{ receivableId: string; promoterId: string }> {
  const receivableId = randomUUID();
  const promoterId = randomUUID();
  await db.pool.query(
    "insert into partner_receivable (id, promoter_id, pg, cause, source_ref, amount, remaining, status, created_at, updated_at) values ($1, $2, null, 'COMPENSATION_ADVANCE', $3, $4, $4, 'OPEN', $5, $5)",
    [receivableId, promoterId, `f0715:${receivableId}`, remaining, new Date(NOW - 31 * 86_400_000)],
  );
  return { receivableId, promoterId };
}

const action = (o: { receivableId: string; promoterId: string; kind: 'BILLED' | 'COLLECTED' | 'WRITE_OFF'; amount: number; remainingAfter: number; key?: string }) => ({
  actionId: randomUUID(),
  idempotencyKey: o.key ?? `f0715-${randomUUID()}`,
  receivableId: o.receivableId,
  promoterId: o.promoterId,
  kind: o.kind,
  amount: o.amount,
  remainingAfter: o.remainingAfter,
  actor: 'commander-1',
  reason: 'F-07-15 PostgreSQL 통합 시험',
  createdAt: new Date(NOW),
});

describe('J-T11 ⑤ 미수금 수동 전이 [실제 PostgreSQL]', () => {
  test('J-T11 ⑤ 0034는 receivable_action 표·CHECK·색인과 statement_id nullable을 만든다', async () => {
    const cols = await q<{ column_name: string; is_nullable: string }>(
      "select column_name, is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'receivable_action' order by ordinal_position",
    );
    expect(cols.map((c) => c.column_name)).toEqual([
      'id',
      'idempotency_key',
      'receivable_id',
      'promoter_id',
      'kind',
      'amount',
      'remaining_after',
      'actor',
      'reason',
      'created_at',
    ]);
    const movement = await q<{ is_nullable: string }>(
      "select is_nullable from information_schema.columns where table_schema = 'public' and table_name = 'receivable_movement' and column_name = 'statement_id'",
    );
    expect(movement[0]?.is_nullable).toBe('YES');

    const checks = (await q<{ conname: string }>("select conname from pg_constraint where conrelid = 'receivable_action'::regclass and contype = 'c' order by conname")).map((r) => r.conname);
    expect(checks).toEqual(['receivable_action_amount_check', 'receivable_action_kind_check', 'receivable_action_reason_check']);
    const indexes = (await q<{ indexname: string }>("select indexname from pg_indexes where schemaname = 'public' and tablename = 'receivable_action' order by indexname")).map((r) => r.indexname);
    expect(indexes).toEqual(['receivable_action_key_uidx', 'receivable_action_pkey', 'receivable_action_receivable_idx']);

    // 별도 앱 롤을 만들지 않는다. 표 ACL은 소유자 기본값(null)이고 postgres 밖의 부여가 없다
    const acl = await q<{ acl: string | null }>("select relacl::text as acl from pg_class where oid = 'receivable_action'::regclass");
    expect(acl[0]?.acl).toBeNull();
    const grants = await q<{ grantee: string }>("select distinct grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = 'receivable_action' and grantee <> 'postgres'");
    expect(grants).toEqual([]);
  });

  test('J-T11 ⑤ 청구·회수는 action과 movement를 한 트랜잭션에 쓰고 조건부 갱신이 지난 행은 건너뛴다', async () => {
    const r = await receivable();
    const billed = action({ ...r, kind: 'BILLED', amount: 445_000, remainingAfter: 445_000 });
    const first = await store.applyReceivableActionAtomically({ action: billed, expectedStatus: 'OPEN', expectedRemaining: 445_000, nextRemaining: 445_000, nextStatus: 'BILLED', updatedAt: new Date(NOW) });
    expect(first?.action.actionId).toBe(billed.actionId);
    expect((await q<{ status: string; remaining: string }>('select status, remaining::text as remaining from partner_receivable where id = $1', [r.receivableId]))[0]).toEqual({ status: 'BILLED', remaining: '445000' });

    const collected = action({ ...r, kind: 'COLLECTED', amount: 100_000, remainingAfter: 345_000 });
    const second = await store.applyReceivableActionAtomically({
      action: collected,
      expectedStatus: 'BILLED',
      expectedRemaining: 445_000,
      nextRemaining: 345_000,
      nextStatus: 'BILLED',
      movement: { receivableId: r.receivableId, statementId: null, amount: 100_000, kind: 'COLLECTED', movedAt: new Date(NOW) },
      updatedAt: new Date(NOW),
    });
    expect(second?.receivable.remaining).toBe(345_000);
    expect(await q<{ kind: string; amount: string; statement_id: string | null }>('select kind, amount::text as amount, statement_id from receivable_movement where receivable_id = $1', [r.receivableId])).toEqual([{ kind: 'COLLECTED', amount: '100000', statement_id: null }]);
    expect(
      (await q<{ kind: string; remaining_after: string }>('select kind, remaining_after::text as remaining_after from receivable_action where receivable_id = $1', [r.receivableId])).sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual([
      { kind: 'BILLED', remaining_after: '445000' },
      { kind: 'COLLECTED', remaining_after: '345000' },
    ]);

    // 같은 키의 두 번째 호출은 action을 더하지 않는다(Drizzle이 이미 있는 키를 본다)
    const replay = await store.applyReceivableActionAtomically({ action: collected, expectedStatus: 'BILLED', expectedRemaining: 345_000, nextRemaining: 245_000, nextStatus: 'BILLED', updatedAt: new Date(NOW) });
    expect(replay).toBeUndefined();
    expect((await q<{ n: number }>('select count(*)::int as n from receivable_action where receivable_id = $1', [r.receivableId]))[0]?.n).toBe(2);

    // 조건부 갱신: 기대 remaining이 다르면 아무것도 쓰지 않는다
    const stale = action({ ...r, kind: 'WRITE_OFF', amount: 345_000, remainingAfter: 0 });
    const skipped = await store.applyReceivableActionAtomically({ action: stale, expectedStatus: 'BILLED', expectedRemaining: 1, nextRemaining: 0, nextStatus: 'WRITTEN_OFF', updatedAt: new Date(NOW) });
    expect(skipped).toBeUndefined();
    expect((await q<{ status: string; remaining: string }>('select status, remaining::text as remaining from partner_receivable where id = $1', [r.receivableId]))[0]).toEqual({ status: 'BILLED', remaining: '345000' });
    expect((await q<{ n: number }>('select count(*)::int as n from receivable_action where id = $1', [stale.actionId]))[0]?.n).toBe(0);
  });

  test('J-T11 ⑤ movement CHECK가 실패하면 action·상태가 함께 되돌아간다', async () => {
    const r = await receivable(70_000);
    const failed = action({ ...r, kind: 'WRITE_OFF', amount: 70_000, remainingAfter: 0 });
    await expect(
      store.applyReceivableActionAtomically({
        action: failed,
        expectedStatus: 'OPEN',
        expectedRemaining: 70_000,
        nextRemaining: 0,
        nextStatus: 'WRITTEN_OFF',
        // receivable_movement.amount > 0 CHECK를 일부러 어긴다
        movement: { receivableId: r.receivableId, statementId: null, amount: 0, kind: 'WRITE_OFF', movedAt: new Date(NOW) },
        updatedAt: new Date(NOW),
      }),
    ).rejects.toThrow();
    expect((await q<{ status: string; remaining: string }>('select status, remaining::text as remaining from partner_receivable where id = $1', [r.receivableId]))[0]).toEqual({ status: 'OPEN', remaining: '70000' });
    expect((await q<{ n: number }>('select count(*)::int as n from receivable_action where id = $1', [failed.actionId]))[0]?.n).toBe(0);
    expect((await q<{ n: number }>('select count(*)::int as n from receivable_movement where receivable_id = $1', [r.receivableId]))[0]?.n).toBe(0);
  });
});
