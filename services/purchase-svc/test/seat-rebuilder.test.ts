// 다시 만들기 RB-06 한 회차(SeatRebuilder, BUILD_ORDER PRF-143, docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현',
// application/seat-rebuilder.ts의 차례, 명세 specs/seat.qnt rebuild). purchase DB 쪽은 가짜 SeatRebuildSource, 좌석맵 판은 MemorySeatMap,
// 좌석 Redis 쪽은 MemorySeatStore(SeatRebuildTarget, Lua 계약의 메모리 쌍둥이)를 기록하는 감싸개로 돌린다.
import { type FakeClock, fakeClock } from '@peaket/platform';
import { describe, expect, test } from 'vitest';
import {
  type MemoryHoldHash,
  type MemorySeatDef,
  MemorySeatMap,
  MemorySeatStore,
  REBUILD_BATCH,
  type RebuildHold,
  type RebuildReport,
  type RebuildSale,
  type RebuildSeat,
  routeStreamEntry,
  SeatRebuilder,
  type SeatRebuilderSignals,
  type SeatRebuildSource,
  type SeatRebuildTarget,
  seatKeys,
} from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, DAY, holdInput, newEvent, ref, SEAT_COUNT, SEAT_DEFS } from './hold-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
const HOLDER = 'pod-rebuild-1';
const KEEP = NOW + 2 * DAY;
const TTL = 420_000;

interface SourceOptions {
  /** acquire가 돌려줄 판 번호(null이면 다른 파드가 임대 중) */
  gen?: number | null;
  sales?: RebuildSale[];
  holds?: RebuildHold[];
  /** 판매 좌석의 HELD 원장 행(만료 조건 없음). 없으면 holds */
  saleHolds?: RebuildHold[];
  /** acquire 바로 뒤에 부른다(임대를 잡은 틈에 다른 곳이 세대 키를 쓴 경우를 만든다) */
  afterAcquire?: () => void;
  /** 이 단계에서 던진다 */
  failAt?: 'sales' | 'holds';
}

/** 호출 기록(차례 확인용 한 줄씩) */
type Log = string[];

function fakeSource(log: Log, o: SourceOptions = {}): SeatRebuildSource & { error: Error } {
  const error = new Error('purchase DB 연결이 끊겼다');
  return {
    error,
    acquire: async (e, h) => {
      log.push(`acquire ${e} ${h}`);
      o.afterAcquire?.();
      return o.gen === undefined ? 2 : o.gen;
    },
    sales: async (e) => {
      log.push(`sales ${e}`);
      if (o.failAt === 'sales') throw error;
      return o.sales ?? [];
    },
    holds: async (e) => {
      log.push(`holds ${e}`);
      if (o.failAt === 'holds') throw error;
      return o.holds ?? [];
    },
    saleHolds: async (e) => {
      log.push(`saleHolds ${e}`);
      return o.saleHolds ?? o.holds ?? [];
    },
    // 주문 근거(orders)를 꽂지 않는 이 시험들에서는 부르지 않는다(PRF-167 리뷰 고침 M2)
    ledgerRows: async (e) => {
      log.push(`ledgerRows ${e}`);
      return [];
    },
    release: async (e, h, opt) => {
      const setGen = (opt as { setGen?: number } | undefined)?.setGen;
      log.push(`release ${e} ${h}${setGen !== undefined ? ` setGen ${setGen}` : ''}`);
    },
  };
}

interface TargetHooks {
  /** n번째(1부터) writeSeats 바로 전에 부른다(다른 곳이 세대 키를 먼저 쓴 경우를 만든다) */
  beforeWrite?: (n: number, store: MemorySeatStore) => void;
  beforeFinish?: (store: MemorySeatStore) => void;
  /** n번째 writeSeats가 던진다 */
  failWriteAt?: number;
  failFinish?: boolean;
}

