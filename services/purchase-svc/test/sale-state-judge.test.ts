// 회차 판매 상태 판정 반복(SaleStateJudge, docs/features/seat-hold.md §4 '판정의 첫 구현', ADR-0122 '뒤에 정한 것', ADR-0214 결정 2·3, ADR-0219 결정 5·6, BUILD_ORDER PRF-144, S-T25).
// 좌석 Redis·DB·좌석맵 판은 모두 대역이고(임대만 메모리 구현), 시각은 가짜 시계, 반복은 손으로 tick()을 부른다(고정 sleep 없음).
// 판정 하나의 규칙은 test/sale-state-domain.test.ts, 실제 Lua·PostgreSQL을 쓴 끝까지의 시험은 test-int/sale-state.int.test.ts다.
// 차례는 설계의 '2026-11-09 고침'을 따른다: 좌석맵 판 → 임대 → 행 → 셈 → 결제 중 → 판정 → 쓰기(판이 없는 회차에 임대 키를 쓰지 않는다).
import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { type FakeClock, fakeClock, type PlatformLogger, PlatformMetrics } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import { DrizzleSalePaying } from '../src/modules/booking/index.js';
import type { EventSaleChange, EventSaleCreate, EventSaleRepublish, EventSaleStore, SaleCountsReader, SalePayingSeats, SaleStateSignals, SeatMap, SeatMapTiers, SweepLane, SweepLeases } from '../src/modules/inventory/domain/ports.js';
import {
  AVG_CACHE_MS,
  type EventSaleRow,
  type EventSeatConfig,
  MemorySeatStore,
  MemorySweepLeases,
  PromSaleStateSignals,
  RedisSaleCounts,
  SALE_JUDGE_CONCURRENCY,
  SALE_REPUBLISH_MS,
  SALE_TICK_MS,
  SALE_TIER_SCAN_PAGE,
  SALE_WARN_INTERVAL_MS,
  type SaleEventReport,
  type SaleLayout,
  SaleStateJudge,
  type SaleStateJudgeDeps,
  type SaleStatus,
  SeatStoreUnavailable,
  SWEEP_LEASE_TTL_MS,
  type SweepTimer,
} from '../src/modules/inventory/index.js';

const NOW = Date.parse('2026-11-09T03:00:00.000Z');
const DAY = 86_400_000;
const E = 'ev-a';

/** 대역이 부르는 단계. trace에 `${단계}:${회차}`로 남는다 */
type Step = 'saleEvents' | 'config' | 'layout' | 'acquire' | 'read' | 'counts' | 'holds' | 'paying' | 'active' | 'avg' | 'create' | 'apply' | 'republish';

/** 회차 하나의 세상(대역이 돌려줄 값) */
interface Scene {
  config: EventSeatConfig | undefined;
  layout: SaleLayout | undefined;
  /** true면 세대 키가 없다 */
  notReady: boolean;
  bitmap: Buffer;
  held: number;
  /** holdIndexes의 쪽들(start ÷ count번째 쪽). 없는 쪽은 빈 배열 */
  pages: number[][];
  paying: Map<string, number>;
  active: number;
  avg: number | undefined;
}

/** 등급 R 색인 0~5, 등급 S 색인 6~9, 판매 대상 10석 */
const defaultLayout = (): SaleLayout => ({
  sellableSeats: 10,
  tiers: [
    { tierId: 'R', indexes: [0, 1, 2, 3, 4, 5] },
    { tierId: 'S', indexes: [6, 7, 8, 9] },
  ],
});

/** 켜진 색인으로 비트맵을 만든다(높은 비트부터, Redis 비트맵 차례) */
function bitmapOf(on: Iterable<number>, bytes = 2): Buffer {
  const b = Buffer.alloc(bytes);
  for (const i of on) b[i >> 3]! |= 0x80 >> (i & 7);
  return b;
}
const ALL = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const FULL_PAGE = (index: number): number[] => Array.from({ length: SALE_TIER_SCAN_PAGE }, () => index);

/** 틱마다 나는 두 지표(allHeld·tickTimes)는 calls와 따로 모은다(calls는 일이 있을 때만 나는 지표다) */
function recordingSignals(): SaleStateSignals & { calls: string[]; allHeld: number[]; tickTimes: number[] } {
  const calls: string[] = [];
  const allHeld: number[] = [];
  const tickTimes: number[] = [];
  return {
    calls,
    allHeld,
    tickTimes,
    transition: (to) => void calls.push(`transition:${to}`),
    republished: () => void calls.push('republished'),
    guardBlocked: () => void calls.push('guardBlocked'),
    tickFailure: (s) => void calls.push(`failure:${s}`),
    skipped: (r, n) => void calls.push(n === undefined ? `skipped:${r}` : `skipped:${r}:${n}`),
    allHeldSeconds: (s) => void allHeld.push(s),
    tickSeconds: (s) => void tickTimes.push(s),
  };
}

function recordingLogger(): { logger: PlatformLogger; lines: { level: string; args: unknown[] }[] } {
  const lines: { level: string; args: unknown[] }[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]) =>
      void lines.push({ level, args });
  const logger: Record<string, unknown> = { error: at('error'), warn: at('warn'), info: at('info'), debug: at('debug'), fatal: at('fatal'), trace: at('trace') };
  logger.child = () => logger;
  return { logger: logger as unknown as PlatformLogger, lines };
}

function manualTimer() {
  const regs: { everyMs: number; run: () => void; cancelled: number }[] = [];
  const timer: SweepTimer = {
    every(everyMs, run) {
      const r = { everyMs, run, cancelled: 0 };
      regs.push(r);
      return { cancel: () => void (r.cancelled += 1) };
    },
  };
  return { timer, regs };
}

function deferred<T = void>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((ok) => {
    resolve = ok;
  });
  return { promise, resolve };
}

const flush = () => new Promise<void>((r) => setImmediate(r));

/**
 * 대역 조립 하나. 같은 world의 판정기 여럿은 같은 표·같은 임대를 나눈다(파드 여럿).
 * fail[단계]는 부를 때마다 불려 값을 돌려주면 그것을 던지고, wait[단계]는 그 약속을 기다린 뒤 진행한다. lose는 조건부 쓰기가 0행이 되게 한다.
 */
function world(ids: readonly string[] = [E], o: { clock?: FakeClock } = {}) {
  const clock = o.clock ?? fakeClock({ now: NOW, monotonic: 0 });
  const scenes = new Map<string, Scene>();
  for (const id of ids) {
    scenes.set(id, {
      config: { eventId: id, layoutVersion: 'v1', seatCount: 10, perAccountLimit: 4, saleEndsAtMs: NOW + DAY },
      layout: defaultLayout(),
      notReady: false,
      bitmap: bitmapOf([]),
      held: 0,
      pages: [],
      paying: new Map(),
      active: 0,
      avg: undefined,
    });
  }
  const scene = (id: string): Scene => scenes.get(id)!;
  const trace: string[] = [];
  const fail: Partial<Record<Step, (e: string) => unknown>> = {};
  const wait: Partial<Record<Step, (e: string) => Promise<void>>> = {};
  const lose = { create: false, apply: false, republish: false };
  const rows = new Map<string, EventSaleRow>();
  const writes = { create: [] as EventSaleCreate[], apply: [] as EventSaleChange[], republish: [] as EventSaleRepublish[] };
  const holdCalls: [string, number, number][] = [];
  const acquires: [string, string, number, SweepLane | undefined][] = [];
  const signals = recordingSignals();
  const log = recordingLogger();

  async function step<T>(name: Step, e: string, run: () => T | Promise<T>): Promise<T> {
    trace.push(`${name}:${e}`);
    await wait[name]?.(e);
    const x = fail[name]?.(e);
    if (x !== undefined) throw x;
    return run();
  }

  const events: SaleStateJudgeDeps['events'] = { saleEvents: () => step('saleEvents', '-', () => [...ids]) };
  const counts: SaleCountsReader = {
    read: (e) => step('counts', e, () => (scene(e).notReady ? ({ kind: 'NOT_READY' } as const) : ({ kind: 'OK', bitmap: scene(e).bitmap, held: scene(e).held } as const))),
    holdIndexes: (e, start, count) =>
      step('holds', e, () => {
        holdCalls.push([e, start, count]);
        return { indexes: [...(scene(e).pages[start / count] ?? [])], badMembers: 0 };
      }),
  };
  const paying: SalePayingSeats = { payingByTier: (e) => step('paying', e, () => new Map(scene(e).paying)) };
  const store: EventSaleStore = {
    read: (e) =>
      step('read', e, () => {
        const r = rows.get(e);
        return r ? { ...r } : undefined;
      }),
    activeSaleCount: (e) => step('active', e, () => scene(e).active),
    avgTicketsPerOrder: (e) => step('avg', e, () => scene(e).avg),
    create: (i) =>
      step('create', i.eventId, () => {
        writes.create.push(i);
        if (lose.create || rows.has(i.eventId)) return undefined;
        const r: EventSaleRow = { eventId: i.eventId, status: 'ON_SALE', version: 1, sellableSeats: i.sellableSeats, available: i.available, held: i.held, paying: i.paying, soldOutTiers: [], reopenCount: 0, changedAtMs: i.nowMs, countedAtMs: i.nowMs };
        rows.set(i.eventId, r);
        return { ...r };
      }),
    applyChange: (i) =>
      step('apply', i.eventId, () => {
        writes.apply.push(i);
        const cur = rows.get(i.eventId);
        if (lose.apply || !cur || cur.version !== i.expectedVersion) return undefined;
        const { previousStatus: _old, ...rest } = cur;
        const r: EventSaleRow = {
          ...rest,
          ...(i.previousStatus !== undefined ? { previousStatus: i.previousStatus } : {}),
          status: i.status,
          version: cur.version + 1,
          available: i.available,
          held: i.held,
          paying: i.paying,
          soldOutTiers: [...i.soldOutTiers],
          reopenCount: i.reopenCount,
          changedAtMs: i.nowMs,
          countedAtMs: i.nowMs,
        };
        rows.set(i.eventId, r);
        return { ...r };
      }),
    republish: (i) =>
      step('republish', i.eventId, () => {
        writes.republish.push(i);
        const cur = rows.get(i.eventId);
        if (lose.republish || !cur || cur.version !== i.expectedVersion) return undefined;
        const r: EventSaleRow = { ...cur, available: i.available, held: i.held, paying: i.paying, countedAtMs: i.nowMs };
        rows.set(i.eventId, r);
        return { ...r };
      }),
  };
  const seatMap: Pick<SeatMap, 'config'> & SeatMapTiers = {
    config: (e) => step('config', e, () => scene(e).config),
    saleLayout: (e) => step('layout', e, () => scene(e).layout),
  };
  const leasesInner = new MemorySweepLeases(new MemorySeatStore(clock).db, clock);
  const leases: SweepLeases = {
    acquire: (e, owner, ttl, lane) =>
      step('acquire', e, () => {
        acquires.push([e, owner, ttl, lane]);
        return leasesInner.acquire(e, owner, ttl, lane);
      }),
  };

  const judge = (podId = 'pod-a', over: Partial<SaleStateJudgeDeps> = {}) => new SaleStateJudge({ events, counts, paying, store, seatMap, leases, clock, podId, signals, logger: log.logger, ...over });

  /** 행을 넣는다(기본: 판 3, 판매 대상 10석, 셈 0, 시각 NOW) */
  const setRow = (status: SaleStatus, over: Partial<EventSaleRow> = {}, eventId = E): void =>
    void rows.set(eventId, { eventId, status, version: 3, sellableSeats: 10, available: 0, held: 0, paying: 0, soldOutTiers: [], reopenCount: 0, changedAtMs: NOW, countedAtMs: NOW, ...over });

  /** 그 단계의 trace 수 */
  const calledCount = (name: Step, eventId = E): number => trace.filter((t) => t === `${name}:${eventId}`).length;
  /** 쓰기가 한 번도 없었는가 */
  const noWrites = (): boolean => writes.create.length + writes.apply.length + writes.republish.length === 0;
  const warnLines = () => log.lines.filter((l) => l.level === 'warn');

  return { clock, scenes, scene, s: scene(ids[0] ?? E), trace, fail, wait, lose, rows, writes, holdCalls, acquires, signals, log, leasesInner, judge, setRow, calledCount, noWrites, warnLines };
}

