// 정비 잡(openspec 변경 add-maintenance-control-and-consumers 결정 11~14·16, ADR-0086 결정 4·7, ADR-0114 결정 3, data.md §2) — 실제 PostgreSQL 18.
import { readFileSync } from 'node:fs';
import { Registry } from '@prometheus-io/client';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  MaintenanceRunner,
  createDatabase,
  deleteExpiredRows,
  dropMonthlyPartitions,
  ensureMonthlyPartitions,
  fakeClock,
  maintenanceMetrics,
  monthlyPartitionTasks,
  monthlyPartitionsAhead,
  platformMaintenanceTasks,
  reindexBloatedIndexes,
  retentionOverdueSeconds,
  retentionTask,
  takeStatSnapshot,
  uuidLowerBound,
  type Database,
  type RetentionSpec,
} from '../src/index.js';
import { sample } from '../test/fixture.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pgc: PostgresContainer;
let database: Database;
const q = async <R = Record<string, unknown>>(text: string, values: unknown[] = []) => (await database.pool.query(text, values)).rows as R[];
const KST = (iso: string) => Date.parse(`${iso}+09:00`);
const DAY = 86_400_000;

beforeAll(async () => {
  pgc = await startPostgres();
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  for (const f of ['0001_idempotency_record.sql', '0002_outbox.sql', '0003_held_event_and_stat_snapshot.sql']) await admin.query(readFileSync(new URL(`../template/migrations/${f}`, import.meta.url), 'utf8'));
  await admin.query(`
    CREATE TABLE scan_event (event_id uuid NOT NULL, id uuid NOT NULL, gate text, PRIMARY KEY (event_id, id)) PARTITION BY RANGE (event_id);
    CREATE TABLE notification_delivery (dedup_key text NOT NULL, sent_at timestamptz NOT NULL, PRIMARY KEY (dedup_key, sent_at)) PARTITION BY RANGE (sent_at);
    CREATE TABLE purchase_order (id uuid PRIMARY KEY);
    CREATE TABLE order_item (order_id uuid NOT NULL REFERENCES purchase_order (id), line_no int NOT NULL, PRIMARY KEY (order_id, line_no));
    CREATE INDEX order_item_order_idx ON order_item (order_id);`);
  await admin.end();
  database = createDatabase({ url: pgc.url, applicationName: 'maintenance-it' });
}, 120_000);

afterAll(async () => {
  await database?.close();
  pgc?.stop();
});

const scan = { table: 'scan_event', key: 'uuidv7' as const };