/** MemorySeatStore를 감싸 부른 차례와 묶음을 적는다 */
function recordingTarget(store: MemorySeatStore, log: Log, hooks: TargetHooks = {}) {
  const batches: RebuildSeat[][] = [];
  const finishes: { quotas: ReadonlyMap<string, number>; gen: number; keepUntilMs: number; maxToken?: number }[] = [];
  const error = new Error('좌석 Redis 스크립트 오류');
  let writes = 0;
  const target: SeatRebuildTarget = {
    isReady: async (e) => {
      log.push(`isReady ${e}`);
      return store.isReady(e);
    },
    begin: async (e, gen, keepUntilMs) => {
      log.push(`begin ${e} ${gen}`);
      return store.begin(e, gen, keepUntilMs);
    },
    writeSeats: async (e, seats, keepUntilMs, gen) => {
      writes += 1;
      log.push(`writeSeats ${e} ${seats.length}`);
      batches.push([...seats]);
      hooks.beforeWrite?.(writes, store);
      if (hooks.failWriteAt === writes) throw error;
      return store.writeSeats(e, seats, keepUntilMs, gen);
    },
    finish: async (e, input) => {
      log.push(`finish ${e}`);
      finishes.push({ ...input, quotas: new Map(input.quotas) });
      hooks.beforeFinish?.(store);
      if (hooks.failFinish) throw error;
      return store.finish(e, input);
    },
    bumpEpoch: async (e) => store.bumpEpoch(e),
  };
  return { target, batches, finishes, error };
}

function recordingSignals(): SeatRebuilderSignals & { calls: string[] } {
  const calls: string[] = [];
  return { calls, rebuilt: (r) => void calls.push(r) };
}

/** 시험 판(hold-cases SEAT_DEFS)을 넣은 좌석맵 */
function layout(eventId: string, defs: readonly MemorySeatDef[] = SEAT_DEFS, seatCount = SEAT_COUNT): MemorySeatMap {
  const m = new MemorySeatMap();
  m.put({ eventId, layoutVersion: 'v1', seatCount, perAccountLimit: 4, saleEndsAtMs: NOW + DAY }, defs);
  return m;
}

function world(o: SourceOptions & TargetHooks & { defs?: MemorySeatDef[]; seatCount?: number; clock?: FakeClock; nodeId?: string } = {}) {
  const clock = o.clock ?? fakeClock({ now: NOW });
  const store = new MemorySeatStore(clock, undefined, o.nodeId === undefined ? {} : { nodeId: o.nodeId });
  const eventId = newEvent();
  const log: Log = [];
  const source = fakeSource(log, o);
  const t = recordingTarget(store, log, o);
  const signals = recordingSignals();
  const rebuilder = new SeatRebuilder({ source, target: t.target, seatMap: layout(eventId, o.defs, o.seatCount), holder: HOLDER, signals });
  return { clock, store, eventId, log, source, signals, rebuilder, ...t, ev: () => store.db.event(eventId), run: () => rebuilder.rebuild(eventId, { keepUntilMs: KEEP }) };
}

/** 원장 홀드 하나(1분 전에 잡아 6분 뒤 만료) */
function ledger(seatId: string, accountId: string, fencingToken: number, over: Partial<RebuildHold> = {}): RebuildHold {
  const heldAtMs = NOW - 60_000;
  return { seatId, accountId, fencingToken, kind: 'FAN', heldAtMs, expiresAtMs: heldAtMs + TTL, holdId: `h-${seatId}`, purchaseSessionId: `ps-${seatId}`, ...over };
}
const tok = (n: number) => (NOW - 60_000) * 1000 + n;

/** 좌석 n개짜리 판(S0000 ~, 한 구역, 색인 = 차례) */
const bigDefs = (n: number): MemorySeatDef[] =>
  Array.from({ length: n }, (_, i) => ({ seatId: `S${String(i).padStart(4, '0')}`, index: i, sectionId: 'SEC-S', sectionIndex: 0, seatOffset: i, tierId: 'R' }));