type World = ReturnType<typeof world>;

/** 회차 하나인 틱의 보고 */
async function once(j: SaleStateJudge): Promise<SaleEventReport> {
  const t = await j.tick();
  expect(t.events).toHaveLength(1);
  return t.events[0]!;
}

/** 전석이 팔려 비었음(가용·홀드·결제 중 0, 활성 판매 행 10) */
function soldAll(w: World): void {
  w.s.bitmap = bitmapOf(ALL);
  w.s.held = 0;
  w.s.active = 10;
}

/** 전석 홀드(가용 0, 등급 홀드가 보여 등급 매진이 아니다) */
function heldAll(w: World): void {
  w.s.bitmap = bitmapOf(ALL);
  w.s.held = 10;
  w.s.pages = [[0, 6]];
}

describe('SaleStateJudge.tick: 한 회차의 차례', () => {
  test('ST25_ADR0122_ 좌석맵 판 → 임대 → 행 → 셈 → 결제 중 차례로 부르고, 임대는 줄 sale·3초·이 파드 ID로 잡는다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.setRow('ON_SALE');
    expect(await once(w.judge('pod-a'))).toEqual({ eventId: E, outcome: 'UNCHANGED', status: 'ON_SALE', guardBlocked: false });
    expect(w.trace).toEqual(['saleEvents:-', `config:${E}`, `layout:${E}`, `acquire:${E}`, `read:${E}`, `counts:${E}`, `paying:${E}`]);
    expect(w.acquires).toEqual([[E, 'pod-a', SWEEP_LEASE_TTL_MS, 'sale']]);
    expect(w.noWrites()).toBe(true);
  });

  test('ST25_ADR0122_ 회차 목록은 회차 ID 문자 코드 순으로 돌고 그 차례로 보고한다', async () => {
    const w = world(['b', 'a', 'C']);
    for (const id of ['a', 'b', 'C']) w.setRow('ON_SALE', {}, id);
    const t = await w.judge().tick();
    expect(t).toMatchObject({ overlapped: false });
    expect(t.listFailed).toBeUndefined();
    expect(t.events.map((x) => x.eventId)).toEqual(['C', 'a', 'b']);
  });

  test('ST25_ADR0122_ 회차가 없으면 빈 보고이고 아무것도 더 부르지 않는다', async () => {
    const w = world([]);
    expect(await w.judge().tick()).toEqual({ overlapped: false, events: [] });
    expect(w.trace).toEqual(['saleEvents:-']);
  });

  test.each([
    ['config', (w: World) => void (w.s.config = undefined)],
    ['saleLayout', (w: World) => void (w.s.layout = undefined)],
  ])('ST25_ADR0122_ 좌석맵 판이 없으면(%s) NO_CONFIG로 쉬고 지표를 올리며, 임대 키를 쓰지 않고 행도 셈도 읽지 않는다', async (_, setup) => {
    const w = world();
    setup(w);
    expect(await once(w.judge())).toEqual({ eventId: E, outcome: 'NO_CONFIG', guardBlocked: false });
    expect(w.signals.calls).toEqual(['skipped:no_config']);
    expect(w.calledCount('acquire')).toBe(0);
    expect(w.calledCount('read')).toBe(0);
    expect(w.calledCount('counts')).toBe(0);
  });

  test('ST25_⑦ ADR0122_ 임대를 다른 파드가 잡았으면 NOT_LEASED이고 행·셈을 읽지 않는다 [ASVS v5.0.0-15.4.2]', async () => {
    const w = world();
    await w.leasesInner.acquire(E, 'pod-b', SWEEP_LEASE_TTL_MS, 'sale');
    expect(await once(w.judge('pod-a'))).toEqual({ eventId: E, outcome: 'NOT_LEASED', guardBlocked: false });
    expect(w.calledCount('read')).toBe(0);
    expect(w.calledCount('counts')).toBe(0);
    expect(w.noWrites()).toBe(true);
    expect(w.signals.calls).toEqual([]);
  });

  test('ST25_ADR0122_ 만료 줄과 세션 줄의 임대는 판정을 막지 않는다(다른 키다)', async () => {
    const w = world();
    w.setRow('ON_SALE');
    await w.leasesInner.acquire(E, 'pod-b', SWEEP_LEASE_TTL_MS, 'expiry');
    await w.leasesInner.acquire(E, 'pod-b', SWEEP_LEASE_TTL_MS, 'session');
    expect((await once(w.judge('pod-a'))).outcome).toBe('UNCHANGED');
  });

  test('ST25_ADR0122_ 행이 이미 ENDED면 좌석 Redis도 결제 중도 부르지 않고 쓰지 않는다(ALREADY_ENDED) [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.setRow('ENDED');
    w.clock.advance(SALE_REPUBLISH_MS);
    expect(await once(w.judge())).toEqual({ eventId: E, outcome: 'ALREADY_ENDED', status: 'ENDED', guardBlocked: false });
    expect(w.calledCount('counts')).toBe(0);
    expect(w.calledCount('paying')).toBe(0);
    expect(w.noWrites()).toBe(true);
  });

  test('ST25_⑫ ADR0122_ 세대 키가 없으면(NOT_READY) 결제 중을 읽지 않고 판정·쓰기도 하지 않으며 지표를 올린다 [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    w.setRow('SOLD_OUT');
    w.s.notReady = true;
    w.clock.advance(SALE_REPUBLISH_MS);
    expect(await once(w.judge())).toEqual({ eventId: E, outcome: 'NOT_READY', status: 'SOLD_OUT', guardBlocked: false });
    expect(w.calledCount('paying')).toBe(0);
    expect(w.noWrites()).toBe(true);
    expect(w.signals.calls).toEqual(['skipped:not_ready']);
    expect(w.warnLines()).toEqual([]);
  });

  test('ST25_⑫ ADR0122_ 리뷰 고침 L7: NOT_READY 틱은 셈을 못 본 틱이라 두 번 이어짐을 끊는다: 비었음·NOT_READY·비었음이면 아직이고 그다음 비었음에서 SOLD_OUT이다', async () => {
    const w = world();
    w.setRow('ALL_HELD');
    soldAll(w);
    const j = w.judge();
    expect((await once(j)).outcome).toBe('UNCHANGED');
    w.clock.advance(SALE_TICK_MS);
    w.s.notReady = true;
    expect((await once(j)).outcome).toBe('NOT_READY');
    w.clock.advance(SALE_TICK_MS);
    w.s.notReady = false;
    expect((await once(j)).outcome).toBe('UNCHANGED');
    w.clock.advance(SALE_TICK_MS);
    expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT' });
  });

  test('ST25_ADR0122_ 결제 중은 그 틱의 주입 시계 지금으로 묻는다', async () => {
    const w = world();
    w.setRow('ON_SALE');
    w.clock.advance(1234);
    const seen: [string, number][] = [];
    const j = w.judge('pod-a', { paying: { payingByTier: async (e, nowMs) => (seen.push([e, nowMs]), new Map()) } });
    await once(j);
    expect(seen).toEqual([[E, NOW + 1234]]);
  });

  test('ST25_ADR0122_ 셈: 가용은 등급 가용의 합, 홀드는 만료 인덱스 수, 결제 중은 받은 값 전부의 합이다(판매 대상이 아닌 색인의 비트는 세지 않는다)', async () => {
    const w = world();
    w.s.layout = { sellableSeats: 9, tiers: [{ tierId: 'R', indexes: [0, 1, 2, 4, 5] }, { tierId: 'S', indexes: [6, 7, 8, 9] }] };
    w.s.bitmap = bitmapOf([0, 3, 6]);
    w.s.held = 2;
    w.s.paying = new Map([
      ['R', 1],
      ['GHOST', 2],
    ]);
    expect(await once(w.judge())).toMatchObject({ outcome: 'CREATED' });
    expect(w.writes.create).toEqual([{ eventId: E, sellableSeats: 9, available: 7, held: 2, paying: 3, nowMs: NOW }]);
  });
});

describe('회차 목록을 읽지 못한 틱', () => {
  test.each([
    ['UNAVAILABLE', new SeatStoreUnavailable(new Error('down'))],
    ['ERROR', new Error('boom')],
  ] as const)('ST25_ADR0122_ %s: listFailed와 빈 보고이고 던지지 않으며, 지표 lease 한 번과 경고 한 줄이다 [ASVS v5.0.0-16.3.4]', async (kind, err) => {
    const w = world();
    w.fail.saleEvents = () => err;
    await expect(w.judge().tick()).resolves.toEqual({ overlapped: false, listFailed: kind, events: [] });
    expect(w.signals.calls).toEqual(['failure:lease']);
    expect(w.warnLines()).toHaveLength(1);
    expect(w.calledCount('config')).toBe(0);
  });
});

