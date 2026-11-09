// 회차 판매 상태 판정을 실제 PostgreSQL 18·실제 Valkey 8.1로 돈다(BUILD_ORDER PRF-144, 시험 S-T25 ①~⑫, ADR-0122 '뒤에 정한 것', ADR-0214 결정 2·3, ADR-0219 결정 5·6).
// 정본: docs/features/seat-hold.md §4 '회차 판매 상태 판정'·'판정의 첫 구현'·표의 S-T25, docs/data.md event_sale·0012·§5·§5.1, docs/api/asyncapi.yaml EventSaleChanged.
//
// 약속:
// - 시각은 주입 시계(fakeClock)이고 틱은 손으로 부른다(judge.tick). 시험마다 실제 지금에서 시작한다(seat_sale.reserved_at이 DB 시계라 10분 창 안에 있어야 하고, Outbox 일 파티션이 그 날짜에 있어야 한다).
// - 시험마다 새 회차 ID(소문자 UUID)와 그 회차만 아는 좌석맵 판을 쓴다. 표를 비우지 않는다. 같은 Valkey의 다른 시험 회차는 판이 없어 NO_CONFIG로 지나가므로 보고에서 이 회차만 본다.
// - 임대는 실제 Valkey 키(수명 3초)다. 파드를 번갈아 돌리는 시험은 임대가 넘어간 것을 키를 지워 흉내 낸다.
// - DB 상태는 저장소를 거치지 않고 직접 SQL로 읽어 본다. 기대 값은 정본에서 시험이 따로 적는다(eventKey는 order-fixtures의 uuid8, 토픽·키 이름은 글자 그대로).
// - 좌석판: 10석(등급 R 색인 0~4, 등급 S 색인 5~9). 비트맵은 16비트이고 색인 10~15는 판매 대상이 아니다.
// - 사용자 해제는 해제 Lua(HOT-070) 전이라 해제가 지우는 것(비트·만료 인덱스·홀드 Hash)을 직접 지워 흉내 낸다(order-holds.int.test.ts와 같다).
//
// 형이 정본보다 모자라 시험이 정한 것(구현이 형을 넓히면 맞춘다):
// - 활성 판매 대조·결제 중 읽기의 SQL을 엿보는 길은 db.execute와 pool.query뿐이다(저장소가 Drizzle 빌더로 읽게 되면 EXPLAIN 시험의 spy를 넓힌다).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { EventSaleChanged } from '@peaket/contracts/asyncapi';
import { createDatabase, createHotRedis, type ConsumedMessage, type Database, ensureOutboxPartitions, fakeClock, type HotRedis, PlatformMetrics, type PlatformLogger, uuidv7 } from '@peaket/platform';
import type { SQL } from 'drizzle-orm';
import { PgDialect } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { EventSaleChangedHandler } from '../../queue-svc/src/modules/sale/inbound/event-sale-changed.handler.js';
import { migratePurchase } from '../scripts/migrate.mjs';
import { DrizzleOrderStore, DrizzleSalePaying, type NewOrder, type TransitionId } from '../src/modules/booking/index.js';
import {
  DrizzleEventSale,
  DrizzleSeatSales,
  type EventSaleStore,
  PromSaleStateSignals,
  RedisSaleCounts,
  RedisSeatStore,
  RedisSweepLeases,
  SALE_COUNT_LUA,
  type SaleEventReport,
  type SaleLayout,
  SaleStateJudge,
  type SaleStateJudgeDeps,
  type SeatRef,
  SeatStoreUnavailable,
  type SweepLeases,
  seatKeys,
  tierAvailability,
} from '../src/modules/inventory/index.js';
import { fingerprintOf, held as heldOf } from '../test/hold-cases.js';
import { DAY, iso, messagesOf, newOrderInput, PAYMENT_RESULT, SAGA, uuid8 } from './order-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const SEAT_COUNT = 16;
const TOTAL = 10;
const NO_OUTBOX_PARTITION = /no partition of relation "outbox" found for row/;
const TOPIC = 'trade.seats';

let pgServer: PostgresContainer | undefined;
let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let database: Database;
let admin: Database;
let seatStore: RedisSeatStore;
let seatSales: DrizzleSeatSales;

beforeAll(async () => {
  const [p, v] = await Promise.allSettled([startPostgres(), startValkey()]);
  if (p.status === 'fulfilled') pgServer = p.value;
  if (v.status === 'fulfilled') valkey = v.value;
  for (const r of [p, v]) if (r.status === 'rejected') throw r.reason as Error;
  redis = await createHotRedis({ url: valkey!.url });
  await migratePurchase(pgServer!.url);
  database = createDatabase({ url: pgServer!.url, profile: 'general', max: 20, applicationName: 'sale-state-test' });
  admin = createDatabase({ url: pgServer!.url, profile: 'general', max: 4, applicationName: 'sale-state-admin' });
  await ensureOutboxPartitions(admin, fakeClock({ now: Date.now() }), { daysAhead: 40 });
  seatStore = new RedisSeatStore(redis);
  seatSales = new DrizzleSeatSales(database);
});

afterAll(async () => {
  await Promise.allSettled([redis?.close(), database?.close(), admin?.close()]);
  valkey?.stop();
  pgServer?.stop();
});

// ───────────────────────────── 도우미 ─────────────────────────────

const q = async <R = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<R[]> => (await admin.pool.query(text, params)).rows as R[];
const cmd = (key: string, args: string[]) => redis.command(args, { key });
const keepUntilMs = (): number => Date.now() + 7 * DAY;
const noop = (): void => undefined;

/** RESP2·RESP3 HGETALL을 글 사전으로 */
function hashOf(v: unknown): Record<string, string> {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  if (Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = String(v[i + 1]);
    return o;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
  return {};
}

const seatIdOf = (i: number): string => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
const SEATS: SeatRef[] = Array.from({ length: TOTAL }, (_, i) => {
  const tierId = i < 5 ? 'R' : 'S';
  return { seatId: seatIdOf(i), index: i, sectionId: `SEC-${tierId}`, sectionIndex: i < 5 ? 0 : 1, seatOffset: i < 5 ? i : i - 5, tierId };
});
const LAYOUT: SaleLayout = { sellableSeats: TOTAL, tiers: [{ tierId: 'R', indexes: [0, 1, 2, 3, 4] }, { tierId: 'S', indexes: [5, 6, 7, 8, 9] }] };

interface Held {
  ref: SeatRef;
  accountId: string;
  holdId: string;
  psid: string;
}
interface Paid {
  o: NewOrder;
  h: Held;
  /** 결제 사건 순번(전이마다 올린다) */
  paySeq: number;
}

interface World {
  eventId: string;
  clock: ReturnType<typeof fakeClock>;
  metrics: PlatformMetrics;
  logs: unknown[];
  sale: DrizzleEventSale;
  orders: DrizzleOrderStore;
  judge: SaleStateJudge;
  other: SaleStateJudge;
  makeJudge(podId: string, over?: Partial<SaleStateJudgeDeps>): SaleStateJudge;
}

/** 새 회차 하나: 판매를 열고(세대 키·비트맵·회차 목록), 그 회차만 아는 좌석맵과 파드 둘의 판정기를 만든다 */
async function world(o: { saleEndsInMs?: number } = {}): Promise<World> {
  const eventId = randomUUID();
  const clock = fakeClock({ now: Date.now() });
  const opened = await seatStore.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: keepUntilMs() });
  expect(opened.created, '준비 단계의 판매 열기').toBe(true);
  const metrics = new PlatformMetrics('purchase-svc');
  const signals = new PromSaleStateSignals().register(metrics.registry);
  const sale = new DrizzleEventSale({ database, clock });
  const logs: unknown[] = [];
  const logger = { warn: (x: unknown) => void logs.push(x), info: noop, error: noop, debug: noop } as unknown as PlatformLogger;
  const saleEndsAtMs = clock.now() + (o.saleEndsInMs ?? DAY);
  const seatMap: SaleStateJudgeDeps['seatMap'] = {
    config: async (id) => (id === eventId ? { eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs } : undefined),
    saleLayout: async (id) => (id === eventId ? LAYOUT : undefined),
  };
  const makeJudge = (podId: string, over: Partial<SaleStateJudgeDeps> = {}) =>
    new SaleStateJudge({
      events: seatStore,
      counts: new RedisSaleCounts(redis),
      paying: new DrizzleSalePaying({ database }),
      store: sale,
      seatMap,
      leases: new RedisSweepLeases(redis),
      signals,
      clock,
      podId,
      logger,
      ...over,
    });
  return { eventId, clock, metrics, logs, sale, orders: new DrizzleOrderStore({ clock }), judge: makeJudge('pod-a'), other: makeJudge('pod-b'), makeJudge };
}

