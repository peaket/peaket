// BAT-051(HOT-252) heavy gate 통합 시험: 실제 PostgreSQL 18·Valkey 8.1에서
// ① core-svc 내부 HTTP를 읽는 CoreSaleConfigs의 5초 캐시·404 1초 기억·5xx 닫힘,
// ② LayoutSeatMap의 판매 설정 덮어쓰기, ③ 홀드의 entryGate·evaluateSalePolicy·등급 혼합·403,
// ④ 입장 토큰 lst 1~10개 검사, ⑤ 홀드 Lua lim과 purchase_quota.limit_count 연결,
// ⑥ 같은 조건 동시 홀드의 1인 한도·quota 표본과 p50/p99를 본다.
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase, createExternalHttpClient, createHotRedis, fakeClock, type HotRedis, ProblemError, uuidv7 } from '@peaket/platform';
import type { SalePolicyRule } from '@peaket/validation/sale-policy';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migratePurchase } from '../scripts/migrate.mjs';
import {
  AdmissionTokenRejected,
  CoreSaleConfigs,
  DrizzleSeatSales,
  type EventSeatConfig,
  FileSeatMapSource,
  HoldError,
  type HoldCommand,
  HoldSeats,
  holdFingerprint,
  LayoutSeatMap,
  MemoryPurchaseSessions,
  MemorySeatMap,
  type MemorySeatDef,
  RecordingHoldAttempts,
  RedisOrderHolds,
  RedisSeatStore,
  type ResolvedPurchaseSessionInfo,
  SaleConfigUnavailable,
  type SeatRef,
  seatKeys,
  throwHoldProblem,
  verifyAdmissionToken,
} from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, newEvent, SEAT_COUNT, SEAT_DEFS } from '../test/hold-cases.js';
import { claimsOf, ISS, JNY, newKey, signAdmission } from '../test/admission-fixtures.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { startValkey, type ValkeyContainer } from './valkey.js';