describe('거짓 매진 막기(S-T25 ⑪)', () => {
  // 등급 매진에는 이 대조가 없다(seat-hold §4). 그래서 회차 판정만 보려고 두 등급을 이미 든 행으로 시작한다
  const TIERS = { soldOutTiers: ['R', 'S'] };

  test('ST25_⑪ ADR0122_ 셋이 0이어도 활성 판매 행 수가 켜진 비트 수와 다르면 몇 틱이 지나도 SOLD_OUT이 아니고, 틱마다 지표·보고를 남긴다 [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.3.4]', async () => {
    const w = world();
    w.setRow('ALL_HELD', TIERS);
    soldAll(w);
    w.s.active = 9;
    const j = w.judge();
    for (let k = 0; k < 3; k++) {
      expect(await once(j)).toMatchObject({ outcome: 'UNCHANGED', status: 'ALL_HELD', guardBlocked: true });
      w.clock.advance(SALE_TICK_MS);
    }
    expect(w.writes.apply).toEqual([]);
    expect(w.signals.calls).toEqual(['guardBlocked', 'guardBlocked', 'guardBlocked']);
  });

  test('ST25_⑪ ADR0122_ 막힌 채로 ON_SALE에서 5초가 지나면 ALL_HELD까지만 간다(사람이 보는 안전한 쪽) [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    w.setRow('ON_SALE', TIERS);
    soldAll(w);
    w.s.active = 9;
    const j = w.judge();
    for (let k = 0; k <= 7; k++) {
      await once(j);
      w.clock.advance(SALE_TICK_MS);
    }
    expect(w.writes.apply.map((x) => x.status)).toEqual(['ALL_HELD']);
  });

  test('ST25_⑪ ADR0122_ 활성 행 수가 판매 대상 − 가용과 같으면 첫 틱은 그대로이고 두 번째 틱에 SOLD_OUT이다(판 번호 조건·앞 상태·셈을 실어 쓴다) [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.setRow('ALL_HELD', { reopenCount: 2 });
    soldAll(w);
    const j = w.judge();
    expect(await once(j)).toEqual({ eventId: E, outcome: 'UNCHANGED', status: 'ALL_HELD', guardBlocked: false });
    w.clock.advance(SALE_TICK_MS);
    expect(await once(j)).toEqual({ eventId: E, outcome: 'CHANGED', status: 'SOLD_OUT', version: 4, guardBlocked: false });
    expect(w.writes.apply).toEqual([{ eventId: E, expectedVersion: 3, status: 'SOLD_OUT', previousStatus: 'ALL_HELD', soldOutTiers: ['R', 'S'], reopenCount: 2, available: 0, held: 0, paying: 0, nowMs: NOW + SALE_TICK_MS }]);
    expect(w.signals.calls).toEqual(['transition:SOLD_OUT']);
  });

  test('ST25_⑪ ADR0122_ 막힌 틱에도 등급 매진은 그대로 센다(등급 매진에는 대조가 없다): 두 틱 이어지면 상태는 ALL_HELD 그대로이고 soldOutTiers만 바뀐다', async () => {
    const w = world();
    w.setRow('ALL_HELD');
    soldAll(w);
    w.s.active = 9;
    const j = w.judge();
    await once(j);
    w.clock.advance(SALE_TICK_MS);
    expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'ALL_HELD', guardBlocked: true });
    expect(w.writes.apply[0]).toMatchObject({ status: 'ALL_HELD', soldOutTiers: ['R', 'S'] });
    expect(w.signals.calls.filter((c) => c.startsWith('transition:'))).toEqual([]);
  });

  test('ST25_⑪ ADR0122_ 막힌 틱은 두 번 이어짐을 끊는다: 맞음·다름·맞음이면 아직이고 그다음 맞음에서 SOLD_OUT이다', async () => {
    const w = world();
    w.setRow('ALL_HELD', TIERS);
    soldAll(w);
    const j = w.judge();
    const outcomes: string[] = [];
    for (const active of [10, 9, 10, 10]) {
      w.s.active = active;
      outcomes.push((await once(j)).outcome);
      w.clock.advance(SALE_TICK_MS);
    }
    expect(outcomes).toEqual(['UNCHANGED', 'UNCHANGED', 'UNCHANGED', 'CHANGED']);
  });

  test('ST25_⑪ ADR0122_ 대조는 판매 대상 좌석으로 한다: 판매 대상이 아닌 색인의 켜진 비트는 켜진 수에 들지 않는다', async () => {
    const w = world();
    w.setRow('ALL_HELD');
    w.s.layout = { sellableSeats: 9, tiers: [{ tierId: 'R', indexes: [0, 1, 2, 4, 5] }, { tierId: 'S', indexes: [6, 7, 8, 9] }] };
    w.s.bitmap = bitmapOf(ALL);
    w.s.active = 9;
    expect((await once(w.judge())).guardBlocked).toBe(false);
  });

  test.each([
    ['가용이 있다', (w: World) => void (w.s.bitmap = bitmapOf([0]))],
    ['홀드가 있다', (w: World) => void ((w.s.bitmap = bitmapOf(ALL)), (w.s.held = 1), (w.s.pages = [[0, 6]]))],
    ['결제 중이 있다', (w: World) => void ((w.s.bitmap = bitmapOf(ALL)), (w.s.paying = new Map([['R', 1]])))],
  ])('ST25_⑪ ADR0122_ 활성 행 읽기는 셋이 모두 0인 후보일 때만 한다: %s', async (_, setup) => {
    const w = world();
    w.setRow('ALL_HELD');
    setup(w);
    await once(w.judge());
    expect(w.calledCount('active')).toBe(0);
    expect(w.signals.calls).not.toContain('guardBlocked');
  });
});

describe('등급 홀드 쪽 읽기(만료 인덱스를 순위로)', () => {
  /** 등급 R에 가용이 있고 등급 S만 후보(가용·결제 중 0)인 세상 */
  function candidateS(w: World, held: number): void {
    w.setRow('ON_SALE');
    w.s.bitmap = bitmapOf([6, 7, 8, 9]);
    w.s.held = held;
  }

  test('ST25_⑨ ADR0122_ 후보 등급이 없으면 holdIndexes를 부르지 않는다(홀드가 있어도)', async () => {
    const w = world();
    w.setRow('ON_SALE');
    w.s.bitmap = bitmapOf([0, 6]);
    w.s.held = 2;
    await once(w.judge());
    expect(w.calledCount('holds')).toBe(0);
  });

  test('ST25_⑨ ADR0122_ 결제 중이 있는 등급은 후보가 아니다', async () => {
    const w = world();
    candidateS(w, 2);
    w.s.paying = new Map([['S', 1]]);
    await once(w.judge());
    expect(w.calledCount('holds')).toBe(0);
  });

  test('ST25_⑨ ADR0122_ 회차의 held가 0이면 후보가 있어도 부르지 않는다', async () => {
    const w = world();
    candidateS(w, 0);
    await once(w.judge());
    expect(w.calledCount('holds')).toBe(0);
  });

  test('ST25_⑨ ADR0122_ 첫 쪽에서 후보를 모두 찾으면 쪽이 꽉 차도 멈춘다(순위 0부터 1,000개) [ASVS v5.0.0-15.4.4]', async () => {
    const w = world();
    candidateS(w, 1000);
    w.s.pages = [[...FULL_PAGE(0).slice(1), 6], FULL_PAGE(0)];
    const j = w.judge();
    await once(j);
    expect(w.holdCalls).toEqual([[E, 0, SALE_TIER_SCAN_PAGE]]);
    w.clock.advance(SALE_TICK_MS);
    await once(j);
    expect(w.writes.apply).toEqual([]);
  });

  test('ST25_⑨ ADR0122_ 쪽이 1,000개보다 짧으면 끝이고 찾지 못한 등급은 비었음이다: 두 틱 이어지면 soldOutTiers에 들고 상태는 그대로다', async () => {
    const w = world();
    candidateS(w, 1500);
    w.s.pages = [FULL_PAGE(0), FULL_PAGE(1).slice(0, 500)];
    const j = w.judge();
    expect((await once(j)).outcome).toBe('UNCHANGED');
    expect(w.holdCalls.map(([, s, c]) => [s, c])).toEqual([
      [0, 1000],
      [1000, 1000],
    ]);
    w.clock.advance(SALE_TICK_MS);
    expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE', version: 4 });
    expect(w.writes.apply[0]).toMatchObject({ status: 'ON_SALE', soldOutTiers: ['S'] });
  });

  test('ST25_⑨ ADR0122_ 마지막 쪽이 딱 1,000개면 다음 빈 쪽을 읽고 멈춘다', async () => {
    const w = world();
    candidateS(w, 1000);
    w.s.pages = [FULL_PAGE(0), []];
    await once(w.judge());
    expect(w.holdCalls.map(([, s]) => s)).toEqual([0, 1000]);
  });

  test('ST25_⑨ ADR0122_ 후보가 둘이면 둘째 쪽까지 읽어 찾고, 둘 다 찾으면 멈춘다', async () => {
    const w = world();
    w.setRow('ALL_HELD');
    w.s.bitmap = bitmapOf(ALL);
    w.s.held = 3000;
    w.s.pages = [FULL_PAGE(0), FULL_PAGE(6), FULL_PAGE(6)];
    const j = w.judge();
    await once(j);
    expect(w.holdCalls.map(([, s]) => s)).toEqual([0, 1000]);
    w.clock.advance(SALE_TICK_MS);
    await once(j);
    expect(w.writes.apply).toEqual([]);
  });

  test('ST25_⑨ ADR0122_ 좌석맵 판에 없는 색인은 무시한다(그 등급의 홀드로 치지 않는다)', async () => {
    const w = world();
    candidateS(w, 1);
    w.s.pages = [[99]];
    const j = w.judge();
    await once(j);
    w.clock.advance(SALE_TICK_MS);
    await once(j);
    expect(w.writes.apply[0]).toMatchObject({ soldOutTiers: ['S'] });
  });

  test('ST25_⑨ ADR0122_ 그 등급의 홀드가 보이면 비지 않은 것이라 들지 않는다', async () => {
    const w = world();
    candidateS(w, 1);
    w.s.pages = [[6]];
    const j = w.judge();
    await once(j);
    w.clock.advance(SALE_TICK_MS);
    expect((await once(j)).outcome).toBe('UNCHANGED');
  });

  test('ST25_⑨ ADR0122_ 등급만 바뀐 판은 판 번호를 올리되 상태 전이로 세지 않고 앞 상태 칸을 그대로 둔다', async () => {
    const w = world();
    w.setRow('ON_SALE', { soldOutTiers: ['S'], previousStatus: 'ALL_HELD' });
    w.s.bitmap = bitmapOf([6, 7, 8]);
    expect(await once(w.judge())).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE', version: 4 });
    expect(w.writes.apply[0]).toMatchObject({ status: 'ON_SALE', previousStatus: 'ALL_HELD', soldOutTiers: [] });
    expect(w.signals.calls).toEqual([]);
  });
});