/** 그 판정기로 한 틱을 돌고 이 회차의 보고를 돌려준다 */
async function tickOf(w: World, judge: SaleStateJudge = w.judge): Promise<SaleEventReport> {
  const r = await judge.tick();
  const mine = r.events.find((e) => e.eventId === w.eventId);
  if (!mine) throw new Error(`이 회차의 보고가 없다: ${JSON.stringify(r)}`);
  return mine;
}
/** 임대가 넘어간 것을 흉내 낸다(키를 지운다, 글자 그대로의 키 이름 s:{event:E}:salesweep) */
const dropLease = (w: World) => cmd(`s:{event:${w.eventId}}:salesweep`, ['DEL', `s:{event:${w.eventId}}:salesweep`]);

async function holdSeat(w: World, i: number): Promise<Held> {
  const ref = SEATS[i]!;
  const h: Held = { ref, accountId: randomUUID(), holdId: uuidv7(fakeClock({ now: Date.now() })), psid: `ps-${randomUUID()}` };
  heldOf(
    await seatStore.hold({
      eventId: w.eventId,
      accountId: h.accountId,
      purchaseSessionId: h.psid,
      holdId: h.holdId,
      idempotencyKey: randomUUID(),
      fingerprint: fingerprintOf([ref.seatId]),
      seats: [ref],
      limit: 4,
      keepUntilMs: keepUntilMs(),
    }),
  );
  return h;
}
const holdAll = async (w: World): Promise<Held[]> => {
  const out: Held[] = [];
  for (let i = 0; i < TOTAL; i += 1) out.push(await holdSeat(w, i));
  return out;
};
/** 사용자 해제 흉내: 비트를 끄고 만료 인덱스·홀드 Hash를 지운다 */
async function releaseSeat(w: World, h: Held): Promise<void> {
  const e = w.eventId;
  const i = String(h.ref.index);
  await cmd(seatKeys.bitmap(e), ['SETBIT', seatKeys.bitmap(e), i, '0']);
  await cmd(seatKeys.expiry(e), ['ZREM', seatKeys.expiry(e), i]);
  await cmd(seatKeys.hold(e, h.ref.index), ['DEL', seatKeys.hold(e, h.ref.index)]);
  await cmd(seatKeys.quota(e, h.accountId), ['DEL', seatKeys.quota(e, h.accountId)]);
}
const setBits = async (w: World, indexes: readonly number[], value: 0 | 1): Promise<void> => {
  for (const i of indexes) await cmd(seatKeys.bitmap(w.eventId), ['SETBIT', seatKeys.bitmap(w.eventId), String(i), String(value)]);
};

async function advance(w: World, p: Paid, path: readonly TransitionId[]): Promise<void> {
  for (const transition of path) {
    const r = await database.transaction((tx) =>
      w.orders.transition(tx, { orderId: p.o.id, transition, actor: SAGA, ...(PAYMENT_RESULT.has(transition) ? { paymentEventSeq: ++p.paySeq } : {}) }),
    );
    expect(r.status, `준비 단계의 전이 ${transition}`).toBe('APPLIED');
  }
}
/** 묶기(Redis)만 한 상태: 비트는 켜져 있고 만료 인덱스에서 빠졌고 판매 행은 아직 없다(⑪) */
async function pinOnly(w: World, h: Held): Promise<void> {
  const r = await seatStore.pin({
    eventId: w.eventId,
    accountId: h.accountId,
    purchaseSessionId: h.psid,
    holdId: h.holdId,
    seats: [h.ref],
    limit: 4,
    orderGen: 1,
    keepUntilMs: keepUntilMs(),
  });
  expect(r.kind, '준비 단계의 묶기').toBe('OK');
}
type PayState = 'RESERVED' | 'AWAITING_DEPOSIT' | 'UNKNOWN' | 'SOLD';
/**
 * 주문·결제 시도까지 실제 전이로: T1 → T3 → T4(ACCEPTED) → 묶기(Redis) → 판매 예약(PENDING) → T7(RESERVED) → 원하는 끝 상태.
 * o.noPin이면 묶기를 건너뛴다(좌석 Redis가 없는 결제 중 셈 시험)
 */
async function pay(w: World, h: Held, final: PayState, o: { noPin?: boolean } = {}): Promise<Paid> {
  const order = newOrderInput(w.clock, {
    eventId: w.eventId,
    accountId: h.accountId,
    holdId: h.holdId,
    purchaseSessionId: h.psid,
    items: [{ seatId: h.ref.seatId, tierId: h.ref.tierId, sectionId: h.ref.sectionId, unitPrice: 1000 }],
  });
  await database.transaction((tx) => w.orders.createOrder(tx, order));
  const p: Paid = { o: order, h, paySeq: 0 };
  await advance(w, p, ['T3', 'T4']);
  if (!o.noPin) await pinOnly(w, h);
  expect(await seatSales.reserve({ eventId: w.eventId, accountId: h.accountId, orderId: order.id, seatIds: [h.ref.seatId], limit: 4 }), '준비 단계의 판매 예약').toEqual({ status: 'RESERVED' });
  await advance(w, p, ['T7']);
  if (final === 'AWAITING_DEPOSIT') await advance(w, p, ['T10']);
  if (final === 'UNKNOWN') await advance(w, p, ['T12']);
  if (final === 'SOLD') await settle(w, p);
  return p;
}
/** 승인 끝: T9 → 판매 확정(SOLD) → T18 */
async function settle(w: World, p: Paid): Promise<void> {
  await advance(w, p, ['T9']);
  expect(await seatSales.markSold({ eventId: w.eventId, orderId: p.o.id, seatIds: [p.h.ref.seatId] }), '준비 단계의 판매 확정').toBe(1);
  await advance(w, p, ['T18']);
}
/** 입금 기한 경과: T17(FAILED) → 판매 예약 되돌림(RETURNED) → 실패 해제 Lua(비트가 꺼진다) */
async function depositExpired(w: World, p: Paid): Promise<void> {
  await advance(w, p, ['T17']);
  expect(await seatSales.releasePending({ eventId: w.eventId, orderId: p.o.id, seatIds: [p.h.ref.seatId], accountId: p.h.accountId }), '준비 단계의 예약 되돌림').toBe(1);
  expect(await seatStore.releaseFailed({ eventId: w.eventId, accountId: p.h.accountId, holdId: p.h.holdId, seats: [p.h.ref], keepUntilMs: keepUntilMs() }), '준비 단계의 실패 해제').toEqual({ kind: 'OK', released: 1 });
}

type SaleDbRow = {
  status: string;
  previous_status: string | null;
  version: number;
  sellable_seats: number;
  available: number;
  held: number;
  paying: number;
  sold_out_tiers: string[];
  open_at: Date | null;
  first_sold_out_at: Date | null;
  reopen_count: number;
  changed_at: Date;
  counted_at: Date;
};
const saleRow = async (eventId: string): Promise<SaleDbRow | undefined> =>
  (
    await q<SaleDbRow>(
      `select status, previous_status, version::int as version, sellable_seats, available, held, paying, sold_out_tiers, open_at, first_sold_out_at, reopen_count, changed_at, counted_at
         from event_sale where event_id = $1`,
      [eventId],
    )
  )[0];

type SaleMsg = Record<string, unknown> & { version: number; eventKey: string; status: string };
interface OutboxRow {
  topic: string;
  key: string;
  raw: string;
  value: SaleMsg;
}
/** 이 회차의 trade.seats Outbox 행(seq 차례). 주문 사건도 같은 키라 토픽으로 거른다 */
async function saleMsgs(eventId: string): Promise<OutboxRow[]> {
  const rows = await q<{ topic: string; msg_key: string; payload: Buffer }>(`select topic, msg_key, payload from outbox where msg_key = $1 and topic = $2 order by seq`, [eventId, TOPIC]);
  return rows.map((r) => {
    const raw = Buffer.from(r.payload).toString('utf8');
    return { topic: r.topic, key: r.msg_key, raw, value: JSON.parse(raw) as SaleMsg };
  });
}
const lastMsg = async (eventId: string): Promise<SaleMsg> => {
  const all = await saleMsgs(eventId);
  if (all.length === 0) throw new Error('Outbox 행이 없다');
  return all[all.length - 1]!.value;
};