describe('SeatRebuilder: 차례', () => {
  test('ST26_ 세대 키가 이미 있으면 purchase DB를 부르지 않고 READY이고 rebuilt(ready)를 한 번 부른다(아무것도 쓰지 않는다) [S-T26]', async () => {
    const w = world();
    await w.store.openSale({ eventId: w.eventId, seatCount: SEAT_COUNT, keepUntilMs: KEEP });
    const before = { ...w.ev().epoch! };
    await expect(w.run()).resolves.toEqual({ result: 'READY' });
    expect(w.log).toEqual([`isReady ${w.eventId}`]);
    expect(w.signals.calls).toEqual(['ready']);
    expect(w.ev().epoch).toEqual(before);
  });

  test('ST26_ 임대를 못 잡으면(acquire null) BUSY이고 판매·원장을 읽지 않으며 좌석 Redis에 쓰지 않는다. rebuilt(busy)를 한 번 부른다 [S-T26]', async () => {
    const w = world({ gen: null, sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }] });
    await expect(w.run()).resolves.toEqual({ result: 'BUSY' });
    expect(w.log.slice(0, 2)).toEqual([`isReady ${w.eventId}`, `acquire ${w.eventId} ${HOLDER}`]);
    expect(w.log.filter((l) => /^(sales|holds|writeSeats|finish) /.test(l))).toEqual([]);
    expect(w.signals.calls).toEqual(['busy']);
    expect(w.ev().epoch).toBeUndefined();
    expect(w.ev().bits.size).toBe(0);
  });

  test('ST26_ 차례: isReady → acquire(회차, holder) → begin(회차, gen) → 판매·원장·판매 좌석 원장 읽기 → writeSeats(좌석 색인 차례) → finish(보유 수, gen = acquire가 준 값, keepUntil, maxToken. node는 넘기지 않는다) → release(회차, holder) [S-T26]', async () => {
    const w = world({
      gen: 7,
      sales: [
        { seatId: 'A02', accountId: ACCOUNT_A, orderId: 'o-1' },
        { seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' },
      ],
      holds: [ledger('A05', ACCOUNT_B, tok(1))],
    });
    await expect(w.run()).resolves.toEqual({ result: 'REBUILT', gen: 7, sold: 2, held: 1, skipped: 0 });
    const e = w.eventId;
    const reads = w.log.slice(3, 6).sort();
    expect(reads).toEqual([`holds ${e}`, `saleHolds ${e}`, `sales ${e}`]);
    expect([...w.log.slice(0, 3), ...w.log.slice(6)]).toEqual([`isReady ${e}`, `acquire ${e} ${HOLDER}`, `begin ${e} 7`, `writeSeats ${e} 3`, `finish ${e}`, `release ${e} ${HOLDER}`]);
    expect(w.batches[0]!.map((s) => s.seat.index)).toEqual([0, 1, 4]);
    expect(w.finishes).toEqual([{ quotas: new Map([[ACCOUNT_A, 2], [ACCOUNT_B, 1]]), gen: 7, keepUntilMs: KEEP, maxToken: tok(1) }]);
    expect('node' in w.finishes[0]!).toBe(false);
    expect(w.signals.calls).toEqual(['rebuilt']);
  });

  test.each([
    [1, [1]],
    [200, [200]],
    [201, [200, 1]],
    [501, [200, 200, 101]],
  ])('ST26_ 좌석 %i석이면 writeSeats를 REBUILD_BATCH(200)석씩 %j로 부르고, 묶음은 좌석 색인 오름차순으로 이어진다(입력이 거꾸로여도) [S-T26]', async (n, sizes) => {
    expect(REBUILD_BATCH).toBe(200);
    const defs = bigDefs(n);
    // 판매 절반·원장 홀드 절반을 거꾸로 넣는다
    const sales = defs.filter((_, i) => i % 2 === 0).map((d) => ({ seatId: d.seatId, accountId: ACCOUNT_A, orderId: 'o-big' })).reverse();
    const holds = defs.filter((_, i) => i % 2 === 1).map((d, i) => ledger(d.seatId, ACCOUNT_B, tok(i + 1))).reverse();
    const w = world({ defs, seatCount: n, sales, holds });
    const r = await w.run();
    expect(r).toEqual({ result: 'REBUILT', gen: 2, sold: sales.length, held: holds.length, skipped: 0 });
    expect(w.batches.map((b) => b.length)).toEqual(sizes);
    expect(w.batches.flat().map((s) => s.seat.index)).toEqual(defs.map((d) => d.index));
    expect(w.log.filter((l) => l.startsWith('finish'))).toHaveLength(1);
    expect(w.log.at(-1)).toBe(`release ${w.eventId} ${HOLDER}`);
  });

  test('ST26_ 판매도 원장 홀드도 없는 회차도 finish로 세대 키를 쓴다(빈 보유 수, writeSeats는 부르지 않는다. node = 저장소 표지 standalone) [S-T26]', async () => {
    const w = world({ gen: 3 });
    await expect(w.run()).resolves.toEqual({ result: 'REBUILT', gen: 3, sold: 0, held: 0, skipped: 0 });
    expect(w.batches).toEqual([]);
    expect(w.finishes).toEqual([{ quotas: new Map(), gen: 3, keepUntilMs: KEEP, maxToken: 0 }]);
    expect(w.ev().epoch).toEqual({ epoch: Math.floor(NOW / 1000), node: 'standalone', gen: 3, chk: Math.floor(NOW / 1000) });
  });

  test('ST26_ 세대 키 node는 임대 holder(파드 이름)가 아니라 좌석 저장소가 구한 주 노드 표지다: 판매 열기와 같은 뜻이라 다시 만든 회차에 세대 올리기를 불러도 SAME이다(BUILD_ORDER PRF-168) [S-T26]', async () => {
    const NODE = '5e6f708192a3b4c5d6e7f809123a4b5c6d7e8f90:3';
    const w = world({ gen: 4, nodeId: NODE, sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }] });
    await expect(w.run()).resolves.toMatchObject({ result: 'REBUILT', gen: 4 });
    expect(w.ev().epoch).toEqual({ epoch: Math.floor(NOW / 1000), node: NODE, gen: 4, chk: Math.floor(NOW / 1000) });
    expect(w.ev().epoch?.node).not.toBe(HOLDER);
    await expect(w.store.bumpEpoch(w.eventId)).resolves.toEqual({ result: 'SAME', epoch: Math.floor(NOW / 1000), bumps: 0 });
  });

  test('ST26_ 넘긴 좌석(좌석맵 판에 없는 좌석, holdId 없는 원장 홀드)은 skipped로 센다 [S-T26]', async () => {
    const w = world({
      sales: [
        { seatId: 'Z99', accountId: ACCOUNT_A, orderId: 'o-z' },
        { seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' },
      ],
      holds: [ledger('A10', ACCOUNT_B, tok(1), { holdId: null })],
    });
    await expect(w.run()).resolves.toEqual({ result: 'REBUILT', gen: 2, sold: 1, held: 0, skipped: 2 });
    expect(w.ev().bits).toEqual(new Set([0]));
  });
});

