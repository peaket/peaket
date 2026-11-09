// 좌석 Redis 다시 만들기 RB-06과 세대 올리기(BUILD_ORDER PRF-143)를 실제 Valkey 8.1 + PostgreSQL 18로 돈다(S-T26 ④).
// 규칙의 정본은 docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현', 저장소 요점은 docs/data.md §4 '다시 만들기 표와 원장 칸'·§5 '다시 만들기' 행,
// Lua 계약은 adapters/rebuild-lua.ts, 명세는 specs/seat.qnt의 rebuild(판매 먼저, 판매 없는 좌석에만 만료 전 원장 홀드, 보유 수, 세대 키는 마지막)다.
//
// 약속:
// - 시험마다 새 회차 ID(이번 달 UUIDv7, seat_hold 파티션에 들어간다)를 쓴다. 좌석 Redis에 그 회차 키가 하나도 없는 것이 '전체 유실'과 같다.
// - 씨앗(판매·원장 행)은 admin 풀의 직접 SQL로 넣고, 결과는 Redis 명령·직접 SQL로 읽어 단언한다.
// - 좌석맵은 seat_sale.seat_id가 uuid라 UUID 좌석 ID의 MemorySeatMap이다.
// - 세대 키 node(BUILD_ORDER PRF-168, seat-hold.md §6 '세대 올리기 감시의 첫 구현'): 판매 열기·끝내기·세대 올리기 Lua가 모두 그 노드의 표지를 Lua 안에서 구한다.
//   이 Valkey는 단일 노드라 표지가 'standalone'이다. 장애 조치(복제본 승격)는 세대 키 node를 HSET으로 다른 표지로 바꿔 흉내 낸다(클러스터 승격은 S-T26 측정의 몫).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { createDatabase, createHotRedis, type Database, type HotRedis, type RedisScript, systemClock, uuidv7 } from '@peaket/platform';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { ensureSeatHoldPartitions, migratePurchase } from '../scripts/migrate.mjs';
import {
  BEGIN_REBUILD_LUA,
  DrizzleSeatRebuildSource,
  FINISH_REBUILD_LUA,
  type HoldInput,
  type MemorySeatDef,
  MemorySeatMap,
  REBUILD_BATCH,
  REBUILD_QUOTAS_LUA,
  REBUILD_SEATS_LUA,
  BUMP_EPOCH_LUA,
  RedisSeatStore,
  type RebuildReport,
  routeStreamEntry,
  SeatRebuilder,
  type SeatRef,
  seatKeys,
  slotOf,
  toLedgerHoldEvent,
} from '../src/modules/inventory/index.js';
import { DAY, fingerprintOf } from '../test/hold-cases.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

let valkey: ValkeyContainer | undefined;
let server: PostgresContainer | undefined;
let redis: HotRedis;
let store: RedisSeatStore;
/** 파드 A·B의 DB 풀(동시 다시 만들기에서 두 파드) */
let dbA: Database;
let dbB: Database;
/** 씨앗 넣기·읽기용 풀 */
let admin: Database;

beforeAll(async () => {
  [valkey, server] = await Promise.all([startValkey(), startPostgres()]);
  await migratePurchase(server.url);
  await ensureSeatHoldPartitions(server.url);
  redis = await createHotRedis({ url: valkey.url });
  store = new RedisSeatStore(redis);
  dbA = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'rebuild-it-a' });
  dbB = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'rebuild-it-b' });
  admin = createDatabase({ url: server.url, profile: 'general', max: 4, applicationName: 'rebuild-it-admin' });
});

afterAll(async () => {
  await Promise.allSettled([redis?.close(), dbA?.close(), dbB?.close(), admin?.close()]);
  valkey?.stop();
  server?.stop();
});

// ───────────────────────────── 좌석맵(UUID 좌석) ─────────────────────────────

/** 색인 순과 문자 코드 순이 같은 UUID 좌석 ID */
const seatUuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
/** 회차 좌석 수. 색인 12 ~ 15는 판에 좌석이 없는 자리다 */
const SEAT_COUNT = 16;
/** 구역 A(구역 색인 0, 등급 R) = 색인 0 ~ 7, 구역 B(구역 색인 1, 등급 S) = 색인 8 ~ 11 */
const SEATS: SeatRef[] = Array.from({ length: 12 }, (_, i) => ({
  seatId: seatUuid(i + 1),
  index: i,
  sectionId: i < 8 ? 'SEC-A' : 'SEC-B',
  sectionIndex: i < 8 ? 0 : 1,
  seatOffset: i < 8 ? i : i - 8,
  tierId: i < 8 ? 'R' : 'S',
}));
const S = (i: number): SeatRef => SEATS[i]!;

function seatMapOf(eventId: string, defs: readonly MemorySeatDef[] = SEATS, seatCount = SEAT_COUNT): MemorySeatMap {
  const m = new MemorySeatMap();
  m.put({ eventId, layoutVersion: 'v1', seatCount, perAccountLimit: 4, saleEndsAtMs: Date.now() + DAY }, defs);
  return m;
}

// ───────────────────────────── 씨앗(purchase DB) ─────────────────────────────

const q = (text: string, params: unknown[] = []) => admin.pool.query(text, params);

const putSale = (eventId: string, seatId: string, accountId: string, orderId: string, status: 'PENDING' | 'SOLD' | 'RETURNED') =>
  q('insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ($1, $2, $3, $4, $5)', [eventId, seatId, orderId, accountId, status]);

interface LedgerSeed {
  seatId: string;
  accountId: string;
  token: number;
  status: 'HELD' | 'RELEASED' | 'EXPIRED';
  kind: 'FAN' | 'PRIORITY';
  heldAtMs: number;
  expiresAtMs: number;
  holdId: string | null;
  purchaseSessionId: string | null;
}