describe('쓰기', () => {
  test('ST25_ADR0122_ 행이 없으면 만들고(판 번호 1) CREATED다. 다음 틱은 그 행을 읽어 그대로다', async () => {
    const w = world();
    const j = w.judge();
    expect(await once(j)).toEqual({ eventId: E, outcome: 'CREATED', status: 'ON_SALE', version: 1, guardBlocked: false });
    expect(w.writes.create).toEqual([{ eventId: E, sellableSeats: 10, available: 10, held: 0, paying: 0, nowMs: NOW }]);
    w.clock.advance(SALE_TICK_MS);
    expect((await once(j)).outcome).toBe('UNCHANGED');
    expect(w.writes.create).toHaveLength(1);
  });

  test('ST25_ADR0122_ 행이 없을 때 만들기를 다른 파드에 지면 LOST다(판 번호가 생기지 않는다) [ASVS v5.0.0-2.3.3]', async () => {
    const w = world();
    w.lose.create = true;
    expect(await once(w.judge())).toMatchObject({ outcome: 'LOST', guardBlocked: false });
  });

  test('ST25_ADR0122_ 행이 없고 판매 종료가 이미 지난 회차는 행도 사건도 만들지 않는다(ON_SALE을 낸 다음 틱에 ENDED를 내는 일이 없다)', async () => {
    const w = world();
    w.s.config = { ...w.s.config!, saleEndsAtMs: NOW };
    expect(await once(w.judge())).toEqual({ eventId: E, outcome: 'ENDED', guardBlocked: false });
    expect(w.calledCount('counts')).toBe(0);
    expect(w.noWrites()).toBe(true);
    expect(w.rows.size).toBe(0);
  });

  test('ST25_ADR0122_ 판매 종료가 되면 행을 ENDED로 바꾸고 다음 틱부터는 셈을 읽지 않는다 [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.setRow('SOLD_OUT', { soldOutTiers: ['R'], reopenCount: 1 });
    w.s.config = { ...w.s.config!, saleEndsAtMs: NOW + 1000 };
    soldAll(w);
    w.clock.advance(1000);
    const j = w.judge();
    expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'ENDED', version: 4 });
    expect(w.writes.apply[0]).toMatchObject({ status: 'ENDED', previousStatus: 'SOLD_OUT', soldOutTiers: ['R'], reopenCount: 1 });
    expect(w.signals.calls).toEqual(['transition:ENDED']);
    const countsBefore = w.calledCount('counts');
    w.clock.advance(SALE_TICK_MS);
    expect((await once(j)).outcome).toBe('ALREADY_ENDED');
    expect(w.calledCount('counts')).toBe(countsBefore);
  });

  test('ST25_ADR0122_ ALL_HELD에서 가용이 생기면 ON_SALE로 바꾼다(지금 판 번호 조건, 앞 상태, 셈, 지표) [ASVS v5.0.0-2.3.1]', async () => {
    const w = world();
    w.setRow('ALL_HELD', { version: 9 });
    w.s.bitmap = bitmapOf([0, 1]);
    w.s.held = 2;
    expect(await once(w.judge())).toEqual({ eventId: E, outcome: 'CHANGED', status: 'ON_SALE', version: 10, guardBlocked: false });
    expect(w.writes.apply).toEqual([{ eventId: E, expectedVersion: 9, status: 'ON_SALE', previousStatus: 'ALL_HELD', soldOutTiers: [], reopenCount: 0, available: 8, held: 2, paying: 0, nowMs: NOW }]);
    expect(w.signals.calls).toEqual(['transition:ON_SALE']);
  });

  test('ST25_⑥ ADR0122_ 매진이 풀리면 reopenCount가 1 는다', async () => {
    const w = world();
    w.setRow('SOLD_OUT', { reopenCount: 2 });
    w.s.bitmap = bitmapOf([0]);
    await once(w.judge());
    expect(w.writes.apply[0]).toMatchObject({ status: 'ON_SALE', previousStatus: 'SOLD_OUT', reopenCount: 3 });
  });

  test('ST25_⑦ ADR0122_ 조건부 쓰기가 0행이면 LOST이고 메모를 지운다: 다음 틱은 정상으로 돌고 두 번 이어짐을 처음부터 다시 센다 [ASVS v5.0.0-15.4.2] [ASVS v5.0.0-2.3.3]', async () => {
    const w = world();
    w.setRow('ALL_HELD');
    soldAll(w);
    const j = w.judge();
    await once(j);
    w.clock.advance(SALE_TICK_MS);
    w.lose.apply = true;
    expect(await once(j)).toMatchObject({ outcome: 'LOST', guardBlocked: false });
    expect(w.signals.calls).toEqual([]);
    w.lose.apply = false;
    w.clock.advance(SALE_TICK_MS);
    expect((await once(j)).outcome).toBe('UNCHANGED');
    w.clock.advance(SALE_TICK_MS);
    expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT' });
  });

  test('ST25_⑦ ADR0122_ 실패 뒤에도 쓸 때마다 읽은 판 번호를 조건으로 쓴다(거꾸로 가는 판 번호를 만들지 않는다) [ASVS v5.0.0-15.4.2]', async () => {
    const w = world();
    w.setRow('ALL_HELD', { version: 5 });
    w.s.bitmap = bitmapOf([0]);
    const j = w.judge();
    await once(j);
    w.setRow('ALL_HELD', { version: 8 });
    w.clock.advance(SALE_TICK_MS);
    await once(j);
    expect(w.writes.apply.map((x) => x.expectedVersion)).toEqual([5, 8]);
  });
});

describe('같은 판 다시 내기(S-T25 ⑧, ADR-0219 결정 5)', () => {
  const stay: [SaleStatus, (w: World) => void][] = [
    ['ON_SALE', (w) => void (w.s.bitmap = bitmapOf([0]))],
    ['ALL_HELD', heldAll],
    ['SOLD_OUT', (w) => soldAll(w)],
  ];

  test.each(stay)('ST25_⑧ ADR0122_ %s: counted_at 뒤 4,999ms는 쓰지 않고 5,000ms에 같은 판을 다시 낸다(판 번호 조건, 지금 셈, 지표)', async (status, setup) => {
    const w = world();
    w.setRow(status, { soldOutTiers: status === 'SOLD_OUT' ? ['R', 'S'] : [] });
    setup(w);
    const j = w.judge();
    w.clock.advance(SALE_REPUBLISH_MS - 1);
    expect((await once(j)).outcome).toBe('UNCHANGED');
    expect(w.writes.republish).toEqual([]);
    w.clock.advance(1);
    expect(await once(j)).toEqual({ eventId: E, outcome: 'REPUBLISHED', status, version: 3, guardBlocked: false });
    expect(w.writes.republish).toHaveLength(1);
    expect(w.writes.republish[0]).toMatchObject({ eventId: E, expectedVersion: 3, nowMs: NOW + SALE_REPUBLISH_MS, held: w.s.held, paying: 0 });
    expect(w.writes.apply).toEqual([]);
    expect(w.signals.calls).toEqual(['republished']);
    // 다시 낸 뒤에는 그 시각부터 다시 잰다
    w.clock.advance(1);
    expect((await once(j)).outcome).toBe('UNCHANGED');
  });

  test('ST25_⑧ ADR0122_ UPCOMING은 5초가 지나도 다시 내지 않는다', async () => {
    const w = world();
    w.setRow('UPCOMING', { openAtMs: NOW + 3_600_000 });
    w.clock.advance(SALE_REPUBLISH_MS * 3);
    expect((await once(w.judge())).outcome).toBe('UNCHANGED');
    expect(w.writes.republish).toEqual([]);
  });

  test('ST25_⑧ ADR0122_ 판정이 바뀌는 틱은 다시 내기 대신 바꾸기만 한다', async () => {
    const w = world();
    w.setRow('ALL_HELD');
    w.s.bitmap = bitmapOf([0]);
    w.clock.advance(SALE_REPUBLISH_MS);
    expect((await once(w.judge())).outcome).toBe('CHANGED');
    expect(w.writes.republish).toEqual([]);
    expect(w.writes.apply).toHaveLength(1);
  });

  test('ST25_⑧ ADR0122_ 다시 내기가 0행이면 UNCHANGED로 건너뛰고 지표를 올리지 않는다', async () => {
    const w = world();
    w.setRow('ON_SALE');
    w.s.bitmap = bitmapOf([0]);
    w.lose.republish = true;
    w.clock.advance(SALE_REPUBLISH_MS);
    expect((await once(w.judge())).outcome).toBe('UNCHANGED');
    expect(w.signals.calls).toEqual([]);
  });

  test('ST25_⑧ ADR0122_ 처음 만든 행도 counted_at 5초 뒤에 다시 낸다', async () => {
    const w = world();
    const j = w.judge();
    expect((await once(j)).outcome).toBe('CREATED');
    w.clock.advance(SALE_REPUBLISH_MS);
    expect((await once(j)).outcome).toBe('REPUBLISHED');
  });
});

describe('평균 구매 매수 캐시(ADR-0219 결정 6, 1분)', () => {
  /** 만들고 5초마다 다시 낸다(atMs = 5,000 … 55,000) */
  async function runMinute(w: World, j: SaleStateJudge): Promise<void> {
    await once(j);
    for (let k = 0; k < 11; k++) {
      w.clock.advance(SALE_REPUBLISH_MS);
      expect((await once(j)).outcome).toBe('REPUBLISHED');
    }
  }

  test('ST25_⑩ ADR0122_ 평균을 사건에 싣고, 1분 안에는 다시 읽지 않으며(값이 바뀌어도 앞 값), 1분이 지나면 새로 읽는다', async () => {
    const w = world();
    w.s.avg = 2.5;
    const j = w.judge();
    await once(j);
    expect(w.writes.create[0]).toMatchObject({ avgTicketsPerOrder: 2.5 });
    w.s.avg = 3.1;
    for (let k = 0; k < 11; k++) {
      w.clock.advance(SALE_REPUBLISH_MS);
      await once(j);
    }
    expect(w.calledCount('avg')).toBe(1);
    expect(w.writes.republish.every((x) => x.avgTicketsPerOrder === 2.5)).toBe(true);
    w.clock.advance(SALE_REPUBLISH_MS + 1);
    expect(AVG_CACHE_MS).toBe(60_000);
    expect((await once(j)).outcome).toBe('REPUBLISHED');
    expect(w.calledCount('avg')).toBe(2);
    expect(w.writes.republish.at(-1)).toMatchObject({ avgTicketsPerOrder: 3.1 });
  });

  test('ST25_⑩ ADR0122_ 주문 100건 미만이면(undefined) 평균 없이 내고, 없다는 답도 1분 동안 다시 읽지 않는다(5초마다 큰 셈을 하지 않는다)', async () => {
    const w = world();
    w.s.avg = undefined;
    await runMinute(w, w.judge());
    expect(w.calledCount('avg')).toBe(1);
    expect(w.writes.create[0]!.avgTicketsPerOrder).toBeUndefined();
    expect(w.writes.republish.every((x) => x.avgTicketsPerOrder === undefined)).toBe(true);
  });

  test('ST25_⑩ ADR0122_ 캐시는 회차마다 따로다', async () => {
    const w = world(['a', 'b']);
    w.scene('a').avg = 2;
    w.scene('b').avg = 3;
    await w.judge().tick();
    expect(w.calledCount('avg', 'a')).toBe(1);
    expect(w.calledCount('avg', 'b')).toBe(1);
    expect(w.writes.create.map((x) => [x.eventId, x.avgTicketsPerOrder])).toEqual([
      ['a', 2],
      ['b', 3],
    ]);
  });

  test('ST25_⑩ ADR0122_ 판을 올리는 쓰기에도 평균을 싣는다', async () => {
    const w = world();
    w.setRow('ALL_HELD');
    w.s.bitmap = bitmapOf([0]);
    w.s.avg = 2.25;
    await once(w.judge());
    expect(w.writes.apply[0]).toMatchObject({ avgTicketsPerOrder: 2.25 });
  });
});