describe('SeatRebuilder: 먼저 끝낸 곳(READY)과 실패', () => {
  test('ST26_ 도중의 writeSeats가 READY면(다른 곳이 먼저 세대 키를 씀) 남은 묶음과 finish를 하지 않고 READY, 임대는 비운다 [S-T26]', async () => {
    const defs = bigDefs(501);
    const other = { epoch: 1_700_000_000, node: 'pod-other', gen: 9 };
    const w = world({
      defs,
      seatCount: 501,
      sales: defs.map((d) => ({ seatId: d.seatId, accountId: ACCOUNT_A, orderId: 'o' })),
      beforeWrite: (n, store) => {
        if (n === 2) store.db.event(w.eventId).epoch = { ...other };
      },
    });
    await expect(w.run()).resolves.toEqual({ result: 'READY' });
    expect(w.batches).toHaveLength(2);
    expect(w.log.filter((l) => l.startsWith('finish'))).toEqual([]);
    // DB 판 번호를 세대 키의 gen(9)에 맞추며 비운다(시험 검토 B가 찾음, 코드 리뷰가 절대값으로 바꿈)
    expect(w.log.at(-1)).toBe(`release ${w.eventId} ${HOLDER} setGen 9`);
    expect(w.signals.calls).toEqual(['ready']);
    expect(w.ev().epoch).toEqual(other);
  });

  test('ST26_ finish가 READY여도 READY이고 임대를 비운다. 먼저 쓴 세대 키(node·gen)는 그대로다 [S-T26]', async () => {
    const other = { epoch: 1_700_000_000, node: 'pod-other', gen: 9 };
    const w = world({
      sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }],
      beforeFinish: (store) => void (store.db.event(w.eventId).epoch = { ...other }),
    });
    await expect(w.run()).resolves.toEqual({ result: 'READY' });
    expect(w.log.at(-1)).toBe(`release ${w.eventId} ${HOLDER} setGen 9`);
    expect(w.signals.calls).toEqual(['ready']);
    expect(w.ev().epoch).toEqual(other);
  });

  test.each(['sales', 'holds'] as const)('ST26_ purchase DB 읽기(%s)가 던지면 좌석 Redis에 쓰지 않고 임대를 비운 뒤 같은 오류로 던진다. rebuilt(failed)를 한 번 부른다 [S-T26]', async (failAt) => {
    const w = world({ failAt, sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }] });
    await expect(w.run()).rejects.toBe(w.source.error);
    expect(w.log.filter((l) => /^(writeSeats|finish) /.test(l))).toEqual([]);
    expect(w.log.at(-1)).toBe(`release ${w.eventId} ${HOLDER}`);
    expect(w.signals.calls).toEqual(['failed']);
  });

  test('ST26_ 둘째 writeSeats가 던지면 finish를 하지 않고 임대를 비운 뒤 같은 오류로 던진다. 세대 키가 없어 회차는 NOT_READY로 남는다(다음 번에 처음부터) [S-T26]', async () => {
    const defs = bigDefs(450);
    const w = world({ defs, seatCount: 450, sales: defs.map((d) => ({ seatId: d.seatId, accountId: ACCOUNT_A, orderId: 'o' })), failWriteAt: 2 });
    await expect(w.run()).rejects.toBe(w.error);
    expect(w.batches).toHaveLength(2);
    expect(w.log.filter((l) => l.startsWith('finish'))).toEqual([]);
    expect(w.log.at(-1)).toBe(`release ${w.eventId} ${HOLDER}`);
    expect(w.signals.calls).toEqual(['failed']);
    expect(w.ev().epoch).toBeUndefined();
    expect(await w.store.isReady(w.eventId)).toBe(false);
  });

  test('ST26_ finish가 던져도 임대를 비우고 같은 오류로 던진다 [S-T26]', async () => {
    const w = world({ sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }], failFinish: true });
    await expect(w.run()).rejects.toBe(w.error);
    expect(w.log.at(-1)).toBe(`release ${w.eventId} ${HOLDER}`);
    expect(w.signals.calls).toEqual(['failed']);
  });
});