const metric = async (w: World, name: string, labels = ''): Promise<number> => {
  const text = await w.metrics.registry.metrics();
  const escaped = labels.replace(/[{}"]/g, '\\$&');
  return Number(new RegExp(`^${name}${escaped} (\\S+)$`, 'm').exec(text)?.[1] ?? '0');
};

/** EXPLAIN(FORMAT JSON) 계획의 노드들(평평하게) */
function planNodes(plan: Record<string, unknown>): Record<string, unknown>[] {
  const kids = (plan.Plans as Record<string, unknown>[] | undefined) ?? [];
  return [plan, ...kids.flatMap(planNodes)];
}

// ───────────────────────────── 1. 좌석 Redis 셈(RedisSaleCounts + 실제 Lua) ─────────────────────────────

describe('RedisSaleCounts: 실제 읽기 Lua', () => {
  const counts = (): RedisSaleCounts => new RedisSaleCounts(redis);

  test('ST25_ADR0122_⑫ 세대 키의 epoch 칸이 없으면 비트맵·만료 인덱스가 있어도 NOT_READY이고 아무것도 읽지 않는다 [ASVS v5.0.0-16.5.3]', async () => {
    const e = randomUUID();
    await cmd(seatKeys.bitmap(e), ['SETBIT', seatKeys.bitmap(e), '3', '1']);
    await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), '123', '3']);
    expect(await counts().read(e)).toEqual({ kind: 'NOT_READY' });
    // 세대 키는 있는데 epoch 칸이 없는 경우도 같다
    await cmd(seatKeys.epoch(e), ['HSET', seatKeys.epoch(e), 'node', 'x']);
    expect(await counts().read(e)).toEqual({ kind: 'NOT_READY' });
  });

  test('ST25_ADR0122_셈 Lua의 첫 줄은 no-writes 선언이다(이 읽기 자체는 메모리 부족에 거절되지 않는다) [ASVS v5.0.0-15.4.2]', () => {
    expect(SALE_COUNT_LUA.split('\n')[0]).toBe('#!lua flags=no-writes');
  });

  test('ST25_ADR0122_비트맵 바이트를 Buffer로 깨지지 않게 돌려준다(0x80 이상의 바이트 포함)와 ZCARD를 한 번에 읽는다. 등급별 가용은 그 바이트에서 나온다 [ASVS v5.0.0-15.4.2]', async () => {
    const w = await world();
    const e = w.eventId;
    await setBits(w, [0, 8, 9, 10, 11, 12, 13, 14, 15], 1);
    await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), '10', '0', '20', '8', '30', '9']);
    const r = await counts().read(e);
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(Buffer.isBuffer(r.bitmap)).toBe(true);
    expect(Buffer.compare(r.bitmap, Buffer.from([0x80, 0xff]))).toBe(0);
    expect(r.held).toBe(3);
    // 판매 대상이 아닌 색인 10~15의 비트는 세지 않는다
    expect(tierAvailability(r.bitmap, LAYOUT.tiers)).toEqual([
      { tierId: 'R', available: 4 },
      { tierId: 'S', available: 3 },
    ]);
  });

  test('ST25_ADR0122_세대 키만 있고 비트맵·만료 인덱스가 없으면 OK, 빈 바이트, held 0이다', async () => {
    const e = randomUUID();
    await cmd(seatKeys.epoch(e), ['HSET', seatKeys.epoch(e), 'epoch', '7', 'node', 'n1']);
    const r = await counts().read(e);
    expect(r.kind).toBe('OK');
    if (r.kind !== 'OK') return;
    expect(r.bitmap.length).toBe(0);
    expect(r.held).toBe(0);
  });

  test('ST25_ADR0122_키 형이 틀리면 일시 장애가 아닌 오류로 던진다(WRONGTYPE) [ASVS v5.0.0-16.5.3]', async () => {
    const e = randomUUID();
    await cmd(seatKeys.epoch(e), ['HSET', seatKeys.epoch(e), 'epoch', '7', 'node', 'n1']);
    await cmd(seatKeys.bitmap(e), ['HSET', seatKeys.bitmap(e), 'a', 'b']);
    const err = await counts().read(e).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(SeatStoreUnavailable);
    expect(messagesOf(err)).toMatch(/WRONGTYPE/);
  });

  test('ST25_ADR0122_holdIndexes는 만료 인덱스를 순위로 쪽 읽기 한다(점수 차례, 끝을 지나면 빈 배열) [ASVS v5.0.0-15.4.2]', async () => {
    const e = randomUUID();
    await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), '30', '5', '10', '2', '20', '9', '40', '0', '50', '7']);
    const c = counts();
    expect(await c.holdIndexes(e, 0, 2)).toEqual({ indexes: [2, 9], badMembers: 0 });
    expect(await c.holdIndexes(e, 2, 2)).toEqual({ indexes: [5, 0], badMembers: 0 });
    expect(await c.holdIndexes(e, 4, 2)).toEqual({ indexes: [7], badMembers: 0 });
    expect(await c.holdIndexes(e, 5, 2)).toEqual({ indexes: [], badMembers: 0 });
  });

  test.each([
    ['count 0', 0, 0],
    ['count 1001', 0, 1001],
    ['start 음수', -1, 2],
    ['start 소수', 1.5, 2],
  ])('ST25_ADR0122_holdIndexes 인자가 범위 밖이면 부르지 않고 RangeError다: %s', async (_label, start, count) => {
    await expect(counts().holdIndexes(randomUUID(), start, count)).rejects.toBeInstanceOf(RangeError);
  });

  test('ST25_ADR0122_회차 ID가 키 조각 모양이 아니면 read·holdIndexes가 부르지 않고 RangeError다', async () => {
    await expect(counts().read('a b')).rejects.toBeInstanceOf(RangeError);
    await expect(counts().holdIndexes('a b', 0, 1)).rejects.toBeInstanceOf(RangeError);
  });

  test.each(['01', 'abc', '-1'])('ST25_ADR0122_리뷰 고침 L12 만료 인덱스 멤버가 앞 0 없는 10진 정수 글이 아니면 던지지 않고 건너뛰어 그 수를 돌려준다: %s [ASVS v5.0.0-16.5.2]', async (member) => {
    const e = randomUUID();
    await cmd(seatKeys.expiry(e), ['ZADD', seatKeys.expiry(e), '1', member, '2', '4']);
    await expect(counts().holdIndexes(e, 0, 10)).resolves.toEqual({ indexes: [4], badMembers: 1 });
  });
});

// ───────────────────────────── 2. S-T25 끝까지 ─────────────────────────────

