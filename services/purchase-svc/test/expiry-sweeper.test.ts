// 1초 만료 반복(ExpirySweeper, docs/features/seat-hold.md §5 '운영 만료 Lua와 1초 반복'·'1초 반복과 회차별 임대', docs/data.md §3 s:{event:E}:sweep,
// BUILD_ORDER PRF-135). 메모리 저장소·메모리 임대·메모리 좌석맵 판으로 조립하고, 시각은 주입한 가짜 시계, 반복은 손으로 tick()을 부른다(고정 sleep 없음).
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { type FakeClock, fakeClock, type HotRedis, type PlatformLogger, PlatformMetrics, systemClock, uuidv7 } from '@peaket/platform';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
  type DueExpiriesInput,
  EXPIRY_BATCH_SIZE,
  EXPIRY_MAX_BATCHES_PER_TICK,
  EXPIRY_TICK_MS,
  type ExpireInput,
  ExpirySweeper,
  type ExpirySweeperDeps,
  HOLD_TTL_MS,
  type HoldInput,
  KEEP_AFTER_SALE_END_MS,
  KEY_PART,
  type MemoryHoldHash,
  type MemorySeatDef,
  MemorySeatMap,
  MemorySeatStore,
  MemorySweepLeases,
  PromSeatSignals,
  RedisSeatStore,
  REHOLD_WAIT_MS,
  type SeatExpiries,
  type SeatLuaErrorCode,
  type SeatLuaScript,
  type SeatRef,
  type SeatSignals,
  SeatStoreUnavailable,
  SWEEP_LEASE_TTL_MS,
  type SweepEventReport,
  type SweepLeases,
  type SweepTimer,
  seatKeys,
  systemSweepTimer,
} from '../src/modules/inventory/index.js';
import * as inventory from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, account, DAY, fingerprintOf, newEvent, ref, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** 좌석 Lua 지표 기록 */
function recordingSignals(): SeatSignals & { calls: [SeatLuaScript, SeatLuaErrorCode][] } {
  const calls: [SeatLuaScript, SeatLuaErrorCode][] = [];
  return { calls, luaError: (script, code) => void calls.push([script, code]) };
}

/** 로그 기록(로거 메서드마다 받은 인자를 그대로 적는다) */
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

/** 손으로 부르는 반복 타이머 */
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

/** 미뤄 둔 약속 */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** 지금 쌓인 약속 작업을 한 바퀴 돌린다(시간을 기다리지 않는다) */
const flush = () => new Promise<void>((r) => setImmediate(r));

/** 큰 회차용 좌석(색인 i, 구역 10개를 고르게) */
const bigSeat = (i: number): MemorySeatDef => ({ seatId: `S${String(i).padStart(5, '0')}`, index: i, sectionId: `SEC-${i % 10}`, sectionIndex: i % 10, seatOffset: Math.floor(i / 10), tierId: 'R' });

interface Calls {
  saleEvents: number;
  due: DueExpiriesInput[];
  expire: ExpireInput[];
  byIndex: { eventId: string; indexes: number[] }[];
  acquire: [string, string, number][];
}

/**
 * 메모리 조립 하나. expiries·leases·seatMap은 메모리 구현을 감싸 호출을 적고, fail로 갈래마다 실패를 끼운다.
 * 같은 world의 sweeper 여럿은 같은 저장소·같은 임대(같은 MemorySeatDb)를 나눈다(파드 여럿)
 */
function world(o: { clock?: FakeClock } = {}) {
  const clock = o.clock ?? fakeClock({ now: NOW, monotonic: 0 });
  const store = new MemorySeatStore(clock);
  const seatMap = new MemorySeatMap();
  const leasesInner = new MemorySweepLeases(store.db, clock);
  const signals = recordingSignals();
  const log = recordingLogger();
  const calls: Calls = { saleEvents: 0, due: [], expire: [], byIndex: [], acquire: [] };
  /** 갈래마다 끼울 실패(부를 때마다 그 함수를 부르고, 값을 돌려주면 그것을 던진다) */
  const fail: { saleEvents?: () => unknown; due?: (i: DueExpiriesInput) => unknown; expire?: (i: ExpireInput, n: number) => unknown; acquire?: () => unknown } = {};
  /** 갈래마다 잠시 붙잡기(부를 때마다 그 약속을 기다린 뒤 저장소를 부른다. 동시성·멈춤 시험용) */
  const wait: { due?: (i: DueExpiriesInput) => Promise<void>; expire?: (i: ExpireInput) => Promise<void> } = {};
  const expiries: SeatExpiries = {
    saleEvents: async () => {
      calls.saleEvents += 1;
      const x = fail.saleEvents?.();
      if (x !== undefined) throw x;
      return store.saleEvents();
    },
    dueExpiries: async (i) => {
      calls.due.push({ ...i });
      await wait.due?.(i);
      const x = fail.due?.(i);
      if (x !== undefined) throw x;
      return store.dueExpiries(i);
    },
    expire: async (i) => {
      calls.expire.push({ ...i, seats: [...i.seats] });
      await wait.expire?.(i);
      const x = fail.expire?.(i, calls.expire.length);
      if (x !== undefined) throw x;
      return store.expire(i);
    },
  };
  const leases: SweepLeases = {
    acquire: async (e, owner, ttl) => {
      calls.acquire.push([e, owner, ttl]);
      const x = fail.acquire?.();
      if (x !== undefined) throw x;
      return leasesInner.acquire(e, owner, ttl);
    },
  };
  const map = {
    config: (e: string) => seatMap.config(e),
    resolve: (e: string, ids: readonly string[]) => seatMap.resolve(e, ids),
    byIndex: async (e: string, indexes: readonly number[]) => {
      calls.byIndex.push({ eventId: e, indexes: [...indexes] });
      return seatMap.byIndex(e, indexes);
    },
  };
  const sweeper = (podId = 'pod-a', over: Partial<ExpirySweeperDeps> = {}) =>
    new ExpirySweeper({ expiries, seatMap: map, leases, clock, podId, signals, logger: log.logger, ...over });

  /** 회차 하나(좌석맵 판·판매 열기) */
  async function openEvent(seats: readonly MemorySeatDef[] = SEAT_DEFS, o2: { seatCount?: number; saleEndsAtMs?: number; map?: boolean; eventId?: string } = {}) {
    const eventId = o2.eventId ?? newEvent();
    const seatCount = o2.seatCount ?? SEAT_COUNT;
    const saleEndsAtMs = o2.saleEndsAtMs ?? NOW + DAY;
    if (o2.map !== false) seatMap.put({ eventId, layoutVersion: 'v1', seatCount, perAccountLimit: 4, saleEndsAtMs }, seats);
    await store.openSale({ eventId, seatCount, keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS });
    return { eventId, saleEndsAtMs, keepUntilMs: saleEndsAtMs + KEEP_AFTER_SALE_END_MS };
  }

  /** 좌석들을 한 계정으로 잡는다(좌석 ID 오름차순·지문을 맞춘다) */
  async function hold(eventId: string, seats: readonly SeatRef[], accountId = ACCOUNT_A, keepUntilMs = NOW + 2 * DAY) {
    const sorted = [...seats].sort((a, b) => byCode(a.seatId, b.seatId));
    const i: HoldInput = {
      eventId,
      accountId,
      purchaseSessionId: `ps-${accountId.slice(-4)}`,
      holdId: uuidv7(systemClock),
      idempotencyKey: randomUUID(),
      fingerprint: fingerprintOf(sorted.map((s) => s.seatId)),
      seats: sorted,
      limit: 4,
      keepUntilMs,
    };
    const r = await store.hold(i);
    if (r.kind !== 'OK') throw new Error(`시험 준비 홀드가 안 됐다: ${JSON.stringify(r)}`);
    return r;
  }

  /** 좌석 n개를 4석씩 다른 계정으로 잡는다 */
  async function holdMany(eventId: string, seats: readonly SeatRef[], firstAccount = 100) {
    for (let k = 0; k * 4 < seats.length; k++) await hold(eventId, seats.slice(k * 4, k * 4 + 4), account(firstAccount + k));
  }

  return { clock, store, seatMap, signals, log, calls, fail, wait, expiries, leases, map, sweeper, openEvent, hold, holdMany, ev: (e: string) => store.db.event(e) };
}

/** 회차 하나의 틱 결과(기본값 0) */
// corrupt 칸(M2)은 구현이 형에 더하는 칸이라, 있든 없든(필수·선택) 형 검사가 되게 뺀 뒤 선택으로 붙인다
const report = (
  eventId: string,
  outcome: SweepEventReport['outcome'],
  o: Partial<Omit<SweepEventReport, 'eventId' | 'outcome' | 'corrupt'>> & { corrupt?: number } = {},
): Omit<SweepEventReport, 'corrupt'> & { corrupt?: number } => ({
  eventId,
  outcome,
  batches: 0,
  released: 0,
  skipped: 0,
  orphans: 0,
  unknownSeats: 0,
  ...o,
});

afterEach(() => {
  vi.useRealTimers();
});

