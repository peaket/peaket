// Outbox 쓰기·폴링 릴레이·일 파티션의 실제 PostgreSQL 시험(openspec 변경 add-idempotency-and-outbox 결정 7~11, ADR-0116·0083·0143, V-T28 로컬 부분).
import { readFileSync } from 'node:fs';
import { Registry } from '@prometheus-io/client';
import { sql } from 'drizzle-orm';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import {
  CONTROL_TOPICS,
  OutboxRelay,
  OutboxRelayMetrics,
  createDatabase,
  dropExpiredOutboxPartitions,
  ensureOutboxPartitions,
  fakeClock,
  outboxHealth,
  outboxPartitionOf,
  kstDayStart,
  writeOutbox,
  type Database,
  type FakeClock,
  type OutboxPublisher,
  type OutboxRecord,
} from '../src/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

const MIGRATION = readFileSync(new URL('../template/migrations/0002_outbox.sql', import.meta.url), 'utf8');
const KST = (s: string) => Date.parse(`${s}+09:00`);
const DAY = 24 * 60 * 60 * 1000;

let pgc: PostgresContainer;
let relayDb: Database;
let partsDb: Database;

beforeAll(async () => {
  pgc = await startPostgres();
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  await admin.query('create database parts');
  await admin.query(MIGRATION);
  await admin.end();
  const partsUrl = pgc.url.replace(/\/peaket$/, '/parts');
  const parts = new pg.Client({ connectionString: partsUrl });
  await parts.connect();
  await parts.query(MIGRATION);
  await parts.end();
  relayDb = createDatabase({ url: pgc.url, applicationName: 'outbox-int' });
  partsDb = createDatabase({ url: partsUrl, applicationName: 'outbox-parts-int' });
  await ensureOutboxPartitions(relayDb, fakeClock({ now: KST('2026-11-01T12:00:00') }));
}, 120_000);

afterAll(async () => {
  await relayDb?.close();
  await partsDb?.close();
  pgc?.stop();
});

/** 받은 묶음을 적어 두는 보내기 포트 */
function recorder(o: { fail?: () => boolean; hold?: Promise<void> } = {}) {
  const batches: OutboxRecord[][] = [];
  const publisher: OutboxPublisher = {
    async publish(records) {
      if (o.fail?.()) throw new Error('브로커 없음');
      await o.hold;
      batches.push([...records]);
    },
  };
  return { publisher, batches, keys: () => batches.flat().map((r) => r.key) };
}

function relayWith(clock: FakeClock, publisher: OutboxPublisher, registry = new Registry()) {
  const metrics = new OutboxRelayMetrics(registry, 'purchase-svc');
  return { relay: new OutboxRelay({ database: relayDb, publisher, leader: { isLeader: () => true }, clock, metrics }), registry };
}

const rows = async (db: Database) =>
  (await db.db.execute(sql`select id::text, seq::text, topic, msg_key, sent_at from outbox order by outbox.seq`)).rows as { id: string; seq: string; topic: string; msg_key: string; sent_at: string | null }[];