describe('S-T25: 실제 Lua·SeatSales·주문 행으로 끝까지', () => {
  test('ST25_ADR0122_① 10석을 모두 홀드하면 가용이 0이 된 때부터 5초(4,999ms는 아직) 뒤 ALL_HELD다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    expect(await tickOf(w)).toMatchObject({ outcome: 'CREATED', status: 'ON_SALE', version: 1, guardBlocked: false });
    expect(await saleRow(w.eventId)).toMatchObject({ status: 'ON_SALE', previous_status: null, version: 1, sellable_seats: TOTAL, available: TOTAL, held: 0, paying: 0, sold_out_tiers: [], reopen_count: 0, first_sold_out_at: null });

    await holdAll(w);
    w.clock.advance(1000);
    expect((await tickOf(w)).status, '가용 0 첫 틱').toBe('ON_SALE');
    w.clock.advance(4999);
    expect((await tickOf(w)).status, '4,999ms').toBe('ON_SALE');
    expect((await saleRow(w.eventId))!.status).toBe('ON_SALE');
    w.clock.advance(1);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ALL_HELD', version: 2 });
    const row = (await saleRow(w.eventId))!;
    expect(row).toMatchObject({ status: 'ALL_HELD', previous_status: 'ON_SALE', version: 2, available: 0, held: TOTAL, paying: 0 });
    expect(row.changed_at.getTime()).toBe(w.clock.now());
    expect(row.counted_at.getTime()).toBe(w.clock.now());
    expect(await lastMsg(w.eventId)).toMatchObject({ status: 'ALL_HELD', previousStatus: 'ON_SALE', version: 2, available: 0, held: TOTAL, paying: 0 });
  });

  test('ST25_ADR0122_② 전석 홀드 4초 만에 하나를 풀고 곧 다시 잡으면 처음 0이 된 때부터 5초가 지나도 ALL_HELD가 아니고, 다시 0이 된 때부터 5초 뒤에 된다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    expect((await tickOf(w)).outcome).toBe('CREATED');
    const held = await holdAll(w);
    w.clock.advance(1000);
    expect((await tickOf(w)).status, '첫 0').toBe('ON_SALE');
    w.clock.advance(4000);
    expect((await tickOf(w)).status, '첫 0에서 4초').toBe('ON_SALE');
    await releaseSeat(w, held[0]!);
    w.clock.advance(200);
    expect((await tickOf(w)).status, '가용 1이 끼었다').toBe('ON_SALE');
    await holdSeat(w, 0);
    w.clock.advance(800);
    // 처음 0이 된 때부터 5초가 지났지만 끊겼으니 아직 ON_SALE이다(다시 0이 된 첫 틱)
    expect((await tickOf(w)).status, '끊긴 뒤 다시 0, 처음부터 5초').toBe('ON_SALE');
    w.clock.advance(4999);
    expect((await tickOf(w)).status, '다시 0에서 4,999ms').toBe('ON_SALE');
    w.clock.advance(1);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ALL_HELD' });
  });

  test('ST25_ADR0122_③④⑥ 9석 결제 중 + 1석 입금 대기는 ALL_HELD를 지키고(결제 중 9), 승인이 끝나면 두 번 이어진 판정 뒤 SOLD_OUT(입금 대기는 팔린 쪽), 입금 기한 경과로 1석이 돌아오면 ON_SALE(매진 풀림) [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    const held = await holdAll(w);
    expect((await tickOf(w)).outcome, '전석 홀드 뒤 첫 틱').toBe('CREATED');
    w.clock.advance(5000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ALL_HELD', version: 2 });

    // ③ 9석은 결제 접수(승인 대기), 1석은 가상계좌 입금 대기
    const paid: Paid[] = [];
    for (let i = 0; i < 9; i += 1) paid.push(await pay(w, held[i]!, 'RESERVED'));
    const deposit = await pay(w, held[9]!, 'AWAITING_DEPOSIT');
    w.clock.advance(5000);
    expect(await tickOf(w), '③ 같은 판을 다시 낸다').toMatchObject({ outcome: 'REPUBLISHED', status: 'ALL_HELD', version: 2 });
    expect(await saleRow(w.eventId)).toMatchObject({ status: 'ALL_HELD', version: 2, available: 0, held: 0, paying: 9 });
    expect(await lastMsg(w.eventId)).toMatchObject({ status: 'ALL_HELD', version: 2, available: 0, held: 0, paying: 9 });

    // ④ 승인 9개가 끝난다. 입금 대기 1개는 팔린 쪽이라 셋 다 0이고 활성 판매 행은 10이다
    for (const p of paid) await settle(w, p);
    w.clock.advance(1000);
    expect((await tickOf(w)).status, '④ 첫 번째 빈 틱').toBe('ALL_HELD');
    w.clock.advance(1000);
    const soldAtMs = w.clock.now();
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT', version: 3 });
    expect(await saleRow(w.eventId)).toMatchObject({ status: 'SOLD_OUT', previous_status: 'ALL_HELD', version: 3, available: 0, held: 0, paying: 0, reopen_count: 0 });
    expect((await saleRow(w.eventId))!.first_sold_out_at!.getTime()).toBe(soldAtMs);
    expect(await lastMsg(w.eventId)).toMatchObject({ status: 'SOLD_OUT', previousStatus: 'ALL_HELD', version: 3 });

    // ⑥ 입금 기한이 지나 1석이 돌아온다
    await depositExpired(w, deposit);
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE', version: 4 });
    const reopened = (await saleRow(w.eventId))!;
    expect(reopened).toMatchObject({ status: 'ON_SALE', previous_status: 'SOLD_OUT', version: 4, available: 1, held: 0, paying: 0, reopen_count: 1 });
    expect(reopened.first_sold_out_at!.getTime(), 'first_sold_out_at은 처음 값 그대로').toBe(soldAtMs);

    // 그 좌석이 다시 팔리면 다시 매진이지만 first_sold_out_at은 처음 값이고 reopen_count는 그대로다
    const again = await holdSeat(w, 9);
    await pay(w, again, 'SOLD');
    w.clock.advance(1000);
    expect((await tickOf(w)).status, '다시 매진 첫 틱').toBe('ON_SALE');
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT', version: 5 });
    const resold = (await saleRow(w.eventId))!;
    expect(resold).toMatchObject({ status: 'SOLD_OUT', previous_status: 'ON_SALE', reopen_count: 1 });
    expect(resold.first_sold_out_at!.getTime()).toBe(soldAtMs);
  });

  test('ST25_ADR0122_⑤ 결과 모름 판매 예약 1개를 둔 채 나머지가 모두 팔리면 그 PENDING은 팔린 쪽이라 두 번 이어진 판정 뒤 ON_SALE에서 바로 SOLD_OUT이다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    const held = await holdAll(w);
    for (let i = 0; i < 9; i += 1) await pay(w, held[i]!, 'SOLD');
    await pay(w, held[9]!, 'UNKNOWN');
    expect(await tickOf(w)).toMatchObject({ outcome: 'CREATED', status: 'ON_SALE', version: 1 });
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT', version: 2 });
    expect(await saleRow(w.eventId)).toMatchObject({ status: 'SOLD_OUT', previous_status: 'ON_SALE', available: 0, held: 0, paying: 0 });
  });

  test('ST25_ADR0122_⑦ 파드 둘을 번갈아·동시에 돌려도 한 회차는 한 파드만 판정하고, 판 번호가 거꾸로 가지 않으며 한 판에 Outbox 한 행이다. 임대를 지나 경합해도 조건부 쓰기가 한쪽만 통과시킨다 [ASVS v5.0.0-15.4.2] [ASVS v5.0.0-15.4.4]', async () => {
    const w = await world();
    const held = await holdAll(w);
    const t0 = w.clock.now();

    // 번갈아: A가 만들고(메모 t0), 임대가 넘어가 B가 돈다(B의 메모는 t0+1초), 다시 A가 t0+5초에 ALL_HELD
    expect(await tickOf(w, w.judge)).toMatchObject({ outcome: 'CREATED', status: 'ON_SALE', version: 1 });
    await dropLease(w);
    w.clock.advance(1000);
    expect((await tickOf(w, w.other)).status, 'B').toBe('ON_SALE');
    await dropLease(w);
    w.clock.advance(4000);
    expect(await tickOf(w, w.judge)).toMatchObject({ outcome: 'CHANGED', status: 'ALL_HELD', version: 2 });
    expect(w.clock.now()).toBe(t0 + 5000);
    await dropLease(w);
    w.clock.advance(1000);
    expect((await tickOf(w, w.other)).status, 'B는 ALL_HELD를 읽고 쓰지 않는다').toBe('ALL_HELD');
    await releaseSeat(w, held[0]!);
    await dropLease(w);
    w.clock.advance(1000);
    expect(await tickOf(w, w.judge)).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE', version: 3 });

    // 동시(실제 임대): 정확히 한쪽만 임대를 잡는다
    await dropLease(w);
    w.clock.advance(100);
    const concurrent = await Promise.all([tickOf(w, w.judge), tickOf(w, w.other)]);
    expect(concurrent.map((r) => r.outcome === 'NOT_LEASED').sort(), JSON.stringify(concurrent)).toEqual([false, true]);

    // 임대를 지나도(대역: 늘 잡힘) 조건부 UPDATE가 한쪽만 통과시킨다. 둘이 같은 판을 읽은 뒤에야 쓰게 읽기에서 맞춘다
    await holdSeat(w, 0);
    const barrier = readBarrier(w.sale);
    const alwaysLeased: SweepLeases = { acquire: async () => true };
    const a = w.makeJudge('pod-c', { leases: alwaysLeased, store: barrier.store });
    const b = w.makeJudge('pod-d', { leases: alwaysLeased, store: barrier.store });
    w.clock.advance(1000);
    await Promise.all([a.tick(), b.tick()]); // 각자의 메모에 가용 0이 든다
    w.clock.advance(5000);
    barrier.arm();
    const raced = await Promise.all([tickOf(w, a), tickOf(w, b)]);
    expect(raced.map((r) => r.outcome).sort(), JSON.stringify(raced)).toEqual(['CHANGED', 'LOST']);
    expect(raced.find((r) => r.outcome === 'CHANGED')).toMatchObject({ status: 'ALL_HELD', version: 4 });

    // 이 시험의 틱은 모두 countedAt 뒤 5초 안이거나 판이 바뀌는 틱이라 다시 내기가 끼지 않는다
    const msgs = (await saleMsgs(w.eventId)).map((m) => m.value);
    expect(msgs.map((m) => m.version), '판 번호는 거꾸로 가지 않고 한 판에 한 행').toEqual([1, 2, 3, 4]);
    expect(new Set(msgs.map((m) => m.eventKey)).size).toBe(4);
    expect((await saleRow(w.eventId))!.version).toBe(4);
  });
});

