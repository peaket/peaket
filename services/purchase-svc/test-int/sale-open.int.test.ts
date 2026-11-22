// 내부 판매 열기·UPCOMING·오픈 경계·장애 주입(S-T41 ⑦⑨, BAT-616 LCH-080, ADR-0122·0327).
// 실제 PostgreSQL 18·Valkey 8.1에서 event_sale·seat_rebuild·비트맵·세대 키·Outbox를 직접 읽고, 판정 틱으로 오픈 전후를 가른다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type Database, createDatabase, createHotRedis, ensureOutboxPartitions, fakeClock, type HotRedis, PlatformMetrics } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleSalePaying } from '../src/modules/booking/index.js';
import {
  DrizzleEventSale,
  DrizzleSeatRebuildSource,
  InternalSaleOpenController,
  MemorySeatMap,
  OpenSale,
  OpenSaleError,
  PromSaleStateSignals,
  RedisSaleCounts,
  RedisSeatStore,
  RedisSweepLeases,
  SALE_NOT_PUBLISHABLE,
  SaleStateJudge,
  type SaleEventReport,
  SEAT_STORE_UNAVAILABLE,
  SeatStoreUnavailable,
} from '../src/modules/inventory/index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const SEAT_COUNT = 137;
const DAY = 86_400_000;
const TOPIC = 'trade.seats';
// 판매 열기·판정 시계는 실행 시각에서 잡는다. 고정 날짜를 쓰면 그날이 지나 '판매 종료(시작 24시간 전)' 검사에 걸린다
const BASE = Date.now() + 7 * DAY;

let pg: PostgresContainer;
let valkey: ValkeyContainer;
let database: Database;
let admin: Database;
let redis: HotRedis;
let seatStore: RedisSeatStore;
let sale: DrizzleEventSale;
let rebuild: DrizzleSeatRebuildSource;

beforeAll(async () => {
  const [p, v] = await Promise.allSettled([startPostgres(), startValkey()]);
  if (p.status === 'rejected') throw p.reason as Error;
  if (v.status === 'rejected') throw v.reason as Error;
  pg = p.value;
  valkey = v.value;
  await migratePurchase(pg.url);
  database = createDatabase({ url: pg.url, profile: 'general', max: 20, applicationName: 'purchase-sale-open-test' });
  admin = createDatabase({ url: pg.url, profile: 'general', max: 4, applicationName: 'purchase-sale-open-admin' });
  await ensureOutboxPartitions(admin, fakeClock({ now: Date.now() }), { daysAhead: 40 });
  redis = await createHotRedis({ url: valkey.url });
  seatStore = new RedisSeatStore(redis);
  sale = new DrizzleEventSale({ database, clock: fakeClock({ now: Date.now() }) });
  rebuild = new DrizzleSeatRebuildSource(database);
}, 240_000);

afterAll(async () => {
  await Promise.allSettled([redis?.close(), database?.close(), admin?.close()]);
  valkey?.stop();
  pg?.stop();
});

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const cmd = (key: string, args: string[]) => redis.command(args, { key });
const hashOf = (v: unknown): Record<string, string> => {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  if (Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = String(v[i + 1]);
    return o;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [String(k), String(x)]));
  return {};
};

interface World {
  eventId: string;
  clock: ReturnType<typeof fakeClock>;
  openAt: number;
  startsAt: number;
  seatMap: MemorySeatMap;
  open: OpenSale;
  judge: SaleStateJudge;
}

/** 회차 하나와 그 판. openAt·startsAt은 epoch ms이고 판매 종료는 시작 24시간 전이다 */
function world(o: { openAt: number; startsAt: number; seats?: number; saleEndsAtMs?: number; noLayout?: boolean; seatsOverride?: { openSale: () => Promise<never> } }): World {
  const eventId = randomUUID();
  const clock = fakeClock({ now: o.openAt - 1 });
  const seatMap = new MemorySeatMap();
  const seatCount = o.seats ?? SEAT_COUNT;
  if (!o.noLayout) {
    const seats = Array.from({ length: seatCount }, (_, i) => ({
      seatId: `S${String(i).padStart(4, '0')}`,
      index: i,
      sectionIndex: 0,
      sectionId: 'SEC-A',
      seatOffset: i,
      tierId: 'R',
    }));
    seatMap.put({ eventId, layoutVersion: 'v1', seatCount, perAccountLimit: 4, saleEndsAtMs: o.saleEndsAtMs ?? o.startsAt - DAY }, seats);
  }
  const seats = o.seatsOverride ?? seatStore;
  const open = new OpenSale({ events: sale, marks: rebuild, seats, seatMap, clock });
  const metrics = new PlatformMetrics('purchase-svc');
  const signals = new PromSaleStateSignals().register(metrics.registry);
  const judge = new SaleStateJudge({
    events: seatStore,
    counts: new RedisSaleCounts(redis),
    paying: new DrizzleSalePaying({ database }),
    store: sale,
    seatMap,
    leases: new RedisSweepLeases(redis),
    signals,
    clock,
    podId: 'pod-a',
  });
  return { eventId, clock, openAt: o.openAt, startsAt: o.startsAt, seatMap, open, judge };
}