describe('ExpirySweeper.tick: 한 회차를 푸는 차례', () => {
  test('ST6_FR042_ 시간이 지난 홀드를 풀어 비트·보유 수가 돌아오고, 1단계는 주입 시계의 지금·100석으로 읽으며 keepUntil은 판매 종료 + 1일이다(DRAINED)', async () => {
    const w = world();
    const { eventId, saleEndsAtMs } = await w.openEvent();
    await w.hold(eventId, [ref('A01'), ref('A02')], ACCOUNT_A);
    await w.hold(eventId, [ref('B01')], ACCOUNT_B);
    w.clock.advance(HOLD_TTL_MS);
    const t = await w.sweeper().tick();
    expect(t).toMatchObject({ overlapped: false, events: [report(eventId, 'DRAINED', { batches: 1, released: 3 })] });
    for (const id of ['A01', 'A02', 'B01']) expect({ id, bit: w.ev(eventId).bits.has(ref(id).index) }).toEqual({ id, bit: false });
    expect(w.ev(eventId).quota.get(ACCOUNT_A)).toBeUndefined();
    expect(w.ev(eventId).quota.get(ACCOUNT_B)).toBeUndefined();
    expect(w.calls.due).toEqual([{ eventId, nowMs: NOW + HOLD_TTL_MS, limit: EXPIRY_BATCH_SIZE }]);
    expect(w.calls.expire.map((x) => x.keepUntilMs)).toEqual([saleEndsAtMs + KEEP_AFTER_SALE_END_MS]);
    expect(w.calls.acquire).toEqual([[eventId, 'pod-a', SWEEP_LEASE_TTL_MS]]);
    // 좌석맵 판의 '색인 → 좌석'을 묶음마다 한 번 부르고, 만료 Lua에는 1단계 차례 그대로 좌석 정보를 붙여 넘긴다
    expect(w.calls.byIndex).toEqual([{ eventId, indexes: [ref('A01').index, ref('A02').index, ref('B01').index] }]);
    expect(w.calls.expire[0]!.seats.map((s) => [s.index, s.expected?.owner, s.seat?.seatId])).toEqual([
      [ref('A01').index, ACCOUNT_A, 'A01'],
      [ref('A02').index, ACCOUNT_A, 'A02'],
      [ref('B01').index, ACCOUNT_B, 'B01'],
    ]);
    expect(w.signals.calls).toEqual([]);
  });

  test('POL012_FR042_ 홀드는 잡은 뒤 7분이 되는 틱에 풀린다(7분 1ms 전 틱은 읽을 것이 없어 묶음 0)', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')]);
    const s = w.sweeper();
    w.clock.advance(HOLD_TTL_MS - 1);
    expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED')]);
    expect(w.ev(eventId).bits.has(ref('A01').index)).toBe(true);
    w.clock.advance(1);
    expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 1 })]);
    expect(w.ev(eventId).bits.has(ref('A01').index)).toBe(false);
  });

  test('FR042_NFR025_ 푼 좌석은 샤드 Pub/Sub로 상태 0(가능)이 나가고 Stream에 EXPIRED가 남는다(좌석맵 화면에 다시 보이는 길)', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A03')]);
    w.clock.advance(HOLD_TTL_MS);
    const before = w.ev(eventId).published.length;
    await w.sweeper().tick();
    const pubs = w.ev(eventId).published.slice(before);
    expect(pubs).toHaveLength(1);
    expect(pubs[0]!.channel).toBe(seatKeys.section(eventId, '0'));
    expect(pubs[0]!.message.endsWith(` ${ref('A03').seatOffset}:0`)).toBe(true);
    expect(w.ev(eventId).stream.at(-1)).toMatchObject({ type: 'EXPIRED', seatId: 'A03', accountId: ACCOUNT_A });
  });

  test('ST6_NFR003_ 묶음마다 100석 이하로 읽고 넘기며, 250석이면 한 틱에 100·100·50 세 묶음으로 다 푼다(DRAINED) [ASVS v5.0.0-15.4.4]', async () => {
    const w = world();
    const seats = Array.from({ length: 250 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 250 });
    await w.holdMany(eventId, seats);
    w.clock.advance(HOLD_TTL_MS);
    const t = await w.sweeper().tick();
    expect(t.events).toMatchObject([report(eventId, 'DRAINED', { batches: 3, released: 250 })]);
    expect(w.calls.due.map((d) => d.limit)).toEqual([100, 100, 100]);
    expect(w.calls.expire.map((x) => x.seats.length)).toEqual([100, 100, 50]);
    expect(w.ev(eventId).bits.size).toBe(0);
    expect(w.ev(eventId).expiry.size).toBe(0);
  });

  test('ST6_ 1단계의 지금은 묶음마다 주입 시계를 새로 읽는다(묶음 사이에 시계가 가면 그 시각으로 읽는다)', async () => {
    const w = world();
    const seats = Array.from({ length: 250 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 250 });
    await w.holdMany(eventId, seats);
    w.clock.advance(HOLD_TTL_MS);
    const t0 = w.clock.now();
    // 만료 Lua 한 번에 1ms가 걸린 것처럼 시계를 민다
    w.fail.expire = () => {
      w.clock.advance(1);
      return undefined;
    };
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 3, released: 250 })]);
    expect(w.calls.due.map((d) => d.nowMs)).toEqual([t0, t0 + 1, t0 + 2]);
  });

  test('ST6_ 지난 좌석이 딱 100석이면 둘째 읽기가 비어 묶음 1로 DRAINED다', async () => {
    const w = world();
    const seats = Array.from({ length: 100 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 100 });
    await w.holdMany(eventId, seats);
    w.clock.advance(HOLD_TTL_MS);
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 100 })]);
    expect(w.calls.due).toHaveLength(2);
  });

  test('ST6_NFR003_ 한 틱에 회차 하나는 20묶음(2,000석)까지만 돌고 BATCH_LIMIT이며, 남은 것은 다음 틱에 푼다 [ASVS v5.0.0-15.4.4]', async () => {
    expect(EXPIRY_MAX_BATCHES_PER_TICK).toBe(20);
    const w = world();
    const seats = Array.from({ length: 2_050 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 2_050 });
    await w.holdMany(eventId, seats);
    w.clock.advance(HOLD_TTL_MS);
    const s = w.sweeper();
    expect((await s.tick()).events).toMatchObject([report(eventId, 'BATCH_LIMIT', { batches: 20, released: 2_000 })]);
    expect(w.calls.expire.every((x) => x.seats.length <= EXPIRY_BATCH_SIZE)).toBe(true);
    expect(w.ev(eventId).expiry.size).toBe(50);
    w.clock.advance(EXPIRY_TICK_MS);
    expect((await s.tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 50 })]);
    expect(w.ev(eventId).expiry.size).toBe(0);
  });

  test('ST6_ 한 묶음에서 푼 것·고아가 모두 0이면(연장된 홀드뿐) 다시 읽어도 같으므로 그 틱을 멈춘다(NO_PROGRESS)', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')]);
    w.clock.advance(HOLD_TTL_MS);
    // 연장됨: 만료 인덱스 점수는 지났는데 Hash exp는 1분 뒤
    w.ev(eventId).holds.get(ref('A01').index)!.exp = w.clock.now() + 60_000;
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'NO_PROGRESS', { batches: 1, skipped: 1 })]);
    expect(w.calls.due).toHaveLength(1);
  });

  test('ST6_ 고아(홀드 Hash 없는 만료 인덱스 멤버)는 좌석맵 판을 묻지 않고 seat 없이 expected null로 넘겨 지운다', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')]);
    w.ev(eventId).expiry.set(36, NOW);
    w.clock.advance(HOLD_TTL_MS);
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 1, orphans: 1 })]);
    expect(w.calls.byIndex).toEqual([{ eventId, indexes: [ref('A01').index] }]);
    expect(w.calls.expire[0]!.seats.find((s) => s.index === 36)).toEqual({ index: 36, expected: null });
    expect(w.ev(eventId).expiry.size).toBe(0);
  });

  test('FR042_ 고아만 있는 묶음은 좌석맵 판을 부르지 않는다', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    w.ev(eventId).expiry.set(36, NOW - 1);
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, orphans: 1 })]);
    expect(w.calls.byIndex).toEqual([]);
  });

  test('FR042_ 좌석맵 판에 없는 색인의 홀드도 멈추지 않고 푼다(EXPIRED의 좌석 칸은 빈 글). unknownSeats를 세고 로그 한 줄(키 이름 없음)을 남기며 Lua 오류 지표는 올리지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    const ghost: SeatRef = { seatId: 'Z35', index: 35, sectionId: 'SEC-Z', sectionIndex: 2, seatOffset: 5, tierId: 'R' };
    await w.hold(eventId, [ghost], ACCOUNT_A);
    await w.hold(eventId, [ref('A01')], ACCOUNT_B);
    w.clock.advance(HOLD_TTL_MS);
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 2, unknownSeats: 1 })]);
    expect(w.ev(eventId).bits.size).toBe(0);
    expect(w.ev(eventId).stream.filter((x) => x.type === 'EXPIRED').map((x) => [x.seatIdx, x.seatId, x.tierId, x.sectionId])).toEqual([
      ['0', 'A01', 'R', 'SEC-A'],
      ['35', '', '', ''],
    ]);
    const errors = w.log.lines.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.args[0]).toEqual({ eventId, step: 'seatmap', unknownSeats: 1 });
    expect(JSON.stringify(errors[0]!.args)).not.toContain(ACCOUNT_A);
    expect(JSON.stringify(errors[0]!.args)).not.toContain('s:{');
    expect(w.signals.calls).toEqual([]);
  });

  test('FR042_ 판매 제외석(좌석맵 판에는 있다)의 홀드도 그 좌석 정보로 푼다(byIndex는 판매 제외석을 준다)', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    const x01 = SEAT_DEFS.find((d) => d.seatId === 'X01')!;
    await w.hold(eventId, [x01]);
    w.clock.advance(HOLD_TTL_MS);
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 1 })]);
    expect(w.ev(eventId).stream.at(-1)).toMatchObject({ type: 'EXPIRED', seatId: 'X01', sectionId: 'SEC-X' });
  });

  test('FR042_POL012_ST33_③ 만료 뒤 다른 계정은 바로 잡고, 같은 계정은 29초에는 REHOLD_WAIT(다시 잡을 시각 = 푼 시각 + 30초), 31초에는 잡는다', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01'), ref('A02')], ACCOUNT_A);
    w.clock.advance(HOLD_TTL_MS);
    const releasedAt = w.clock.now();
    await w.sweeper().tick();
    await w.hold(eventId, [ref('A02')], ACCOUNT_B);
    w.clock.advance(29_000);
    const input = (accountId: string): HoldInput => ({
      eventId,
      accountId,
      purchaseSessionId: 'ps-x',
      holdId: uuidv7(systemClock),
      idempotencyKey: randomUUID(),
      fingerprint: fingerprintOf(['A01']),
      seats: [ref('A01')],
      limit: 4,
      keepUntilMs: NOW + 2 * DAY,
    });
    expect(await w.store.hold(input(ACCOUNT_A))).toEqual({ kind: 'REHOLD_WAIT', seatIds: ['A01'], availableAtMs: releasedAt + REHOLD_WAIT_MS });
    w.clock.advance(2_000);
    expect((await w.store.hold(input(ACCOUNT_A))).kind).toBe('OK');
  });
});