const msg = (key: string, topic = 'trade.orders') => ({ topic, key, payload: Buffer.from(`p-${key}`), headers: { traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` } });

describe('쓰기와 릴레이', () => {
  const clock = fakeClock({ now: KST('2026-11-01T12:00:00') });
  beforeEach(async () => {
    await relayDb.db.execute(sql`delete from outbox`);
  });

  test('FND080_되돌린트랜잭션의Outbox행은_나가지않는다', async () => {
    await expect(
      relayDb.transaction(async (tx) => {
        await writeOutbox(tx, clock, [msg('k-1')]);
        throw new Error('업무 실패');
      }),
    ).rejects.toThrow('업무 실패');
    const r = recorder();
    expect(await relayWith(clock, r.publisher).relay.relayOnce()).toBe(0);
    expect(r.batches).toEqual([]);
  });

  test('FND110_V-T28_자릿수가다른seq가한묶음에섞여도_글자순이아니라숫자순으로보낸다', async () => {
    // 재현: 질의가 seq를 글자로 바꾼 이름으로 정렬해 '10'이 '2'보다 먼저 나갔다(BUILD_ORDER FND-110에서 찾음)
    // 앞 시험의 실행 순서에 기대지 않게 번호가 9에서 시작해 한 자리에서 두 자리로 넘어가게 한다(코드 리뷰 2026-11-01)
    await relayDb.db.execute(sql`select setval('outbox_seq', 8)`);
    for (let i = 0; i < 12; i++) await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg(`k-${i}`)]));
    const r = recorder();
    expect(await relayWith(clock, r.publisher).relay.relayOnce()).toBe(12);
    const seqs = r.batches[0]!.map((x) => BigInt(x.seq));
    expect(seqs).toEqual([...seqs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    expect(r.keys()).toEqual(Array.from({ length: 12 }, (_, i) => `k-${i}`));
  });

  test('FND080_커밋한사건을_seq순서로키값머리그대로보내고_보낸시각을적는다', async () => {
    const ids = await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg('k-1'), msg('k-2')]));
    await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg('k-3')]));
    expect(ids).toHaveLength(2);
    const r = recorder();
    clock.advance(50);
    const { relay } = relayWith(clock, r.publisher);
    expect(await relay.relayOnce()).toBe(3);
    expect(r.keys()).toEqual(['k-1', 'k-2', 'k-3']);
    const first = r.batches[0]![0]!;
    expect(first).toMatchObject({ topic: 'trade.orders', key: 'k-1', headers: { traceparent: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01` } });
    expect(Buffer.from(first.payload).toString()).toBe('p-k-1');
    const after = await rows(relayDb);
    expect(after.every((x) => x.sent_at !== null && new Date(x.sent_at).getTime() === clock.now())).toBe(true);
    expect(after.map((x) => Number(x.seq))).toEqual([...after.map((x) => Number(x.seq))].sort((a, b) => a - b));
    expect(await relay.relayOnce()).toBe(0);
  });

  test('FND080_보내기에실패하면_행이남아_다음묶음에서다시나간다 [ASVS v5.0.0-16.5.2]', async () => {
    await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg('k-1'), msg('k-2')]));
    let down = true;
    const r = recorder({ fail: () => down });
    const { relay } = relayWith(clock, r.publisher);
    await expect(relay.relayOnce()).rejects.toThrow('브로커 없음');
    expect((await rows(relayDb)).every((x) => x.sent_at === null)).toBe(true);
    down = false;
    expect(await relay.relayOnce()).toBe(2);
    expect(r.keys()).toEqual(['k-1', 'k-2']);
  });

  test('FND080_다른릴레이가잡은앞묶음을_건너뛰지않고기다렸다가_그뒤의행만보낸다', async () => {
    await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg('k-1'), msg('k-2'), msg('k-3')]));
    let releaseA!: () => void;
    let enteredA!: () => void;
    const aEntered = new Promise<void>((r) => (enteredA = r));
    const aHeld = new Promise<void>((r) => (releaseA = r));
    const events: string[] = [];
    const a: OutboxPublisher = {
      async publish(records) {
        enteredA();
        await aHeld;
        events.push(`A:${records.map((x) => x.key).join(',')}`);
      },
    };
    const b: OutboxPublisher = {
      async publish(records) {
        events.push(`B:${records.map((x) => x.key).join(',')}`);
      },
    };
    const ra = relayWith(clock, a).relay.relayOnce();
    await aEntered;
    await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg('k-4'), msg('k-5')]));
    const rb = relayWith(clock, b).relay.relayOnce();
    await new Promise((r) => setTimeout(r, 300));
    // B는 A가 잡은 앞 묶음의 잠금을 기다린다(SKIP LOCKED를 쓰지 않는다)
    expect(events).toEqual([]);
    releaseA();
    expect(await Promise.all([ra, rb])).toEqual([3, 2]);
    expect(events).toEqual(['A:k-1,k-2,k-3', 'B:k-4,k-5']);
  });

  test('FND080_제어사건도같은Outbox로_주제와키그대로순서대로나간다', async () => {
    await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg('sess-1', CONTROL_TOPICS.sessionsTerminated)]));
    await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg('queue.entry-rate', CONTROL_TOPICS.settings), msg('sess-2', CONTROL_TOPICS.sessionsTerminated)]));
    const r = recorder();
    await relayWith(clock, r.publisher).relay.relayOnce();
    expect(r.batches.flat().map((x) => `${x.topic}/${x.key}`)).toEqual([
      'control.sessions-terminated/sess-1',
      'control.settings/queue.entry-rate',
      'control.sessions-terminated/sess-2',
    ]);
  });

  test('FND080_지연은_가장오래기다린보내지않은행의나이이고_파티션지표와함께잰다', async () => {
    await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg('k-1')]));
    clock.advance(10_000);
    await relayDb.transaction((tx) => writeOutbox(tx, clock, [msg('k-2')]));
    const r = recorder();
    const { relay, registry } = relayWith(clock, r.publisher);
    await relay.measure();
    const json = await registry.getMetricsAsJSON();
    const v = (n: string) => (json.find((x) => x.name === n) as { values: { value: number }[] }).values[0]!.value;
    expect(v('outbox_relay_lag_seconds')).toBe(10);
    expect(v('outbox_partitions_ahead_days')).toBe(7);
    expect(v('outbox_partitions_overdue')).toBe(0);
    expect(v('outbox_relay_is_leader')).toBe(1);
    await relay.relayOnce();
    await relay.measure();
    const after = await registry.getMetricsAsJSON();
    expect((after.find((x) => x.name === 'outbox_relay_lag_seconds') as { values: { value: number }[] }).values[0]!.value).toBe(0);
  });
});