describe('실패 격리', () => {
  const noRow = (_: World): void => undefined;
  const live = (w: World): void => w.setRow('ON_SALE');
  const cases: [Step, string, (w: World) => void][] = [
    ['acquire', 'lease', live],
    ['config', 'counts', live],
    ['layout', 'counts', live],
    ['counts', 'counts', live],
    ['holds', 'counts', (w) => void (w.setRow('ALL_HELD'), (w.s.bitmap = bitmapOf(ALL)), (w.s.held = 2))],
    ['active', 'counts', (w) => void (w.setRow('ALL_HELD'), soldAll(w))],
    ['paying', 'paying', live],
    ['read', 'write', live],
    ['create', 'write', noRow],
    ['apply', 'write', (w) => void (w.setRow('ALL_HELD'), (w.s.bitmap = bitmapOf([0])))],
    ['republish', 'write', (w) => void (w.setRow('ON_SALE', { countedAtMs: NOW - SALE_REPUBLISH_MS }), (w.s.bitmap = bitmapOf([0])))],
  ];

  test.each(cases)('ST25_ADR0122_ %s 단계가 실패하면 FAILED(%s)이고 던지지 않으며 지표 한 번이다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.2]', async (stepName, stage, setup) => {
    const w = world();
    setup(w);
    w.fail[stepName] = () => new SeatStoreUnavailable(new Error('down'));
    const j = w.judge();
    const t = await j.tick();
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toMatchObject({ eventId: E, outcome: 'FAILED', failedStage: stage });
    expect(w.signals.calls).toEqual([`failure:${stage}`]);
  });

  test.each(['counts', 'paying', 'read', 'active'] as const)('ST25_ADR0122_ %s 실패는 쓰기를 하지 않는다(판정을 바꾸지 않는다) [ASVS v5.0.0-16.5.3]', async (stepName) => {
    const w = world();
    w.setRow('ALL_HELD');
    soldAll(w);
    w.fail[stepName] = () => new Error('boom');
    const j = w.judge();
    await once(j);
    w.clock.advance(SALE_REPUBLISH_MS);
    await once(j);
    expect(w.noWrites()).toBe(true);
  });

  test('ST25_ADR0122_ 한 회차가 던져도 다른 회차는 그대로 돈다(보고는 회차마다) [ASVS v5.0.0-16.5.2]', async () => {
    const w = world(['a', 'b', 'c']);
    for (const id of ['a', 'b', 'c']) w.setRow('ON_SALE', {}, id);
    w.fail.counts = (e) => (e === 'b' ? new Error('boom') : undefined);
    const t = await w.judge().tick();
    expect(t.events.map((x) => [x.eventId, x.outcome])).toEqual([
      ['a', 'UNCHANGED'],
      ['b', 'FAILED'],
      ['c', 'UNCHANGED'],
    ]);
  });

  test('ST25_ADR0122_ 앞 회차가 실패해도 동시 상한 4개 뒤에 줄 선 회차까지 이번 틱에 모두 돈다 [ASVS v5.0.0-16.5.2]', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const w = world(ids);
    for (const id of ids) w.setRow('ON_SALE', {}, id);
    w.fail.counts = (e) => (e === 'a' ? new Error('boom') : undefined);
    const t = await w.judge().tick();
    expect(t.events.map((x) => [x.eventId, x.outcome])).toEqual([['a', 'FAILED'], ...ids.slice(1).map((id) => [id, 'UNCHANGED'])]);
    expect(w.signals.calls.filter((c) => c.startsWith('failure:'))).toEqual(['failure:counts']);
  });

  test('ST25_ADR0122_ 실패한 틱은 두 번 이어짐을 끊는다: 비었음·실패·비었음이면 아직이고 그다음 비었음에서 SOLD_OUT이다 [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    w.setRow('ALL_HELD');
    soldAll(w);
    const j = w.judge();
    const outcomes: string[] = [];
    for (const failing of [false, true, false, false]) {
      w.fail.counts = failing ? () => new Error('boom') : undefined;
      if (!failing) delete w.fail.counts;
      outcomes.push((await once(j)).outcome);
      w.clock.advance(SALE_TICK_MS);
    }
    expect(outcomes).toEqual(['UNCHANGED', 'FAILED', 'UNCHANGED', 'CHANGED']);
  });

  test('ST25_⑨ ADR0122_ 실패한 틱은 등급의 두 번 이어짐도 끊는다 [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    w.setRow('ON_SALE');
    w.s.bitmap = bitmapOf([6, 7, 8, 9]);
    const j = w.judge();
    await once(j);
    w.clock.advance(SALE_TICK_MS);
    w.fail.paying = () => new Error('boom');
    expect((await once(j)).outcome).toBe('FAILED');
    delete w.fail.paying;
    w.clock.advance(SALE_TICK_MS);
    expect((await once(j)).outcome).toBe('UNCHANGED');
    expect(w.writes.apply).toEqual([]);
  });

  test('ST25_ADR0122_ 실패해도 가용 0이 시작된 시각은 둔다: 중간에 한 틱 실패해도 처음 0부터 5초에 ALL_HELD다', async () => {
    const w = world();
    w.setRow('ON_SALE', { countedAtMs: NOW + 60_000 });
    heldAll(w);
    const j = w.judge();
    await once(j);
    w.clock.advance(2000);
    w.fail.counts = () => new Error('boom');
    await once(j);
    delete w.fail.counts;
    w.clock.advance(3000);
    expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'ALL_HELD' });
  });

  test('ST25_ADR0122_ 경고는 파드마다 1분에 한 줄이다(지표는 실패마다 오른다): 59,999ms 뒤는 없고 60,000ms 뒤에 한 줄 더 [ASVS v5.0.0-16.3.4]', async () => {
    const w = world(['a', 'b']);
    w.fail.counts = () => new Error('boom');
    const j = w.judge();
    await j.tick();
    expect(w.warnLines()).toHaveLength(1);
    expect(w.signals.calls.filter((c) => c === 'failure:counts')).toHaveLength(2);
    w.clock.advance(SALE_WARN_INTERVAL_MS - 1);
    await j.tick();
    expect(w.warnLines()).toHaveLength(1);
    w.clock.advance(1);
    await j.tick();
    expect(w.warnLines()).toHaveLength(2);
    expect(w.signals.calls.filter((c) => c === 'failure:counts')).toHaveLength(6);
  });

  test('ST25_ADR0122_ 경고 줄에는 회차 ID·실패 단계·오류 코드만 있고 키 이름·오류 글·오류 객체는 없다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    w.setRow('ON_SALE');
    const err = Object.assign(new Error('WRONGTYPE s:{event:ev-a}:expiry SECRET-MESSAGE'), { code: 'WRONGTYPE' });
    w.fail.counts = () => err;
    await once(w.judge());
    const lines = w.warnLines();
    expect(lines).toHaveLength(1);
    const fields = lines[0]!.args[0] as Record<string, unknown>;
    expect(fields).toMatchObject({ eventId: E, stage: 'counts' });
    expect(Object.keys(fields).every((k) => ['eventId', 'stage', 'code'].includes(k)), JSON.stringify(Object.keys(fields))).toBe(true);
    const dumped = JSON.stringify(lines[0]!.args.map((a) => (a instanceof Error ? { error: a.message } : a)));
    expect(dumped).not.toContain('SECRET-MESSAGE');
    expect(dumped).not.toContain('s:{event:');
    expect(lines[0]!.args.some((a) => a instanceof Error)).toBe(false);
  });

  test('ST25_ADR0122_ 주입한 경고 문을 쓴다(warnGate가 닫혀 있으면 지표만 오른다)', async () => {
    const w = world();
    w.setRow('ON_SALE');
    w.fail.counts = () => new Error('boom');
    const gate = { allow: () => false } as unknown as NonNullable<SaleStateJudgeDeps['warnGate']>;
    await once(w.judge('pod-a', { warnGate: gate }));
    expect(w.warnLines()).toEqual([]);
    expect(w.signals.calls).toEqual(['failure:counts']);
  });

  test('ST25_ADR0122_ 지표·로거를 넘기지 않아도 돈다(기본 noSaleStateSignals)', async () => {
    const w = world();
    w.setRow('ON_SALE');
    w.fail.counts = () => new Error('boom');
    const j = w.judge('pod-a', { signals: undefined as never, logger: undefined as never });
    await expect(j.tick()).resolves.toMatchObject({ overlapped: false });
  });
});