describe('ExpirySweeper.tick: 회차별 임대(NFR-025, 임대 3초 [가정])', () => {
  test('NFR025_ 두 파드 가운데 임대를 잡은 파드만 그 회차를 돌고, 다른 파드는 NOT_LEASED로 만료 저장소를 부르지 않는다', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')]);
    w.clock.advance(HOLD_TTL_MS);
    const a = w.sweeper('pod-a');
    const b = w.sweeper('pod-b');
    expect((await a.tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 1 })]);
    const dueBefore = w.calls.due.length;
    expect((await b.tick()).events).toMatchObject([report(eventId, 'NOT_LEASED')]);
    expect(w.calls.due.length).toBe(dueBefore);
    expect(w.calls.acquire.map((c) => c[1])).toEqual(['pod-a', 'pod-b']);
  });

  test('NFR025_ 잡은 파드는 틱마다 임대를 늘리고, 그 파드가 멈추면 임대 수명(3초)이 다한 틱에 다른 파드가 맡는다', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    const a = w.sweeper('pod-a');
    const b = w.sweeper('pod-b');
    expect((await a.tick()).events[0]!.outcome).toBe('DRAINED');
    w.clock.advance(EXPIRY_TICK_MS);
    expect((await a.tick()).events[0]!.outcome).toBe('DRAINED');
    // a의 마지막 틱(지금)에서 3초가 되기 1ms 전까지는 b가 못 잡는다
    w.clock.advance(SWEEP_LEASE_TTL_MS - 1);
    expect((await b.tick()).events[0]!.outcome).toBe('NOT_LEASED');
    // a가 멈추고 3초가 되면 b가 맡는다. 그 뒤로는 a가 NOT_LEASED다
    w.clock.advance(1);
    expect((await b.tick()).events[0]!.outcome).toBe('DRAINED');
    expect(w.ev(eventId).sweep?.owner).toBe('pod-b');
    expect((await a.tick()).events[0]!.outcome).toBe('NOT_LEASED');
    await w.hold(eventId, [ref('A01')]);
    w.clock.advance(HOLD_TTL_MS);
    expect((await b.tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 1 })]);
  });

  test('ST5_ 임대가 겹쳐 두 파드가 같은 회차를 함께 돌아도 만료 Lua의 펜싱 확인이 한 홀드를 한 번만 푼다(EXPIRED 한 건씩) [ASVS v5.0.0-15.4.2]', async () => {
    const w = world();
    const seats = Array.from({ length: 30 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 30 });
    await w.holdMany(eventId, seats);
    w.clock.advance(HOLD_TTL_MS);
    const always: SweepLeases = { acquire: async () => true };
    const [ra, rb] = await Promise.all([w.sweeper('pod-a', { leases: always }).tick(), w.sweeper('pod-b', { leases: always }).tick()]);
    const total = ra!.events[0]!.released + rb!.events[0]!.released;
    expect(total).toBe(30);
    const expired = w.ev(eventId).stream.filter((x) => x.type === 'EXPIRED').map((x) => x.seatIdx);
    expect(expired).toHaveLength(30);
    expect(new Set(expired).size).toBe(30);
    expect(w.ev(eventId).quota.size).toBe(0);
  });
});

describe('ExpirySweeper.tick: 회차 목록과 회차별 실패', () => {
  test('NFR025_ 보고는 회차 ID 문자 코드 순이고, 한 회차의 실패(스크립트 오류)는 다른 회차를 막지 않는다', async () => {
    const w = world();
    // 회차 목록에 넣는 차례(판매 연 차례)가 문자 코드 순과 다르게: c → a → B(대문자는 소문자보다 앞)
    const base = newEvent();
    const one = await w.openEvent(SEAT_DEFS, { eventId: `${base}-c` });
    const two = await w.openEvent(SEAT_DEFS, { eventId: `${base}-a` });
    const three = await w.openEvent(SEAT_DEFS, { eventId: `${base}-B` });
    for (const e of [one, two, three]) await w.hold(e.eventId, [ref('A01')]);
    w.clock.advance(HOLD_TTL_MS);
    w.fail.expire = (i) => (i.eventId === two.eventId ? new Error('ERR Error running script') : undefined);
    const t = await w.sweeper().tick();
    const order = [one.eventId, two.eventId, three.eventId].sort(byCode);
    expect(order).toEqual([three.eventId, two.eventId, one.eventId]);
    expect(t.events.map((x) => x.eventId)).toEqual(order);
    expect(Object.fromEntries(t.events.map((x) => [x.eventId, x.outcome]))).toEqual({ [one.eventId]: 'DRAINED', [two.eventId]: 'ERROR', [three.eventId]: 'DRAINED' });
  });

  test('NFR025_ 회차 목록이 비면 아무 회차도 돌지 않는다', async () => {
    const w = world();
    expect(await w.sweeper().tick()).toEqual({ overlapped: false, events: [] });
    expect(w.calls.acquire).toEqual([]);
  });

  test('ST26_③ 세대 키가 없는 회차는 NOT_READY이고 지표 {expire, NOT_READY}를 한 번 올린다(쓰지 않음) [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')]);
    w.clock.advance(HOLD_TTL_MS);
    w.ev(eventId).epoch = undefined;
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'NOT_READY', { batches: 1 })]);
    expect(w.signals.calls).toEqual([['expire', 'NOT_READY']]);
    expect(w.ev(eventId).bits.has(ref('A01').index)).toBe(true);
  });

  test('NFR025_ 좌석맵 판에 회차 설정이 없으면 NO_CONFIG이고 만료 저장소를 부르지 않는다', async () => {
    const w = world();
    const { eventId } = await w.openEvent(SEAT_DEFS, { map: false });
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'NO_CONFIG')]);
    expect(w.calls.due).toEqual([]);
    expect(w.calls.expire).toEqual([]);
  });

  test('NFR015_ 좌석 Redis 일시 장애(임대·1단계 읽기·만료 Lua 어디서든)는 UNAVAILABLE이고 Lua 오류 지표를 올리지 않는다 [ASVS v5.0.0-16.3.4]', async () => {
    for (const where of ['acquire', 'due', 'expire'] as const) {
      const w = world();
      const { eventId } = await w.openEvent();
      await w.hold(eventId, [ref('A01')]);
      w.clock.advance(HOLD_TTL_MS);
      w.fail[where] = () => new SeatStoreUnavailable(new Error('down'));
      const t = await w.sweeper().tick();
      expect({ where, outcome: t.events[0]!.outcome }).toEqual({ where, outcome: 'UNAVAILABLE' });
      expect({ where, signals: w.signals.calls }).toEqual({ where, signals: [] });
      expect(w.ev(eventId).bits.has(ref('A01').index)).toBe(true);
    }
  });

  test('NFR015_ 메모리 부족은 UNAVAILABLE이고, 만료 Lua에서 났을 때만 지표 {expire, OOM}을 한 번 올린다(임대·1단계 읽기의 메모리 부족은 세지 않는다) [ASVS v5.0.0-16.3.4] [ASVS v5.0.0-16.5.3]', async () => {
    const oom = () => new SeatStoreUnavailable(new Error("OOM command not allowed when used memory > 'maxmemory'."), 'oom');
    const expected: Record<string, [SeatLuaScript, SeatLuaErrorCode][]> = { acquire: [], due: [], expire: [['expire', 'OOM']] };
    for (const where of ['acquire', 'due', 'expire'] as const) {
      const w = world();
      const { eventId } = await w.openEvent();
      await w.hold(eventId, [ref('A01')]);
      w.clock.advance(HOLD_TTL_MS);
      w.fail[where] = oom;
      const t = await w.sweeper().tick();
      expect({ where, outcome: t.events[0]!.outcome, signals: w.signals.calls }).toEqual({ where, outcome: 'UNAVAILABLE', signals: expected[where] });
    }
  });

  test('ST4_ 만료 Lua가 키 전체가 망가져(형이 틀림) 묶음 전체를 거절하면 ERROR이고 지표 {expire, code} 한 번과 로그 한 줄(회차·단계·code·키 종류만, 키 이름·계정 ID·오류 글 없음)을 남긴다 [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')], ACCOUNT_A);
    w.clock.advance(HOLD_TTL_MS);
    // Lua가 계정 ID가 든 키 이름을 오류 글에 싣는 경우(키 형 오류는 좌석 격리 밖이라 묶음 전체 오류, M2)
    w.fail.expire = () => new Error(`ERR PEAKET_CORRUPT_KEY ${seatKeys.rel(eventId, ACCOUNT_A)}`);
    const t = await w.sweeper().tick();
    expect(t.events[0]!.outcome).toBe('ERROR');
    expect(w.signals.calls).toEqual([['expire', 'CORRUPT_KEY']]);
    const errors = w.log.lines.filter((l) => l.level === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]!.args[0]).toEqual({ eventId, step: 'expire', code: 'CORRUPT_KEY', keyKind: 'rel' });
    const text = JSON.stringify(errors[0]!.args);
    expect(text).not.toContain(ACCOUNT_A);
    expect(text).not.toContain('s:{');
    expect(text).not.toContain('PEAKET_');
    expect(w.ev(eventId).bits.has(ref('A01').index)).toBe(true);
  });

  test('ST4_ 만료 Lua의 그 밖 오류는 code OTHER로, 지난 keepUntil은 KEEP_UNTIL_PAST로 센다. 오류 앞 묶음에서 푼 수는 보고에 남는다 [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    const seats = Array.from({ length: 150 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 150 });
    await w.holdMany(eventId, seats);
    w.clock.advance(HOLD_TTL_MS);
    w.fail.expire = (_i, n) => (n === 2 ? new Error('ERR Error running script (call to f_x): @user_script:1: boom') : undefined);
    const t = await w.sweeper().tick();
    expect(t.events[0]).toMatchObject({ eventId, outcome: 'ERROR', released: 100 });
    expect(w.signals.calls).toEqual([['expire', 'OTHER']]);
    expect(w.log.lines.filter((l) => l.level === 'error').map((l) => l.args[0])).toEqual([{ eventId, step: 'expire', code: 'OTHER' }]);

    const k = world();
    const ev2 = await k.openEvent();
    await k.hold(ev2.eventId, [ref('A01')]);
    k.clock.advance(HOLD_TTL_MS);
    k.fail.expire = () => new Error('ERR PEAKET_KEEP_UNTIL_PAST keepUntil 1 now 2');
    expect((await k.sweeper().tick()).events[0]!.outcome).toBe('ERROR');
    expect(k.signals.calls).toEqual([['expire', 'KEEP_UNTIL_PAST']]);
  });

  test('ST4_ 1단계 읽기·임대의 망가진 값 오류는 ERROR이고 로그(step due·lease)만 남기며 Lua 오류 지표는 올리지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')], ACCOUNT_A);
    w.clock.advance(HOLD_TTL_MS);
    w.fail.due = () => new Error(`PEAKET_CORRUPT_KEY ${seatKeys.hold(eventId, 0)}`);
    expect((await w.sweeper().tick()).events[0]!.outcome).toBe('ERROR');
    expect(w.log.lines.filter((l) => l.level === 'error').map((l) => l.args[0])).toEqual([{ eventId, step: 'due', code: 'CORRUPT_KEY', keyKind: 'hold' }]);
    expect(w.signals.calls).toEqual([]);

    const l = world();
    const ev2 = await l.openEvent();
    l.fail.acquire = () => new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
    expect((await l.sweeper().tick()).events).toMatchObject([report(ev2.eventId, 'ERROR')]);
    expect(l.log.lines.filter((x) => x.level === 'error').map((x) => x.args[0])).toEqual([{ eventId: ev2.eventId, step: 'lease', code: 'OTHER' }]);
    expect(l.signals.calls).toEqual([]);
  });

  test('NFR015_ 회차 목록을 읽지 못하면 listFailed(일시 장애 UNAVAILABLE, 그 밖 ERROR와 로그 step list)이고 회차를 돌지 않는다. 던지지 않는다', async () => {
    const w = world();
    await w.openEvent();
    w.fail.saleEvents = () => new SeatStoreUnavailable(new Error('down'));
    expect(await w.sweeper().tick()).toEqual({ overlapped: false, listFailed: 'UNAVAILABLE', events: [] });
    w.fail.saleEvents = () => new Error('ERR unknown');
    expect(await w.sweeper().tick()).toEqual({ overlapped: false, listFailed: 'ERROR', events: [] });
    const fields = w.log.lines.filter((l) => l.level === 'error').map((l) => l.args[0] as { code?: string });
    expect(fields.filter((f) => f.code === 'OTHER')).toEqual([{ step: 'list', code: 'OTHER' }]);
    expect(w.calls.acquire).toEqual([]);
  });

  test('NFR025_ 앞 틱이 아직 돌고 있으면 이번 틱은 아무것도 부르지 않고 overlapped다', async () => {
    const w = world();
    await w.openEvent();
    const gate = deferred<void>();
    let slowCalls = 0;
    const slow: SeatExpiries = {
      ...w.expiries,
      saleEvents: async () => {
        slowCalls += 1;
        await gate.promise;
        return w.expiries.saleEvents();
      },
    };
    const s = w.sweeper('pod-a', { expiries: slow });
    const first = s.tick();
    await flush();
    expect(slowCalls).toBe(1);
    expect(await s.tick()).toEqual({ overlapped: true, events: [] });
    expect(slowCalls).toBe(1);
    gate.resolve();
    expect((await first).overlapped).toBe(false);
    // 끝난 뒤에는 다시 돈다
    expect((await s.tick()).overlapped).toBe(false);
  });
});