describe('SeatRebuilder: 메모리 좌석 Redis에 남는 것', () => {
  test('ST26_ 다시 만든 회차: 판매·되살린 홀드 좌석의 비트, 홀드 Hash(판매는 pin 1·대조한 원장 행의 토큰·시각, 홀드는 원장 값·ext 0), 만료 인덱스는 홀드만, 보유 수, 세대 키(epoch = 지금 초·node = 저장소 표지 standalone·gen), 회차 목록 [S-T26] [S-T5]', async () => {
    const hb = ledger('A05', ACCOUNT_B, tok(7), { holdId: 'h-b', purchaseSessionId: 'ps-b' });
    const w = world({
      gen: 4,
      sales: [
        { seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' },
        { seatId: 'A02', accountId: ACCOUNT_A, orderId: 'o-1' },
      ],
      holds: [ledger('A01', ACCOUNT_A, tok(3), { holdId: 'h-a', purchaseSessionId: 'ps-a' }), ledger('A02', ACCOUNT_A, tok(3), { holdId: 'h-a', purchaseSessionId: 'ps-a' }), hb],
    });
    await expect(w.run()).resolves.toEqual({ result: 'REBUILT', gen: 4, sold: 2, held: 1, skipped: 0 });
    const ev = w.ev();
    expect(ev.bits).toEqual(new Set([0, 1, 4]));
    const sold: MemoryHoldHash = { holdId: 'h-a', owner: ACCOUNT_A, psid: 'ps-a', fence: String(tok(3)), heldAt: NOW - 60_000, exp: NOW - 60_000 + TTL, kind: 'FAN', ext: '0', pin: '1' };
    expect(Object.fromEntries(ev.holds)).toEqual({
      0: sold,
      1: sold,
      4: { holdId: 'h-b', owner: ACCOUNT_B, psid: 'ps-b', fence: String(tok(7)), heldAt: hb.heldAtMs!, exp: hb.expiresAtMs, kind: 'FAN', ext: '0' },
    });
    expect(ev.holds.get(4)!.pin).toBeUndefined();
    expect(Object.fromEntries(ev.expiry)).toEqual({ 4: hb.expiresAtMs });
    expect(Object.fromEntries(ev.quota)).toEqual({ [ACCOUNT_A]: 2, [ACCOUNT_B]: 1 });
    expect(ev.epoch).toEqual({ epoch: Math.floor(NOW / 1000), node: 'standalone', gen: 4, chk: Math.floor(NOW / 1000) });
    expect(w.store.db.ctlEvents.has(w.eventId)).toBe(true);
    // 펜싱 카운터는 되살린 토큰의 최댓값으로 되살리고(코드 리뷰로 고침), Stream·Pub/Sub·구역 일련번호는 쓰지 않는다
    expect(ev.fence).toBe(String(tok(7)));
    expect(ev.stream).toEqual([]);
    expect(ev.published).toEqual([]);
    expect(ev.secver.size).toBe(0);
    // 키 수명은 keepUntil
    for (const k of [seatKeys.hold(w.eventId, 0), seatKeys.hold(w.eventId, 4), seatKeys.bitmap(w.eventId), seatKeys.expiry(w.eventId), seatKeys.quota(w.eventId, ACCOUNT_A), seatKeys.epoch(w.eventId)]) {
      expect(ev.expireAt.get(k), k).toBe(KEEP);
    }
    expect(await w.store.isReady(w.eventId)).toBe(true);
  });

  test('ST26_ 같은 회차를 다시 부르면 READY이고 다시 읽지 않는다(두 번째 파드·다음 반복) [S-T26]', async () => {
    const w = world({ sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }] });
    await w.run();
    w.log.length = 0;
    w.signals.calls.length = 0;
    await expect(w.run()).resolves.toEqual({ result: 'READY' });
    expect(w.log).toEqual([`isReady ${w.eventId}`]);
    expect(w.signals.calls).toEqual(['ready']);
  });
});