describe('동시성과 임대', () => {
  /** counts에서 붙잡아 지금 들어온 회차를 잰다 */
  function gated(w: World) {
    const gates: ReturnType<typeof deferred<void>>[] = [];
    let inFlight = 0;
    let peak = 0;
    w.wait.counts = async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      const g = deferred();
      gates.push(g);
      await g.promise;
      inFlight -= 1;
    };
    return { gates, inFlight: () => inFlight, peak: () => peak };
  }

  test('ST25_ADR0122_ 회차는 동시에 4개까지만 돌고, 하나가 끝나면 다음을 꺼내 모두 돈다 [ASVS v5.0.0-15.4.4]', async () => {
    expect(SALE_JUDGE_CONCURRENCY).toBe(4);
    const ids = Array.from({ length: 10 }, (_, i) => `ev-${i}`);
    const w = world(ids);
    const g = gated(w);
    const p = w.judge().tick();
    await flush();
    expect(g.gates).toHaveLength(4);
    for (let k = 0; k < 10; k++) {
      g.gates[k]!.resolve();
      await flush();
    }
    const t = await p;
    expect(g.peak()).toBe(4);
    expect(t.events.map((x) => x.eventId)).toEqual(ids);
    expect(t.events.every((x) => x.outcome === 'CREATED')).toBe(true);
  });

  test('ST25_ADR0122_ 앞 틱이 돌고 있으면 이번 틱은 아무것도 부르지 않고 overlapped다. 끝난 뒤에는 다시 돈다 [ASVS v5.0.0-15.4.4]', async () => {
    const w = world();
    w.setRow('ON_SALE');
    const g = gated(w);
    const j = w.judge();
    const first = j.tick();
    await flush();
    const before = w.trace.length;
    expect(await j.tick()).toEqual({ overlapped: true, events: [] });
    expect(w.trace.length).toBe(before);
    g.gates[0]!.resolve();
    expect((await first).overlapped).toBe(false);
    delete w.wait.counts;
    expect((await j.tick()).overlapped).toBe(false);
  });

  test('ST25_ADR0122_ start는 타이머를 1초로 하나만 걸고 틱을 바로 부르지 않는다(두 번 불러도 하나다)', () => {
    const w = world();
    const m = manualTimer();
    const j = w.judge('pod-a', { timer: m.timer });
    j.start();
    j.start();
    expect(m.regs.map((r) => r.everyMs)).toEqual([SALE_TICK_MS]);
    expect(w.trace).toEqual([]);
  });

  test('ST25_ADR0122_ 타이머가 부르면 한 틱을 돈다', async () => {
    const w = world();
    w.setRow('ON_SALE');
    const m = manualTimer();
    const j = w.judge('pod-a', { timer: m.timer });
    j.start();
    m.regs[0]!.run();
    await flush();
    expect(w.calledCount('read')).toBe(1);
    await j.stop();
  });

  test('ST25_ADR0122_ 켜지 않은 stop은 바로 끝나고, 두 번 불러도 되며, 끈 뒤 다시 켤 수 있다', async () => {
    const w = world();
    const m = manualTimer();
    const j = w.judge('pod-a', { timer: m.timer });
    await j.stop();
    j.start();
    await j.stop();
    await j.stop();
    expect(m.regs[0]!.cancelled).toBe(1);
    j.start();
    expect(m.regs).toHaveLength(2);
    await j.stop();
  });

  test('ST25_ADR0122_ stop은 돌던 회차가 끝날 때까지 기다리고, 아직 시작하지 않은 회차는 꺼내지 않는다(임대도 잡지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
    const ids = Array.from({ length: 6 }, (_, i) => `ev-${i}`);
    const w = world(ids);
    const g = gated(w);
    const m = manualTimer();
    const j = w.judge('pod-a', { timer: m.timer });
    j.start();
    const running = j.tick();
    await flush();
    expect(g.gates).toHaveLength(4);
    let stopped = false;
    const stopping = j.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(m.regs[0]!.cancelled).toBe(1);
    expect(stopped).toBe(false);
    for (const x of g.gates) x.resolve();
    await stopping;
    expect(stopped).toBe(true);
    const t = await running;
    expect(t.events.map((x) => x.eventId)).toEqual(ids.slice(0, 4));
    expect(w.acquires).toHaveLength(4);
  });

  test('ST25_⑦ ADR0122_ 두 파드가 같은 틱에 돌면 회차마다 한 파드만 판정하고, 임대 수명(3초) 뒤에 다른 파드가 이어받는다 [ASVS v5.0.0-15.4.2]', async () => {
    const w = world();
    w.setRow('ON_SALE');
    const a = w.judge('pod-a');
    const b = w.judge('pod-b');
    const [ra, rb] = await Promise.all([once(a), once(b)]);
    expect([ra.outcome, rb.outcome].sort()).toEqual(['NOT_LEASED', 'UNCHANGED']);
    expect(w.calledCount('read')).toBe(1);
    const holder = ra.outcome === 'NOT_LEASED' ? b : a;
    const other = ra.outcome === 'NOT_LEASED' ? a : b;
    w.clock.advance(SWEEP_LEASE_TTL_MS - 1);
    expect((await once(other)).outcome).toBe('NOT_LEASED');
    expect((await once(holder)).outcome).not.toBe('NOT_LEASED');
    w.clock.advance(SWEEP_LEASE_TTL_MS);
    expect((await once(other)).outcome).not.toBe('NOT_LEASED');
    expect((await once(holder)).outcome).toBe('NOT_LEASED');
  });

  test('ST25_⑦ ADR0122_ 임대가 넘어가 메모가 없으면 5초는 새 파드의 첫 틱부터다(그만큼 늦을 뿐이다) [ASVS v5.0.0-15.4.2]', async () => {
    const w = world();
    w.setRow('ON_SALE', { countedAtMs: NOW + 60_000 });
    heldAll(w);
    const a = w.judge('pod-a');
    const b = w.judge('pod-b');
    for (let k = 0; k <= 4; k++) {
      expect((await once(a)).outcome).toBe('UNCHANGED');
      if (k < 4) w.clock.advance(SALE_TICK_MS);
    }
    // pod-a가 멈춘다(임대는 마지막 틱 + 3초에 풀린다)
    w.clock.advance(SWEEP_LEASE_TTL_MS);
    expect((await once(b)).outcome).toBe('UNCHANGED');
    w.clock.advance(4999);
    expect((await once(b)).outcome).toBe('UNCHANGED');
    expect(w.writes.apply).toEqual([]);
    w.clock.advance(1);
    expect(await once(b)).toMatchObject({ outcome: 'CHANGED', status: 'ALL_HELD' });
  });
});