describe('일 파티션', () => {
  const partitions = async () =>
    (
      await partsDb.db.execute(sql`
        select c.relname as name, pg_get_expr(c.relpartbound, c.oid) as bound
        from pg_inherits i join pg_class c on c.oid = i.inhrelid
        where i.inhparent = 'outbox'::regclass order by c.relname`)
    ).rows as { name: string; bound: string }[];

  test('FND080_오늘부터7일뒤까지_여덟파티션을한번씩만만들고_경계는그날0시KST의UUID다', async () => {
    const clock = fakeClock({ now: KST('2026-11-01T12:00:00') });
    const first = await ensureOutboxPartitions(partsDb, clock);
    expect(first.created).toEqual(Array.from({ length: 8 }, (_, i) => outboxPartitionOf(KST('2026-11-01T00:00:00') + i * DAY).name));
    expect((await ensureOutboxPartitions(partsDb, clock)).created).toEqual([]);
    const p = (await partitions()).find((x) => x.name === 'outbox_p20261101')!;
    const want = outboxPartitionOf(kstDayStart(clock.now()));
    expect(p.bound).toBe(`FOR VALUES FROM ('${want.from}') TO ('${want.to}')`);
    // 기본 파티션이 없으므로 범위 밖 ID는 들어가지 않는다
    await expect(partsDb.transaction((tx) => writeOutbox(tx, fakeClock({ now: KST('2026-11-09T00:00:00') }), [msg('late')]))).rejects.toThrow();
    // 붙인 파티션에 기본 키와 보내지 않은 행 부분 인덱스가 있다
    const idx = (await partsDb.db.execute(sql`select indexdef from pg_indexes where tablename = 'outbox_p20261101' order by indexname`)).rows as { indexdef: string }[];
    expect(idx.map((x) => x.indexdef).join('\n')).toMatch(/UNIQUE INDEX .* \(id\)[\s\S]*\(seq\) WHERE \(sent_at IS NULL\)/);
  });

  test('FND080_정비시간에3일지난파티션을지우되_보내지않은행이남은파티션은남긴다 [ASVS v5.0.0-16.5.2]', async () => {
    await partsDb.transaction((tx) => writeOutbox(tx, fakeClock({ now: KST('2026-11-02T10:00:00') }), [msg('unsent')]));
    await partsDb.transaction((tx) => writeOutbox(tx, fakeClock({ now: KST('2026-11-03T10:00:00') }), [msg('sent')]));
    await partsDb.db.execute(sql`update outbox set sent_at = now() where msg_key = 'sent'`);
    const outside = await dropExpiredOutboxPartitions(partsDb, fakeClock({ now: KST('2026-11-11T12:00:00') }));
    expect(outside).toEqual({ dropped: [], blocked: [], failed: [], skipped: 'outside-window' });
    const clock = fakeClock({ now: KST('2026-11-11T04:30:00') });
    // 코드 리뷰 2026-11-01: 떼어 낸 뒤 DROP이 실패한 표는 부모 목록에서 빠져 다시 지우지도 지표에 잡히지도 않았다
    await partsDb.db.execute(sql`alter table outbox detach partition outbox_p20261104`);
    expect((await outboxHealth(partsDb, clock)).overdue).toBe(6);
    const r = await dropExpiredOutboxPartitions(partsDb, clock);
    expect(r.blocked).toEqual(['outbox_p20261102']);
    expect(r.failed).toEqual([]);
    expect(r.dropped).toEqual(['outbox_p20261101', 'outbox_p20261103', 'outbox_p20261104', 'outbox_p20261105', 'outbox_p20261106', 'outbox_p20261107']);
    expect((await partitions()).map((x) => x.name)).toEqual(['outbox_p20261102', 'outbox_p20261108']);
    const left = (await partsDb.db.execute(sql`select count(*)::int as n from pg_class where relname = 'outbox_p20261103'`)).rows[0] as { n: number };
    expect(left.n).toBe(0);
    // 막힌 파티션은 지울 날에서 하루 더 지나도 남아 지표가 알린다. 미리 만든 날은 없다
    expect(await outboxHealth(partsDb, clock)).toMatchObject({ aheadDays: 0, overdue: 1 });
  });
});
