// 보류 표 held_event(openspec 변경 add-maintenance-control-and-consumers 결정 6, ADR-0142 결정 2, docs/data.md §4의 15번, ST-T19·RB-11).
import { readFileSync } from 'node:fs';
import pg from 'pg';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  createDatabase,
  deleteReprocessedHeldEvents,
  drizzleHeldEventStore,
  fakeClock,
  heldEventCounts,
  reprocessHeldEvents,
  type ConsumedMessage,
  type Database,
  type HeldEventInput,
} from '../src/index.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pgc: PostgresContainer;
let database: Database;

beforeAll(async () => {
  pgc = await startPostgres();
  const admin = new pg.Client({ connectionString: pgc.url });
  await admin.connect();
  await admin.query(readFileSync(new URL('../template/migrations/0003_held_event_and_stat_snapshot.sql', import.meta.url), 'utf8'));
  await admin.end();
  database = createDatabase({ url: pgc.url, applicationName: 'held-it' });
}, 120_000);

afterAll(async () => {
  await database?.close();
  pgc?.stop();
});

const ev = (offset: number, key: string, eventKey: string | null = `${key}-${offset}`): HeldEventInput => ({
  topic: 'trade.payments',
  partition: 0,
  offset: BigInt(offset),
  eventKey,
  businessKey: key,
  error: 'Error: 상태 전이 불가',
  key: 'E1',
  timestamp: Date.parse('2026-11-01T00:00:00.000Z') + offset,
  value: Buffer.from(JSON.stringify({ order: key, offset })),
  headers: { traceparent: '00-0123456789abcdef0123456789abcdef-0123456789abcdef-01' },
});

test('ST_T19_보류행은같은위치나같은eventKey로두번넣지않고_보류중인키와수를알린다 [ASVS v5.0.0-14.2.4]', async () => {
  const clock = fakeClock();
  const store = drizzleHeldEventStore(database, clock);
  await store.hold(ev(1, 'A'));
  await store.hold(ev(1, 'A')); // 다시 받음(같은 위치)
  await store.hold({ ...ev(9, 'A'), eventKey: 'A-1' }); // 릴레이가 다시 보낸 같은 사건(다른 위치)
  await store.hold(ev(2, 'A'));
  await store.hold(ev(3, 'B', null));
  expect([...(await store.heldKeys('trade.payments', 0))].sort()).toEqual(['A', 'B']);
  expect(await store.heldKeys('trade.payments', 1)).toEqual(new Set());
  expect(await store.isHeld('trade.payments', 'A')).toBe(true);
  expect(await store.isHeld('trade.orders', 'A')).toBe(false);
  expect((await heldEventCounts(database)).get('trade.payments')).toBe(3);
  const row = (await database.pool.query("select value, headers, error from held_event where kafka_offset = 2")).rows[0] as { value: Buffer; headers: Record<string, string>; error: string };
  expect(JSON.parse(row.value.toString())).toEqual({ order: 'A', offset: 2 });
  expect(row.headers.traceparent).toMatch(/^00-/);
});

test('ST_T19_RB11_다시처리는업무키마다들어온순서대로하고_실패하면멈추며_끝나면보류가풀린다', async () => {
  const clock = fakeClock();
  const store = drizzleHeldEventStore(database, clock);
  for (const o of [12, 10, 11]) await store.hold({ ...ev(o, 'R'), topic: 'trade.orders' });
  const seen: bigint[] = [];
  let failAt: bigint | undefined = 11n;
  const handle = async (m: ConsumedMessage) => {
    if (m.offset === failAt) throw new Error('아직 고치지 않았다');
    seen.push(m.offset);
    expect(JSON.parse(m.value!.toString())).toMatchObject({ order: 'R' });
  };
  const first = await reprocessHeldEvents(database, clock, { topic: 'trade.orders', businessKey: 'R', handle });
  expect(first).toEqual({ reprocessed: 1, failed: { offset: 11n, error: 'Error: 아직 고치지 않았다' } });
  expect(await store.isHeld('trade.orders', 'R')).toBe(true);
  failAt = undefined;
  const second = await reprocessHeldEvents(database, clock, { topic: 'trade.orders', businessKey: 'R', handle });
  expect(second).toEqual({ reprocessed: 2 });
  expect(seen).toEqual([10n, 11n, 12n]);
  expect(await store.isHeld('trade.orders', 'R')).toBe(false);
  expect((await heldEventCounts(database)).get('trade.orders')).toBeUndefined();
});