describe('리뷰 고침(코드 리뷰 2026-11-09, BUILD_ORDER PRF-144)', () => {
  const TIERS = { soldOutTiers: ['R', 'S'] };
  /** 셋이 0인데 활성 판매 행이 하나 모자란 회차(새는 비트) */
  function leaking(w: World, id: string): void {
    w.setRow('ALL_HELD', TIERS, id);
    w.scene(id).bitmap = bitmapOf(ALL);
    w.scene(id).active = 9;
  }
  /** 전석 홀드인 회차(ALL_HELD에 머문다) */
  function heldScene(w: World, id: string): void {
    w.scene(id).bitmap = bitmapOf(ALL);
    w.scene(id).held = 10;
    w.scene(id).pages = [[0, 6]];
  }
  const byEvent = (a: unknown, b: unknown): number => ((a as { eventId: string }).eventId < (b as { eventId: string }).eventId ? -1 : 1);

  describe('H1 새는 비트를 사람이 알게 한다', () => {
    test('ST25_⑪ ADR0122_ 리뷰 고침 H1: 거짓 매진 막기가 막으면 회차마다 1분에 경고 한 줄이고 회차 ID·활성 행 수·켜진 비트 수만 싣는다 [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', async () => {
      const w = world(['a', 'b']);
      leaking(w, 'a');
      leaking(w, 'b');
      const j = w.judge();
      await j.tick();
      const fields = w.warnLines().map((l) => l.args[0]);
      expect([...fields].sort(byEvent)).toEqual([
        { eventId: 'a', activeSales: 9, takenSeats: 10 },
        { eventId: 'b', activeSales: 9, takenSeats: 10 },
      ]);
      w.clock.advance(SALE_WARN_INTERVAL_MS - 1);
      await j.tick();
      expect(w.warnLines()).toHaveLength(2);
      w.clock.advance(1);
      await j.tick();
      expect(w.warnLines()).toHaveLength(4);
      expect(w.signals.calls.filter((c) => c === 'guardBlocked')).toHaveLength(6);
    });

    test('ST25_⑪ ADR0122_ 리뷰 고침 H1: 막힘 경고의 문은 실패 경고의 문과 따로다(실패 경고가 있었어도 막힘 경고가 남는다) [ASVS v5.0.0-16.3.4]', async () => {
      const w = world(['a', 'b']);
      w.setRow('ON_SALE', {}, 'a');
      w.fail.counts = (e) => (e === 'a' ? new Error('boom') : undefined);
      leaking(w, 'b');
      await w.judge().tick();
      expect(w.warnLines().map((l) => (l.args[0] as { eventId: string }).eventId).sort()).toEqual(['a', 'b']);
    });

    test('ST25_ADR0122_ 리뷰 고침 H1: all_held_seconds는 이 파드가 맡은 회차 가운데 ALL_HELD가 가장 오래 이어진 시간(지금 − changed_at, 초)이고 틱 끝에 한 번 낸다 [ASVS v5.0.0-16.3.4]', async () => {
      const w = world(['a', 'b', 'c']);
      w.setRow('ALL_HELD', { changedAtMs: NOW - 90_000 }, 'a');
      w.setRow('ALL_HELD', { changedAtMs: NOW - 1_500_000 }, 'b');
      w.setRow('ON_SALE', { changedAtMs: NOW - 9_000_000 }, 'c');
      heldScene(w, 'a');
      heldScene(w, 'b');
      await w.judge().tick();
      expect(w.signals.allHeld).toEqual([1500]);
    });

    test('ST25_ADR0122_ 리뷰 고침 H1: ALL_HELD가 없으면 0이다', async () => {
      const w = world();
      w.setRow('ON_SALE', { changedAtMs: NOW - 9_000_000 });
      await w.judge().tick();
      expect(w.signals.allHeld).toEqual([0]);
    });

    test('ST25_ADR0122_ 리뷰 고침 H1: 이번 틱에 ALL_HELD를 벗어난 회차는 세지 않는다', async () => {
      const w = world();
      w.setRow('ALL_HELD', { changedAtMs: NOW - 9_000_000 });
      w.s.bitmap = bitmapOf([0]);
      expect(await once(w.judge())).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE' });
      expect(w.signals.allHeld).toEqual([0]);
    });

    test('ST25_ADR0122_ 리뷰 고침 H1: 임대를 다른 파드가 잡은 회차는 이 파드의 값에 들지 않는다', async () => {
      const w = world();
      w.setRow('ALL_HELD', { changedAtMs: NOW - 9_000_000 });
      await w.leasesInner.acquire(E, 'pod-b', SWEEP_LEASE_TTL_MS, 'sale');
      await w.judge('pod-a').tick();
      expect(w.signals.allHeld).toEqual([0]);
    });

    test.each([
      ['세대 키가 없는 틱', (w: World) => void (w.s.notReady = true)],
      ['좌석 Redis가 실패한 틱', (w: World) => void (w.fail.counts = () => new Error('boom'))],
    ])('ST25_ADR0122_ 리뷰 고침 H1: %s에도 맡은 회차의 ALL_HELD 시간을 낸다(셈을 못 봐도 상태는 그대로다)', async (_, setup) => {
      const w = world();
      w.setRow('ALL_HELD', { changedAtMs: NOW - 1_300_000 });
      setup(w);
      await w.judge().tick();
      expect(w.signals.allHeld).toEqual([1300]);
    });
  });

  describe('M2 ENDED는 셈에 묶이지 않는다', () => {
    test('ST25_ADR0122_ 리뷰 고침 M2: 판매 종료가 지나면 좌석 Redis·결제 중을 읽지 않고 행의 마지막 셈으로 ENDED를 쓴다(판 번호 조건) [ASVS v5.0.0-2.3.1]', async () => {
      const w = world();
      w.setRow('ALL_HELD', { available: 3, held: 4, paying: 5, soldOutTiers: ['R'], reopenCount: 1, previousStatus: 'ON_SALE' });
      w.s.config = { ...w.s.config!, saleEndsAtMs: NOW };
      expect(await once(w.judge())).toEqual({ eventId: E, outcome: 'CHANGED', status: 'ENDED', version: 4, guardBlocked: false });
      expect(w.calledCount('counts')).toBe(0);
      expect(w.calledCount('paying')).toBe(0);
      expect(w.calledCount('active')).toBe(0);
      expect(w.writes.apply).toEqual([{ eventId: E, expectedVersion: 3, status: 'ENDED', previousStatus: 'ALL_HELD', soldOutTiers: ['R'], reopenCount: 1, available: 3, held: 4, paying: 5, nowMs: NOW }]);
      expect(w.signals.calls).toEqual(['transition:ENDED']);
    });

    test.each([
      ['세대 키가 없어도(NOT_READY)', (w: World) => void (w.s.notReady = true)],
      ['좌석 Redis 읽기가 실패해도', (w: World) => void (w.fail.counts = () => new SeatStoreUnavailable(new Error('down')))],
      ['결제 중 읽기가 실패해도', (w: World) => void (w.fail.paying = () => new Error('boom'))],
    ])('ST25_ADR0122_ 리뷰 고침 M2: %s ENDED가 된다 [ASVS v5.0.0-16.5.3]', async (_, setup) => {
      const w = world();
      w.setRow('ON_SALE');
      w.s.config = { ...w.s.config!, saleEndsAtMs: NOW };
      setup(w);
      expect(await once(w.judge())).toMatchObject({ outcome: 'CHANGED', status: 'ENDED' });
    });

    test('ST25_ADR0122_ 리뷰 고침 M2: 다른 파드에 지면 LOST다(판 번호 조건)', async () => {
      const w = world();
      w.setRow('ON_SALE');
      w.s.config = { ...w.s.config!, saleEndsAtMs: NOW };
      w.lose.apply = true;
      expect(await once(w.judge())).toMatchObject({ outcome: 'LOST' });
      expect(w.signals.calls).toEqual([]);
    });
  });

  describe('M3 평균 실패가 전이를 막지 않는다', () => {
    test('ST25_⑩ ADR0122_ 리뷰 고침 M3: 평균 읽기가 실패해도 전이는 평균 칸 없이 쓰고 지표 stage avg와 경고를 남긴다 [ASVS v5.0.0-16.5.2] [ASVS v5.0.0-16.3.4]', async () => {
      const w = world();
      w.setRow('ALL_HELD');
      w.s.bitmap = bitmapOf([0]);
      w.fail.avg = () => new Error('boom');
      expect(await once(w.judge())).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE', version: 4 });
      expect(w.writes.apply).toHaveLength(1);
      expect('avgTicketsPerOrder' in w.writes.apply[0]!).toBe(false);
      expect(w.signals.calls).toEqual(['failure:avg', 'transition:ON_SALE']);
      expect(w.warnLines().map((l) => l.args[0])).toMatchObject([{ eventId: E, stage: 'avg' }]);
    });

    test('ST25_⑩ ADR0122_ 리뷰 고침 M3: 평균 실패는 두 번 이어짐을 끊지 않는다: 다시 내기에서 실패해도 다음 빈 틱에 SOLD_OUT이다 [ASVS v5.0.0-16.5.2]', async () => {
      const w = world();
      w.setRow('ALL_HELD', { ...TIERS, countedAtMs: NOW - SALE_REPUBLISH_MS });
      soldAll(w);
      w.fail.avg = () => new Error('boom');
      const j = w.judge();
      expect((await once(j)).outcome).toBe('REPUBLISHED');
      w.clock.advance(SALE_TICK_MS);
      expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT' });
    });

    test('ST25_⑩ ADR0122_ 리뷰 고침 M3: 실패도 1분 캐시해 다음 틱에 다시 읽지 않고, 1분이 지나면 다시 읽어 싣는다 [ASVS v5.0.0-15.4.4]', async () => {
      const w = world();
      w.fail.avg = () => new Error('boom');
      const j = w.judge();
      expect((await once(j)).outcome).toBe('CREATED');
      w.clock.advance(SALE_REPUBLISH_MS);
      expect((await once(j)).outcome).toBe('REPUBLISHED');
      w.clock.advance(AVG_CACHE_MS - SALE_REPUBLISH_MS - 1);
      expect((await once(j)).outcome).toBe('REPUBLISHED');
      expect(w.calledCount('avg')).toBe(1);
      expect(w.signals.calls.filter((c) => c === 'failure:avg')).toHaveLength(1);
      delete w.fail.avg;
      w.s.avg = 2.5;
      w.clock.advance(SALE_REPUBLISH_MS);
      expect((await once(j)).outcome).toBe('REPUBLISHED');
      expect(w.calledCount('avg')).toBe(2);
      expect(w.writes.republish.at(-1)).toMatchObject({ avgTicketsPerOrder: 2.5 });
    });
  });

  describe('M4 틱이 겹친 때와 걸린 시간', () => {
    test('ST25_ADR0122_ 리뷰 고침 M4: 앞 틱과 겹쳐 건너뛰면 skipped overlapped를 올리고 틱 시간은 내지 않는다 [ASVS v5.0.0-15.4.4]', async () => {
      const w = world();
      w.setRow('ON_SALE');
      const gate = deferred();
      w.wait.counts = () => gate.promise;
      const j = w.judge();
      const first = j.tick();
      await flush();
      expect(await j.tick()).toEqual({ overlapped: true, events: [] });
      expect(w.signals.calls).toEqual(['skipped:overlapped']);
      expect(w.signals.tickTimes).toEqual([]);
      gate.resolve();
      await first;
    });

    test('ST25_ADR0122_ 리뷰 고침 M4: 틱 하나의 걸린 시간을 초로 낸다(단조 시계)', async () => {
      const w = world();
      w.setRow('ON_SALE');
      w.wait.counts = async () => void w.clock.advance(250);
      await w.judge().tick();
      expect(w.signals.tickTimes).toEqual([0.25]);
    });

    test('ST25_ADR0122_ 리뷰 고침 M4: 회차 목록을 읽지 못한 틱도 걸린 시간을 낸다', async () => {
      const w = world();
      w.fail.saleEvents = () => new Error('boom');
      await w.judge().tick();
      expect(w.signals.tickTimes).toEqual([0]);
    });
  });

  describe('L6 매진 풀림 대조', () => {
    test('ST25_⑥ ADR0122_ 리뷰 고침 L6: SOLD_OUT에서 가용이 생겨도 활성 판매 행 수가 판매 대상과 같으면 풀지 않고 guard_blocked와 경고를 남긴다(비트만 잃은 장애 조치) [ASVS v5.0.0-16.5.3] [ASVS v5.0.0-16.3.4]', async () => {
      const w = world();
      w.setRow('SOLD_OUT', TIERS);
      w.s.bitmap = bitmapOf(ALL.slice(1));
      w.s.active = 10;
      w.clock.advance(1);
      expect(await once(w.judge())).toEqual({ eventId: E, outcome: 'UNCHANGED', status: 'SOLD_OUT', guardBlocked: true });
      expect(w.writes.apply).toEqual([]);
      expect(w.signals.calls).toEqual(['guardBlocked']);
      expect(w.warnLines().map((l) => l.args[0])).toEqual([{ eventId: E, activeSales: 10, takenSeats: 9 }]);
    });

    test('ST25_⑥ ADR0122_ 리뷰 고침 L6: 활성 판매 행 수가 판매 대상보다 적으면 그대로 풀린다 [ASVS v5.0.0-2.3.1]', async () => {
      const w = world();
      w.setRow('SOLD_OUT', { reopenCount: 2 });
      w.s.bitmap = bitmapOf(ALL.slice(1));
      w.s.active = 9;
      expect(await once(w.judge())).toMatchObject({ outcome: 'CHANGED', status: 'ON_SALE', guardBlocked: false });
      expect(w.writes.apply[0]).toMatchObject({ reopenCount: 3 });
    });

    test('ST25_ADR0122_ 리뷰 고침 L6: 대조는 SOLD_OUT에서 가용이 생긴 때만 읽는다 [ASVS v5.0.0-15.4.4]', async () => {
      const w = world();
      w.setRow('SOLD_OUT', TIERS);
      soldAll(w);
      await once(w.judge());
      expect(w.calledCount('active')).toBe(0);
    });
  });

  describe('L7 두 번 이어짐과 시각', () => {
    test('ST25_④ ADR0122_ 리뷰 고침 L7: 틱이 몰려 빈 틱 두 번이 1초 안이면 SOLD_OUT이 아니고 첫 빈 틱에서 1초가 지난 틱에 된다 [ASVS v5.0.0-2.3.1]', async () => {
      const w = world();
      w.setRow('ALL_HELD', TIERS);
      soldAll(w);
      const j = w.judge();
      expect((await once(j)).status).toBe('ALL_HELD');
      w.clock.advance(SALE_TICK_MS - 1);
      expect((await once(j)).status).toBe('ALL_HELD');
      w.clock.advance(1);
      expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT' });
    });

    test('ST25_ADR0122_ 리뷰 고침 L7: 좌석맵 판이 없는 틱도 두 번 이어짐을 끊는다', async () => {
      const w = world();
      w.setRow('ALL_HELD', TIERS);
      soldAll(w);
      const j = w.judge();
      const layout = w.s.layout;
      await once(j);
      w.clock.advance(SALE_TICK_MS);
      w.s.layout = undefined;
      expect((await once(j)).outcome).toBe('NO_CONFIG');
      w.clock.advance(SALE_TICK_MS);
      w.s.layout = layout;
      expect((await once(j)).outcome).toBe('UNCHANGED');
      w.clock.advance(SALE_TICK_MS);
      expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'SOLD_OUT' });
    });

    test('ST25_ADR0122_ 리뷰 고침 L7: NOT_READY 틱은 가용 0이 시작된 시각도 지운다(셈을 못 본 동안은 이어짐을 모른다)', async () => {
      const w = world();
      w.setRow('ON_SALE', { countedAtMs: NOW + 60_000 });
      heldAll(w);
      const j = w.judge();
      await once(j);
      w.clock.advance(2000);
      w.s.notReady = true;
      expect((await once(j)).outcome).toBe('NOT_READY');
      w.s.notReady = false;
      w.clock.advance(3000);
      expect((await once(j)).outcome).toBe('UNCHANGED');
      w.clock.advance(4999);
      expect((await once(j)).outcome).toBe('UNCHANGED');
      w.clock.advance(1);
      expect(await once(j)).toMatchObject({ outcome: 'CHANGED', status: 'ALL_HELD' });
    });
  });

  describe('L9·L12 잘못된 값', () => {
    test('ST25_ADR0122_ 리뷰 고침 L9: 결제 중 읽기는 소문자 UUID가 아닌 회차 ID를 빈 Map으로 넘기지 않고 RangeError로 던진다(쿼리를 보내지 않는다) [ASVS v5.0.0-16.5.3]', async () => {
      const untouchable = new Proxy({} as never, {
        get: (_t, p) => {
          throw new Error(`DB에 갔다: ${String(p)}`);
        },
      });
      await expect(new DrizzleSalePaying({ database: untouchable }).payingByTier('NOT-A-UUID', NOW)).rejects.toBeInstanceOf(RangeError);
    });

    test('ST25_ADR0122_ 리뷰 고침 L12: 만료 인덱스의 정수가 아닌 멤버는 던지지 않고 건너뛰어 그 수를 돌려준다 [ASVS v5.0.0-16.5.2]', async () => {
      const redis = { evalScript: async () => ['1', '01', 'abc', '-1', '2'] };
      await expect(new RedisSaleCounts(redis as never).holdIndexes('ev-a', 0, 10)).resolves.toEqual({ indexes: [1, 2], badMembers: 3 });
    });

    test('ST25_⑨ ADR0122_ 리뷰 고침 L12: 건너뛴 멤버는 지표로 드러나고, 쪽이 꽉 찼는지는 건너뛰기 전의 수로 본다(다음 쪽의 홀드를 놓치지 않는다) [ASVS v5.0.0-16.5.2]', async () => {
      const w = world();
      w.setRow('ON_SALE');
      w.s.bitmap = bitmapOf([6, 7, 8, 9]);
      w.s.held = 1500;
      const calls: number[] = [];
      const counts: SaleCountsReader = {
        read: async () => ({ kind: 'OK', bitmap: w.s.bitmap, held: w.s.held }),
        holdIndexes: async (_e, start) => {
          calls.push(start);
          return start === 0 ? { indexes: FULL_PAGE(0).slice(1), badMembers: 1 } : { indexes: [6], badMembers: 0 };
        },
      };
      const j = w.judge('pod-a', { counts });
      await once(j);
      expect(calls).toEqual([0, 1000]);
      expect(w.signals.calls).toEqual(['skipped:bad_member:1']);
      w.clock.advance(SALE_TICK_MS);
      await once(j);
      expect(w.writes.apply, '다음 쪽에 홀드가 있으니 등급 매진이 아니다').toEqual([]);
    });
  });
});