describe('ADR0086 결정4 월 파티션', () => {
  test('ADR0086_회차ID범위월파티션은_이번달부터3개월뒤까지_첫파티션포함_한번씩만생기고_부모를ANALYZE한다', async () => {
    const clock = fakeClock({ now: KST('2026-11-15T10:00:00') });
    const first = await ensureMonthlyPartitions(database, clock, scan);
    expect(first.created).toEqual(['scan_event_p202611', 'scan_event_p202612', 'scan_event_p202701', 'scan_event_p202702']);
    expect((await ensureMonthlyPartitions(database, clock, scan)).created).toEqual([]);
    expect(await monthlyPartitionsAhead(database, clock, scan)).toBe(3);
    // 그달 1일 0시(KST) 경계의 회차 ID는 그달 파티션에 든다
    const at = (ms: number) => `${uuidLowerBound(ms).slice(0, 24)}00000000000${Math.floor(Math.random() * 9)}`;
    await q(`insert into scan_event (event_id, id) values ($1, gen_random_uuid()), ($2, gen_random_uuid())`, [at(KST('2026-11-30T23:59:59')), at(KST('2026-12-01T00:00:00'))]);
    const parts = await q<{ p: string }>(`select tableoid::regclass::text as p from scan_event order by event_id`);
    expect(parts.map((r) => r.p)).toEqual(['scan_event_p202611', 'scan_event_p202612']);
    const metrics = maintenanceMetrics(new Registry(), 'it-svc');
    const [daily] = monthlyPartitionTasks(database, clock, scan, async () => false, metrics);
    await daily!.run();
    expect(await q(`select 1 from pg_stats where tablename = 'scan_event' and inherited`)).not.toHaveLength(0);
    expect((await metrics.partitionsAhead.get()).values[0]?.value).toBe(3);
  });

  test('발송 시각(timestamptz) 월 파티션은 한국 시각 1일 0시로 나뉜다', async () => {
    const clock = fakeClock({ now: KST('2026-11-15T10:00:00') });
    await ensureMonthlyPartitions(database, clock, { table: 'notification_delivery', key: 'timestamptz' });
    await q(`insert into notification_delivery values ('a', '2026-11-30T23:59:59+09:00'), ('b', '2026-12-01T00:00:00+09:00'), ('c', '2026-11-30T15:00:00Z')`);
    const parts = await q<{ k: string; p: string }>(`select dedup_key as k, tableoid::regclass::text as p from notification_delivery order by dedup_key`);
    expect(parts).toEqual([
      { k: 'a', p: 'notification_delivery_p202611' },
      { k: 'b', p: 'notification_delivery_p202612' },
      { k: 'c', p: 'notification_delivery_p202612' },
    ]);
  });

  test('ADR0086_지우기는정비시간에만_조건을만족한지난파티션만하고_가리키는행이남으면실패로남긴다', async () => {
    await q(`CREATE TABLE gate_ref (id uuid PRIMARY KEY, event_id uuid NOT NULL, scan_id uuid NOT NULL, FOREIGN KEY (event_id, scan_id) REFERENCES scan_event (event_id, id))`);
    const ref = (await q<{ event_id: string; id: string }>(`select event_id, id from scan_event where tableoid = 'scan_event_p202612'::regclass limit 1`))[0]!;
    await q(`insert into gate_ref values (gen_random_uuid(), $1, $2)`, [ref.event_id, ref.id]);
    // 이번 달과 앞 달 파티션은 조건이 참이어도 지우지 않는다
    const sameMonth = await dropMonthlyPartitions(database, fakeClock({ now: KST('2026-11-16T04:30:00') }), scan, async () => true);
    expect(sameMonth).toEqual({ dropped: [], blocked: [], failed: [] });
    const outside = fakeClock({ now: KST('2027-03-10T03:59:00') });
    expect((await dropMonthlyPartitions(database, outside, scan, async () => true)).skipped).toBe('outside-window');
    const inWindow = fakeClock({ now: KST('2027-03-10T04:30:00') });
    const r = await dropMonthlyPartitions(database, inWindow, scan, async (p) => p.name !== 'scan_event_p202702');
    expect(r.dropped).toEqual(['scan_event_p202611', 'scan_event_p202701']);
    expect(r.failed).toEqual(['scan_event_p202612']);
    expect(r.blocked).toEqual(['scan_event_p202702']);
    const left = await q<{ n: string }>(`select c.relname as n from pg_class c where c.relname like 'scan_event_p%' and c.relkind = 'r' order by 1`);
    expect(left.map((x) => x.n)).toEqual(['scan_event_p202612', 'scan_event_p202702']);
  });
});

test('ADR0086_결정7_통계스냅샷은하루한벌을남기고_90일지난것을지운다', async () => {
  const clock = fakeClock({ now: KST('2026-11-15T10:00:00') });
  const a = await takeStatSnapshot(database, clock);
  expect(a.taken).toBe(true);
  expect(a.rows).toBeGreaterThan(0);
  expect((await takeStatSnapshot(database, clock)).taken).toBe(false);
  const rows = await q<{ kind: string; relname: string; indexrelname: string }>(`select kind, relname, indexrelname from stat_snapshot where relname = 'purchase_order'`);
  expect(rows.map((r) => r.kind).sort()).toEqual(['index', 'table']);
  clock.advance(DAY);
  expect((await takeStatSnapshot(database, clock)).taken).toBe(true);
  clock.advance(90 * DAY);
  const c = await takeStatSnapshot(database, clock);
  expect(c.deleted).toBe(a.rows);
});