/** 저장소 대역: arm 뒤의 read는 두 쪽이 모두 읽을 때까지 기다린다(판 번호 조건 경합을 항상 만든다) */
function readBarrier(inner: EventSaleStore): { store: EventSaleStore; arm(): void } {
  let armed = false;
  let waiting = 0;
  let open: () => void = noop;
  const gate = new Promise<void>((r) => {
    open = r;
  });
  return {
    arm: () => {
      armed = true;
    },
    store: {
      read: async (id) => {
        const r = await inner.read(id);
        if (armed) {
          waiting += 1;
          if (waiting >= 2) open();
          await gate;
        }
        return r;
      },
      activeSaleCount: (id) => inner.activeSaleCount(id),
      avgTicketsPerOrder: (id) => inner.avgTicketsPerOrder(id),
      create: (x) => inner.create(x),
      applyChange: (x) => inner.applyChange(x),
      republish: (x) => inner.republish(x),
    },
  };
}

// ───────────────────────────── 3. Outbox 행의 값·한 트랜잭션·다시 내기 ─────────────────────────────

describe('Outbox 행', () => {
  test('ST25_ADR0122_첫 사건: 토픽 trade.seats·키 회차이고 값은 정본 칸 전부(type 칸 없음)이며 EventSaleChanged 계약을 통과하고, event_sale과 한 트랜잭션이다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    const t0 = w.clock.now();
    await tickOf(w);
    const msgs = await saleMsgs(w.eventId);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]).toMatchObject({ topic: 'trade.seats', key: w.eventId });
    const value = msgs[0]!.value;
    expect(value).toEqual({
      eventId: w.eventId,
      status: 'ON_SALE',
      available: TOTAL,
      held: 0,
      paying: 0,
      soldOutTiers: [],
      version: 1,
      changedAt: iso(t0),
      countedAt: iso(t0),
      eventKey: uuid8(`EventSaleChanged:${w.eventId}:1`),
    });
    expect('type' in value).toBe(false);
    expect(EventSaleChanged.safeParse(value).error?.issues ?? []).toEqual([]);
    // 같은 트랜잭션이면 두 행의 xmin이 같다
    const [a] = await q<{ x: string }>('select xmin::text as x from event_sale where event_id = $1', [w.eventId]);
    const [b] = await q<{ x: string }>(`select xmin::text as x from outbox where msg_key = $1 and topic = $2 order by seq desc limit 1`, [w.eventId, TOPIC]);
    expect(a!.x).toBe(b!.x);
  });

  test('ST25_ADR0122_다시 낸 사건도 계약을 통과하고 키는 회차다 [ASVS v5.0.0-2.3.3]', async () => {
    const w = await world();
    await tickOf(w);
    await holdSeat(w, 0);
    w.clock.advance(5000);
    expect((await tickOf(w)).outcome).toBe('REPUBLISHED');
    const msgs = await saleMsgs(w.eventId);
    expect(msgs).toHaveLength(2);
    expect(msgs[1]).toMatchObject({ topic: TOPIC, key: w.eventId });
    expect(EventSaleChanged.safeParse(msgs[1]!.value).error?.issues ?? []).toEqual([]);
  });

  test('ST25_ADR0122_Outbox를 쓰지 못하면 event_sale도 바뀌지 않는다(만들기·판 올리기·다시 내기). 판정기는 그 틱만 쉬고 단계 지표와 1분에 경고 한 줄(회차·단계·코드만)을 남긴다 [ASVS v5.0.0-2.3.3] [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.2]', async () => {
    const w = await world();
    // Outbox ID의 시계를 파티션이 없는 날로 둔다(다른 것은 그대로)
    const broken = new DrizzleEventSale({ database, clock: fakeClock({ now: Date.now() - 30 * DAY }) });
    const brokenJudge = w.makeJudge('pod-broken', { store: broken });

    expect(await tickOf(w, brokenJudge)).toMatchObject({ outcome: 'FAILED', failedStage: 'write' });
    expect(await saleRow(w.eventId), '만들기 실패').toBeUndefined();
    expect(await saleMsgs(w.eventId)).toEqual([]);
    w.clock.advance(1000);
    expect(await tickOf(w, brokenJudge)).toMatchObject({ outcome: 'FAILED', failedStage: 'write' });
    expect(await metric(w, 'purchase_event_sale_tick_failures_total', '{stage="write"}')).toBe(2);
    expect(w.logs, '경고는 파드마다 1분에 한 줄').toHaveLength(1);
    const line = w.logs[0] as Record<string, unknown>;
    expect(line).toMatchObject({ eventId: w.eventId, stage: 'write' });
    expect(Object.keys(line).filter((k) => !['eventId', 'stage', 'code'].includes(k))).toEqual([]);
    expect(JSON.stringify(line)).not.toMatch(/partition|outbox|s:\{event/);

    await dropLease(w);
    expect((await tickOf(w)).outcome).toBe('CREATED');
    const before = await saleRow(w.eventId);
    const sameCounts = { available: 3, held: 4, paying: 5 };

    const changeErr = await broken
      .applyChange({ eventId: w.eventId, expectedVersion: 1, status: 'ALL_HELD', previousStatus: 'ON_SALE', soldOutTiers: [], reopenCount: 0, nowMs: w.clock.now() + 1000, ...sameCounts })
      .catch((x: unknown) => x);
    expect(messagesOf(changeErr)).toMatch(NO_OUTBOX_PARTITION);
    expect(await saleRow(w.eventId), '판 올리기 실패').toEqual(before);

    const republishErr = await broken.republish({ eventId: w.eventId, expectedVersion: 1, nowMs: w.clock.now() + 2000, ...sameCounts }).catch((x: unknown) => x);
    expect(messagesOf(republishErr)).toMatch(NO_OUTBOX_PARTITION);
    expect(await saleRow(w.eventId), '다시 내기 실패').toEqual(before);
    expect(await saleMsgs(w.eventId)).toHaveLength(1);
  });

  test('ST25_ADR0122_판 번호 조건이 틀리면 applyChange·republish는 undefined이고 행도 Outbox도 그대로다. create는 이미 있으면 undefined이고 Outbox를 쓰지 않는다 [ASVS v5.0.0-15.4.2]', async () => {
    const w = await world();
    await tickOf(w);
    const before = await saleRow(w.eventId);
    const c = { available: 1, held: 2, paying: 3 };
    expect(await w.sale.applyChange({ eventId: w.eventId, expectedVersion: 9, status: 'ALL_HELD', previousStatus: 'ON_SALE', soldOutTiers: [], reopenCount: 0, nowMs: w.clock.now() + 1000, ...c })).toBeUndefined();
    expect(await w.sale.republish({ eventId: w.eventId, expectedVersion: 9, nowMs: w.clock.now() + 1000, ...c })).toBeUndefined();
    expect(await w.sale.create({ eventId: w.eventId, sellableSeats: TOTAL, nowMs: w.clock.now() + 1000, ...c })).toBeUndefined();
    expect(await saleRow(w.eventId)).toEqual(before);
    expect(await saleMsgs(w.eventId)).toHaveLength(1);
  });

  test('ST25_ADR0122_⑧ 상태가 그대로면 countedAt 뒤 5초(4,999ms는 아직)에 같은 version·eventKey·changedAt으로 새 셈과 countedAt을 다시 낸다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    const t0 = w.clock.now();
    await tickOf(w);
    await holdSeat(w, 0);
    w.clock.advance(4999);
    expect((await tickOf(w)).outcome).toBe('UNCHANGED');
    expect(await saleMsgs(w.eventId)).toHaveLength(1);
    w.clock.advance(1);
    expect(await tickOf(w)).toMatchObject({ outcome: 'REPUBLISHED', status: 'ON_SALE', version: 1 });
    expect(await metric(w, 'purchase_event_sale_republished_total')).toBe(1);

    const [first, second] = (await saleMsgs(w.eventId)).map((m) => m.value);
    expect(second).toMatchObject({ version: first!.version, eventKey: first!.eventKey, changedAt: iso(t0), countedAt: iso(t0 + 5000), available: TOTAL - 1, held: 1, paying: 0 });
    expect(first).toMatchObject({ countedAt: iso(t0), available: TOTAL, held: 0 });
    const row = (await saleRow(w.eventId))!;
    expect(row).toMatchObject({ version: 1, available: TOTAL - 1, held: 1 });
    expect(row.changed_at.getTime()).toBe(t0);
    expect(row.counted_at.getTime()).toBe(t0 + 5000);
  });

  test('ST25_ADR0122_⑧ UPCOMING은 오픈 시각 전에 몇 번을 돌아도 내지 않고, 시각이 지나면 ON_SALE로 판을 올린다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    const t0 = w.clock.now();
    await admin.pool.query(
      `insert into event_sale (event_id, status, version, sellable_seats, available, held, paying, open_at, changed_at, counted_at) values ($1, 'UPCOMING', 3, $2, $2, 0, 0, $3, $4, $4)`,
      [w.eventId, TOTAL, new Date(t0 + 60_000), new Date(t0)],
    );
    for (let i = 0; i < 3; i += 1) {
      w.clock.advance(6000);
      expect((await tickOf(w)).status).toBe('UPCOMING');
    }
    expect(await saleMsgs(w.eventId)).toEqual([]);
    w.clock.advance(42_000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE', version: 4 });
    expect((await saleRow(w.eventId))!.previous_status).toBe('UPCOMING');
    expect(await lastMsg(w.eventId)).toMatchObject({ status: 'ON_SALE', previousStatus: 'UPCOMING', version: 4 });
  });

  test('ST25_ADR0122_⑧ 판매 종료가 지나면 어느 상태든 ENDED이고 그 뒤로는 내지도 바뀌지도 않는다(좌석이 돌아와도) [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world({ saleEndsInMs: 10_000 });
    await tickOf(w);
    const held = await holdSeat(w, 0);
    w.clock.advance(10_000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ENDED', version: 2 });
    expect(await lastMsg(w.eventId)).toMatchObject({ status: 'ENDED', previousStatus: 'ON_SALE', version: 2 });
    await releaseSeat(w, held);
    w.clock.advance(6000);
    expect((await tickOf(w)).outcome).toBe('ALREADY_ENDED');
    w.clock.advance(6000);
    expect((await tickOf(w)).outcome).toBe('ALREADY_ENDED');
    expect((await saleMsgs(w.eventId)).map((m) => m.value.version)).toEqual([1, 2]);
    expect(await saleRow(w.eventId)).toMatchObject({ status: 'ENDED', version: 2 });
  });
});