describe('ExpirySweeper.start·stop과 시스템 타이머', () => {
  test('NFR025_ start는 1초 주기 타이머 하나만 걸고 틱을 바로 부르지 않는다. 타이머가 부르면 틱이 돈다', async () => {
    const w = world();
    await w.openEvent();
    const { timer, regs } = manualTimer();
    const s = w.sweeper('pod-a', { timer });
    s.start();
    s.start();
    expect(regs.map((r) => r.everyMs)).toEqual([EXPIRY_TICK_MS]);
    expect(EXPIRY_TICK_MS).toBe(1000);
    expect(w.calls.saleEvents).toBe(0);
    regs[0]!.run();
    await flush();
    expect(w.calls.saleEvents).toBe(1);
    await s.stop();
  });

  test('NFR025_ stop은 타이머를 멈추고 돌고 있는 틱이 끝날 때까지 기다린다. 두 번 불러도 되고, 켜지 않았으면 바로 끝나며, 끈 뒤 다시 켤 수 있다. 임대는 놓지 않는다', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    const { timer, regs } = manualTimer();
    const gate = deferred<void>();
    const slow: SeatExpiries = {
      ...w.expiries,
      saleEvents: async () => {
        await gate.promise;
        return w.expiries.saleEvents();
      },
    };
    // 임대를 먼저 잡아 둔다(멈춤 표시 뒤의 틱은 회차를 돌지 않는다, L4)
    await w.sweeper('pod-a').tick();
    const idle = w.sweeper('pod-b', { timer });
    await idle.stop();
    expect(regs).toHaveLength(0);
    const s = w.sweeper('pod-a', { timer, expiries: slow });
    s.start();
    regs[0]!.run();
    await flush();
    let stopped = false;
    const p = s.stop().then(() => void (stopped = true));
    await flush();
    expect(regs[0]!.cancelled).toBeGreaterThanOrEqual(1);
    expect(stopped).toBe(false);
    gate.resolve();
    await p;
    expect(stopped).toBe(true);
    await s.stop();
    // 임대는 그대로(수명 뒤 저절로 풀린다)
    expect(w.ev(eventId).sweep?.owner).toBe('pod-a');
    s.start();
    expect(regs).toHaveLength(2);
    await s.stop();
  });

  test('NFR025_ 시스템 타이머는 everyMs마다 부르고(첫 부름은 everyMs 뒤) 멈추면 더 부르지 않는다', () => {
    vi.useFakeTimers();
    let n = 0;
    const h = systemSweepTimer.every(1000, () => void (n += 1));
    vi.advanceTimersByTime(999);
    expect(n).toBe(0);
    vi.advanceTimersByTime(1);
    expect(n).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(n).toBe(3);
    h.cancel();
    h.cancel();
    vi.advanceTimersByTime(5000);
    expect(n).toBe(3);
  });
});

// ---- 새 맥락 리뷰 결함의 재현(추천 적용 2026-11-04, PRF-135 M1·M2·M5·L3·L4·L5·L6·L7) ----

/** 노출 글에서 이름이 name인 표본: 이름표 글 → 값 */
async function samplesOf(registry: PlatformMetrics['registry'], name: string): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const l of (await registry.metrics()).split('\n')) {
    if (!(l.startsWith(`${name}{`) || l.startsWith(`${name} `))) continue;
    const labels = [...l.matchAll(/(\w+)="([^"]*)"/g)]
      .map((m) => `${m[1]}=${m[2]}`)
      .sort()
      .join(',');
    out[labels] = Number(l.slice(l.lastIndexOf(' ') + 1));
  }
  return out;
}

/** 조건이 설 때까지 쌓인 작업을 한 바퀴씩 돌린다(시간을 기다리지 않는다, 400바퀴까지) */
async function settle(ok: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !ok(); i++) await flush();
}