async function tickOf(w: World): Promise<SaleEventReport> {
  const r = await w.judge.tick();
  const mine = r.events.find((e) => e.eventId === w.eventId);
  if (!mine) throw new Error(`이 회차의 보고가 없다: ${JSON.stringify(r)}`);
  return mine;
}

const rowOf = async (eventId: string) =>
  (await q(`select status, previous_status, version, sellable_seats, available, held, paying, sold_out_tiers, open_at from event_sale where event_id = $1`, [eventId]))[0];
const saleMsgs = async (eventId: string) =>
  (await q<{ payload: Buffer }>(`select payload from outbox where msg_key = $1 and topic = $2 order by seq`, [eventId, TOPIC])).map((r) => JSON.parse(r.payload.toString('utf8')) as Record<string, unknown>);

describe('purchase 판매 열기(실제 PostgreSQL·Valkey, S-T41 ⑦⑨)', () => {
  test('S-T41 ⑦_ openAt−1ms에 UPCOMING(open_at·판 1·EventSaleChanged)·seat_rebuild 판 1·비트맵·s:ctl:events·세대 키가 서고, 판정은 오픈 전에 ON_SALE을 내지 않는다', async () => {
    const openAt = BASE;
    const w = world({ openAt, startsAt: openAt + 3 * DAY });
    const r = await w.open.run({ eventId: w.eventId, openAtMs: w.openAt, startsAtMs: w.startsAt });
    expect(r).toEqual({ opened: true, upcomingCreated: true, seatEpoch: expect.any(Number) });
    expect(r.seatEpoch).toBeGreaterThan(0);

    expect(await rowOf(w.eventId)).toMatchObject({
      status: 'UPCOMING',
      previous_status: null,
      version: '1',
      sellable_seats: SEAT_COUNT,
      available: SEAT_COUNT,
      held: 0,
      paying: 0,
      sold_out_tiers: [],
    });
    expect(new Date((await rowOf(w.eventId))!.open_at as string).getTime()).toBe(openAt);
    expect(await q(`select gen, holder from seat_rebuild where event_id = $1`, [w.eventId])).toEqual([{ gen: 1, holder: null }]);
    const msgs = await saleMsgs(w.eventId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ status: 'UPCOMING', version: 1, eventKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/) });
    expect(msgs[0]).not.toHaveProperty('previousStatus');
    expect((await cmd('s:ctl:events', ['SMEMBERS', 's:ctl:events'])) as string[]).toContain(w.eventId);
    expect(Number(await cmd(`s:{event:${w.eventId}}:bitmap`, ['STRLEN', `s:{event:${w.eventId}}:bitmap`]))).toBeGreaterThan(0);
    const epoch = hashOf(await cmd(`s:{event:${w.eventId}}:epoch`, ['HGETALL', `s:{event:${w.eventId}}:epoch`]));
    expect(epoch).toMatchObject({ epoch: String(r.seatEpoch), node: 'standalone' });

    // 오픈 1ms 전 틱은 상태·판을 바꾸지 않는다
    const before = await tickOf(w);
    expect(before.outcome).not.toBe('CHANGED');
    expect(await rowOf(w.eventId)).toMatchObject({ status: 'UPCOMING', version: '1' });

    // openAt에는 다음 틱이 ON_SALE(OPENED)로 바꾼다
    w.clock.advance(1);
    const at = await tickOf(w);
    expect(at.outcome).toBe('CHANGED');
    expect(await rowOf(w.eventId)).toMatchObject({ status: 'ON_SALE', previous_status: 'UPCOMING', version: '2' });
    expect((await saleMsgs(w.eventId)).at(-1)).toMatchObject({ status: 'ON_SALE', previousStatus: 'UPCOMING', version: 2 });

    // 같은 호출 두 번은 행·판·비트맵을 늘리지 않는다
    const again = await w.open.run({ eventId: w.eventId, openAtMs: w.openAt, startsAtMs: w.startsAt });
    expect(again).toMatchObject({ opened: false, upcomingCreated: false, seatEpoch: r.seatEpoch });
    expect(await q(`select count(*)::int as n from event_sale where event_id = $1`, [w.eventId])).toEqual([{ n: 1 }]);
    expect(await q(`select count(*)::int as n from seat_rebuild where event_id = $1`, [w.eventId])).toEqual([{ n: 1 }]);
    expect(await saleMsgs(w.eventId)).toHaveLength(2);
  });

  test('S-T41 ⑦_ openAt+1ms도 다음 틱이 ON_SALE로 바꾸고, 판매 종료 지난 회차·좌석맵이 없는 회차는 409이고 행을 만들지 않는다', async () => {
    const openAt = BASE + DAY;
    const late = world({ openAt, startsAt: openAt + 3 * DAY });
    await late.open.run({ eventId: late.eventId, openAtMs: late.openAt, startsAtMs: late.startsAt });
    late.clock.advance(2); // openAt + 1ms에 다음 틱이 돈다
    expect(await tickOf(late)).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE' });

    // 판매 종료(시작 24시간 전)가 지난 회차
    const endedOpenAt = BASE + 2 * DAY;
    const ended = world({ openAt: endedOpenAt, startsAt: endedOpenAt + DAY, saleEndsAtMs: endedOpenAt - 30 * 60_000 });
    const endedErr = await ended.open.run({ eventId: ended.eventId, openAtMs: ended.openAt, startsAtMs: ended.startsAt }).catch((e: unknown) => e);
    expect(endedErr).toBeInstanceOf(OpenSaleError);
    expect((endedErr as OpenSaleError).code).toBe(SALE_NOT_PUBLISHABLE);
    expect(await rowOf(ended.eventId)).toBeUndefined();
    expect(await q(`select count(*)::int as n from seat_rebuild where event_id = $1`, [ended.eventId])).toEqual([{ n: 0 }]);

    // 좌석맵 판이 없는 회차
    const noLayoutOpenAt = BASE + 3 * DAY;
    const noLayout = world({ openAt: noLayoutOpenAt, startsAt: noLayoutOpenAt + 3 * DAY, noLayout: true });
    const noLayoutErr = await noLayout.open.run({ eventId: noLayout.eventId, openAtMs: noLayout.openAt, startsAtMs: noLayout.startsAt }).catch((e: unknown) => e);
    expect(noLayoutErr).toBeInstanceOf(OpenSaleError);
    expect((noLayoutErr as OpenSaleError).code).toBe(SALE_NOT_PUBLISHABLE);
    expect(await rowOf(noLayout.eventId)).toBeUndefined();
    expect(await q(`select count(*)::int as n from seat_rebuild where event_id = $1`, [noLayout.eventId])).toEqual([{ n: 0 }]);
  });

  test('S-T41 ⑨_ 좌석 Redis 장애는 503 seat-store-unavailable이고 UPCOMING·seat_rebuild는 남으며, 회복한 뒤 다시 부르면 이어서 연다', async () => {
    const openAt = BASE + 4 * DAY;
    const startsAt = openAt + 3 * DAY;
    const w = world({
      openAt,
      startsAt,
      seatsOverride: {
        openSale: async () => {
          throw new SeatStoreUnavailable('unavailable');
        },
      },
    });
    const err = await w.open.run({ eventId: w.eventId, openAtMs: openAt, startsAtMs: startsAt }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(OpenSaleError);
    expect((err as OpenSaleError).code).toBe(SEAT_STORE_UNAVAILABLE);
    // 1·2단계는 끝났고 3단계만 실패했다(다음 호출이 이어서 연다)
    expect(await rowOf(w.eventId)).toMatchObject({ status: 'UPCOMING', version: '1' });
    expect(await q(`select gen from seat_rebuild where event_id = $1`, [w.eventId])).toEqual([{ gen: 1 }]);
    expect(await cmd(`s:{event:${w.eventId}}:bitmap`, ['EXISTS', `s:{event:${w.eventId}}:bitmap`])).toBe(0);
    expect(await cmd(`s:{event:${w.eventId}}:epoch`, ['EXISTS', `s:{event:${w.eventId}}:epoch`])).toBe(0);

    // 내부 HTTP 계약은 503으로 닫는다
    const controller = new InternalSaleOpenController(w.open);
    await expect(controller.open({ eventId: w.eventId }, { openAtMs: openAt, startsAtMs: startsAt })).rejects.toMatchObject({ status: 503 });

    // 회복한 저장소로 다시 부르면 같은 행·판을 다시 만들지 않고 이어서 연다
    const recovered = new OpenSale({ events: sale, marks: rebuild, seats: seatStore, seatMap: w.seatMap, clock: w.clock });
    const ok = await recovered.run({ eventId: w.eventId, openAtMs: openAt, startsAtMs: startsAt });
    expect(ok).toMatchObject({ opened: true, upcomingCreated: false });
    expect(await q(`select version from event_sale where event_id = $1`, [w.eventId])).toEqual([{ version: '1' }]);
    expect(await q(`select count(*)::int as n from seat_rebuild where event_id = $1`, [w.eventId])).toEqual([{ n: 1 }]);
    expect(Number(await cmd(`s:{event:${w.eventId}}:epoch`, ['HGET', `s:{event:${w.eventId}}:epoch`, 'epoch']))).toBeGreaterThan(0);
  });
});