// ───────────────────────────── 4. ⑪ 거짓 매진 막기 ─────────────────────────────

describe('S-T25 ⑪ 거짓 매진 막기', () => {
  test('ST25_ADR0122_⑪ 묶기 뒤 PENDING 전(비트 켜짐·만료 인덱스에 없음·판매 행 없음)에 셋이 0이어도 두 틱 내내 SOLD_OUT이 아니고 지표가 오른다. 판매 행이 맞춰지면 그제야 두 번 뒤 SOLD_OUT이다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    const held = await holdAll(w);
    for (const h of held) await pinOnly(w, h);

    const first = await tickOf(w);
    expect(first).toMatchObject({ outcome: 'CREATED', status: 'ON_SALE', guardBlocked: true });
    expect(await saleRow(w.eventId), '셋이 0이어도 활성 판매 행이 없다').toMatchObject({ available: 0, held: 0, paying: 0 });
    w.clock.advance(1000);
    const second = await tickOf(w);
    expect(second.status).toBe('ON_SALE');
    expect(second.guardBlocked).toBe(true);
    w.clock.advance(1000);
    expect((await tickOf(w)).status).toBe('ON_SALE');
    expect(await metric(w, 'purchase_event_sale_guard_blocked_total')).toBe(3);
    expect(await metric(w, 'purchase_event_sale_transitions_total', '{to="SOLD_OUT"}')).toBe(0);

    // 주문이 판매 행을 만들면(모두 SOLD) 활성 판매 행 수 10 = 켜진 비트 수 10. 그 뒤 두 번 이어져야 매진이다
    for (const h of held) await settleWithoutPin(w, h);
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ status: 'ON_SALE', guardBlocked: false });
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT', guardBlocked: false });
    expect(await metric(w, 'purchase_event_sale_transitions_total', '{to="SOLD_OUT"}')).toBe(1);
  });

  test('ST25_ADR0122_⑪ 판매 대상이 아닌 색인의 비트와 활성 판매 행 수의 차이는 매진을 세우지 못한다(켜진 비트 10, 활성 행 9이면 막는다) [ASVS v5.0.0-16.5.3]', async () => {
    const w = await world();
    const held = await holdAll(w);
    for (let i = 0; i < 9; i += 1) await pay(w, held[i]!, 'SOLD');
    await pinOnly(w, held[9]!);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CREATED', guardBlocked: true });
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ status: 'ON_SALE', guardBlocked: true });
    // 판매 대상이 아닌 색인을 켜도 available은 달라지지 않는다
    await setBits(w, [10, 11], 1);
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ status: 'ON_SALE', guardBlocked: true });
    expect((await saleRow(w.eventId))!.status).toBe('ON_SALE');
  });
});

/** 묶기는 이미 했고 판매 행이 없던 좌석을 주문·판매 확정까지 끌고 간다(⑪의 뒤쪽 절반) */
async function settleWithoutPin(w: World, h: Held): Promise<void> {
  await pay(w, h, 'SOLD', { noPin: true });
}

// ───────────────────────────── 5. ⑫ 세대 키 없음 ─────────────────────────────

describe('리뷰 고침(코드 리뷰 2026-11-09, BUILD_ORDER PRF-144)', () => {
  test('ST25_ADR0122_리뷰 고침 M2 세대 키를 지운 회차도 판매 종료 시각이 지나면 행의 마지막 셈으로 ENDED가 된다(판 번호 조건, Outbox) [ASVS v5.0.0-2.3.1] [ASVS v5.0.0-16.5.3]', async () => {
    const w = await world({ saleEndsInMs: 10_000 });
    expect((await tickOf(w)).outcome).toBe('CREATED');
    const epochKey = seatKeys.epoch(w.eventId);
    await cmd(epochKey, ['DEL', epochKey]);
    w.clock.advance(10_000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ENDED', version: 2 });
    expect(await saleRow(w.eventId)).toMatchObject({ status: 'ENDED', previous_status: 'ON_SALE', version: 2, available: TOTAL, held: 0, paying: 0 });
    expect(await lastMsg(w.eventId)).toMatchObject({ status: 'ENDED', previousStatus: 'ON_SALE', version: 2, available: TOTAL });
    expect(await metric(w, 'purchase_event_sale_skipped_total', '{reason="not_ready"}')).toBe(0);
    expect(await metric(w, 'purchase_event_sale_transitions_total', '{to="ENDED"}')).toBe(1);
  });

  test('ST25_ADR0122_리뷰 고침 L6 모든 좌석이 SOLD 행인데 비트 하나만 지워지면(장애 조치로 비트만 잃음) 매진을 풀지 않고 guard_blocked와 경고를 남긴다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.3.4]', async () => {
    const w = await world();
    const held = await holdAll(w);
    for (const h of held) await pay(w, h, 'SOLD');
    expect((await tickOf(w)).outcome).toBe('CREATED');
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT', version: 2 });

    await setBits(w, [3], 0);
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'UNCHANGED', status: 'SOLD_OUT', guardBlocked: true });
    expect(await saleRow(w.eventId)).toMatchObject({ status: 'SOLD_OUT', version: 2, reopen_count: 0 });
    expect(await metric(w, 'purchase_event_sale_guard_blocked_total')).toBe(1);
    expect(await metric(w, 'purchase_event_sale_transitions_total', '{to="ON_SALE"}')).toBe(0);
    expect(w.logs).toContainEqual({ eventId: w.eventId, activeSales: TOTAL, takenSeats: TOTAL - 1 });
  });
});