describe('M1 만료 상한 포화: BATCH_LIMIT이면 다음 틱을 바로, 밀림·틱 결과 지표', () => {
  test('ST6_NFR025_ 반복이 켜진 채 어떤 회차가 한 틱에 20묶음(BATCH_LIMIT)에 닿으면 1초를 기다리지 않고 다음 틱을 바로 시작한다(묶음 상한은 틱마다 그대로 20) [ASVS v5.0.0-15.4.4]', async () => {
    const w = world();
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromSeatSignals().register(metrics.registry);
    const seats = Array.from({ length: 2_050 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 2_050 });
    await w.holdMany(eventId, seats);
    w.clock.advance(HOLD_TTL_MS);
    // 1단계 읽기마다 이벤트 루프를 한 바퀴 돌린다: 다 푼 뒤에도 틱을 끝없이 잇는 구현이 마이크로태스크만으로 시험을 멈춰 세우지 않고 아래 '더 잇지 않는다'에서 걸리게
    w.wait.due = () => flush();
    const { timer, regs } = manualTimer();
    const s = w.sweeper('pod-a', { timer, signals: prom });
    s.start();
    // 타이머는 한 번만 부른다: 첫 틱이 2,000석에서 멈추고, 이어서 바로 둘째 틱이 남은 50석을 푼다
    regs[0]!.run();
    await settle(() => w.ev(eventId).expiry.size === 0);
    expect(w.ev(eventId).expiry.size).toBe(0);
    expect(w.calls.expire.map((x) => x.seats.length)).toEqual([...Array.from({ length: 20 }, () => 100), 50]);
    const ticks = await samplesOf(metrics.registry, 'seat_expiry_ticks_total');
    expect({ batchLimit: ticks['outcome=BATCH_LIMIT'], drained: ticks['outcome=DRAINED'] }).toEqual({ batchLimit: 1, drained: 1 });
    // 다 풀었으면 더 잇지 않는다(다음은 타이머 차례)
    const due = w.calls.due.length;
    for (let i = 0; i < 20; i++) await flush();
    expect(w.calls.due.length).toBe(due);
    await s.stop();
  });

  test('ST6_NFR025_ 멈춘 뒤에는 그 틱이 BATCH_LIMIT이어도 다음 틱을 바로 시작하지 않는다(돌던 20번째 묶음만 마친다, M1·L4)', async () => {
    const w = world();
    const seats = Array.from({ length: 2_050 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 2_050 });
    await w.holdMany(eventId, seats);
    w.clock.advance(HOLD_TTL_MS);
    // 20번째 만료 Lua를 붙잡은 채 멈춘다
    const gate = deferred<void>();
    w.wait.expire = async () => {
      if (w.calls.expire.length === EXPIRY_MAX_BATCHES_PER_TICK) await gate.promise;
    };
    w.wait.due = () => flush();
    const { timer, regs } = manualTimer();
    const s = w.sweeper('pod-a', { timer });
    s.start();
    regs[0]!.run();
    await settle(() => w.calls.expire.length === EXPIRY_MAX_BATCHES_PER_TICK);
    expect(w.calls.expire).toHaveLength(EXPIRY_MAX_BATCHES_PER_TICK);
    const stopped = s.stop();
    gate.resolve();
    await stopped;
    for (let i = 0; i < 20; i++) await flush();
    // 새 틱을 열지 않았다(회차 목록도 다시 읽지 않는다)
    expect(w.calls.saleEvents).toBe(1);
    expect(w.calls.expire).toHaveLength(EXPIRY_MAX_BATCHES_PER_TICK);
    expect(w.calls.due).toHaveLength(EXPIRY_MAX_BATCHES_PER_TICK);
    expect(w.ev(eventId).expiry.size).toBe(50);
  });

  test('ST6_NFR025_ seat_expiry_lag_seconds는 이 파드가 돈 회차 가운데 가장 오래 밀린 것(지금 − 가장 오래된 지난 점수, 초, 회차 이름표 없음)이고 밀린 것이 없으면 0이다. seat_expiry_ticks_total{outcome}은 회차의 틱 결과마다 센다', async () => {
    const w = world();
    const metrics = new PlatformMetrics('purchase-svc');
    const prom = new PromSeatSignals().register(metrics.registry);
    const a = await w.openEvent();
    const b = await w.openEvent();
    await w.hold(a.eventId, [ref('A01')]);
    w.clock.advance(20_000);
    await w.hold(b.eventId, [ref('A01')]);
    await w.hold(a.eventId, [ref('A02')]);
    // a의 A01은 7분 30초, a의 A02와 b는 7분 10초 전에 잡혔다: a의 가장 오래된 점수가 30초, b의 점수가 10초 밀렸다(a의 가장 새 점수도 10초)
    w.clock.advance(HOLD_TTL_MS + 10_000);
    // a는 연장된 홀드라 풀리지 않고(NO_PROGRESS) 밀린 채 남는다
    w.ev(a.eventId).holds.get(ref('A01').index)!.exp = w.clock.now() + 60_000;
    w.ev(a.eventId).holds.get(ref('A02').index)!.exp = w.clock.now() + 60_000;
    const s = w.sweeper('pod-a', { signals: prom });
    const t = await s.tick();
    expect(Object.fromEntries(t.events.map((x) => [x.eventId, x.outcome]))).toEqual({ [a.eventId]: 'NO_PROGRESS', [b.eventId]: 'DRAINED' });
    expect(await samplesOf(metrics.registry, 'seat_expiry_lag_seconds')).toEqual({ '': 30 });
    expect(await samplesOf(metrics.registry, 'seat_expiry_ticks_total')).toEqual({ 'outcome=DRAINED': 1, 'outcome=NO_PROGRESS': 1 });
    // a의 밀린 멤버를 치우면 0이다
    w.ev(a.eventId).expiry.delete(ref('A01').index);
    w.ev(a.eventId).expiry.delete(ref('A02').index);
    w.clock.advance(EXPIRY_TICK_MS);
    await s.tick();
    expect(await samplesOf(metrics.registry, 'seat_expiry_lag_seconds')).toEqual({ '': 0 });
    expect((await samplesOf(metrics.registry, 'seat_expiry_ticks_total'))['outcome=DRAINED']).toBe(3);
  });
});

describe('M2 망가진 키 격리: 망가지지 않은 좌석은 같은 묶음에서 푼다', () => {
  test('ST4_FR042_ 한 계정의 보유 수가 망가져도 같은 묶음의 다른 계정 좌석은 이 틱에 풀리고, 망가진 좌석은 corrupt로 세며 지표 {expire, CORRUPT_KEY}를 묶음마다 한 번 올린다(ERROR가 아니다) [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    // 망가진 계정의 좌석이 둘이어도 지표는 묶음마다 한 번이다(좌석마다가 아니다)
    await w.hold(eventId, [ref('A01'), ref('A02')], ACCOUNT_A);
    await w.hold(eventId, [ref('B01')], ACCOUNT_B);
    w.clock.advance(HOLD_TTL_MS);
    w.ev(eventId).quota.set(ACCOUNT_A, 1.5);
    const t = await w.sweeper().tick();
    expect(t.events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 1, corrupt: 2 })]);
    expect(w.ev(eventId).bits.has(ref('B01').index)).toBe(false);
    expect(w.ev(eventId).bits.has(ref('A01').index)).toBe(true);
    expect(w.ev(eventId).bits.has(ref('A02').index)).toBe(true);
    expect(w.signals.calls).toEqual([['expire', 'CORRUPT_KEY']]);
  });

  test('ST4_FR042_ 1단계에서 칸이 일부만 있는 홀드(corrupt: true)는 만료 Lua에 넘기지 않고 corrupt로 세며, 다른 좌석은 같은 묶음에서 푼다 [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')], ACCOUNT_A);
    w.ev(eventId).holds.set(7, { holdId: 'h7' } as unknown as MemoryHoldHash);
    w.ev(eventId).expiry.set(7, NOW);
    w.clock.advance(HOLD_TTL_MS);
    const t = await w.sweeper().tick();
    expect(w.calls.expire.flatMap((x) => x.seats.map((s) => s.index))).toEqual([ref('A01').index]);
    expect(t.events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 1, corrupt: 1 })]);
    expect(w.ev(eventId).bits.has(ref('A01').index)).toBe(false);
  });

  test('ST4_ 1단계가 준 색인이 회차 좌석 수(config.seatCount) 이상이면 corrupt로 세고 만료 Lua에 넘기지 않는다(좌석 수 안의 판에 없는 색인은 지금처럼 푼다, 추천 적용 2026-11-04 L7) [ASVS v5.0.0-16.5.3]', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    // 경계: 색인 = 좌석 수(40)는 망가진 것, 좌석 수 − 1(39)은 판에 없는 색인으로 푼다
    const beyond: SeatRef = { seatId: 'Z40', index: SEAT_COUNT, sectionId: 'SEC-Z', sectionIndex: 2, seatOffset: 9, tierId: 'R' };
    const ghost: SeatRef = { seatId: 'Z39', index: SEAT_COUNT - 1, sectionId: 'SEC-Z', sectionIndex: 2, seatOffset: 5, tierId: 'R' };
    await w.hold(eventId, [beyond], ACCOUNT_A);
    await w.hold(eventId, [ghost], ACCOUNT_B);
    await w.hold(eventId, [ref('A01')], account(7));
    w.clock.advance(HOLD_TTL_MS);
    const t = await w.sweeper().tick();
    expect(w.calls.expire.flatMap((x) => x.seats.map((s) => s.index)).sort((x, y) => x - y)).toEqual([ref('A01').index, SEAT_COUNT - 1]);
    expect(t.events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 2, unknownSeats: 1, corrupt: 1 })]);
    expect(w.ev(eventId).bits.has(SEAT_COUNT)).toBe(true);
  });
});