describe('코드 리뷰 재현(PRF-143)', () => {
  const HOLD_ID = '0190f3a1-7c2e-7a00-8000-00000000d001';
  const PSID = '0190f3a1-7c2e-7a00-8000-00000000c001';
  /** 판매 좌석 하나(A01, 계정 A)의 RELEASED Stream 항목을 릴레이 길로 바꾼 사건 */
  const releasedOf = (w: ReturnType<typeof world>) => {
    const ev = w.ev();
    const last = ev.stream.at(-1)!;
    expect(last.type).toBe('RELEASED');
    const route = routeStreamEntry(w.eventId, { id: '1-0', fields: last });
    expect(route.kind).toBe('send');
    return (route as { message: { fencingToken: number; expiresAt: string; holdId: string } }).message;
  };

  test('코드 리뷰_ 결제 중 판매 좌석의 holdId는 만료 시각이 지난 HELD 원장 행(saleHolds)에서 온다: 다시 만든 뒤 그 holdId로 실패 해제가 풀고, RELEASED 사건의 토큰은 원장 토큰(1 이상)이다 [S-T26] [S-T7]', async () => {
    // 묶인 지 10분: 원장은 HELD인 채 만료 시각이 지났다(holds()에는 없고 saleHolds()에만 있다)
    const pinned = ledger('A01', ACCOUNT_A, tok(9), { holdId: HOLD_ID, purchaseSessionId: PSID, heldAtMs: NOW - 600_000, expiresAtMs: NOW - 180_000 });
    const w = world({ sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }], holds: [], saleHolds: [pinned] });
    await expect(w.run()).resolves.toMatchObject({ result: 'REBUILT', sold: 1 });
    expect(w.ev().holds.get(0)).toEqual({ holdId: HOLD_ID, owner: ACCOUNT_A, psid: PSID, fence: String(tok(9)), heldAt: NOW - 600_000, exp: NOW - 180_000, kind: 'FAN', ext: '0', pin: '1' });
    const rel = await w.store.releaseFailed({ eventId: w.eventId, accountId: ACCOUNT_A, holdId: HOLD_ID, seats: [ref('A01')], keepUntilMs: KEEP });
    expect(rel).toEqual({ kind: 'OK', released: 1 });
    expect(w.ev().bits.has(0)).toBe(false);
    const m = releasedOf(w);
    expect(m.fencingToken).toBe(tok(9));
    expect(m.holdId).toBe(HOLD_ID);
  });

  test('코드 리뷰_ 원장 행이 없는 판매 좌석은 fence = 저장소 시각 µs, heldAt = exp = 지금(ms)이라 실패 해제의 RELEASED 토큰이 1 이상이다 [S-T26] [S-T7]', async () => {
    const ORDER = '0190f3a1-7c2e-7a00-8000-00000000f001';
    const w = world({ sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: ORDER }] });
    await w.run();
    expect(w.ev().holds.get(0)).toEqual({ holdId: ORDER, owner: ACCOUNT_A, psid: '', fence: String(NOW * 1000), heldAt: NOW, exp: NOW, kind: 'FAN', ext: '0', pin: '1' });
    expect(await w.store.releaseFailed({ eventId: w.eventId, accountId: ACCOUNT_A, holdId: ORDER, seats: [ref('A01')], keepUntilMs: KEEP })).toEqual({ kind: 'OK', released: 1 });
    // Stream 항목의 토큰이 1 이상이다(구매 세션 ID가 빈 글이라 릴레이는 이 항목을 malformed로 넘긴다: 토큰과 별개의 알려진 한계)
    const last = w.ev().stream.at(-1)!;
    expect(last).toMatchObject({ type: 'RELEASED', fencingToken: String(NOW * 1000), expiresAtMs: String(NOW), holdId: ORDER });
  });

  test('코드 리뷰_ 앞 시도가 좌석을 쓰고 실패한 뒤 그 판매가 사라지면, 다음 시도가 앞 시도의 비트·만료 인덱스를 지우고 다시 쓴다(그 좌석은 빈 좌석) [S-T26]', async () => {
    let failOnce = true;
    const opts: Parameters<typeof world>[0] = {
      sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }],
      holds: [ledger('A03', ACCOUNT_B, tok(1))],
      beforeFinish: () => {
        if (failOnce) {
          failOnce = false;
          throw new Error('좌석 Redis 일시 장애');
        }
      },
    };
    const w = world(opts);
    await expect(w.run()).rejects.toThrow('일시 장애');
    expect(w.ev().bits.has(0)).toBe(true);
    // 승인 거절로 판매가 지워지고, 원장 홀드도 끝났다(DB만)
    opts.sales = [];
    opts.holds = [];
    await expect(w.run()).resolves.toMatchObject({ result: 'REBUILT', sold: 0, held: 0 });
    expect(w.ev().bits.size).toBe(0);
    expect(w.ev().expiry.size).toBe(0);
    const h = await w.store.hold(holdInput(w.eventId, ['A01'], { keepUntilMs: KEEP, accountId: ACCOUNT_B, limit: 4 }));
    expect(h.kind).toBe('OK');
  });

  test('코드 리뷰_ 늦은 시도(판 번호 2)가 더 새 시도(판 번호 3)가 시작한 뒤에 쓰면 STALE이라 아무것도 쓰지 않고 BUSY로 끝난다(새 시도는 REBUILT, 판 번호를 되돌리지 않는다) [S-T26]', async () => {
    const store = new MemorySeatStore(fakeClock({ now: NOW }));
    const eventId = newEvent();
    const seatMap = layout(eventId);
    let openA!: () => void;
    const gateA = new Promise<void>((r) => (openA = r));
    const logA: Log = [];
    const srcA = fakeSource(logA, { gen: 2, sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-old' }] });
    const salesA = srcA.sales;
    srcA.sales = async (e) => {
      await gateA;
      return salesA(e);
    };
    const srcB = fakeSource([], { gen: 3, sales: [{ seatId: 'A02', accountId: ACCOUNT_B, orderId: 'o-new' }] });
    let runA!: Promise<RebuildReport>;
    // B는 끝내기 바로 앞에서 A를 마저 돌린다(A의 쓰기는 B가 시작한 뒤, B가 끝내기 전)
    const targetB = new Proxy(store, {
      get(t, p) {
        if (p === 'finish')
          return async (e: string, i: Parameters<MemorySeatStore['finish']>[1]) => {
            openA();
            await runA;
            return t.finish(e, i);
          };
        const v = Reflect.get(t, p, t) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
      },
    });
    runA = new SeatRebuilder({ source: srcA, target: store, seatMap, holder: 'pod-a' }).rebuild(eventId, { keepUntilMs: KEEP });
    const b = await new SeatRebuilder({ source: srcB, target: targetB, seatMap, holder: 'pod-b' }).rebuild(eventId, { keepUntilMs: KEEP });
    const a = await runA;
    expect(b).toEqual({ result: 'REBUILT', gen: 3, sold: 1, held: 0, skipped: 0 });
    expect(a).toEqual({ result: 'BUSY' });
    const ev = store.db.event(eventId);
    expect(ev.bits).toEqual(new Set([1]));
    expect(ev.holds.has(0)).toBe(false);
    // 세대 키를 쓴 것은 B(판 번호 3)다. node는 파드가 아니라 저장소 표지라 판 번호로 가린다(PRF-168)
    expect(ev.epoch).toMatchObject({ gen: 3 });
    // A는 판 번호를 되돌리지 않고 임대만 비운다
    expect(logA.at(-1)).toBe(`release ${eventId} pod-a`);
  });

  test('코드 리뷰_ 임대를 잡은 틈에 다른 곳이 세대 키(gen 9)를 썼으면 READY이고 release는 DB 판 번호를 세대 키의 gen에 맞춘다(setGen 9) [S-T26]', async () => {
    const other = { epoch: 1_700_000_000, node: 'pod-other', gen: 9 };
    const w = world({ sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }], afterAcquire: () => void (w.store.db.event(w.eventId).epoch = { ...other }) });
    await expect(w.run()).resolves.toEqual({ result: 'READY' });
    expect(w.log.at(-1)).toBe(`release ${w.eventId} ${HOLDER} setGen 9`);
    expect(w.log.filter((l) => /^(sales|holds|saleHolds|writeSeats|finish) /.test(l))).toEqual([]);
    expect(w.ev().epoch).toEqual(other);
  });

  test('코드 리뷰_ 끝내면 펜싱 카운터 fence = max(옛 fence, 되살린 토큰 최댓값)이다(판매 좌석의 원장 토큰 포함) [S-T26] [S-T5]', async () => {
    const w = world({
      sales: [{ seatId: 'A01', accountId: ACCOUNT_A, orderId: 'o-1' }],
      holds: [ledger('A05', ACCOUNT_B, tok(7))],
      saleHolds: [ledger('A01', ACCOUNT_A, tok(11), { holdId: HOLD_ID })],
    });
    await w.run();
    expect(w.ev().fence).toBe(String(tok(11)));
    expect(w.ev().expireAt.get(seatKeys.fence(w.eventId))).toBe(KEEP);
    // 옛 fence가 더 크면 그대로
    const v = world({ holds: [ledger('A05', ACCOUNT_B, tok(7))] });
    v.ev().fence = String(tok(500));
    await v.run();
    expect(v.ev().fence).toBe(String(tok(500)));
  });
});