describe('ADR0114 결정3 보존 나눠 지우기', () => {
  const spec: RetentionSpec = { table: 'purchase_order', children: [{ table: 'order_item', column: 'order_id' }], retentionMs: 5 * 365 * DAY };
  const now = KST('2031-11-15T04:30:00');
  // 그 밀리초의 UUIDv7 모양 ID(판 7, 변형 8)
  const orderAt = (ms: number) => `${uuidLowerBound(ms).slice(0, 14)}7000-8${Math.random().toString(16).slice(2, 5).padEnd(3, '0')}-${Math.random().toString(16).slice(2, 14).padEnd(12, '0')}`;
  const seed = async (expired: number, fresh: number) => {
    const ids: string[] = [];
    for (let i = 0; i < expired; i += 1) ids.push(orderAt(now - spec.retentionMs - (i + 1) * 60_000));
    for (let i = 0; i < fresh; i += 1) ids.push(orderAt(now - spec.retentionMs + (i + 1) * 60_000));
    for (const id of ids) {
      await q(`insert into purchase_order values ($1)`, [id]);
      await q(`insert into order_item values ($1, 1), ($1, 2)`, [id]);
    }
  };

  test('ADR0114_기한이지난행은묶음마다자식먼저지우고_묶음사이에쉬며_기한전행은남긴다 [ASVS v5.0.0-15.2.2]', async () => {
    await seed(25, 5);
    const clock = fakeClock({ now });
    const sleeps: number[] = [];
    const r = await deleteExpiredRows(database, clock, spec, { batchSize: 10, sleep: async (ms) => void sleeps.push(ms) });
    expect(r).toEqual({ deleted: 25, batches: 3, stopped: 'done' });
    expect(sleeps).toEqual([500, 500]);
    expect((await q<{ n: number }>(`select count(*)::int as n from purchase_order`))[0]!.n).toBe(5);
    expect((await q<{ n: number }>(`select count(*)::int as n from order_item`))[0]!.n).toBe(10);
    expect(await retentionOverdueSeconds(database, clock, spec)).toBe(0);
    await q(`delete from order_item; delete from purchase_order`);
  });

  test('ADR0114_지키는선이멈추면그날밤은멈추고_다못지움지표가1이며_정비시간밖에서는하지않는다 [ASVS v5.0.0-15.2.2]', async () => {
    await seed(25, 0);
    const clock = fakeClock({ now });
    let calls = 0;
    const metrics = maintenanceMetrics(new Registry(), 'it-svc');
    const task = retentionTask(database, clock, spec, { batchSize: 10, metrics, guard: async () => (calls++ === 0 ? undefined : '읽기 복제본 지연 1.4초') });
    await expect(task.run()).rejects.toThrow(/guard: 읽기 복제본 지연 1\.4초/);
    expect((await q<{ n: number }>(`select count(*)::int as n from purchase_order`))[0]!.n).toBe(15);
    expect((await metrics.retentionIncomplete.get()).values[0]?.value).toBe(1);
    expect((await metrics.retentionOverdue.get()).values[0]?.value).toBeGreaterThan(0);
    const outside = fakeClock({ now: now - 2 * 60 * 60_000 });
    expect(await deleteExpiredRows(database, outside, spec)).toEqual({ deleted: 0, batches: 0, stopped: 'window' });
    await q(`delete from order_item; delete from purchase_order`);
  });
});

test('ADR0114_결정3_부푼인덱스는REINDEX_CONCURRENTLY하고_pgstattuple이없으면건너뛴다', async () => {
  await q(`CREATE TABLE bloat_t (id bigint PRIMARY KEY, v int)`);
  await q(`insert into bloat_t select g, g from generate_series(1, 200000) g`);
  expect(await reindexBloatedIndexes(database, { tables: ['bloat_t'], minBytes: 0 })).toEqual({ reindexed: [], checked: 0, skipped: 'pgstattuple-missing' });
  await q(`CREATE EXTENSION pgstattuple`);
  await q(`delete from bloat_t where v % 10 <> 0`);
  await q(`vacuum bloat_t`);
  const first = await reindexBloatedIndexes(database, { tables: ['bloat_t'], minBytes: 0 });
  expect(first.reindexed).toEqual(['bloat_t_pkey']);
  expect((await reindexBloatedIndexes(database, { tables: ['bloat_t'], minBytes: 0 })).reindexed).toEqual([]);
  // 작은 인덱스는 보지 않는다(기본 8MiB)
  expect((await reindexBloatedIndexes(database, { tables: ['bloat_t'] })).checked).toBe(0);
});

test('결정16_정비반복은리더가매일일과정비시간일을한번씩하고_지표를낸다', async () => {
  const clock = fakeClock({ now: KST('2026-11-16T04:30:00') });
  const registry = new Registry();
  const runner = new MaintenanceRunner({ service: 'it-svc', clock, leader: { isLeader: () => true }, tasks: platformMaintenanceTasks(database, clock), registry });
  const t = await runner.tick();
  expect(t.failed).toEqual([]);
  expect(t.ran).toEqual(['outbox-partitions-ensure', 'outbox-partitions-drop', 'idempotency-records-delete', 'held-events-delete', 'stat-snapshot']);
  expect((await runner.tick()).ran).toEqual([]);
  expect(sample(await registry.metrics(), 'maintenance_task_last_success_timestamp_seconds', { service: 'it-svc', task: 'outbox-partitions-ensure' })).toBe(Math.floor(clock.now() / 1000));
});