describe('PromSaleStateSignals(지표 이름·이름표, docs/observability.md)', () => {
  /** 노출 글에서 purchase_event_sale_ 카운터 표본 줄만(게이지·히스토그램은 값이 없어도 나오므로 따로 본다) */
  const samples = (text: string): string[] =>
    text
      .split('\n')
      .filter((l) => l.startsWith('purchase_event_sale_') && /_total[{ ]/.test(l))
      .sort();

  test('ST25_ADR0122_ 리뷰 고침 H1·M4·M3·L12: ALL_HELD 시간 게이지·틱 시간 히스토그램·overlapped·bad_member·avg가 정한 이름으로 나온다(회차 이름표 없음) [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromSaleStateSignals().register(metrics.registry);
    s.allHeldSeconds(1500);
    s.tickSeconds(0.25);
    s.skipped('overlapped');
    s.skipped('bad_member', 3);
    s.tickFailure('avg');
    const text = await metrics.registry.metrics();
    expect(text).toContain('# TYPE purchase_event_sale_all_held_seconds gauge');
    expect(text).toMatch(/^purchase_event_sale_all_held_seconds 1500$/m);
    expect(text).toContain('# TYPE purchase_event_sale_tick_seconds histogram');
    expect(text).toMatch(/^purchase_event_sale_tick_seconds_count 1$/m);
    expect(text).toMatch(/^purchase_event_sale_tick_seconds_sum 0\.25$/m);
    expect(samples(text)).toEqual(expect.arrayContaining(['purchase_event_sale_skipped_total{reason="bad_member"} 3', 'purchase_event_sale_skipped_total{reason="overlapped"} 1', 'purchase_event_sale_tick_failures_total{stage="avg"} 1']));
  });

  test('ST25_ADR0122_ register는 자신을 돌려주고, 다섯 지표가 정한 이름·이름표로 1씩 오른다(회차 이름표 없음) [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.2.5]', async () => {
    const metrics = new PlatformMetrics('purchase-svc');
    const s = new PromSaleStateSignals();
    expect(s.register(metrics.registry)).toBe(s);
    s.transition('SOLD_OUT');
    s.transition('SOLD_OUT');
    s.transition('ON_SALE');
    s.republished();
    s.guardBlocked();
    s.guardBlocked();
    s.tickFailure('lease');
    s.tickFailure('counts');
    s.tickFailure('paying');
    s.tickFailure('write');
    s.skipped('no_config');
    s.skipped('not_ready');
    const text = await metrics.registry.metrics();
    expect(samples(text)).toEqual(
      [
        'purchase_event_sale_transitions_total{to="SOLD_OUT"} 2',
        'purchase_event_sale_transitions_total{to="ON_SALE"} 1',
        'purchase_event_sale_republished_total 1',
        'purchase_event_sale_guard_blocked_total 2',
        'purchase_event_sale_tick_failures_total{stage="lease"} 1',
        'purchase_event_sale_tick_failures_total{stage="counts"} 1',
        'purchase_event_sale_tick_failures_total{stage="paying"} 1',
        'purchase_event_sale_tick_failures_total{stage="write"} 1',
        'purchase_event_sale_skipped_total{reason="no_config"} 1',
        'purchase_event_sale_skipped_total{reason="not_ready"} 1',
      ].sort(),
    );
    for (const name of ['transitions', 'republished', 'guard_blocked', 'tick_failures', 'skipped']) expect(text).toContain(`# TYPE purchase_event_sale_${name}_total counter`);
  });

  test('ST25_ADR0122_ 붙이기 전에도 메서드는 던지지 않고 센다', async () => {
    const s = new PromSaleStateSignals();
    expect(() => {
      s.transition('ALL_HELD');
      s.republished();
      s.guardBlocked();
      s.tickFailure('write');
      s.skipped('not_ready');
    }).not.toThrow();
    const metrics = new PlatformMetrics('purchase-svc');
    s.register(metrics.registry);
    expect(samples(await metrics.registry.metrics())).toContain('purchase_event_sale_transitions_total{to="ALL_HELD"} 1');
  });
});

describe('운영 조립(main.ts): 판정기는 조립에서 빠뜨려도 형 오류가 없어 소스 글로 본다', () => {
  /** 주석을 뺀 소스(주석으로 막은 줄이 통과하지 않게). 줄바꿈은 LF로 맞춘다 */
  const source = (): string =>
    // 운영 조립은 start.ts에 있다(main.ts는 환경 값과 SIGTERM만 잇는다, BUILD_ORDER PRF-215)
    readFileSync(new URL('../src/start.ts', import.meta.url), 'utf8')
      .replace(/\r\n/g, '\n')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  /** new SaleStateJudge를 담은 변수 이름 */
  const judgeName = (main: string): string => {
    const m = /\b(\w+)\s*=\s*new SaleStateJudge\(\{/.exec(main);
    expect(m, 'main.ts에 new SaleStateJudge({ … })가 있다').not.toBeNull();
    return m![1]!;
  };

  test('ST25_ADR0122_ 운영 main.ts는 전용 풀(saleStateDatabaseOptions)로 판정기를 만들고 어댑터와 지표를 잇는다 [ASVS v5.0.0-16.5.2]', () => {
    const main = source();
    expect(main).toMatch(/\bcreateDatabase\(saleStateDatabaseOptions\(databaseUrl\)\)/);
    judgeName(main);
    expect(main).toMatch(/\bnew RedisSaleCounts\(/);
    expect(main).toMatch(/\bnew DrizzleEventSale\(/);
    expect(main).toMatch(/\bnew DrizzleSalePaying\(/);
    expect(main).toMatch(/new PromSaleStateSignals\(\)\.register\(service\.metrics\.registry\)/);
  });

  test('ST25_ADR0122_ 듣기 시작한 뒤에 start()로 켜고, 종료 때 stop()으로 끈 뒤 전용 풀을 닫는다 [ASVS v5.0.0-16.5.2]', () => {
    const main = source();
    const name = judgeName(main);
    const listenAt = main.indexOf('await service.listen();');
    expect(listenAt, 'main.ts에 await service.listen()이 있다').toBeGreaterThan(-1);
    expect(main.slice(listenAt)).toMatch(new RegExp(`\\b${name}\\??\\.start\\(\\);`));
    const closing = main.slice(main.indexOf('function shutdown'));
    const stopAt = closing.search(new RegExp(`\\b${name}\\??\\.stop\\(\\)`));
    expect(stopAt, 'shutdown이 판정기를 멈춘다').toBeGreaterThan(-1);
    const pool = /\b(\w+)\s*=\s*createDatabase\(saleStateDatabaseOptions\(/.exec(main)?.[1];
    expect(pool, '전용 풀 변수가 있다').toBeDefined();
    // createDatabase를 임시 변수에 받아 let 변수로 옮기는 꼴(orderExpiryDatabase)도 받는다
    const closed = new RegExp(`\\b(${pool}|\\w*[Ss]aleState\\w*)\\??\\.close\\(\\)`).exec(closing);
    expect(closed, 'shutdown이 전용 풀을 닫는다').not.toBeNull();
    expect(closed!.index, '판정기를 멈춘 뒤에 닫는다').toBeGreaterThan(stopAt);
  });
});