describe('M5 여러 회차 동시와 실패한 회차 쉬기(BACKOFF)', () => {
  test('NFR025_ 반복은 회차를 최대 4개 [가정]까지 동시에 돈다(6회차: 동시에 도는 1단계 읽기가 4를 넘지 않고 하나씩도 아니다). 보고는 회차 ID 문자 코드 순이다', async () => {
    const w = world();
    const events: string[] = [];
    for (let k = 0; k < 6; k++) {
      const { eventId } = await w.openEvent();
      events.push(eventId);
      await w.hold(eventId, [ref('A01')]);
    }
    w.clock.advance(HOLD_TTL_MS);
    let inflight = 0;
    let most = 0;
    // 1단계 읽기를 모두 붙잡아 두고(구현의 차례·이벤트 루프 바퀴 수에 기대지 않게) 더 시작할 회차가 다 시작한 뒤 센다
    const gate = deferred<void>();
    w.wait.due = async () => {
      inflight += 1;
      most = Math.max(most, inflight);
      await gate.promise;
      inflight -= 1;
    };
    const ticking = w.sweeper().tick();
    for (let i = 0; i < 50; i++) await flush();
    expect(inflight).toBe(4);
    gate.resolve();
    const t = await ticking;
    expect(most).toBe(4);
    expect(t.events.map((x) => x.eventId)).toEqual([...events].sort(byCode));
    expect(t.events.every((x) => x.outcome === 'DRAINED' && x.released === 1)).toBe(true);
  });

  test('NFR015_ 직전에 UNAVAILABLE·ERROR였던 회차는 5초 [가정] 동안 BACKOFF로 건너뛰고(임대·만료 저장소를 부르지 않는다) 5초가 되면 다시 돈다. 다른 회차는 그대로 돈다', async () => {
    // 실패 갈래 × 난 곳(만료 Lua, 1단계 읽기)
    for (const [failure, where] of [
      ['UNAVAILABLE', 'expire'],
      ['ERROR', 'expire'],
      ['UNAVAILABLE', 'due'],
      ['ERROR', 'due'],
    ] as const) {
      const w = world();
      const bad = await w.openEvent();
      const good = await w.openEvent();
      await w.hold(bad.eventId, [ref('A01')]);
      await w.hold(good.eventId, [ref('A01')]);
      w.clock.advance(HOLD_TTL_MS);
      let broken = true;
      const failOf = (eventId: string) =>
        broken && eventId === bad.eventId ? (failure === 'UNAVAILABLE' ? new SeatStoreUnavailable(new Error('down')) : new Error('ERR Error running script')) : undefined;
      if (where === 'expire') w.fail.expire = (i) => failOf(i.eventId);
      else w.fail.due = (i) => failOf(i.eventId);
      const s = w.sweeper();
      const outcome = (t: Awaited<ReturnType<typeof s.tick>>, e: string) => String(t.events.find((x) => x.eventId === e)?.outcome);
      const touched = () => w.calls.acquire.filter((c) => c[0] === bad.eventId).length + w.calls.due.filter((c) => c.eventId === bad.eventId).length;
      const first = await s.tick();
      expect({ failure, where, bad: outcome(first, bad.eventId), good: outcome(first, good.eventId) }).toEqual({ failure, where, bad: failure, good: 'DRAINED' });
      broken = false;
      for (const step of [EXPIRY_TICK_MS, 5_000 - EXPIRY_TICK_MS - 1]) {
        w.clock.advance(step);
        const n = touched();
        const t = await s.tick();
        // 쉬는 것은 실패한 회차뿐이다(다른 회차는 그 틱에도 돈다)
        expect({ failure, where, step, bad: outcome(t, bad.eventId), touched: touched() - n, good: outcome(t, good.eventId) }).toEqual({
          failure,
          where,
          step,
          bad: 'BACKOFF',
          touched: 0,
          good: 'DRAINED',
        });
      }
      w.clock.advance(1);
      const back = await s.tick();
      expect({ failure, where, bad: outcome(back, bad.eventId) }).toEqual({ failure, where, bad: 'DRAINED' });
      expect(w.ev(bad.eventId).bits.has(ref('A01').index)).toBe(false);
    }
  });

  test('NFR015_ NOT_READY·NOT_LEASED·NO_CONFIG는 쉬지 않는다(다음 틱에 다시 본다)', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')]);
    w.clock.advance(HOLD_TTL_MS);
    w.ev(eventId).epoch = undefined;
    const s = w.sweeper();
    expect((await s.tick()).events[0]!.outcome).toBe('NOT_READY');
    w.clock.advance(EXPIRY_TICK_MS);
    expect((await s.tick()).events[0]!.outcome).toBe('NOT_READY');

    // 회차 설정이 없던 회차는 다음 틱에 설정이 생기면 바로 돈다
    const n = world();
    const later = await n.openEvent(SEAT_DEFS, { map: false });
    await n.hold(later.eventId, [ref('A01')]);
    n.clock.advance(HOLD_TTL_MS);
    const ns = n.sweeper();
    expect((await ns.tick()).events[0]!.outcome).toBe('NO_CONFIG');
    n.seatMap.put({ eventId: later.eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: later.saleEndsAtMs }, SEAT_DEFS);
    n.clock.advance(EXPIRY_TICK_MS);
    expect((await ns.tick()).events[0]).toMatchObject({ outcome: 'DRAINED', released: 1 });

    // 다른 파드가 임대를 가졌던 회차는 그 임대가 다한 틱에 바로 맡는다
    const l = world();
    const leased = await l.openEvent();
    await l.hold(leased.eventId, [ref('A01')]);
    l.clock.advance(HOLD_TTL_MS);
    expect(await l.leases.acquire(leased.eventId, 'pod-b', SWEEP_LEASE_TTL_MS)).toBe(true);
    const ls = l.sweeper('pod-a');
    expect((await ls.tick()).events[0]!.outcome).toBe('NOT_LEASED');
    l.clock.advance(SWEEP_LEASE_TTL_MS);
    expect((await ls.tick()).events[0]).toMatchObject({ outcome: 'DRAINED', released: 1 });
  });
});

describe('L3·L4·L6 반복의 차례·멈춤·메모리 부족 로그', () => {
  test('NFR025_ 회차 설정(좌석맵 판)을 임대보다 먼저 본다: NO_CONFIG면 임대 키를 쓰지 않는다(L3)', async () => {
    const w = world();
    const { eventId } = await w.openEvent(SEAT_DEFS, { map: false });
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'NO_CONFIG')]);
    expect(w.calls.acquire).toEqual([]);
    expect(w.ev(eventId).sweep).toBeUndefined();
  });

  test('NFR025_ stop()은 묶음 사이에서 멈춤 표시를 본다: 돌고 있던 묶음만 마치고 그 회차의 남은 묶음을 돌지 않는다(L4)', async () => {
    const w = world();
    const seats = Array.from({ length: 250 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 250 });
    await w.holdMany(eventId, seats);
    w.clock.advance(HOLD_TTL_MS);
    const gate = deferred<void>();
    w.wait.expire = async () => {
      if (w.calls.expire.length === 1) await gate.promise;
    };
    const { timer, regs } = manualTimer();
    const s = w.sweeper('pod-a', { timer });
    s.start();
    regs[0]!.run();
    await settle(() => w.calls.expire.length === 1);
    const stopped = s.stop();
    gate.resolve();
    await stopped;
    expect(w.calls.expire).toHaveLength(1);
    expect(w.ev(eventId).expiry.size).toBe(150);
  });

  test('NFR025_ stop()은 회차 사이에서도 멈춤 표시를 본다: 아직 시작하지 않은 회차는 임대도 잡지 않고, 다시 켜면 그 회차를 돈다(L4)', async () => {
    const w = world();
    const events: string[] = [];
    for (let k = 0; k < 6; k++) {
      const { eventId } = await w.openEvent();
      events.push(eventId);
      await w.hold(eventId, [ref('A01')]);
    }
    w.clock.advance(HOLD_TTL_MS);
    const gate = deferred<void>();
    w.wait.due = () => gate.promise;
    const { timer, regs } = manualTimer();
    const s = w.sweeper('pod-a', { timer });
    s.start();
    regs[0]!.run();
    await settle(() => w.calls.due.length > 0);
    const stopped = s.stop();
    gate.resolve();
    await stopped;
    const started = new Set(w.calls.acquire.map((c) => c[0]));
    const untouched = events.filter((e) => w.ev(e).bits.has(ref('A01').index));
    expect(started.size).toBeLessThanOrEqual(4);
    expect(untouched.length).toBeGreaterThanOrEqual(2);
    expect(untouched.every((e) => !started.has(e))).toBe(true);
    // 다시 켜면 남은 회차를 돈다
    w.wait.due = undefined;
    s.start();
    regs[1]!.run();
    await settle(() => events.every((e) => !w.ev(e).bits.has(ref('A01').index)));
    expect(events.filter((e) => w.ev(e).bits.has(ref('A01').index))).toEqual([]);
    await s.stop();
  });

  test('NFR015_ 메모리 부족 경고 로그는 파드마다 1초에 한 줄까지다(주입 시계, 키 이름·계정 ID 없음, L6) [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    const oom = () => new SeatStoreUnavailable(new Error("OOM command not allowed when used memory > 'maxmemory'."), 'oom');
    w.fail.expire = oom;
    const s = w.sweeper();
    const warns = () => w.log.lines.filter((l) => l.level === 'warn');
    /** 지금 시각에 지난 홀드 하나가 있는 새 회차 */
    const fresh = async () => {
      const { eventId } = await w.openEvent();
      await w.hold(eventId, [ref('A01')]);
      w.ev(eventId).holds.get(ref('A01').index)!.exp = w.clock.now();
      w.ev(eventId).expiry.set(ref('A01').index, w.clock.now());
      return eventId;
    };
    for (let k = 0; k < 3; k++) await fresh();
    const t1 = await s.tick();
    expect(t1.events.map((x) => x.outcome)).toEqual(['UNAVAILABLE', 'UNAVAILABLE', 'UNAVAILABLE']);
    expect(warns()).toHaveLength(1);
    w.clock.advance(500);
    await fresh();
    await s.tick();
    expect(warns()).toHaveLength(1);
    w.clock.advance(500);
    await fresh();
    await s.tick();
    expect(warns()).toHaveLength(2);
    const text = JSON.stringify(warns().map((l) => l.args));
    expect(text).not.toContain(ACCOUNT_A);
    expect(text).not.toContain('s:{');
  });
});