describe('S-T25 ⑫ 다시 만들기 중', () => {
  test('ST25_ADR0122_⑫ 세대 키가 없으면 판정·쓰기를 쉬어 상태가 그대로이고(비트맵이 비어도 거짓 풀림이 없다) not_ready 지표가 오르며, 세대 키가 돌아오면 이어서 판정한다 [ASVS v5.0.0-16.5.3]', async () => {
    const w = await world();
    const held = await holdAll(w);
    await tickOf(w);
    w.clock.advance(5000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ALL_HELD', version: 2 });
    const before = await saleRow(w.eventId);
    const msgCount = (await saleMsgs(w.eventId)).length;

    const epochKey = seatKeys.epoch(w.eventId);
    const fields = hashOf(await cmd(epochKey, ['HGETALL', epochKey]));
    expect(fields.epoch, '준비 단계의 세대 키').toBeDefined();
    await cmd(epochKey, ['DEL', epochKey]);
    await cmd(seatKeys.bitmap(w.eventId), ['DEL', seatKeys.bitmap(w.eventId)]);

    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'NOT_READY' });
    w.clock.advance(6000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'NOT_READY' });
    expect(await saleRow(w.eventId), '판정·쓰기를 쉰다').toEqual(before);
    expect(await saleMsgs(w.eventId)).toHaveLength(msgCount);
    expect(await metric(w, 'purchase_event_sale_skipped_total', '{reason="not_ready"}')).toBe(2);

    // 다시 만들기가 끝났다(비트맵·세대 키). 다시 만들기는 세대 키를 마지막에 쓴다
    await setBits(w, Array.from({ length: TOTAL }, (_, i) => i), 1);
    await cmd(epochKey, ['HSET', epochKey, ...Object.entries(fields).flat()]);
    w.clock.advance(1000);
    expect((await tickOf(w)).status).toBe('ALL_HELD');
    await releaseSeat(w, held[0]!);
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE' });
  });
});

// ───────────────────────────── 6. ⑨ 등급 매진·⑩ 평균 ─────────────────────────────

describe('S-T25 ⑨ 등급 매진', () => {
  test('ST25_ADR0122_⑨ 한 등급의 가용·홀드·결제 중이 0이면 두 번 이어져야 soldOutTiers에 들고 판 번호가 오르며(상태는 그대로), 좌석이 돌아오면 바로 빠지고 판 번호가 오른다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    await setBits(w, [0, 1, 2, 3, 4], 1);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CREATED', version: 1 });
    expect((await saleRow(w.eventId))!.sold_out_tiers, '첫 번째 빈 틱은 아직').toEqual([]);
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE', version: 2 });
    expect(await saleRow(w.eventId)).toMatchObject({ status: 'ON_SALE', previous_status: null, version: 2, sold_out_tiers: ['R'], available: 5 });
    const up = await lastMsg(w.eventId);
    expect(up).toMatchObject({ status: 'ON_SALE', soldOutTiers: ['R'], version: 2 });
    expect('previousStatus' in up, '바뀌기 전 상태가 없으면 칸을 싣지 않는다').toBe(false);
    expect(await metric(w, 'purchase_event_sale_transitions_total', '{to="ON_SALE"}'), '등급만 바뀐 판은 전이로 세지 않는다').toBe(0);

    await setBits(w, [2], 0);
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE', version: 3 });
    expect(await saleRow(w.eventId)).toMatchObject({ version: 3, sold_out_tiers: [] });
    expect(await lastMsg(w.eventId)).toMatchObject({ soldOutTiers: [], version: 3 });
  });

  test('ST25_ADR0122_⑨ 홀드가 있는 등급은 가용이 0이어도 매진이 아니다(실제 만료 인덱스 쪽 읽기) [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    await setBits(w, [0, 1, 2, 3, 4], 1);
    for (let i = 5; i < 10; i += 1) await holdSeat(w, i);
    await tickOf(w);
    w.clock.advance(1000);
    expect(await tickOf(w)).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE' });
    expect((await saleRow(w.eventId))!.sold_out_tiers).toEqual(['R']);
  });
});

describe('S-T25 ⑩ 평균 구매 매수와 활성 판매 대조', () => {
  /** 결제가 끝난 주문 orders건(주문 하나 좌석 하나, extraSeats개 주문은 좌석이 하나 더)을 넣는다 */
  async function putSold(eventId: string, orders: number, extraSeats: number): Promise<void> {
    await admin.pool.query(
      `with o as (select gen_random_uuid() as id, row_number() over () as n from generate_series(1, $2::int)),
            s as (select o.id, o.n from o union all select o.id, o.n from o where o.n <= $3::int)
       insert into seat_sale (event_id, seat_id, order_id, account_id, status)
       select $1::uuid, gen_random_uuid(), s.id, gen_random_uuid(), 'SOLD' from s`,
      [eventId, orders, extraSeats],
    );
  }

  test('ST25_ADR0122_⑩ 주문 99건이면 사건에 avgTicketsPerOrder 칸이 없다', async () => {
    const w = await world();
    await putSold(w.eventId, 99, 40);
    await tickOf(w);
    const v = await lastMsg(w.eventId);
    expect('avgTicketsPerOrder' in v).toBe(false);
    expect(await w.sale.avgTicketsPerOrder(w.eventId)).toBeUndefined();
  });

  test('ST25_ADR0122_⑩ 주문 100건이면 좌석 수 ÷ 주문 수(소수 둘째 자리)를 싣고, 칸이 있어도 계약을 통과한다', async () => {
    const w = await world();
    await putSold(w.eventId, 100, 50);
    expect(await w.sale.avgTicketsPerOrder(w.eventId)).toBe(1.5);
    await tickOf(w);
    const v = await lastMsg(w.eventId);
    expect(v.avgTicketsPerOrder).toBe(1.5);
    expect(EventSaleChanged.safeParse(v).error?.issues ?? []).toEqual([]);
  });

  test('ST25_ADR0122_⑩ 평균은 소수 둘째 자리로 반올림한다(주문 103건·좌석 151개 = 1.47)', async () => {
    const w = await world();
    await putSold(w.eventId, 103, 48);
    expect(await w.sale.avgTicketsPerOrder(w.eventId)).toBe(1.47);
  });

  test('ST25_ADR0122_activeSaleCount는 PENDING·SOLD만 세고 RETURNED·다른 회차를 세지 않는다 [ASVS v5.0.0-15.4.2]', async () => {
    const w = await world();
    const other = randomUUID();
    await putSold(other, 3, 0);
    const a = randomUUID();
    await admin.pool.query(
      `insert into seat_sale (event_id, seat_id, order_id, account_id, status)
       values ($1::uuid, gen_random_uuid(), gen_random_uuid(), $2::uuid, 'PENDING'), ($1::uuid, gen_random_uuid(), gen_random_uuid(), $2::uuid, 'SOLD'), ($1::uuid, gen_random_uuid(), gen_random_uuid(), $2::uuid, 'RETURNED')`,
      [w.eventId, a],
    );
    expect(await w.sale.activeSaleCount(w.eventId)).toBe(2);
  });
});

// ───────────────────────────── 7. 결제 중 셈(payingByTier) ─────────────────────────────