const NOW = Date.now();
const KEY = 'lumen-fanclub-2026';
const LISTS = [KEY];
const policy = (): SalePolicyRule[] => [
  {
    version: 1,
    name: '팬클럽 선예매',
    rounds: 'ALL',
    during: { from: new Date(NOW - 3_600_000).toISOString(), to: new Date(NOW + 3_600_000).toISOString() },
    rule: { if: { fact: 'buyer.lists', has: KEY }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
  },
];

let valkey: ValkeyContainer | undefined;
let redis: HotRedis;
let pg: PostgresContainer | undefined;
let database: ReturnType<typeof createDatabase> | undefined;
let admin: ReturnType<typeof createDatabase> | undefined;

beforeAll(async () => {
  const [v, p] = await Promise.allSettled([startValkey(), startPostgres()]);
  if (v.status === 'fulfilled') valkey = v.value;
  if (p.status === 'fulfilled') pg = p.value;
  if (!valkey || !pg) throw (v.status === 'rejected' ? v.reason : (p as PromiseRejectedResult).reason) as Error;
  redis = await createHotRedis({ url: valkey.url });
  await migratePurchase(pg.url);
  database = createDatabase({ url: pg.url, profile: 'hot', max: 8, applicationName: 'bat051-int-hot' });
  admin = createDatabase({ url: pg.url, profile: 'general', max: 4, applicationName: 'bat051-int-admin' });
}, 180_000);

afterAll(async () => {
  await redis?.close();
  await Promise.allSettled([database?.close(), admin?.close()]);
  valkey?.stop();
  pg?.stop();
});

// ── core-svc 내부 HTTP 대역(실제 HTTP 서버) ─────────────────────────────────────────────────────────────

type Mode = 'ok' | '404' | '500' | 'bad';

interface CoreServer {
  url: string;
  mode: Mode;
  calls: number;
  close(): Promise<void>;
}

async function startCoreServer(body: unknown): Promise<CoreServer> {
  const state = { mode: 'ok' as Mode, calls: 0 };
  const server = createServer((_req, res) => {
    state.calls++;
    if (state.mode === '404') {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'not-found' }));
      return;
    }
    if (state.mode === '500') {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end('{}');
      return;
    }
    const payload = state.mode === 'bad' ? { ...(body as Record<string, unknown>), perPersonLimit: 9 } : body;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    get mode() {
      return state.mode;
    },
    set mode(v: Mode) {
      state.mode = v;
    },
    get calls() {
      return state.calls;
    },
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

const coreBody = (eventId: string, over: Record<string, unknown> = {}) => ({
  eventId,
  productionId: randomUUID(),
  promoterId: randomUUID(),
  rev: 7,
  opensAtMs: NOW,
  startsAtMs: NOW + DAY,
  lobbyMinutes: 10,
  lobbyShuffle: true,
  openBatch: true,
  perPersonLimit: 4,
  saleEndsAtMs: NOW + 3_600_000,
  layoutVersion: 9,
  salePolicy: policy(),
  eligGates: [],
  eligLists: LISTS,
  ...over,
});

const coreConfigs = (server: CoreServer, clock: ReturnType<typeof fakeClock>) =>
  new CoreSaleConfigs({
    client: createExternalHttpClient({ provider: 'core-svc-test', baseUrl: server.url, timeoutCapMs: 1_000 }),
    clock,
  });

describe('CoreSaleConfigs(실제 HTTP)', () => {
  test('BAT051_ 200이면 salePolicy·eligLists·한도·판매 종료를 읽고, 기본 5초 캐시 뒤 다시 읽는다', async () => {
    const eventId = randomUUID();
    const server = await startCoreServer(coreBody(eventId));
    const clock = fakeClock({ now: NOW });
    try {
      const configs = coreConfigs(server, clock);
      expect(await configs.get(eventId)).toMatchObject({ rev: 7, perPersonLimit: 4, salePolicy: policy(), eligLists: LISTS, layoutVersion: 9 });
      expect(await configs.get(eventId)).toMatchObject({ rev: 7 });
      expect(server.calls).toBe(1);
      clock.advance(5_001);
      await configs.get(eventId);
      expect(server.calls).toBe(2);
    } finally {
      await server.close();
    }
  });

  test('BAT051_ 404는 사본 없음으로 1초 기억하고 undefined다', async () => {
    const eventId = randomUUID();
    const server = await startCoreServer(coreBody(eventId));
    server.mode = '404';
    const clock = fakeClock({ now: NOW });
    try {
      const configs = coreConfigs(server, clock);
      expect(await configs.get(eventId)).toBeUndefined();
      expect(await configs.get(eventId)).toBeUndefined();
      expect(server.calls).toBe(1);
      clock.advance(1_001);
      expect(await configs.get(eventId)).toBeUndefined();
      expect(server.calls).toBe(2);
    } finally {
      await server.close();
    }
  });

  test('BAT051_ 5xx·모양 오류는 SaleConfigUnavailable로 닫는다(정책을 건너뛰지 않는다)', async () => {
    const eventId = randomUUID();
    const server = await startCoreServer(coreBody(eventId));
    const clock = fakeClock({ now: NOW });
    try {
      const configs = coreConfigs(server, clock);
      server.mode = '500';
      await expect(configs.get(eventId)).rejects.toBeInstanceOf(SaleConfigUnavailable);
      server.mode = 'bad';
      await expect(configs.get(eventId)).rejects.toBeInstanceOf(SaleConfigUnavailable);
    } finally {
      await server.close();
    }
  });
});

// ── LayoutSeatMap 덮어쓰기(실제 파일 출처 + 실제 HTTP) ───────────────────────────────────────────────────

const rawFile = {
  perAccountLimit: 2,
  saleEndsAt: '2026-12-23T10:00:00.000Z',
  layout: {
    layoutVersion: 7,
    canvas: { width: 1000, height: 800 },
    sections: [
      {
        sectionId: 'SEC-A',
        name: 'A구역',
        shape: { type: 'polygon', points: [] },
        tierId: 'R',
        seatIndexRange: { from: 0, to: 1 },
        seats: [
          { seatId: 'A01', row: 'A', number: 1, x: 10, y: 20, index: 0 },
          { seatId: 'A02', row: 'A', number: 2, x: 20, y: 20, index: 1 },
        ],
      },
    ],
  },
};

describe('LayoutSeatMap: core 사본을 파일 설정 위에 덮는다', () => {
  test('BAT051_ perPersonLimit·saleEndsAtMs·salePolicy·eligLists는 사본, 좌석·판 번호는 파일 판이다', async () => {
    const eventId = randomUUID();
    const server = await startCoreServer(coreBody(eventId, { perPersonLimit: 3, saleEndsAtMs: NOW + 7_200_000, layoutVersion: 9 }));
    const dir = await mkdtemp(join(tmpdir(), 'peaket-bat051-'));
    const clock = fakeClock({ now: NOW });
    try {
      await writeFile(join(dir, `${eventId}.json`), JSON.stringify(rawFile));
      const configs = coreConfigs(server, clock);
      const map = new LayoutSeatMap({ source: new FileSeatMapSource(dir), clock, overlay: configs });
      const c = await map.config(eventId);
      expect(c).toMatchObject({ perAccountLimit: 3, saleEndsAtMs: NOW + 7_200_000, salePolicy: policy(), eligLists: LISTS, saleConfigRev: 7, layoutVersion: '7', seatCount: 2 });
      expect((await map.resolve(eventId, ['A01']))[0]?.seatId).toBe('A01');
    } finally {
      await server.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ── HoldSeats: 실제 Valkey, 판매 정책·등급 혼합·403 ──────────────────────────────────────────────────────

function seatMapOf(eventId: string, rules: SalePolicyRule[], seats: readonly MemorySeatDef[] = SEAT_DEFS): MemorySeatMap {
  const m = new MemorySeatMap();
  const config: EventSeatConfig = { eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY, salePolicy: rules, eligLists: LISTS, saleConfigRev: 1 };
  m.put(config, seats);
  return m;
}

function holdHarness(seatMap: MemorySeatMap, eventId: string) {
  const clock = fakeClock({ now: NOW });
  const store = new RedisSeatStore(redis);
  const sessions = new MemoryPurchaseSessions();
  const attempts = new RecordingHoldAttempts();
  const uc = new HoldSeats(store, seatMap, sessions, attempts, clock);
  const session: ResolvedPurchaseSessionInfo = { sessionId: 'ps-bat051', accountId: ACCOUNT_A, eventId, journeyId: JNY };
  const run = (seatIds: readonly string[], lists: readonly string[] | undefined, c: Partial<HoldCommand> = {}) =>
    uc.execute({
      eventId,
      accountId: ACCOUNT_A,
      purchaseSessionId: 'ps-bat051',
      session,
      idempotencyKey: randomUUID(),
      body: { seatIds },
      ...(lists !== undefined ? { lists } : {}),
      ...c,
    });
  return { clock, store, uc, run };
}

function problemOf(e: HoldError): ProblemError {
  try {
    throwHoldProblem(e, { header: () => undefined });
  } catch (x) {
    if (x instanceof ProblemError) return x;
    throw x;
  }
  throw new Error('throwHoldProblem이 던지지 않았다');
}

describe('HoldSeats 판매 정책(실제 Valkey)', () => {
  test('BAT051_Q-T36③ lst가 없으면 entryGate가 PRESALE_ONLY로 403이고, lst가 있으면 규칙 한도 2가 홀드 Lua에 걸린다 [ASVS v5.0.0-2.3.2]', async () => {
    const eventId = newEvent();
    const map = seatMapOf(eventId, policy());
    const h = holdHarness(map, eventId);
    await h.store.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: NOW + 2 * DAY });
    const denied = await h.run(['A01'], []).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(HoldError);
    expect((denied as HoldError).code).toBe('SALE_POLICY_DENIED');
    expect((denied as HoldError).details.reason).toBe('PRESALE_ONLY');
    const p = problemOf(denied as HoldError);
    expect({ status: p.status, type: p.slug, reason: p.extensions.reason }).toEqual({ status: 403, type: 'sale-policy-denied', reason: 'PRESALE_ONLY' });
    expect(Number(await redis.command(['EXISTS', seatKeys.hold(eventId, 0)], { key: seatKeys.hold(eventId, 0) }))).toBe(0);

    const ok1 = await h.run(['A01'], LISTS);
    expect(ok1.seatIds).toEqual(['A01']);
    const holdKey = seatKeys.hold(eventId, 0);
    const lim = await redis.command(['HGET', holdKey, 'lim'], { key: holdKey });
    expect(String(lim)).toBe('2');
    expect((await h.run(['A02'], LISTS)).seatIds).toEqual(['A02']);
    const over = await h.run(['A03'], LISTS).catch((e: unknown) => e);
    expect(over).toBeInstanceOf(HoldError);
    expect((over as HoldError).code).toBe('QUOTA_EXCEEDED');
  });

  test('BAT051_ 등급이 섞인 홀드는 거부 등급이 하나라도 있으면 GRADE_NOT_ON_SALE 403이고, 허용 등급만이면 잡는다', async () => {
    const eventId = newEvent();
    const rules: SalePolicyRule[] = [{ version: 1, name: 'S등급 판매 중지', rounds: 'ALL', rule: { if: { fact: 'grade', eq: 'S' }, then: { deny: 'GRADE_NOT_ON_SALE' } } }];
    const map = seatMapOf(eventId, rules);
    const h = holdHarness(map, eventId);
    await h.store.openSale({ eventId, seatCount: SEAT_COUNT, keepUntilMs: NOW + 2 * DAY });
    const denied = await h.run(['A01', 'B01'], LISTS).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(HoldError);
    expect((denied as HoldError).code).toBe('SALE_POLICY_DENIED');
    expect((denied as HoldError).details.reason).toBe('GRADE_NOT_ON_SALE');
    expect(await h.run(['A01'], LISTS)).toMatchObject({ seatIds: ['A01'] });
  });

  test('BAT051_ lst는 1~10개의 중복 없는 명단 키만 받고 11개·빈 배열·틀린 키는 claims로 거절한다', () => {
    const key = newKey('k1');
    const keys = new Map([['k1', key.pub]]);
    const sign = (lst: unknown) => signAdmission(key, claimsOf({ nowMs: NOW, jti: randomUUID() }, { lst }));
    expect(verifyAdmissionToken(sign(['a-b']), { keys, issuer: ISS, nowMs: NOW }).lists).toEqual(['a-b']);
    expect(verifyAdmissionToken(sign(Array.from({ length: 10 }, (_, i) => `list-${i + 1}`)), { keys, issuer: ISS, nowMs: NOW }).lists).toHaveLength(10);
    for (const bad of [[], Array.from({ length: 11 }, (_, i) => `list-${i + 1}`), ['BAD'], ['a-b', 'a-b']]) {
      expect(() => verifyAdmissionToken(sign(bad), { keys, issuer: ISS, nowMs: NOW }), JSON.stringify(bad)).toThrow(AdmissionTokenRejected);
    }
  });
});

// ── 홀드 Hash lim → purchase_quota.limit_count(실제 Valkey·PostgreSQL) ─────────────────────────────────

const UUID_SEATS: MemorySeatDef[] = [
  { seatId: '00000000-0000-4000-8000-000000000001', index: 0, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 0, tierId: 'R' },
  { seatId: '00000000-0000-4000-8000-000000000002', index: 1, sectionId: 'SEC-A', sectionIndex: 0, seatOffset: 1, tierId: 'R' },
];

describe('홀드 Hash lim과 purchase_quota 한도(실제 Valkey·PostgreSQL)', () => {
  test('BAT051_ 홀드 때 쓴 lim 2를 OrderHolds.limit이 읽고, 예약의 purchase_quota.limit_count가 2가 되며 다음 예약은 QUOTA_EXCEEDED다 [ASVS v5.0.0-2.3.2]', async () => {
    const eventId = randomUUID();
    const map = new MemorySeatMap();
    map.put({ eventId, layoutVersion: 'v1', seatCount: 2, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, UUID_SEATS);
    const store = new RedisSeatStore(redis);
    const keepUntilMs = NOW + 2 * DAY;
    await store.openSale({ eventId, seatCount: 2, keepUntilMs });
    const seatIds = UUID_SEATS.map((s) => s.seatId);
    const seats = (await map.resolve(eventId, seatIds)).filter((s): s is SeatRef => s !== undefined);
    const accountId = ACCOUNT_A;
    const purchaseSessionId = 'ps-bat051-quota';
    const holdId = uuidv7(fakeClock({ now: NOW }));
    const held = await store.hold({
      eventId,
      accountId,
      purchaseSessionId,
      holdId,
      idempotencyKey: randomUUID(),
      fingerprint: holdFingerprint(seatIds),
      seats,
      limit: 2,
      keepUntilMs,
    });
    expect(held.kind).toBe('OK');
    const orderHolds = new RedisOrderHolds(redis, map);
    const limit = await orderHolds.limit({ eventId, accountId, purchaseSessionId, holdId, seatIds });
    expect(limit).toBe(2);

    const sales = new DrizzleSeatSales(database!);
    const firstOrder = randomUUID();
    expect(await sales.reserve({ eventId, accountId, orderId: firstOrder, seatIds, limit: limit! })).toEqual({ status: 'RESERVED' });
    const row = (await admin!.pool.query<{ limit_count: number; used: number }>('select limit_count, used from purchase_quota where account_id = $1 and event_id = $2', [accountId, eventId])).rows[0]!;
    expect({ limit_count: row.limit_count, used: row.used }).toEqual({ limit_count: 2, used: 2 });
    expect(await sales.reserve({ eventId, accountId, orderId: randomUUID(), seatIds: [randomUUID()], limit: limit! })).toEqual({ status: 'QUOTA_EXCEEDED' });
  });
});

// ── Q-T36 ③ 표본 측정: 같은 조건 동시 홀드 ──────────────────────────────────────────────────────────────

describe('Q-T36 ③ 동시 홀드 표본(실제 Valkey)', () => {
  test('BAT051_ 1인 2매 규칙에서 100 동시 홀드는 2 성공·98 한도 초과이고, 403·409는 각각 따로 센다 [ASVS v5.0.0-2.3.2]', async () => {
    const eventId = newEvent();
    const map = new MemorySeatMap();
    const seats = Array.from({ length: 100 }, (_, i) => ({ seatId: `M${String(i + 1).padStart(3, '0')}`, index: i, sectionId: 'SEC-M', sectionIndex: 0, seatOffset: i, tierId: 'R' }));
    map.put({ eventId, layoutVersion: 'v1', seatCount: 100, perAccountLimit: 4, saleEndsAtMs: NOW + DAY, salePolicy: policy(), eligLists: LISTS, saleConfigRev: 1 }, seats);
    const h = holdHarness(map, eventId);
    await h.store.openSale({ eventId, seatCount: 100, keepUntilMs: NOW + 2 * DAY });
    const started = seats.map(({ seatId }) => {
      const t0 = performance.now();
      return h.run([seatId], LISTS).then(
        (r) => ({ kind: 'OK' as const, ms: performance.now() - t0, r }),
        (e: unknown) => ({ kind: e instanceof HoldError ? e.code : ('ERROR' as const), ms: performance.now() - t0 }),
      );
    });
    const results = await Promise.all(started);
    const ok = results.filter((r) => r.kind === 'OK').length;
    const quota = results.filter((r) => r.kind === 'QUOTA_EXCEEDED').length;
    const other = results.filter((r) => r.kind !== 'OK' && r.kind !== 'QUOTA_EXCEEDED');
    const sorted = results.map((r) => r.ms).sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)]!;
    const p99 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.99))]!;
    // eslint-disable-next-line no-console
    console.log(`BAT051 Q-T36 ③ n=${results.length} ok=${ok} quota=${quota} other=${other.length} p50=${p50.toFixed(1)}ms p99=${p99.toFixed(1)}ms`);
    expect({ ok, quota, other: other.length }).toEqual({ ok: 2, quota: 98, other: 0 });

    // 403: 같은 회차·같은 계정이라도 lst가 없으면 정책 거부
    const denied = await h.run(['A21'], []).catch((e: unknown) => e);
    expect(denied).toBeInstanceOf(HoldError);
    expect((denied as HoldError).code).toBe('SALE_POLICY_DENIED');

    // 409: 다른 계정 둘이 같은 좌석을 동시에 잡으면 하나만 성공한다(정책은 lst를 허용)
    const conflictEvent = newEvent();
    const conflictMap = seatMapOf(conflictEvent, policy());
    const c1 = holdHarness(conflictMap, conflictEvent);
    await c1.store.openSale({ eventId: conflictEvent, seatCount: SEAT_COUNT, keepUntilMs: NOW + 2 * DAY });
    const sessionB: ResolvedPurchaseSessionInfo = { sessionId: 'ps-bat051-b', accountId: ACCOUNT_B, eventId: conflictEvent, journeyId: JNY };
    const runB = () =>
      c1.uc.execute({ eventId: conflictEvent, accountId: ACCOUNT_B, purchaseSessionId: 'ps-bat051-b', session: sessionB, idempotencyKey: randomUUID(), body: { seatIds: ['A01'] }, lists: LISTS });
    const both = await Promise.allSettled([c1.run(['A01'], LISTS), runB()]);
    expect(both.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = both.find((r) => r.status === 'rejected');
    expect(rejected?.status === 'rejected' && rejected.reason instanceof HoldError ? rejected.reason.code : undefined).toBe('CONFLICT');
  });
});