describe('L5 파드 ID(podIdFrom(env, random), main.ts가 부르는 순수 함수)', () => {
  /** 구현이 내보낼 함수(이름은 구현 담당이 정한다, 추천 적용 2026-11-04 L5). random(n)은 무작위 n바이트를 준다고 본다(crypto.randomBytes 꼴) */
  const podIdFrom = (inventory as Record<string, unknown>).podIdFrom as ((env: Record<string, string | undefined>, random: (n: number) => Uint8Array) => string) | undefined;
  const bytes = (b: number) => (n: number) => Buffer.alloc(n, b);
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  test('NFR025_ HOSTNAME이 키 조각 모양이면 {HOSTNAME}-{무작위 6자리 16진}이다(같은 HOSTNAME의 두 파드도 무작위가 달라 임대 값이 갈린다)', () => {
    expect(typeof podIdFrom).toBe('function');
    expect(podIdFrom!({ HOSTNAME: 'purchase-svc-7d9f8-abcde' }, bytes(0xab))).toBe('purchase-svc-7d9f8-abcde-ababab');
    const a = podIdFrom!({ HOSTNAME: 'pod-1' }, bytes(0x01));
    const b = podIdFrom!({ HOSTNAME: 'pod-1' }, bytes(0x02));
    expect(a).toMatch(/^pod-1-[0-9a-f]{6}$/);
    expect(a).not.toBe(b);
  });

  test('NFR025_ HOSTNAME이 없거나 키 조각 모양이 아니면 무작위 UUID이고, 결과는 늘 키 조각 모양(임대 값)이다', () => {
    expect(typeof podIdFrom).toBe('function');
    for (const HOSTNAME of [undefined, '', 'pod.cluster.local', 'a b', 's:{x}']) {
      const id = podIdFrom!({ HOSTNAME }, bytes(0x5c));
      expect({ HOSTNAME, uuid: UUID.test(id) }).toEqual({ HOSTNAME, uuid: true });
    }
    expect(podIdFrom!({}, bytes(0x01))).not.toBe(podIdFrom!({}, bytes(0x02)));
    // 키 조각 모양의 긴 HOSTNAME(63자, 쿠버네티스 파드 이름 상한)에 꼬리를 붙여도 임대 값은 키 조각 모양이어야 한다
    for (const HOSTNAME of ['pod-1', 'x'.repeat(57), 'x'.repeat(58), 'x'.repeat(63), 'x'.repeat(64)]) {
      expect({ HOSTNAME, keyPart: KEY_PART.test(podIdFrom!({ HOSTNAME }, bytes(0x0f))) }).toEqual({ HOSTNAME, keyPart: true });
    }
  });

  test('NFR025_ HOSTNAME이 58자를 넘으면 앞 57자로 자른 뒤 -{6자리 16진}을 붙이고(임대 값 64자), 자른 결과가 키 조각 모양이 아니면 UUID다(추천 적용 2026-11-04 L5 빈칸)', () => {
    expect(typeof podIdFrom).toBe('function');
    const x57 = 'x'.repeat(57);
    // 모양은 자른 뒤에 본다: 65자(키 조각 길이 밖)·58자째부터 '.'이 든 이름도 앞 57자가 키 조각이면 그것을 쓴다
    for (const HOSTNAME of ['x'.repeat(59), 'x'.repeat(63), 'x'.repeat(64), 'x'.repeat(65), `${x57}.cluster.local`]) {
      expect({ HOSTNAME, id: podIdFrom!({ HOSTNAME }, bytes(0x0f)) }).toEqual({ HOSTNAME, id: `${x57}-0f0f0f` });
    }
    // 앞 57자 안에 키 조각 밖의 글자가 있으면 UUID
    for (const HOSTNAME of [`p.${'x'.repeat(60)}`, `${'x'.repeat(30)} ${'x'.repeat(30)}`]) {
      expect({ HOSTNAME, uuid: UUID.test(podIdFrom!({ HOSTNAME }, bytes(0x0f))) }).toEqual({ HOSTNAME, uuid: true });
    }
    // 57자는 자르지 않고 꼬리를 붙인다(64자)
    expect(podIdFrom!({ HOSTNAME: x57 }, bytes(0x0f))).toBe(`${x57}-0f0f0f`);
  });
});

// ---- 최종 검토 결함의 재현(추천 적용 2026-11-04, PRF-135 B1·C2·C3) ----

/**
 * 좌석 Redis 흉내(RedisSeatStore가 부르는 명령만, B1): 만료 인덱스에 멤버 0·1·2가 있고 홀드 키 0은 형이 틀려 HMGET이 WRONGTYPE이다.
 * 만료 Lua는 받은 좌석을 모두 푼 것으로 답하고 그 멤버를 만료 인덱스에서 뺀다
 */
function wrongTypeRedis(eventId: string) {
  const members = new Map<number, number>([
    [0, NOW - 3_000],
    [1, NOW - 2_000],
    [2, NOW - 1_000],
  ]);
  const evals: { keys: string[]; args: string[] }[] = [];
  const command = async (args: string[]): Promise<unknown> => {
    switch (args[0]) {
      case 'SMEMBERS':
        return [eventId];
      case 'ZRANGE': {
        const upTo = Number(args[3]);
        const limit = Number(args[args.indexOf('LIMIT') + 2]);
        return [...members]
          .filter(([, score]) => score <= upTo)
          .sort((a, b) => a[1] - b[1] || a[0] - b[0])
          .slice(0, limit)
          .flatMap(([m, score]) => [String(m), String(score)]);
      }
      case 'HMGET': {
        const index = Number(args[1]!.slice(args[1]!.lastIndexOf(':') + 1));
        if (index === 0) throw new Error('WRONGTYPE Operation against a key holding the wrong kind of value');
        return [`h${index}`, String(1_700_000_000_000_000 + index), ACCOUNT_A];
      }
      default:
        throw new Error(`모르는 명령: ${args.join(' ')}`);
    }
  };
  const redis: HotRedis = {
    command: (a) => command(a),
    sendCommand: (a) => command(a),
    close: async () => {},
    evalScript: async (_script, keys, args) => {
      evals.push({ keys: [...keys], args: [...args] });
      const m = Number(args[3]);
      const out: string[] = [];
      for (let k = 4 + m; k + 9 <= args.length; k += 9) {
        members.delete(Number(args[k]));
        out.push(args[k]!, args[k + 2]!);
      }
      return ['OK', '1793761200000000', out.length / 2, 0, 0, ...out];
    },
  };
  return { redis, evals };
}

describe('B1 반복: 홀드 키의 형이 틀린 좌석은 corrupt로 세고 나머지는 풀며 회차가 쉬지 않는다(RedisSeatStore + 가짜 좌석 Redis)', () => {
  test('ST4_FR042_ 1단계 읽기에서 홀드 키 하나가 WRONGTYPE이어도 읽기는 던지지 않아, 그 좌석만 만료 Lua에 넘기지 않고(corrupt) 나머지를 푼다. 회차는 ERROR가 되지 않고 다음 틱에 BACKOFF에 들어가지 않는다(B1) [ASVS v5.0.0-16.5.3]', async () => {
    const eventId = newEvent();
    const fake = wrongTypeRedis(eventId);
    const clock = fakeClock({ now: NOW, monotonic: 0 });
    const seatMap = new MemorySeatMap();
    seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_COUNT, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, SEAT_DEFS);
    const signals = recordingSignals();
    const s = new ExpirySweeper({ expiries: new RedisSeatStore(fake.redis), seatMap, leases: { acquire: async () => true }, clock, podId: 'pod-a', signals });

    const t1 = await s.tick();
    expect(t1.events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 2, corrupt: 1 })]);
    // 만료 Lua에는 정상 좌석 둘만 넘어갔다(홀드 키 0은 넘기지 않았다)
    expect(fake.evals).toHaveLength(1);
    expect(fake.evals[0]!.keys.filter((k) => k.includes(':hold:'))).toEqual([seatKeys.hold(eventId, 1), seatKeys.hold(eventId, 2)]);
    expect(signals.calls).toEqual([['expire', 'CORRUPT_KEY']]);

    // 다음 틱: 남은 것은 망가진 좌석뿐이라 보낼 것이 없다. 그래도 쉬지 않는다(1초 뒤 다시 읽는다)
    clock.advance(EXPIRY_TICK_MS);
    const t2 = await s.tick();
    expect(t2.events).toMatchObject([report(eventId, 'NO_PROGRESS', { corrupt: 1 })]);
    expect(fake.evals).toHaveLength(1);
  });
});

/**
 * fn을 도는 동안 처리되지 않은 거부를 모아 돌려준다. vitest 자신의 처리기는 잠시 떼어 둔다(떼지 않으면 이 시험이 아니라 시험 실행 전체가 실패로 끝난다).
 * 처리되지 않은 거부 사건은 약속 작업이 비고 이벤트 루프가 한 바퀴 돈 뒤에 오므로 flush를 두 번 한다
 */
async function unhandledDuring(fn: () => Promise<void>): Promise<unknown[]> {
  const saved = process.rawListeners('unhandledRejection');
  process.removeAllListeners('unhandledRejection');
  const seen: unknown[] = [];
  const on = (reason: unknown) => void seen.push(reason);
  process.on('unhandledRejection', on);
  try {
    await fn();
    await flush();
    await flush();
  } finally {
    process.removeListener('unhandledRejection', on);
    for (const l of saved) process.on('unhandledRejection', l as NodeJS.UnhandledRejectionListener);
  }
  return seen;
}

describe('C2 start()의 반복이 거부돼도 처리되지 않은 거부가 되지 않는다(추천 적용 2026-11-04)', () => {
  test('NFR025_ tick이 거부돼도(타이머가 부른 반복) 처리되지 않은 거부가 없고, 오류는 code·키 종류만 로그에 남기며(계정 ID·키 이름·오류 글·오류 객체 없음) 다음 틱이 열린다 [ASVS v5.0.0-16.2.5]', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    const { timer, regs } = manualTimer();
    const s = w.sweeper('pod-a', { timer });
    // 앞의 둘은 거부(키 이름이 든 Error, 계정 ID가 든 글)이고 셋째부터는 진짜 틱이다
    const tick = vi
      .spyOn(s, 'tick')
      .mockRejectedValueOnce(new Error(`ERR PEAKET_CORRUPT_KEY ${seatKeys.quota(eventId, ACCOUNT_A)}`))
      .mockRejectedValueOnce(`boom ${ACCOUNT_A}`);
    const seen = await unhandledDuring(async () => {
      s.start();
      for (let k = 0; k < 3; k++) {
        regs[0]!.run();
        await flush();
        await flush();
      }
    });
    expect(seen).toEqual([]);
    expect(tick).toHaveBeenCalledTimes(3);
    // 셋째 틱은 진짜 틱이라 회차 목록을 읽었다: 반복이 이어진다
    expect(w.calls.saleEvents).toBe(1);
    const lines = w.log.lines.filter((l) => l.level === 'error' || l.level === 'warn');
    expect(lines).toHaveLength(2);
    const fields = lines.map((l) => l.args[0] as { code?: string; keyKind?: string });
    expect(fields[0]).toMatchObject({ code: 'CORRUPT_KEY', keyKind: 'quota' });
    expect(fields[1]).toMatchObject({ code: 'OTHER' });
    const text = JSON.stringify(lines.map((l) => l.args));
    for (const leak of [ACCOUNT_A, 's:{', 'PEAKET_', 'boom']) expect({ leak, found: text.includes(leak) }).toEqual({ leak, found: false });
    expect(lines.flatMap((l) => l.args).some((a) => a instanceof Error)).toBe(false);
    expect(fields.flatMap((f) => Object.keys(f))).not.toContain('err');
    await s.stop();
  });
});