describe('DrizzleSalePaying.payingByTier', () => {
  const fakeHeld = (i: number): Held => ({ ref: SEATS[i]!, accountId: randomUUID(), holdId: uuidv7(fakeClock({ now: Date.now() })), psid: `ps-${randomUUID()}` });

  test('ST25_ADR0122_RESERVED 주문의 PENDING만 등급별로 센다. 입금 대기·결과 모름·판매 확정·되돌린 행·다른 회차는 세지 않고 0인 등급은 넣지 않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    await pay(w, fakeHeld(0), 'RESERVED', { noPin: true });
    await pay(w, fakeHeld(1), 'RESERVED', { noPin: true });
    await pay(w, fakeHeld(5), 'RESERVED', { noPin: true });
    await pay(w, fakeHeld(2), 'AWAITING_DEPOSIT', { noPin: true });
    await pay(w, fakeHeld(6), 'UNKNOWN', { noPin: true });
    await pay(w, fakeHeld(3), 'SOLD', { noPin: true });
    const returned = await pay(w, fakeHeld(4), 'RESERVED', { noPin: true });
    expect(await seatSales.releasePending({ eventId: w.eventId, orderId: returned.o.id, seatIds: [returned.h.ref.seatId], accountId: returned.h.accountId })).toBe(1);
    const other = await world();
    await pay(other, fakeHeld(0), 'RESERVED', { noPin: true });

    const paying = new DrizzleSalePaying({ database });
    expect(await paying.payingByTier(w.eventId, Date.now())).toEqual(new Map([['R', 2], ['S', 1]]));
    expect(await paying.payingByTier(randomUUID(), Date.now()), '행이 없는 회차').toEqual(new Map());
  });

  test('ST25_ADR0122_판매 예약이 승인 기한 10분 안일 때만 센다(정확히 10분 전은 지난 것, 1ms 안쪽은 센다). pending_until은 보지 않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = await world();
    const nowMs = Date.UTC(2026, 10, 9, 3, 0, 0, 0);
    const edge = await pay(w, fakeHeld(0), 'RESERVED', { noPin: true });
    const inside = await pay(w, fakeHeld(5), 'RESERVED', { noPin: true });
    await q('update seat_sale set reserved_at = $1 where order_id = $2', [new Date(nowMs - 600_000), edge.o.id]);
    await q('update seat_sale set reserved_at = $1, pending_until = $2 where order_id = $3', [new Date(nowMs - 599_999), new Date(nowMs - DAY), inside.o.id]);
    expect(await new DrizzleSalePaying({ database }).payingByTier(w.eventId, nowMs)).toEqual(new Map([['S', 1]]));
  });

  test('ST25_ADR0122_리뷰 고침 L9 회차 ID가 소문자 UUID가 아니면 쿼리를 보내지 않고 RangeError다(빈 Map으로 넘겨 거짓 매진 후보를 만들지 않는다) [ASVS v5.0.0-16.5.3]', async () => {
    const touched: string[] = [];
    const untouchable = new Proxy({} as Database, {
      get: (_t, p) => {
        touched.push(String(p));
        throw new Error(`DB에 갔다: ${String(p)}`);
      },
    });
    await expect(new DrizzleSalePaying({ database: untouchable }).payingByTier('NOT-A-UUID', Date.now())).rejects.toBeInstanceOf(RangeError);
    expect(touched).toEqual([]);
  });

  /** db.execute와 pool.query를 엿보는 대역(나머지는 실제로 보낸다) */
  function spyDatabase(real: Database): { db: Database; sqls: (SQL | { text: string; params: unknown[] })[] } {
    const sqls: (SQL | { text: string; params: unknown[] })[] = [];
    const db = new Proxy(real.db, {
      get: (t, p, r) => (p === 'execute' ? (x: SQL) => (sqls.push(x), real.db.execute(x)) : Reflect.get(t, p, r)),
    });
    const pool = new Proxy(real.pool, {
      get: (t, p) => {
        if (p === 'query') return (text: string, params: unknown[]) => (sqls.push({ text, params }), t.query(text, params));
        const v = Reflect.get(t, p) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    return { db: new Proxy(real, { get: (t, p) => (p === 'db' ? db : p === 'pool' ? pool : Reflect.get(t, p)) }), sqls };
  }

  test('ST25_ADR0122_결제 중 셈은 한 문장이고, 큰 표에서도 seat_sale을 부분 인덱스 seat_sale_pending_idx로 읽는다(EXPLAIN, saga-e2e H1 본보기: 큰 표는 같은 트랜잭션에 넣고 되돌린다)', async () => {
    const w = await world();
    await pay(w, fakeHeld(0), 'RESERVED', { noPin: true });
    const spy = spyDatabase(database);
    await new DrizzleSalePaying({ database: spy.db }).payingByTier(w.eventId, Date.now());
    expect(spy.sqls, '결제 중 셈은 한 문장(db.execute 또는 pool.query)').toHaveLength(1);
    const first = spy.sqls[0]!;
    const { text, params } = 'text' in first ? first : (() => {
      const q2 = new PgDialect().sqlToQuery(first);
      return { text: q2.sql, params: q2.params };
    })();

    const client = await admin.pool.connect();
    let nodes: Record<string, unknown>[];
    try {
      await client.query('begin');
      // 팔린 행이 PENDING보다 훨씬 많은 회차, 다른 회차의 PENDING을 넣는다
      await client.query(
        `insert into seat_sale (event_id, seat_id, order_id, account_id, status)
         select $1::uuid, gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'SOLD' from generate_series(1, 20000)`,
        [w.eventId],
      );
      await client.query(
        `insert into seat_sale (event_id, seat_id, order_id, account_id, status)
         select gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), 'PENDING' from generate_series(1, 5000)`,
      );
      await client.query(
        `with o as (insert into purchase_order (id, account_id, event_id, status, amount, event_seq, idempotency_key, consent_version, seat_assignment, created_at, hold_id, purchase_session_id)
                    select gen_random_uuid(), gen_random_uuid(), $1::uuid, 'CONFIRMED', 0, 1, 'k', 'v1', 'PICK', now(), gen_random_uuid(), 'ps' from generate_series(1, 20000)
                    returning id),
              e as (insert into order_event (order_id, seq, from_status, to_status, cause, actor, occurred_at) select id, 1, null, 'CONFIRMED', 'TEST', 'test', now() from o)
         insert into order_item (order_id, line_no, seat_id, tier, section_id, unit_price) select id, 1, gen_random_uuid(), 'R', 'A', 0 from o`,
        [randomUUID()],
      );
      for (const t of ['seat_sale', 'purchase_order', 'order_item']) await client.query(`analyze ${t}`);
      await client.query('set local enable_seqscan = off');
      const r = await client.query<{ 'QUERY PLAN': [{ Plan: Record<string, unknown> }] }>(`explain (format json) ${text}`, params);
      nodes = planNodes(r.rows[0]!['QUERY PLAN'][0].Plan);
      await client.query('rollback');
    } finally {
      client.release();
    }
    const scan = nodes.find((n) => n['Index Name'] === 'seat_sale_pending_idx');
    expect(scan, JSON.stringify(nodes.filter((n) => n['Relation Name'] === 'seat_sale' || n['Index Name']))).toBeDefined();
    // 리뷰 고침 L11: 승인 기한 조건이 거르기(Filter)가 아니라 인덱스 조건이다(오래 묵은 PENDING을 읽지 않는다)
    expect(String(scan!['Index Cond']), JSON.stringify(scan)).toMatch(/reserved_at/);
  });
});

// ───────────────────────────── 8. 받는 쪽(queue-svc) 처리기와 값 맞추기 ─────────────────────────────

describe('queue-svc EventSaleChangedHandler와 값이 맞는다', () => {
  const decodeOf = (key: string, raw: string) =>
    new EventSaleChangedHandler(undefined as never).decode({ topic: TOPIC, partition: 0, offset: 0n, key, value: Buffer.from(raw, 'utf8'), headers: {}, timestamp: 0 } satisfies ConsumedMessage);

  test('ST25_ADR0122_첫 사건·다시 낸 사건·상태가 바뀐 사건의 Outbox 값이 queue-svc decode에서 그대로 kind sale이고 키는 회차, 중복 제거 키는 eventKey다', async () => {
    const w = await world();
    await tickOf(w);
    await holdSeat(w, 0);
    w.clock.advance(5000);
    await tickOf(w); // 다시 내기
    await holdSeat(w, 1);
    await holdSeat(w, 2);
    await holdSeat(w, 3);
    await holdSeat(w, 4);
    await holdSeat(w, 5);
    await holdSeat(w, 6);
    await holdSeat(w, 7);
    await holdSeat(w, 8);
    await holdSeat(w, 9);
    w.clock.advance(1000);
    await tickOf(w);
    w.clock.advance(5000);
    await tickOf(w); // ALL_HELD(판이 바뀐 사건)
    const msgs = await saleMsgs(w.eventId);
    expect(msgs.map((m) => m.value.status).at(-1)).toBe('ALL_HELD');
    expect(msgs.length).toBeGreaterThanOrEqual(3);
    for (const m of msgs) {
      const r = decodeOf(m.key, m.raw);
      expect(r.kind, m.raw).toBe('sale');
      if (r.kind !== 'sale') continue;
      expect(r.event).toMatchObject({ eventId: w.eventId, status: m.value.status, version: m.value.version, eventKey: m.value.eventKey });
      const handler = new EventSaleChangedHandler(undefined as never);
      expect(handler.keyOf(r)).toBe(w.eventId);
      expect(handler.eventKeyOf(r)).toBe(m.value.eventKey);
    }
  });
});

// ───────────────────────────── 9. 임대 줄 ─────────────────────────────

describe('임대 줄 sale', () => {
  test('ST25_ADR0122_틱은 s:{event:E}:salesweep에 파드 ID를 수명 3초 이하로 쓰고, 그동안 다른 파드는 NOT_LEASED로 아무것도 쓰지 않는다. 만료 임대 키는 건드리지 않는다 [ASVS v5.0.0-15.4.4]', async () => {
    const w = await world();
    const leaseKey = `s:{event:${w.eventId}}:salesweep`;
    const sweepKey = `s:{event:${w.eventId}}:sweep`;
    await tickOf(w);
    expect(await cmd(leaseKey, ['GET', leaseKey])).toBe('pod-a');
    const ttl = Number(await cmd(leaseKey, ['PTTL', leaseKey]));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(3000);
    expect(await cmd(sweepKey, ['GET', sweepKey])).toBeNull();
    const before = await saleRow(w.eventId);
    w.clock.advance(1000);
    expect(await tickOf(w, w.other)).toMatchObject({ outcome: 'NOT_LEASED' });
    expect(await saleRow(w.eventId)).toEqual(before);
    expect(await saleMsgs(w.eventId)).toHaveLength(1);
  });
});