test('ADR0142_결정2_다시처리한행은7일뒤에지운다', async () => {
  await database.pool.query('delete from held_event');
  const clock = fakeClock();
  const store = drizzleHeldEventStore(database, clock);
  await store.hold({ ...ev(1, 'Z'), topic: 'trade.seats' });
  await store.hold({ ...ev(2, 'Y'), topic: 'trade.seats' });
  await reprocessHeldEvents(database, clock, { topic: 'trade.seats', businessKey: 'Z', handle: async () => {} });
  clock.advance(7 * 24 * 60 * 60 * 1000 - 1);
  expect(await deleteReprocessedHeldEvents(database, clock)).toBe(0);
  clock.advance(2);
  expect(await deleteReprocessedHeldEvents(database, clock)).toBe(1);
  // 보류 중인 행은 지우지 않는다
  expect(await store.isHeld('trade.seats', 'Y')).toBe(true);
});

test('코드리뷰_ST_T19_holdIfHeld는보류중인키일때만넣고_보류행은Kafka키와레코드시각을다시처리에넘긴다', async () => {
  await database.pool.query('delete from held_event');
  const clock = fakeClock();
  const store = drizzleHeldEventStore(database, clock);
  // 보류 중이 아니면 넣지 않는다(다시 처리가 막 끝난 키)
  expect(await store.holdIfHeld({ ...ev(1, 'K'), topic: 'trade.orders' })).toBe(false);
  expect(await store.isHeld('trade.orders', 'K')).toBe(false);
  await store.hold({ ...ev(2, 'K'), topic: 'trade.orders' });
  expect(await store.holdIfHeld({ ...ev(3, 'K'), topic: 'trade.orders' })).toBe(true);
  const got: { offset: bigint; key: string | null; timestamp: number }[] = [];
  const r = await reprocessHeldEvents(database, clock, { topic: 'trade.orders', businessKey: 'K', handle: async (m) => void got.push({ offset: m.offset, key: m.key, timestamp: m.timestamp }) });
  expect(r).toEqual({ reprocessed: 2 });
  expect(got).toEqual([
    { offset: 2n, key: 'E1', timestamp: Date.parse('2026-11-01T00:00:00.002Z') },
    { offset: 3n, key: 'E1', timestamp: Date.parse('2026-11-01T00:00:00.003Z') },
  ]);
});

test('코드리뷰_다시처리중에새로보류된행도_끝내기전에잠금아래에서다시보고이어한다', async () => {
  await database.pool.query('delete from held_event');
  const clock = fakeClock();
  const store = drizzleHeldEventStore(database, clock);
  await store.hold({ ...ev(10, 'Q'), topic: 'trade.orders' });
  let raced = false;
  const seen: bigint[] = [];
  const r = await reprocessHeldEvents(database, clock, {
    topic: 'trade.orders',
    businessKey: 'Q',
    handle: async (m) => {
      seen.push(m.offset);
      // 실시간 소비자가 같은 키의 뒤 사건을 그사이 넣는다
      if (!raced) {
        raced = true;
        expect(await store.holdIfHeld({ ...ev(11, 'Q'), topic: 'trade.orders' })).toBe(true);
      }
    },
  });
  expect(r).toEqual({ reprocessed: 2 });
  expect(seen).toEqual([10n, 11n]);
  expect(await store.isHeld('trade.orders', 'Q')).toBe(false);
});