describe('C3 saleEvents의 회차 ID 모양 거르기 경고는 파드마다 60초에 한 줄까지다(주입 시계, 추천 적용 2026-11-04)', () => {
  test('NFR025_ 거를 값이 있어도 경고는 처음 한 줄 뒤 60초가 지나야(경계 포함) 다시 남고, 거를 값이 없으면 경고도 경고 문도 쓰지 않으며, 돌려주는 값은 그대로다. 거른 값은 로그에 싣지 않는다 [ASVS v5.0.0-16.2.5]', async () => {
    const clock = fakeClock({ now: NOW });
    const log = recordingLogger();
    const store = new MemorySeatStore(clock, log.logger);
    const warns = () => log.lines.filter((l) => l.level === 'warn').length;
    store.db.ctlEvents.add('ev-ok');
    // 거를 값이 없으면 경고가 없다(경고 문도 쓰지 않는다)
    await store.saleEvents();
    expect(warns()).toBe(0);
    store.db.ctlEvents.add('bad{x}');
    store.db.ctlEvents.add('a:b');
    // 같은 순간에 몇 번을 읽어도 한 줄이다(지금은 읽을 때마다 한 줄이 남는다)
    for (let k = 0; k < 5; k++) await store.saleEvents();
    expect(warns()).toBe(1);
    clock.advance(59_999);
    await store.saleEvents();
    expect(warns()).toBe(1);
    clock.advance(1);
    await store.saleEvents();
    expect(warns()).toBe(2);
    clock.advance(30_000);
    await store.saleEvents();
    expect(warns()).toBe(2);
    expect(await store.saleEvents()).toEqual(['ev-ok']);
    const text = JSON.stringify(log.lines.map((l) => l.args));
    for (const raw of ['bad{x}', 'a:b']) expect({ raw, found: text.includes(raw) }).toEqual({ raw, found: false });
  });
});

describe('ExpirySweeper 주문 만료 고리 onHoldsExpired(BUILD_ORDER PRF-172, ADR-0107, docs/features/seat-hold.md §5)', () => {
  type HoldsExpired = { readonly eventId: string; readonly holdIds: readonly string[] };
  /** 고리를 단 world. seen은 고리가 받은 값(그때의 복사본)이다 */
  function hooked(onCall?: () => void) {
    const w = world();
    const seen: HoldsExpired[] = [];
    const sweeper = w.sweeper('pod-a', {
      onHoldsExpired: (e) => {
        seen.push({ eventId: e.eventId, holdIds: [...e.holdIds] });
        onCall?.();
      },
    });
    /** 좌석의 홀드 ID(풀리기 전에 읽어 둔다) */
    const holdIdOf = (eventId: string, seat: SeatRef) => w.ev(eventId).holds.get(seat.index)!.holdId;
    return { w, seen, sweeper, holdIdOf };
  }
  const allHoldIds = (seen: HoldsExpired[]) => seen.flatMap((e) => [...e.holdIds]);

  test('PT41_ADR0107_푼 홀드의 holdId를 회차와 함께 넘기고, 여러 좌석의 같은 holdId는 한 번만 싣는다 [ASVS v5.0.0-2.3.1]', async () => {
    const { w, seen, sweeper, holdIdOf } = hooked();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01'), ref('A02')], ACCOUNT_A);
    await w.hold(eventId, [ref('B01')], ACCOUNT_B);
    const a = holdIdOf(eventId, ref('A01'));
    const b = holdIdOf(eventId, ref('B01'));
    expect(holdIdOf(eventId, ref('A02'))).toBe(a);
    w.clock.advance(HOLD_TTL_MS);
    expect((await sweeper.tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 3 })]);
    expect(seen.every((e) => e.eventId === eventId)).toBe(true);
    expect(allHoldIds(seen).sort()).toEqual([a, b].sort());
  });

  test('ADR0107_풀 것이 없으면 고리를 부르지 않는다(틱에 만료된 홀드 없음)', async () => {
    const { w, seen, sweeper } = hooked();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')]);
    await sweeper.tick();
    expect(seen).toEqual([]);
  });

  test('ADR0107_건너뛴 좌석(연장된 홀드)과 고아는 푼 것이 아니므로 그 holdId를 넘기지 않는다', async () => {
    const { w, seen, sweeper, holdIdOf } = hooked();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')], ACCOUNT_A);
    await w.hold(eventId, [ref('B01')], ACCOUNT_B);
    const released = holdIdOf(eventId, ref('B01'));
    w.clock.advance(HOLD_TTL_MS);
    // A01은 연장됨: 만료 인덱스 점수는 지났는데 Hash exp는 1분 뒤
    w.ev(eventId).holds.get(ref('A01').index)!.exp = w.clock.now() + 60_000;
    // 색인 36은 고아(홀드 Hash 없음)
    w.ev(eventId).expiry.set(36, NOW);
    expect((await sweeper.tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 1, skipped: 1, orphans: 1 })]);
    expect(allHoldIds(seen)).toEqual([released]);
  });

  test('ADR0107_연장된 홀드뿐이면(NO_PROGRESS) 고리를 부르지 않는다', async () => {
    const { w, seen, sweeper } = hooked();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')]);
    w.clock.advance(HOLD_TTL_MS);
    w.ev(eventId).holds.get(ref('A01').index)!.exp = w.clock.now() + 60_000;
    expect((await sweeper.tick()).events).toMatchObject([report(eventId, 'NO_PROGRESS', { batches: 1, skipped: 1 })]);
    expect(seen).toEqual([]);
  });

  test('PT41_ADR0107_묶음이 여럿이어도 푼 홀드를 모두 넘기고 한 번의 부름에는 같은 holdId가 없다 [ASVS v5.0.0-2.3.1]', async () => {
    const { w, seen, sweeper, holdIdOf } = hooked();
    const seats = Array.from({ length: 250 }, (_, i) => bigSeat(i));
    const { eventId } = await w.openEvent(seats, { seatCount: 250 });
    await w.holdMany(eventId, seats);
    const expected = [...new Set(seats.map((s) => holdIdOf(eventId, s)))].sort();
    w.clock.advance(HOLD_TTL_MS);
    expect((await sweeper.tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 3, released: 250 })]);
    for (const e of seen) expect(new Set(e.holdIds).size).toBe(e.holdIds.length);
    expect([...new Set(allHoldIds(seen))].sort()).toEqual(expected);
  });

  test('ADR0107_회차가 여럿이면 회차마다 제 회차의 holdId만 넘긴다', async () => {
    const { w, seen, sweeper, holdIdOf } = hooked();
    const a = await w.openEvent();
    const b = await w.openEvent();
    await w.hold(a.eventId, [ref('A01')]);
    await w.hold(b.eventId, [ref('A01')]);
    const idA = holdIdOf(a.eventId, ref('A01'));
    const idB = holdIdOf(b.eventId, ref('A01'));
    w.clock.advance(HOLD_TTL_MS);
    await sweeper.tick();
    expect(seen.filter((e) => e.eventId === a.eventId).flatMap((e) => [...e.holdIds])).toEqual([idA]);
    expect(seen.filter((e) => e.eventId === b.eventId).flatMap((e) => [...e.holdIds])).toEqual([idB]);
  });

  test('ADR0107_고리가 던져도 반복은 멈추지 않는다: 그 회차의 다음 묶음과 다른 회차를 그대로 돌고 결과도 그대로다 [ASVS v5.0.0-16.5.2]', async () => {
    const { w, seen, sweeper } = hooked(() => {
      throw new Error('hook down');
    });
    const seats = Array.from({ length: 150 }, (_, i) => bigSeat(i));
    const big = await w.openEvent(seats, { seatCount: 150 });
    const small = await w.openEvent();
    await w.holdMany(big.eventId, seats);
    await w.hold(small.eventId, [ref('A01')]);
    w.clock.advance(HOLD_TTL_MS);
    const t = await sweeper.tick();
    expect(Object.fromEntries(t.events.map((x) => [x.eventId, [x.outcome, x.released]]))).toEqual({ [big.eventId]: ['DRAINED', 150], [small.eventId]: ['DRAINED', 1] });
    // 회차마다 적어도 한 번 불렸고 그때마다 던졌다
    expect(new Set(seen.map((e) => e.eventId)).size).toBe(2);
    expect(w.ev(big.eventId).expiry.size).toBe(0);
    expect(w.ev(small.eventId).expiry.size).toBe(0);
  });

  test('ADR0107_고리를 달지 않은 조립도 그대로 돈다', async () => {
    const w = world();
    const { eventId } = await w.openEvent();
    await w.hold(eventId, [ref('A01')]);
    w.clock.advance(HOLD_TTL_MS);
    expect((await w.sweeper().tick()).events).toMatchObject([report(eventId, 'DRAINED', { batches: 1, released: 1 })]);
  });
});