const putHold = (eventId: string, h: LedgerSeed) =>
  q(
    `insert into seat_hold (event_id, seat_id, account_id, fencing_token, status, kind, held_at, expires_at, hold_id, purchase_session_id)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [eventId, h.seatId, h.accountId, h.token, h.status, h.kind, new Date(h.heldAtMs), new Date(h.expiresAtMs), h.holdId, h.purchaseSessionId],
  );

const MIN = 60_000;
const T0 = 1_762_250_000_000_001;

/**
 * 기본 세계(회차 하나):
 * - 판매: 색인 0 SOLD A(주문 O1), 색인 1 PENDING A(주문 O1), 색인 2 SOLD B(주문 O2), 색인 3 RETURNED C(빈 좌석), 판에 없는 좌석 SOLD C(넘김),
 *   다른 회차의 색인 8 SOLD(이 회차와 상관없음)
 * - 원장: 색인 4 HELD B(FAN, 만료 전, holdId·psid 있음) → 되살림, 색인 9 HELD C(PRIORITY, 만료 전) → 되살림, 색인 5 HELD A 만료됨 → 빈 좌석,
 *   색인 6 HELD C 만료 전이지만 hold_id 없음(옛 행) → 빈 좌석·넘김, 색인 7 RELEASED B → 빈 좌석, 판에 없는 좌석 HELD A(넘김)
 * - 기대: 비트 1 = {0, 1, 2, 4, 9}, sold 3, held 2, skipped 3(hold_id 없음 1 + 판에 없는 판매 1 + 판에 없는 홀드 1), 보유 수 A 2·B 2·C 1
 */
async function seedWorld() {
  const eventId = uuidv7(systemClock);
  const [A, B, C, D] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const [O1, O2, O3, O4] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const now = Date.now();
  await putSale(eventId, S(0).seatId, A, O1, 'SOLD');
  await putSale(eventId, S(1).seatId, A, O1, 'PENDING');
  await putSale(eventId, S(2).seatId, B, O2, 'SOLD');
  await putSale(eventId, S(3).seatId, C, O3, 'RETURNED');
  await putSale(eventId, randomUUID(), C, O4, 'SOLD');
  await putSale(uuidv7(systemClock), S(8).seatId, D, randomUUID(), 'SOLD');

  const live = (seat: number, accountId: string, token: number, kind: 'FAN' | 'PRIORITY' = 'FAN'): LedgerSeed => ({
    seatId: S(seat).seatId,
    accountId,
    token,
    status: 'HELD',
    kind,
    heldAtMs: now - MIN,
    expiresAtMs: now + 5 * MIN + seat,
    holdId: uuidv7(systemClock),
    purchaseSessionId: randomUUID(),
  });
  const holdB = live(4, B, T0 + 4);
  const holdC = live(9, C, T0 + 9, 'PRIORITY');
  await putHold(eventId, holdB);
  await putHold(eventId, holdC);
  await putHold(eventId, { ...live(5, A, T0 + 5), heldAtMs: now - 20 * MIN, expiresAtMs: now - 13 * MIN });
  await putHold(eventId, { ...live(6, C, T0 + 6), holdId: null, purchaseSessionId: null });
  await putHold(eventId, { ...live(7, B, T0 + 7), status: 'RELEASED' });
  await putHold(eventId, { ...live(0, A, T0 + 50), seatId: randomUUID() });
  return { eventId, A, B, C, D, O1, O2, holdB, holdC, seatMap: seatMapOf(eventId) };
}
type World = Awaited<ReturnType<typeof seedWorld>>;

/** 다시 만든 뒤 비트가 1인 색인(기본 세계) */
const LIT = [0, 1, 2, 4, 9];

// ───────────────────────────── 좌석 Redis 읽기 ─────────────────────────────

const cmd = (key: string, args: string[]) => redis.command(args, { key });

/** HGETALL 응답(RESP2 평평한 배열, RESP3 Map·객체)을 글 사전으로 */
function hash(v: unknown): Record<string, string> {
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [String(k), String(x)]));
  if (Array.isArray(v)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < v.length; i += 2) o[String(v[i])] = String(v[i + 1]);
    return o;
  }
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, String(x)]));
  return {};
}
const numOrNull = (v: unknown) => (v === null || v === undefined ? null : Number(v));

const bit = async (e: string, i: number) => Number(await cmd(seatKeys.bitmap(e), ['GETBIT', seatKeys.bitmap(e), String(i)]));
const bits = (e: string) => Promise.all(Array.from({ length: SEAT_COUNT }, (_, i) => bit(e, i)));
const holdHash = async (e: string, i: number) => {
  const h = hash(await cmd(seatKeys.hold(e, i), ['HGETALL', seatKeys.hold(e, i)]));
  return Object.keys(h).length ? h : null;
};
const expiryScore = async (e: string, i: number) => numOrNull(await cmd(seatKeys.expiry(e), ['ZSCORE', seatKeys.expiry(e), String(i)]));
const quota = async (e: string, a: string) => numOrNull(await cmd(seatKeys.quota(e, a), ['GET', seatKeys.quota(e, a)]));
const epochHash = async (e: string) => {
  const h = hash(await cmd(seatKeys.epoch(e), ['HGETALL', seatKeys.epoch(e)]));
  return Object.keys(h).length ? h : null;
};
const exists = async (key: string) => Number(await cmd(key, ['EXISTS', key])) === 1;
const expireAt = async (key: string) => Number(await cmd(key, ['PEXPIRETIME', key]));
const inCtlEvents = async (e: string) => Number(await cmd(seatKeys.ctlEvents(), ['SISMEMBER', seatKeys.ctlEvents(), e])) === 1;

/** seat_rebuild 행(없으면 null) */
async function rebuildRow(eventId: string) {
  const r = await q('select gen, holder, lease_until from seat_rebuild where event_id = $1', [eventId]);
  if (r.rows.length === 0) return null;
  const x = r.rows[0] as { gen: number; holder: string | null; lease_until: Date | null };
  return { gen: Number(x.gen), holder: x.holder, leaseUntil: x.lease_until };
}

/** Docker 엔진 VM의 시계와 이 PC 시계의 차이(초 단위 세대 견주기) */
const SKEW_S = 5;
/** 단일 노드 Valkey의 주 노드 표지(hold-lua.ts NODE_ID) */
const STANDALONE = 'standalone';
/** 승격 전 주 노드의 표지 흉내(클러스터 모양 '{CLUSTER MYID}:{cluster_my_epoch}') */
const OLD_PRIMARY = '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d:3';

// ───────────────────────────── 홀드 입력 ─────────────────────────────

function holdOf(eventId: string, idxs: number[], accountId: string, keepUntilMs: number): HoldInput {
  const seats = idxs.map(S).sort((a, b) => (a.seatId < b.seatId ? -1 : 1));
  return {
    eventId,
    accountId,
    purchaseSessionId: randomUUID(),
    holdId: uuidv7(systemClock),
    idempotencyKey: randomUUID(),
    fingerprint: fingerprintOf(seats.map((s) => s.seatId)),
    seats,
    limit: 4,
    keepUntilMs,
  };
}

const rebuilderOf = (w: { seatMap: MemorySeatMap }, holder = 'pod-a', db: Database = dbA, signals?: { rebuilt(r: string): void }) =>
  new SeatRebuilder({ source: new DrizzleSeatRebuildSource(db), target: store, seatMap: w.seatMap, holder, ...(signals ? { signals } : {}) });

/** 다시 만든 뒤 기본 세계의 좌석 Redis 모습(한 번 다시 만든 것과 같아야 하는 끝 상태) */
async function expectRebuilt(w: World, o: { keepUntilMs: number; before: number; after: number }): Promise<void> {
  const e = w.eventId;
  // 비트: 판매 좌석과 되살린 홀드만 1
  expect(await bits(e)).toEqual(Array.from({ length: SEAT_COUNT }, (_, i) => (LIT.includes(i) ? 1 : 0)));
  // 판매 좌석: 묶음(pin '1')·owner = 판매 계정·holdId = 주문 ID(그 좌석·계정의 원장 홀드가 없다), fence = Redis TIME µs, heldAt = exp = 지금 ms. 만료 인덱스에 없다
  const sold = (owner: string, holdId: string) =>
    expect.objectContaining({ holdId, owner, pin: '1', fence: expect.stringMatching(/^[1-9][0-9]{15}$/), heldAt: expect.stringMatching(/^[1-9][0-9]{12}$/), kind: 'FAN', ext: '0' });
  for (const [i, owner, holdId] of [
    [0, w.A, w.O1],
    [1, w.A, w.O1],
    [2, w.B, w.O2],
  ] as const) {
    const h = await holdHash(e, i);
    expect(h).toEqual(sold(owner, holdId));
    expect(h!.exp).toBe(h!.heldAt);
    expect(Number(h!.heldAt)).toBeGreaterThanOrEqual(o.before - SKEW_S * 1000);
    expect(Number(h!.heldAt)).toBeLessThanOrEqual(o.after + SKEW_S * 1000);
  }
  for (const i of [0, 1, 2]) expect(await expiryScore(e, i), `판매 좌석 ${i}의 만료 인덱스`).toBeNull();
  // 되살린 홀드: 원장 값 그대로(ext '0', pin 없음)와 만료 인덱스(점수 = exp)
  for (const [i, h] of [
    [4, w.holdB],
    [9, w.holdC],
  ] as const) {
    expect(await holdHash(e, i)).toEqual({
      holdId: h.holdId!,
      owner: h.accountId,
      psid: h.purchaseSessionId!,
      fence: String(h.token),
      heldAt: String(h.heldAtMs),
      exp: String(h.expiresAtMs),
      kind: h.kind,
      ext: '0',
    });
    expect(await expiryScore(e, i)).toBe(h.expiresAtMs);
  }
  // 빈 좌석(RETURNED·만료된 원장·hold_id 없는 원장·RELEASED·판에 없는 자리)은 Hash·만료 인덱스가 없다
  for (const i of [3, 5, 6, 7, 8, 10, 11]) {
    expect(await holdHash(e, i), `빈 좌석 ${i}의 Hash`).toBeNull();
    expect(await expiryScore(e, i), `빈 좌석 ${i}의 만료 인덱스`).toBeNull();
  }
  // 보유 수 = 판매 + 되살린 홀드(판에 없는 좌석·넘긴 홀드는 세지 않는다)
  expect([await quota(e, w.A), await quota(e, w.B), await quota(e, w.C), await quota(e, w.D)]).toEqual([2, 2, 1, null]);
  // 세대 키: epoch = Redis TIME 초, node = 그 노드의 표지(단일 노드 standalone, 판매 열기와 같은 뜻. 다시 만든 파드 이름이 아니다, PRF-168), gen = 올린 판 번호(2)
  const ep = await epochHash(e);
  expect(ep).toMatchObject({ node: STANDALONE, gen: '2' });
  expect(Number(ep!.epoch)).toBeGreaterThanOrEqual(Math.floor(o.before / 1000) - SKEW_S);
  expect(Number(ep!.epoch)).toBeLessThanOrEqual(Math.ceil(o.after / 1000) + SKEW_S);
  // 회차 목록에 다시 들어가고, 펜싱 카운터는 되살린 토큰의 최댓값(색인 9의 T0 + 9)이다
  expect(await inCtlEvents(e)).toBe(true);
  expect(await cmd(seatKeys.fence(e), ['GET', seatKeys.fence(e)])).toBe(String(w.holdC.token));
  expect(await expireAt(seatKeys.fence(e))).toBe(o.keepUntilMs);
  // 키 수명은 keepUntilMs
  for (const k of [seatKeys.bitmap(e), seatKeys.expiry(e), seatKeys.epoch(e), seatKeys.hold(e, 0), seatKeys.hold(e, 4), seatKeys.quota(e, w.A)]) expect(await expireAt(k), k).toBe(o.keepUntilMs);
}

// ───────────────────────────── 시험 ─────────────────────────────

describe('다시 만들기 전: 세대 키가 없는 회차(전체 유실)', () => {
  test('ST26_세대 키가 서기 전의 홀드는 NOT_READY(503으로 미룸)이고 아무것도 쓰지 않는다 [ASVS v5.0.0-2.3.4] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    for (const idxs of [[5], [0], [4]]) expect(await store.hold(holdOf(w.eventId, idxs, w.D, keepUntilMs))).toEqual({ kind: 'NOT_READY' });
    expect(await bits(w.eventId)).toEqual(Array(SEAT_COUNT).fill(0));
    expect(await epochHash(w.eventId)).toBeNull();
    expect(await rebuildRow(w.eventId)).toBeNull();
  });

  test('ST26_isReady는 세대 키가 없으면 거짓, 판매 열기로 세대 키가 서면 참이다 [S-T26]', async () => {
    const w = await seedWorld();
    expect(await store.isReady(w.eventId)).toBe(false);
    await store.openSale({ eventId: w.eventId, seatCount: SEAT_COUNT, keepUntilMs: Date.now() + 2 * DAY });
    expect(await store.isReady(w.eventId)).toBe(true);
  });
});

describe('다시 만들기(RB-06): 판매·원장 홀드를 좌석 Redis에 다시 쓴다', () => {
  test('ST26_판매 좌석은 비트 1·묶음 Hash(pin 1, owner 판매 계정), 만료 전 원장 홀드는 비트·Hash(원장 값)·만료 인덱스, 만료·hold_id 없는 원장 홀드는 빈 좌석, 보유 수·세대 키(gen 2, node = 노드 표지 standalone)·회차 목록, 결과 REBUILT [ASVS v5.0.0-2.3.4] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    const before = Date.now();
    const report = await rebuilderOf(w).rebuild(w.eventId, { keepUntilMs });
    const after = Date.now();
    expect(report).toEqual<RebuildReport>({ result: 'REBUILT', gen: 2, sold: 3, held: 2, skipped: 3 });
    await expectRebuilt(w, { keepUntilMs, before, after });
    // 판 번호는 purchase DB에 커밋되어 있고 임대는 비었다
    expect(await rebuildRow(w.eventId)).toMatchObject({ gen: 2, leaseUntil: null });
  });

  test('ST26_다시 만든 뒤 판매 좌석·남의 되살린 홀드 좌석에 새 홀드는 CONFLICT이고(오버셀 0), 빈 좌석은 잡힌다 [ASVS v5.0.0-2.3.4] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    expect((await rebuilderOf(w).rebuild(w.eventId, { keepUntilMs })).result).toBe('REBUILT');
    for (const i of [0, 1, 2, 4, 9]) expect(await store.hold(holdOf(w.eventId, [i], w.D, keepUntilMs)), `색인 ${i}`).toEqual({ kind: 'CONFLICT', seatId: S(i).seatId });
    // 판매 계정·되살린 홀드의 주인과 다른 계정 D가 바꾼 것이 없다
    expect(await holdHash(w.eventId, 0)).toMatchObject({ owner: w.A, pin: '1' });
    expect(await holdHash(w.eventId, 4)).toMatchObject({ owner: w.B, holdId: w.holdB.holdId! });
    expect(await quota(w.eventId, w.D)).toBeNull();
    // 빈 좌석(만료된 원장 홀드의 색인 5)은 잡힌다
    expect((await store.hold(holdOf(w.eventId, [5], w.D, keepUntilMs))).kind).toBe('OK');
    expect(await quota(w.eventId, w.D)).toBe(1);
    expect((await bits(w.eventId)).filter((b) => b === 1)).toHaveLength(LIT.length + 1);
  });

  test('ST26_다시 만드는 동안 보낸 홀드는 NOT_READY이고, 판매 좌석·되살릴 홀드 좌석에는 끝난 뒤에도 잡히지 않는다(OK가 한 번도 없다) [ASVS v5.0.0-2.3.4] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    const kinds: string[] = [];
    let done = false;
    const run = rebuilderOf(w)
      .rebuild(w.eventId, { keepUntilMs })
      .finally(() => {
        done = true;
      });
    while (!done) {
      for (const i of [0, 4]) kinds.push((await store.hold(holdOf(w.eventId, [i], w.D, keepUntilMs))).kind);
    }
    expect((await run).result).toBe('REBUILT');
    for (const i of [0, 4]) kinds.push((await store.hold(holdOf(w.eventId, [i], w.D, keepUntilMs))).kind);
    expect(kinds).toContain('NOT_READY');
    expect(kinds.filter((k) => k !== 'NOT_READY' && k !== 'CONFLICT')).toEqual([]);
    expect(kinds.at(-1)).toBe('CONFLICT');
  });

  test('ST26_판매 좌석에 남의 만료 전 원장 홀드가 있어도 판매가 이긴다(owner = 판매 계정, 그 홀드는 보유 수에 없음). 같은 계정의 원장 홀드가 있으면 그 holdId를 쓴다 [ASVS v5.0.0-2.3.4] [S-T26]', async () => {
    const eventId = uuidv7(systemClock);
    const [A, C, D] = [randomUUID(), randomUUID(), randomUUID()];
    const [O5, O6] = [randomUUID(), randomUUID()];
    const now = Date.now();
    const base = { status: 'HELD' as const, kind: 'FAN' as const, heldAtMs: now - MIN, expiresAtMs: now + 5 * MIN };
    // 색인 0: C가 샀는데 원장에는 D의 만료 전 HELD가 남았다(적재가 늦음)
    await putSale(eventId, S(0).seatId, C, O5, 'SOLD');
    await putHold(eventId, { ...base, seatId: S(0).seatId, accountId: D, token: T0, holdId: uuidv7(systemClock), purchaseSessionId: randomUUID() });
    // 색인 1: A가 묶어 산 좌석에 A 자신의 원장 홀드가 있다 → 그 holdId
    const ownHold = uuidv7(systemClock);
    await putSale(eventId, S(1).seatId, A, O6, 'PENDING');
    await putHold(eventId, { ...base, seatId: S(1).seatId, accountId: A, token: T0 + 1, holdId: ownHold, purchaseSessionId: randomUUID() });
    const keepUntilMs = Date.now() + 2 * DAY;

    const report = await rebuilderOf({ seatMap: seatMapOf(eventId) }).rebuild(eventId, { keepUntilMs });
    expect(report).toMatchObject({ result: 'REBUILT', gen: 2, sold: 2, held: 0 });
    expect(await holdHash(eventId, 0)).toMatchObject({ owner: C, holdId: O5, pin: '1' });
    expect(await holdHash(eventId, 1)).toMatchObject({ owner: A, holdId: ownHold, pin: '1' });
    for (const i of [0, 1]) expect(await expiryScore(eventId, i)).toBeNull();
    expect([await quota(eventId, C), await quota(eventId, A), await quota(eventId, D)]).toEqual([1, 1, null]);
  });

  test('ST26_다시 부르면 READY(세대 키가 있음)이고 판 번호가 오르지 않는다. 지표 seat_rebuild_total{result}는 rebuilt 뒤 ready [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    const results: string[] = [];
    const signals = { rebuilt: (r: string) => void results.push(r) };
    expect((await rebuilderOf(w, 'pod-a', dbA, signals).rebuild(w.eventId, { keepUntilMs })).result).toBe('REBUILT');
    const ep = await epochHash(w.eventId);
    expect(await rebuilderOf(w, 'pod-a', dbA, signals).rebuild(w.eventId, { keepUntilMs })).toEqual({ result: 'READY' });
    expect(await rebuilderOf(w, 'pod-b', dbB).rebuild(w.eventId, { keepUntilMs })).toEqual({ result: 'READY' });
    expect(await rebuildRow(w.eventId)).toMatchObject({ gen: 2, leaseUntil: null });
    expect(await epochHash(w.eventId)).toEqual(ep);
    expect(results).toEqual(['rebuilt', 'ready']);
  });

  test('ST26_판매 열기로 세대 키가 선 회차는 READY이고 seat_rebuild 행을 만들지 않으며 좌석 Redis를 바꾸지 않는다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId: w.eventId, seatCount: SEAT_COUNT, keepUntilMs });
    const ep = await epochHash(w.eventId);
    expect(await rebuilderOf(w).rebuild(w.eventId, { keepUntilMs })).toEqual({ result: 'READY' });
    expect(await rebuildRow(w.eventId)).toBeNull();
    expect(await epochHash(w.eventId)).toEqual(ep);
    expect(await bits(w.eventId)).toEqual(Array(SEAT_COUNT).fill(0));
  });

  test('ST26_다른 파드가 임대 중이면 BUSY이고 좌석 Redis에 아무것도 쓰지 않는다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const w = await seedWorld();
    expect(await new DrizzleSeatRebuildSource(dbB).acquire(w.eventId, 'pod-b')).toBe(2);
    expect(await rebuilderOf(w, 'pod-a').rebuild(w.eventId, { keepUntilMs: Date.now() + 2 * DAY })).toEqual({ result: 'BUSY' });
    expect(await epochHash(w.eventId)).toBeNull();
    expect(await bits(w.eventId)).toEqual(Array(SEAT_COUNT).fill(0));
    expect(await rebuildRow(w.eventId)).toMatchObject({ gen: 2, holder: 'pod-b' });
  });

  test('ST26_두 SeatRebuilder(holder 다름)를 동시에 부르면(5라운드) 하나는 REBUILT, 하나는 BUSY 또는 READY이고 끝 상태는 한 번 다시 만든 것과 같다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    for (let round = 0; round < 5; round++) {
      const w = await seedWorld();
      const keepUntilMs = Date.now() + 2 * DAY;
      const before = Date.now();
      const [a, b] = await Promise.all([rebuilderOf(w, 'pod-a', dbA).rebuild(w.eventId, { keepUntilMs }), rebuilderOf(w, 'pod-b', dbB).rebuild(w.eventId, { keepUntilMs })]);
      const after = Date.now();
      const results = [a.result, b.result];
      expect(results.filter((r) => r === 'REBUILT'), `라운드 ${round}: ${results.join(', ')}`).toHaveLength(1);
      expect(['BUSY', 'READY'], `라운드 ${round}`).toContain(results.find((r) => r !== 'REBUILT'));
      expect(a.result === 'REBUILT' ? a : b).toEqual({ result: 'REBUILT', gen: 2, sold: 3, held: 2, skipped: 3 });
      await expectRebuilt(w, { keepUntilMs, before, after });
      expect(await rebuildRow(w.eventId), `라운드 ${round}`).toMatchObject({ gen: 2, leaseUntil: null });
    }
  });
});

describe('다시 만들기 Lua의 모양(rebuild-lua.ts 계약, ADR-0086)', () => {
  test('ST26_코드 리뷰_ 450석·225계정은 시작 Lua 한 번 → 좌석 Lua 3번(200·200·50석) → 보유 수 Lua 2번(200·25계정) → 끝내기 Lua(세대 키·펜싱 카운터만) 한 번이다. 다섯 다 #!lua로 시작하고 KEYS가 모두 회차 한 슬롯이다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    for (const src of [BEGIN_REBUILD_LUA, REBUILD_SEATS_LUA, REBUILD_QUOTAS_LUA, FINISH_REBUILD_LUA, BUMP_EPOCH_LUA]) expect(src.split('\n')[0]).toMatch(/^#!lua(\s|$)/);
    expect(REBUILD_BATCH).toBe(200);
    const eventId = uuidv7(systemClock);
    const count = 450;
    const defs: MemorySeatDef[] = Array.from({ length: count }, (_, i) => ({ seatId: seatUuid(1000 + i), index: i, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: i, tierId: 'R' }));
    const accounts = Array.from({ length: 225 }, () => randomUUID());
    const values: string[] = [];
    const params: unknown[] = [eventId];
    defs.forEach((d, i) => {
      const at = params.length;
      values.push(`($1, $${at + 1}, $${at + 2}, $${at + 3}, 'SOLD')`);
      params.push(d.seatId, randomUUID(), accounts[Math.floor(i / 2)]);
    });
    await q(`insert into seat_sale (event_id, seat_id, order_id, account_id, status) values ${values.join(', ')}`, params);

    const calls: { script: RedisScript; keys: string[]; args: string[] }[] = [];
    const rec: HotRedis = {
      command: (a, o) => redis.command(a, o),
      sendCommand: (a) => redis.sendCommand(a),
      evalScript: (s, k, a, o) => {
        calls.push({ script: s, keys: [...k], args: [...a] });
        return redis.evalScript(s, k, a, o);
      },
      close: () => redis.close(),
    };
    const keepUntilMs = Date.now() + 2 * DAY;
    const rebuilder = new SeatRebuilder({ source: new DrizzleSeatRebuildSource(dbA), target: new RedisSeatStore(rec), seatMap: seatMapOf(eventId, defs, count), holder: 'pod-a' });
    expect(await rebuilder.rebuild(eventId, { keepUntilMs })).toEqual({ result: 'REBUILT', gen: 2, sold: count, held: 0, skipped: 0 });

    expect(calls[0]!.script.source).toBe(BEGIN_REBUILD_LUA);
    expect(calls[0]!.keys).toEqual([seatKeys.bitmap(eventId), seatKeys.expiry(eventId), seatKeys.epoch(eventId), seatKeys.rebuild(eventId), seatKeys.ordered(eventId), seatKeys.paused(eventId)]);
    expect(calls[0]!.args).toEqual(['2', String(keepUntilMs)]);
    const seatCalls = calls.filter((c) => c.script.source === REBUILD_SEATS_LUA);
    expect(seatCalls.map((c) => c.keys.length - 4)).toEqual([200, 200, 50]);
    for (const c of seatCalls) {
      expect(c.keys.slice(0, 4)).toEqual([seatKeys.bitmap(eventId), seatKeys.expiry(eventId), seatKeys.epoch(eventId), seatKeys.rebuild(eventId)]);
      // ARGV: keepUntil, gen, 그다음 좌석마다 10칸
      expect(c.args.slice(0, 2)).toEqual([String(keepUntilMs), '2']);
      expect(c.args.length).toBe(2 + 10 * (c.keys.length - 4));
    }
    // 좌석은 색인 오름차순, KEYS 5..는 그 차례의 hold 키
    expect(seatCalls.flatMap((c) => c.keys.slice(4))).toEqual(defs.map((d) => seatKeys.hold(eventId, d.index)));
    // 판매 좌석 하나의 10칸: 색인, 'S', holdId(원장 홀드가 없어 주문 ID), owner, psid, 원장 행이 없어 fence·heldAt·exp는 ''(Lua가 TIME으로 채운다), kind 'FAN', 예비 ''
    const first = seatCalls[0]!.args.slice(2, 12);
    expect(first).toEqual(['0', 'S', expect.any(String), accounts[0], expect.any(String), '', '', '', 'FAN', '']);
    // 보유 수 Lua: 200계정씩, KEYS 1·2 = epoch·rebuild, ARGV = gen, keepUntil, 계정마다 2
    const quotaCalls = calls.filter((c) => c.script.source === REBUILD_QUOTAS_LUA);
    expect(quotaCalls.map((c) => c.keys.length - 2)).toEqual([200, 25]);
    for (const c of quotaCalls) {
      expect(c.keys.slice(0, 2)).toEqual([seatKeys.epoch(eventId), seatKeys.rebuild(eventId)]);
      expect(c.args.slice(0, 2)).toEqual(['2', String(keepUntilMs)]);
      expect(c.args.slice(2)).toEqual(c.keys.slice(2).map(() => '2'));
    }
    expect(new Set(quotaCalls.flatMap((c) => c.keys.slice(2)))).toEqual(new Set(accounts.map((a) => seatKeys.quota(eventId, a))));
    // 끝내기 Lua: 마지막 한 번, 세대 키·rebuild·펜싱 카운터만(원장 토큰이 없어 최댓값 '0'). ARGV에 node가 없다(Lua가 그 노드의 표지를 구한다, PRF-168)
    const finish = calls.filter((c) => c.script.source === FINISH_REBUILD_LUA);
    expect(finish).toHaveLength(1);
    expect(calls.at(-1)?.script.source).toBe(FINISH_REBUILD_LUA);
    expect(finish[0]!.keys).toEqual([seatKeys.epoch(eventId), seatKeys.rebuild(eventId), seatKeys.fence(eventId)]);
    expect(finish[0]!.args).toEqual(['2', String(keepUntilMs), '0']);
    expect(await epochHash(eventId)).toMatchObject({ node: STANDALONE, gen: '2' });
    expect(calls.map((c) => c.script.source)).toEqual([BEGIN_REBUILD_LUA, ...seatCalls.map(() => REBUILD_SEATS_LUA), ...quotaCalls.map(() => REBUILD_QUOTAS_LUA), FINISH_REBUILD_LUA]);
    expect(new Set(calls.flatMap((c) => c.keys).map(slotOf)).size).toBe(1);

    // 좌석 Redis: 450석 모두 비트 1, 계정마다 2, 펜싱 카운터는 만들지 않는다
    const ones = Number(await cmd(seatKeys.bitmap(eventId), ['BITCOUNT', seatKeys.bitmap(eventId)]));
    expect(ones).toBe(count);
    for (const a of [accounts[0]!, accounts[224]!]) expect(await quota(eventId, a)).toBe(2);
    expect(await exists(seatKeys.fence(eventId))).toBe(false);
  });
});

describe('세대 올리기(장애 조치 뒤, ADR-0121 결정 5, BUILD_ORDER PRF-168)', () => {
  /** 승격 흉내: 세대 키 node를 옛 주 노드 표지로 바꾼다(epoch·gen·수명은 그대로) */
  const pretendFailover = (e: string) => cmd(seatKeys.epoch(e), ['HSET', seatKeys.epoch(e), 'node', OLD_PRIMARY]);

  test('ST26_판매 열기 뒤 세대 키 node가 지금 노드 표지(standalone)와 같으면 SAME이고 세대 키를 바꾸지 않는다(장애 조치가 없으면 오르지 않는다) [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = uuidv7(systemClock);
    const keepUntilMs = Date.now() + 2 * DAY;
    const o = await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    // chk = 표지를 견준 초(판매 열기가 세대와 같은 TIME 초로 둔다, 세대 올리기는 견줄 때마다 그 초로 둔다, ADR-0210)
    expect(await epochHash(e)).toEqual({ epoch: String(o.seatEpoch), node: STANDALONE, gen: '1', chk: String(o.seatEpoch) });
    expect(await store.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: o.seatEpoch, bumps: 0 });
    expect(await store.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: o.seatEpoch, bumps: 0 });
    expect(await epochHash(e)).toMatchObject({ epoch: String(o.seatEpoch), node: STANDALONE, gen: '1' });
    expect(await expireAt(seatKeys.epoch(e))).toBe(keepUntilMs);
  });

  test('ST26_다시 만들기 끝내기와 판매 열기가 세대 키 node에 같은 표지(standalone, 파드 이름 아님)를 적어, 다시 만든 회차에 세대 올리기를 불러도 SAME이다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const w = await seedWorld();
    expect((await rebuilderOf(w, 'pod-a').rebuild(w.eventId, { keepUntilMs: Date.now() + 2 * DAY })).result).toBe('REBUILT');
    const opened = uuidv7(systemClock);
    await store.openSale({ eventId: opened, seatCount: SEAT_COUNT, keepUntilMs: Date.now() + 2 * DAY });
    const rebuiltEp = (await epochHash(w.eventId))!;
    expect(rebuiltEp.node).toBe(STANDALONE);
    expect(rebuiltEp.node).toBe((await epochHash(opened))!.node);
    expect(await store.bumpEpoch(w.eventId)).toEqual({ result: 'SAME', epoch: Number(rebuiltEp.epoch), bumps: 0 });
  });

  test('ST26_세대 키 node를 다른 표지로 바꿔 두면(승격 흉내) BUMPED 한 번(epoch ≥ 이전 + 1, node = standalone, gen·수명 그대로), 다시 부르면 SAME이다. 좌석은 그대로다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    expect((await rebuilderOf(w, 'pod-a').rebuild(w.eventId, { keepUntilMs })).result).toBe('REBUILT');
    const e0 = Number((await epochHash(w.eventId))!.epoch);
    await pretendFailover(w.eventId);

    const bumped = await store.bumpEpoch(w.eventId);
    expect(bumped).toMatchObject({ result: 'BUMPED', bumps: 1 });
    const e1 = (bumped as { epoch: number }).epoch;
    expect(e1).toBeGreaterThanOrEqual(e0 + 1);
    expect(await epochHash(w.eventId)).toMatchObject({ epoch: String(e1), node: STANDALONE, gen: '2', bumps: '1' });
    expect(await expireAt(seatKeys.epoch(w.eventId))).toBe(keepUntilMs);
    expect(await store.bumpEpoch(w.eventId)).toEqual({ result: 'SAME', epoch: e1, bumps: 1 });
    expect(await bits(w.eventId)).toEqual(Array.from({ length: SEAT_COUNT }, (_, i) => (LIT.includes(i) ? 1 : 0)));
  });

  test('ST26_승격 흉내 뒤 같은 회차에 세대 올리기를 여럿이 동시에 부르면 세대는 한 번만 오른다(BUMPED 하나, 나머지 SAME과 같은 epoch) [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const w = await seedWorld();
    expect((await rebuilderOf(w, 'pod-a').rebuild(w.eventId, { keepUntilMs: Date.now() + 2 * DAY })).result).toBe('REBUILT');
    await pretendFailover(w.eventId);
    const rs = await Promise.all(Array.from({ length: 6 }, () => store.bumpEpoch(w.eventId)));
    expect(rs.filter((r) => r.result === 'BUMPED')).toHaveLength(1);
    expect(rs.filter((r) => r.result === 'SAME')).toHaveLength(5);
    const epochs = new Set(rs.map((r) => (r as { epoch: number }).epoch));
    expect(epochs.size).toBe(1);
    expect(await epochHash(w.eventId)).toMatchObject({ epoch: String([...epochs][0]), node: STANDALONE, gen: '2' });
  });

  test('ST26_세대 키가 없는 회차는 NOT_READY이고 세대 키를 만들지 않는다 [S-T26]', async () => {
    const e = uuidv7(systemClock);
    expect(await store.bumpEpoch(e)).toEqual({ result: 'NOT_READY' });
    expect(await exists(seatKeys.epoch(e))).toBe(false);
  });

  test('ST26_세대 올리기 Lua는 KEYS 세대 키 하나에 ARGV가 없다(지금 노드의 표지는 Lua가 구한다) [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = uuidv7(systemClock);
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs: Date.now() + 2 * DAY });
    const calls: { script: RedisScript; keys: string[]; args: string[] }[] = [];
    const rec: HotRedis = {
      command: (a, o) => redis.command(a, o),
      sendCommand: (a) => redis.sendCommand(a),
      evalScript: (s, k, a, o) => {
        calls.push({ script: s, keys: [...k], args: [...a] });
        return redis.evalScript(s, k, a, o);
      },
      close: () => redis.close(),
    };
    const r = await new RedisSeatStore(rec).bumpEpoch(e);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.script.source).toBe(BUMP_EPOCH_LUA);
    expect(calls[0]!.keys).toEqual([seatKeys.epoch(e)]);
    expect(calls[0]!.args).toEqual([]);
    expect(r.result).toBe('SAME');
  });
});

describe('다시 만든 뒤의 묶기(판 번호, S-T5)', () => {
  test('ST5_빈 좌석이 있는 주문을 옛 판 번호(orderGen 1)로 묶으면 STALE_GEN이고 아무것도 쓰지 않는다. orderGen 2면 그 좌석을 다시 잡아 묶는다 [ASVS v5.0.0-2.3.4] [S-T5] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    expect((await rebuilderOf(w).rebuild(w.eventId, { keepUntilMs })).result).toBe('REBUILT');
    const order = { eventId: w.eventId, accountId: w.A, purchaseSessionId: randomUUID(), holdId: uuidv7(systemClock), seats: [S(5)], limit: 4, keepUntilMs };
    expect(await store.pin({ ...order, orderGen: 1 })).toEqual({ kind: 'STALE_GEN', gen: 2 });
    expect(await bit(w.eventId, 5)).toBe(0);
    expect(await holdHash(w.eventId, 5)).toBeNull();
    expect(await quota(w.eventId, w.A)).toBe(2);

    const p = await store.pin({ ...order, orderGen: 2 });
    expect(p).toMatchObject({ kind: 'OK', gen: 2, regrabbed: 1 });
    expect(await bit(w.eventId, 5)).toBe(1);
    expect(await holdHash(w.eventId, 5)).toMatchObject({ owner: w.A, holdId: order.holdId, pin: '1' });
    expect(await quota(w.eventId, w.A)).toBe(3);
  });

  test('ST5_되살린 홀드는 원장의 holdId·구매 세션으로 주인이 묶을 수 있다(모두 내 홀드라 판 번호와 관계없이 OK, regrabbed 0) [ASVS v5.0.0-2.3.4] [S-T5] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    expect((await rebuilderOf(w).rebuild(w.eventId, { keepUntilMs })).result).toBe('REBUILT');
    const pin = { eventId: w.eventId, accountId: w.B, purchaseSessionId: w.holdB.purchaseSessionId!, holdId: w.holdB.holdId!, seats: [S(4)], limit: 4, orderGen: 1, keepUntilMs };
    expect(await store.pin(pin)).toEqual({ kind: 'OK', gen: 2, regrabbed: 0 });
    expect(await holdHash(w.eventId, 4)).toMatchObject({ owner: w.B, holdId: w.holdB.holdId!, pin: '1' });
    // 남의 holdId로는 묶지 못한다
    expect((await store.pin({ ...pin, accountId: w.D, holdId: uuidv7(systemClock) })).kind).toBe('TAKEN');
  });
});

describe('시험 검토 B가 더한 경계', () => {
  test('ST26_세대 키가 이미 선 회차(판매 열기)에 좌석 쓰기 Lua를 직접 부르면 READY이고 좌석에 아무것도 쓰지 않는다(다른 곳이 막 다시 만든 좌석을 덮어쓰지 않는다) [ASVS v5.0.0-2.3.4] [S-T26]', async () => {
    const eventId = uuidv7(systemClock);
    const keepUntilMs = Date.now() + 2 * DAY;
    await store.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs });

    expect(await store.writeSeats(eventId, [{ mode: 'SOLD', seat: S(0), accountId: uuidv7(systemClock), holdId: uuidv7(systemClock), purchaseSessionId: '' }], keepUntilMs, 2)).toEqual({ result: 'READY', gen: 1 });

    expect(await bits(eventId)).toEqual(Array(SEAT_COUNT).fill(0));
    expect(await exists(seatKeys.hold(eventId, 0))).toBe(false);
  });

  test('ST26_세대 올리기는 옛 세대가 지금 초보다 한참 작아도 지금 초 이상으로 올린다(max(epoch + 1, TIME 초)) [S-T26]', async () => {
    const w = await seedWorld();
    expect((await rebuilderOf(w, 'pod-a').rebuild(w.eventId, { keepUntilMs: Date.now() + 2 * DAY })).result).toBe('REBUILT');
    // 옛 세대와 승격 흉내(옛 주 노드 표지)
    await cmd(seatKeys.epoch(w.eventId), ['HSET', seatKeys.epoch(w.eventId), 'epoch', '100', 'node', OLD_PRIMARY]);
    const nowSec = Math.floor(Date.now() / 1000);

    const b = await store.bumpEpoch(w.eventId);

    expect(b.result).toBe('BUMPED');
    expect((b as { epoch: number }).epoch).toBeGreaterThanOrEqual(nowSec - 5);
  });

  test('ST26_세대 올리기는 옛 세대가 지금 초보다 커도 꼭 하나 올린다(max(epoch + 1, TIME 초)의 + 1. 같은 초 안에 부르는 시험만으로는 + 1을 빠뜨린 구현이 가끔 지나간다) [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const e = uuidv7(systemClock);
    await store.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs: Date.now() + 2 * DAY });
    // 지금 초보다 한참 큰 옛 세대와 승격 흉내(옛 주 노드 표지)
    const ahead = Math.floor(Date.now() / 1000) + 100_000;
    await cmd(seatKeys.epoch(e), ['HSET', seatKeys.epoch(e), 'epoch', String(ahead), 'node', OLD_PRIMARY]);

    expect(await store.bumpEpoch(e)).toEqual({ result: 'BUMPED', epoch: ahead + 1, bumps: 1 });
    expect(await epochHash(e)).toMatchObject({ epoch: String(ahead + 1), node: STANDALONE, gen: '1' });
  });
});

describe('시험 검토 B가 더한 경계(PRF-168): 클러스터 모드(노드 하나)의 표지', () => {
  // 단일 노드 Valkey는 표지가 'standalone'이라 Lua가 nodeId()를 부르지 않고 글자 'standalone'을 박아 두어도 위 시험이 모두 지나간다.
  // 클러스터 모드(노드 하나, 설정 세대 3)에서는 표지가 '{CLUSTER MYID}:3'이라 세 Lua가 모두 nodeId()로 같은 표지를 구하는지 가린다
  const CONFIG_EPOCH = 3;
  let cluster: ValkeyContainer | undefined;
  let clusterRedis: HotRedis | undefined;
  let clusterStore: RedisSeatStore;
  let me: string;

  beforeAll(async () => {
    cluster = await startValkey({ cluster: true, configEpoch: CONFIG_EPOCH });
    clusterRedis = await createHotRedis({ url: cluster.url });
    clusterStore = new RedisSeatStore(clusterRedis);
    me = `${String(await clusterRedis.command(['CLUSTER', 'MYID'], { key: 'x' }))}:${CONFIG_EPOCH}`;
  });

  afterAll(async () => {
    await clusterRedis?.close();
    cluster?.stop();
  });

  const clusterEpoch = async (e: string) => hash(await clusterRedis!.command(['HGETALL', seatKeys.epoch(e)], { key: seatKeys.epoch(e) }));

  test('ST26_클러스터 모드에서는 판매 열기·끝내기·세대 올리기가 모두 Lua가 구한 {CLUSTER MYID}:{cluster_my_epoch}를 세대 키 node에 쓰고 견준다: 연 회차·다시 만든 회차는 SAME, node를 옛 표지로 바꾸면 BUMPED 한 번 뒤 node = 그 표지다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const keepUntilMs = Date.now() + 2 * DAY;
    // 판매 열기
    const opened = uuidv7(systemClock);
    const o = await clusterStore.openSale({ eventId: opened, seatCount: SEAT_COUNT, keepUntilMs });
    // chk = 표지를 견준 초(판매 열기가 세대와 같은 TIME 초로 둔다, ADR-0210)
    expect(await clusterEpoch(opened)).toEqual({ epoch: String(o.seatEpoch), node: me, gen: '1', chk: String(o.seatEpoch) });
    expect(await clusterStore.bumpEpoch(opened)).toEqual({ result: 'SAME', epoch: o.seatEpoch, bumps: 0 });

    // 다시 만들기 끝내기
    const w = await seedWorld();
    const rebuilder = new SeatRebuilder({ source: new DrizzleSeatRebuildSource(dbA), target: clusterStore, seatMap: w.seatMap, holder: 'pod-a' });
    expect((await rebuilder.rebuild(w.eventId, { keepUntilMs })).result).toBe('REBUILT');
    const rebuilt = await clusterEpoch(w.eventId);
    expect(rebuilt).toMatchObject({ node: me, gen: '2', chk: rebuilt.epoch });
    expect(await clusterStore.bumpEpoch(w.eventId)).toEqual({ result: 'SAME', epoch: Number(rebuilt.epoch), bumps: 0 });

    // 승격 흉내: 옛 주 노드 표지로 바꾸면 한 번 오르고 node = 지금 표지
    await clusterRedis!.command(['HSET', seatKeys.epoch(w.eventId), 'node', OLD_PRIMARY], { key: seatKeys.epoch(w.eventId) });
    const b = await clusterStore.bumpEpoch(w.eventId);
    expect(b).toMatchObject({ result: 'BUMPED', bumps: 1 });
    expect(await clusterEpoch(w.eventId)).toMatchObject({ epoch: String((b as { epoch: number }).epoch), node: me, gen: '2' });
    expect(await clusterStore.bumpEpoch(w.eventId)).toEqual({ result: 'SAME', epoch: (b as { epoch: number }).epoch, bumps: 1 });
  });

  const setEpochFields = (e: string, fields: string[]) => clusterRedis!.command(['HSET', seatKeys.epoch(e), ...fields], { key: seatKeys.epoch(e) });
  /** 시계가 뒤로 가 남은 미래의 chk(먼 앞 초, 리뷰 고침 낮음 d) */
  const FAR_CHK = '9999999999';

  test('ST26_리뷰 고침 H1_ 세대 올리기 Lua도 쓰는 Lua와 같은 도우미 규칙이다: 노드 ID가 같고 설정 세대만 다르면 chk가 이번 초인 동안 SAME(CLUSTER INFO 0번), chk가 지난 초면 BUMPED 한 번(CLUSTER INFO 1번, node = 지금 표지, chk = 그 초)이다. 미래의 chk는 이번 초로 보지 않고(리뷰 고침 낮음 d), 다른 노드 ID는 chk와 관계없이 BUMPED다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const r = clusterRedis!;
    const e = uuidv7(systemClock);
    const o = await clusterStore.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs: Date.now() + 2 * DAY });
    const stale = `${me.split(':')[0]}:${CONFIG_EPOCH - 1}`;

    // 같은 초 안(chk = 지금 초): 노드 ID만 견준다
    const same = await inOneSecond(r, (sec) => setEpochFields(e, ['node', stale, 'chk', String(sec)]), async () => ({ before: await clusterEpoch(e), b: await clusterStore.bumpEpoch(e) }));
    expect(same.out.b).toMatchObject({ result: 'SAME', epoch: Number(same.out.before.epoch) });
    expect(same.infoCalls, '같은 초 안의 CLUSTER INFO').toBe(0);
    expect(await clusterEpoch(e)).toMatchObject({ node: stale, chk: String(same.sec) });

    await setEpochFields(e, ['node', stale, 'chk', '1']);
    const sec0 = await timeSec(r);
    const c1 = await infoCalls(r);
    const b = await clusterStore.bumpEpoch(e);
    expect((await infoCalls(r)) - c1, '지난 초의 CLUSTER INFO').toBe(1);
    expect(b.result).toBe('BUMPED');
    const ep = await clusterEpoch(e);
    expect(ep).toMatchObject({ epoch: String((b as { epoch: number }).epoch), node: me, gen: '1' });
    expect(Number(ep.chk)).toBeGreaterThanOrEqual(sec0);
    expect(Number(ep.epoch)).toBeGreaterThanOrEqual(o.seatEpoch + 1);

    // 감시가 같은 초 안에 다시 불러도 설정 세대를 다시 견주지 않는다
    const again = await inOneSecond(r, (sec) => setEpochFields(e, ['chk', String(sec)]), () => clusterStore.bumpEpoch(e));
    expect(again.out).toMatchObject({ result: 'SAME', epoch: (b as { epoch: number }).epoch });
    expect(again.infoCalls).toBe(0);

    // 미래의 chk(시계가 뒤로 감)는 이번 초로 보지 않는다: 설정 세대까지 견줘 올린다
    await setEpochFields(e, ['node', stale, 'chk', FAR_CHK]);
    const c3 = await infoCalls(r);
    const b3 = await clusterStore.bumpEpoch(e);
    expect((await infoCalls(r)) - c3, '미래 chk의 CLUSTER INFO').toBe(1);
    expect(b3.result).toBe('BUMPED');
    expect(Number((await clusterEpoch(e)).chk)).toBeLessThanOrEqual(await timeSec(r));

    // 다른 노드 ID는 chk가 이번 초여도 올린다(노드 ID는 매번 견준다)
    await setEpochFields(e, ['node', OLD_PRIMARY, 'chk', String(await timeSec(r))]);
    const b2 = await clusterStore.bumpEpoch(e);
    expect(b2.result).toBe('BUMPED');
    expect((b2 as { epoch: number }).epoch).toBeGreaterThan((b3 as { epoch: number }).epoch);
    expect(await clusterEpoch(e)).toMatchObject({ node: me });
  });
});

/** Valkey TIME의 초(Lua가 쓰는 시계) */
const timeSec = async (r: HotRedis) => Number(((await r.command(['TIME'], { key: 'x' })) as unknown[])[0]);
/** INFO commandstats의 cmdstat_cluster|info calls(스크립트 안에서 부른 것도 센다). 없으면 0 */
const infoCalls = async (r: HotRedis) => Number(/cmdstat_cluster\|info:calls=(\d+)/.exec(String(await r.command(['INFO', 'commandstats'], { key: 'x' })))?.[1] ?? '0');

/**
 * '같은 초 안'(chk = 지금 TIME 초, ADR-0210 결정 2·리뷰 고침 낮음 d: chk가 지금 초와 같을 때만 설정 세대 견주기를 건너뛴다).
 * set(초)로 세대 키를 맞추고 call을 부른 뒤 TIME 초가 그대로면(그 Lua가 그 초에 돌았다) 결과와 그사이 CLUSTER INFO 수를 돌려준다.
 * 초가 바뀌었으면 다시 맞춰 부른다(5번까지, 고정 sleep 없음)
 */
async function inOneSecond<T>(r: HotRedis, set: (sec: number) => Promise<unknown>, call: () => Promise<T>): Promise<{ out: T; sec: number; infoCalls: number }> {
  for (let k = 0; k < 5; k++) {
    const sec = await timeSec(r);
    await set(sec);
    const c0 = await infoCalls(r);
    const out = await call();
    const c1 = await infoCalls(r);
    if ((await timeSec(r)) === sec) return { out, sec, infoCalls: c1 - c0 };
  }
  throw new Error("TIME 초가 다섯 번 모두 바뀌어 '같은 초 안'을 만들지 못했다");
}

describe('리뷰 고침 시험 더하기(PRF-168): 실제 설정 세대를 바꾼 노드 하나짜리 클러스터(CLUSTER BUMPEPOCH)', () => {
  // 설정 세대 0으로 띄운다(설정 세대가 이미 가장 큰 노드 하나짜리 클러스터에서는 CLUSTER BUMPEPOCH가 STILL이라 0 → 1 한 번만 오른다)
  let c: ValkeyContainer | undefined;
  let cr: HotRedis | undefined;
  let cs: RedisSeatStore;
  let id: string;

  beforeAll(async () => {
    c = await startValkey({ cluster: true });
    cr = await createHotRedis({ url: c.url });
    cs = new RedisSeatStore(cr);
    id = String(await cr.command(['CLUSTER', 'MYID'], { key: 'x' }));
  });

  afterAll(async () => {
    await cr?.close();
    c?.stop();
  });

  const epochOf = async (e: string) => hash(await cr!.command(['HGETALL', seatKeys.epoch(e)], { key: seatKeys.epoch(e) }));
  const setChk = (e: string, chk: string) => cr!.command(['HSET', seatKeys.epoch(e), 'chk', chk], { key: seatKeys.epoch(e) });

  test('ST26_리뷰 고침 시험 더하기_ CLUSTER BUMPEPOCH로 그 노드의 설정 세대가 0에서 1로 바뀌면, 같은 초(chk = 그 초) 안의 세대 올리기·홀드는 노드 ID가 같아 오르지 않고(CLUSTER INFO 0번), 다음 초(chk = 지난 초로 흉내)의 홀드가 한 번 올려 node = {MYID}:1·HELD의 seatEpoch = 새 세대이며, 그 뒤 세대 올리기는 SAME이다 [ASVS v5.0.0-15.4.2] [S-T26]', async () => {
    const r = cr!;
    const e = uuidv7(systemClock);
    const keepUntilMs = Date.now() + 2 * DAY;
    const o = await cs.openSale({ eventId: e, seatCount: SEAT_COUNT, keepUntilMs });
    expect(await epochOf(e)).toMatchObject({ epoch: String(o.seatEpoch), node: `${id}:0` });

    expect(String(await r.command(['CLUSTER', 'BUMPEPOCH'], { key: 'x' }))).toBe('BUMPED 1');
    expect(String(await r.command(['CLUSTER', 'INFO'], { key: 'x' }))).toMatch(/cluster_my_epoch:1\r?\n/);

    // 같은 초 안: 노드 ID만 견주므로 바뀐 설정 세대를 아직 보지 않는다(세대 올리기도, 홀드도). 초가 바뀌어 다시 하면 옛 표지로 되돌리고 다음 좌석을 잡는다
    let seat = 0;
    const same = await inOneSecond(
      r,
      (sec) => r.command(['HSET', seatKeys.epoch(e), 'node', `${id}:0`, 'chk', String(sec)], { key: seatKeys.epoch(e) }),
      async () => ({ before: await epochOf(e), b: await cs.bumpEpoch(e), h: await cs.hold(holdOf(e, [seat++], randomUUID(), keepUntilMs)) }),
    );
    expect(same.out.b).toEqual({ result: 'SAME', epoch: Number(same.out.before.epoch), bumps: Number(same.out.before.bumps ?? 0) });
    expect(same.out.h.kind).toBe('OK');
    expect(same.infoCalls, '같은 초 안의 CLUSTER INFO').toBe(0);
    expect(await epochOf(e)).toMatchObject({ epoch: same.out.before.epoch, node: `${id}:0`, chk: String(same.sec) });

    // 다음 초(chk를 지난 초로 고쳐 흉내): 홀드가 설정 세대까지 견줘 한 번 올린다
    const before = await epochOf(e);
    await setChk(e, String(same.sec - 1));
    const c0 = await infoCalls(r);
    const h = await cs.hold(holdOf(e, [seat], randomUUID(), keepUntilMs));
    expect(h.kind).toBe('OK');
    expect((await infoCalls(r)) - c0, '다음 초의 CLUSTER INFO').toBe(1);
    const ep = await epochOf(e);
    expect(ep).toMatchObject({ node: `${id}:1`, gen: '1', bumps: String(Number(before.bumps ?? 0) + 1) });
    expect(Number(ep.epoch)).toBeGreaterThanOrEqual(Number(before.epoch) + 1);
    const items = (await r.command(['XRANGE', seatKeys.stream(e), '-', '+'], { key: seatKeys.stream(e) })) as unknown[];
    expect(hash((items.at(-1) as unknown[])[1])).toMatchObject({ type: 'HELD', seatIdx: String(seat), seatEpoch: ep.epoch });

    // 그 뒤로는 오르지 않는다(지난 chk여도 표지가 같다)
    expect(await cs.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: Number(ep.epoch), bumps: Number(ep.bumps) });
    await setChk(e, '1');
    expect(await cs.bumpEpoch(e)).toEqual({ result: 'SAME', epoch: Number(ep.epoch), bumps: Number(ep.bumps) });
  });
});

describe('코드 리뷰 재현(PRF-143)', () => {
  /** HotRedis를 감싸 이름이 맞는 호출을 처음 한 번만 던지게 한다 */
  function failingOnce(match: (args: readonly string[], script?: RedisScript) => boolean): { rec: HotRedis; error: Error } {
    const error = new Error('좌석 Redis 일시 장애(시험)');
    let armed = true;
    const rec: HotRedis = {
      command: (a, o) => {
        if (armed && match(a)) {
          armed = false;
          return Promise.reject(error);
        }
        return redis.command(a, o);
      },
      sendCommand: (a) => redis.sendCommand(a),
      evalScript: (s, k, a, o) => {
        if (armed && match(a, s)) {
          armed = false;
          return Promise.reject(error);
        }
        return redis.evalScript(s, k, a, o);
      },
      close: () => redis.close(),
    };
    return { rec, error };
  }

  test('ST26_ST7_코드 리뷰_ 결제 중 판매 좌석의 holdId·토큰은 만료 시각이 지난 HELD 원장 행에서 온다: 다시 만든 뒤 그 holdId로 실패 해제가 풀고, RELEASED 항목이 릴레이·원장 적재 모양을 지난다 [ASVS v5.0.0-2.3.4] [S-T26] [S-T7]', async () => {
    const eventId = uuidv7(systemClock);
    const [A, O, H, P] = [randomUUID(), randomUUID(), uuidv7(systemClock), randomUUID()];
    const now = Date.now();
    await putSale(eventId, S(0).seatId, A, O, 'PENDING');
    // 묶인 지 10분: 원장은 HELD인 채 처음 만료 시각(3분 전)이 지났다
    await putHold(eventId, { seatId: S(0).seatId, accountId: A, token: T0 + 77, status: 'HELD', kind: 'FAN', heldAtMs: now - 10 * MIN, expiresAtMs: now - 3 * MIN, holdId: H, purchaseSessionId: P });
    const keepUntilMs = Date.now() + 2 * DAY;
    expect(await rebuilderOf({ seatMap: seatMapOf(eventId) }).rebuild(eventId, { keepUntilMs })).toMatchObject({ result: 'REBUILT', sold: 1, held: 0 });
    expect(await holdHash(eventId, 0)).toEqual({ holdId: H, owner: A, psid: P, fence: String(T0 + 77), heldAt: String(now - 10 * MIN), exp: String(now - 3 * MIN), kind: 'FAN', ext: '0', pin: '1' });
    expect(await cmd(seatKeys.fence(eventId), ['GET', seatKeys.fence(eventId)])).toBe(String(T0 + 77));

    expect(await store.releaseFailed({ eventId, accountId: A, holdId: H, seats: [S(0)], keepUntilMs })).toEqual({ kind: 'OK', released: 1 });
    expect(await bit(eventId, 0)).toBe(0);
    const entries = (await cmd(seatKeys.stream(eventId), ['XRANGE', seatKeys.stream(eventId), '-', '+'])) as [unknown, unknown][];
    const [id, raw] = entries.at(-1)!;
    const route = routeStreamEntry(eventId, { id: String(id), fields: hash(raw) });
    expect(route.kind).toBe('send');
    const ledger = toLedgerHoldEvent(JSON.parse(JSON.stringify((route as { message: object }).message)));
    expect(ledger).toMatchObject({ type: 'RELEASED', fencingToken: T0 + 77, holdId: H, accountId: A, seatId: S(0).seatId });
  });

  test('ST26_코드 리뷰_ 끝내기의 회차 목록 SADD는 Lua 앞이다: SADD가 실패하면 세대 키가 서지 않아(NOT_READY) 다음 번이 다시 만들고 목록에 넣는다 [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    const { rec, error } = failingOnce((a) => a[0] === 'SADD' && a[1] === seatKeys.ctlEvents());
    const first = new SeatRebuilder({ source: new DrizzleSeatRebuildSource(dbA), target: new RedisSeatStore(rec), seatMap: w.seatMap, holder: 'pod-a' });
    await expect(first.rebuild(w.eventId, { keepUntilMs })).rejects.toBe(error);
    expect(await store.isReady(w.eventId)).toBe(false);
    expect(await inCtlEvents(w.eventId)).toBe(false);
    const before = Date.now();
    expect(await rebuilderOf(w).rebuild(w.eventId, { keepUntilMs })).toMatchObject({ result: 'REBUILT', gen: 3 });
    expect(await inCtlEvents(w.eventId)).toBe(true);
    expect(await epochHash(w.eventId)).toMatchObject({ node: STANDALONE, gen: '3' });
    expect(Number((await epochHash(w.eventId))!.epoch)).toBeGreaterThanOrEqual(Math.floor(before / 1000) - SKEW_S);
  });

  test('ST26_코드 리뷰_ 앞 시도가 좌석을 쓰고 끝내기 전에 실패한 뒤 판매가 풀리면, 다음 시도의 시작 Lua가 앞 시도의 비트·만료 인덱스를 지워 그 좌석은 빈 좌석이다 [ASVS v5.0.0-2.3.4] [S-T26]', async () => {
    const w = await seedWorld();
    const keepUntilMs = Date.now() + 2 * DAY;
    const { rec, error } = failingOnce((_a, s) => s?.source === FINISH_REBUILD_LUA);
    const first = new SeatRebuilder({ source: new DrizzleSeatRebuildSource(dbA), target: new RedisSeatStore(rec), seatMap: w.seatMap, holder: 'pod-a' });
    await expect(first.rebuild(w.eventId, { keepUntilMs })).rejects.toBe(error);
    expect(await bit(w.eventId, 0)).toBe(1);
    expect(await expiryScore(w.eventId, 4)).toBe(w.holdB.expiresAtMs);
    // 승인 거절로 색인 0의 판매가 지워지고, 색인 4의 원장 홀드는 풀렸다(DB만)
    await q('delete from seat_sale where event_id = $1 and seat_id = $2', [w.eventId, S(0).seatId]);
    await q("update seat_hold set status = 'RELEASED' where event_id = $1 and seat_id = $2", [w.eventId, S(4).seatId]);
    expect(await rebuilderOf(w).rebuild(w.eventId, { keepUntilMs })).toMatchObject({ result: 'REBUILT', gen: 3, sold: 2, held: 1 });
    expect(await bits(w.eventId)).toEqual(Array.from({ length: SEAT_COUNT }, (_, i) => ([1, 2, 9].includes(i) ? 1 : 0)));
    expect(await expiryScore(w.eventId, 4)).toBeNull();
    expect((await store.hold(holdOf(w.eventId, [0, 4], w.D, keepUntilMs))).kind).toBe('OK');
  });

  test('ST26_코드 리뷰_ 시작 Lua가 rebuild 키에 판 번호를 쓰면 낮은 판 번호의 시작·좌석·보유 수·끝내기는 STALE이고 아무것도 쓰지 않는다. 세대 키가 서면 READY와 그 gen이다 [ASVS v5.0.0-2.3.4] [S-T26]', async () => {
    const eventId = uuidv7(systemClock);
    const keepUntilMs = Date.now() + 2 * DAY;
    const seat = { mode: 'SOLD' as const, seat: S(3), accountId: randomUUID(), holdId: uuidv7(systemClock), purchaseSessionId: '' };
    // 판 번호 없이(시작 전) 쓰면 STALE
    expect(await store.writeSeats(eventId, [seat], keepUntilMs, 2)).toEqual({ result: 'STALE' });
    expect(await store.begin(eventId, 3, keepUntilMs)).toEqual({ result: 'OK' });
    expect(await cmd(seatKeys.rebuild(eventId), ['GET', seatKeys.rebuild(eventId)])).toBe('3');
    expect(await expireAt(seatKeys.rebuild(eventId))).toBe(keepUntilMs);
    expect(await store.begin(eventId, 2, keepUntilMs)).toEqual({ result: 'STALE' });
    expect(await store.writeSeats(eventId, [seat], keepUntilMs, 2)).toEqual({ result: 'STALE' });
    expect(await store.finish(eventId, { quotas: new Map([[seat.accountId, 1]]), gen: 2, keepUntilMs })).toEqual({ result: 'STALE' });
    expect(await bit(eventId, 3)).toBe(0);
    expect(await quota(eventId, seat.accountId)).toBeNull();
    expect(await epochHash(eventId)).toBeNull();
    // 내 판 번호는 쓴다
    expect(await store.writeSeats(eventId, [seat], keepUntilMs, 3)).toEqual({ result: 'OK' });
    expect(await store.finish(eventId, { quotas: new Map([[seat.accountId, 1]]), gen: 3, keepUntilMs, maxToken: 0 })).toEqual({ result: 'OK' });
    expect(await quota(eventId, seat.accountId)).toBe(1);
    // 세대 키가 선 뒤는 어느 판 번호든 READY와 세대 키의 gen
    for (const g of [2, 3, 4]) {
      expect(await store.begin(eventId, g, keepUntilMs)).toEqual({ result: 'READY', gen: 3 });
      expect(await store.writeSeats(eventId, [seat], keepUntilMs, g)).toEqual({ result: 'READY', gen: 3 });
    }
  });
});
