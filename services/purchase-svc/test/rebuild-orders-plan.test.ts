// 다시 만들기의 주문 기준 되살리기: planRebuild의 주문 근거(BUILD_ORDER PRF-167, docs/features/seat-hold.md §6 '주문 기준 되살리기' K1·K3,
// 명세 specs/seat.qnt rebuild). 우선순위 판매 > 묶인 주문 > 원장 홀드, 판매 좌석의 holdId·psid는 판매 주문의 것, 묶인 주문의 좌석은 살아 있는 홀드
// (묶음 아님, 잡은 시각 = 지금, 만료 = 지금 + 7분), 보유 수는 세 근거를 합쳐 계정마다 센다. SeatRebuilder가 주문 근거를 읽어 넘기는 차례도 본다.
// 묶인 주문의 좌석은 원장(pinnedLedger, 그 좌석들의 원장 행·상태 상관없이)에 그 주문 holdId의 HELD 행이 있고, 그보다 토큰이 높은 다른 holdId의 행이
// 그 좌석에 없을 때만 되살린다. 되살린 홀드의 펜싱 토큰은 그 HELD 행의 토큰이다(리뷰 고침 M2·L3·L4).
// 좌석맵 판은 test/hold-cases.ts의 시험 판(A01 ~ A20 = 색인 0 ~ 19)이다.
import { describe, expect, test } from 'vitest';
import {
  MemorySeatMap,
  MemorySeatStore,
  planRebuild,
  quotasOf,
  type RebuildHold,
  type RebuildLedgerRow,
  type RebuildOrderInputs,
  type RebuildOrderSource,
  type RebuildPinnedOrder,
  type RebuildSale,
  type RebuildSaleOrder,
  type SeatRebuildSource,
  SeatRebuilder,
  type SeatRef,
} from '../src/modules/inventory/index.js';
import { fakeClock } from '@peaket/platform';
import { ACCOUNT_A, ACCOUNT_B, ref, SEAT_DEFS } from './hold-cases.js';

const NOW = Date.parse('2026-11-05T03:00:00.000Z');
/** 홀드 수명 7분(HOLD_TTL_MS) */
const TTL = 420_000;

const resolve = (seatId: string): SeatRef | undefined => {
  const d = SEAT_DEFS.find((s) => s.seatId === seatId);
  return d && !d.saleExcluded ? ref(seatId) : undefined;
};
const sale = (seatId: string, accountId: string, orderId: string): RebuildSale => ({ seatId, accountId, orderId });
const saleOrder = (orderId: string): RebuildSaleOrder => ({ orderId, holdId: `hold-of-${orderId}`, purchaseSessionId: `ps-of-${orderId}` });
const pinned = (orderId: string, accountId: string, seatIds: string[]): RebuildPinnedOrder => ({
  orderId,
  accountId,
  holdId: `hold-of-${orderId}`,
  purchaseSessionId: `ps-of-${orderId}`,
  seatIds,
});
/** 원장 행 하나(pinnedLedger). holdId는 'hold-of-{주문}' 꼴 */
const row = (seatId: string, holdId: string | null, fencingToken: number, status: RebuildLedgerRow['status'] = 'HELD'): RebuildLedgerRow => ({ seatId, holdId, status, fencingToken });
/** 묶인 주문의 좌석마다 그 주문 holdId의 HELD 원장 행(토큰은 from부터 1씩) */
const heldRows = (orderId: string, seatIds: string[], from = 100): RebuildLedgerRow[] => seatIds.map((s, k) => row(s, `hold-of-${orderId}`, from + k));
/** 원장 홀드 하나(기본은 FAN, 1분 전에 잡아 6분 뒤 만료) */
function ledger(seatId: string, accountId: string, fencingToken: number, over: Partial<RebuildHold> = {}): RebuildHold {
  const heldAtMs = NOW - 60_000;
  return { seatId, accountId, fencingToken, kind: 'FAN', heldAtMs, expiresAtMs: heldAtMs + TTL, holdId: `h-${seatId}-${fencingToken}`, purchaseSessionId: 'ps-ledger', ...over };
}
const orders = (o: Partial<RebuildOrderInputs> = {}): RebuildOrderInputs => ({ saleOrders: [], pinned: [], pinnedLedger: [], nowMs: NOW, ...o });

describe('planRebuild 주문 근거(PRF-167)', () => {
  test('rebuild_④ K3: 원장 행이 없는 판매 좌석은 SOLD이고 holdId·purchaseSessionId = 그 판매 주문의 hold_id·purchase_session_id다(주문 ID·빈 글이 아니다). 토큰·시각 칸은 없다 [ASVS v5.0.0-2.3.4]', () => {
    const plan = planRebuild([sale('A01', ACCOUNT_A, 'order-1')], [], resolve, [], orders({ saleOrders: [saleOrder('order-1')] }));
    expect(plan).toEqual({
      seats: [{ mode: 'SOLD', seat: ref('A01'), accountId: ACCOUNT_A, holdId: 'hold-of-order-1', purchaseSessionId: 'ps-of-order-1' }],
      skipped: 0,
    });
  });

  test('rebuild_④ K3: 판매 좌석에 그 계정의 원장 행이 있으면 토큰·잡은 시각·만료 시각은 원장 행의 것이고 holdId·psid는 판매 주문의 것이다 [ASVS v5.0.0-2.3.4]', () => {
    const h = ledger('A01', ACCOUNT_A, 7, { holdId: 'hold-of-order-1', purchaseSessionId: 'ps-of-order-1' });
    const plan = planRebuild([sale('A01', ACCOUNT_A, 'order-1')], [], resolve, [h], orders({ saleOrders: [saleOrder('order-1')] }));
    expect(plan.seats).toEqual([
      { mode: 'SOLD', seat: ref('A01'), accountId: ACCOUNT_A, holdId: 'hold-of-order-1', purchaseSessionId: 'ps-of-order-1', fencingToken: 7, heldAtMs: h.heldAtMs, expiresAtMs: h.expiresAtMs },
    ]);
  });

  test('rebuild_④ K1: 묶인 주문의 좌석은 그 holdId의 HELD 원장 행이 있으면 만료가 지났어도(holds에 없어도) HELD(묶음 아님, FAN)이고 holdId·psid = 그 주문의 것, 잡은 시각 = 지금, 만료 = 지금 + 7분, 펜싱 토큰 = 그 HELD 행의 토큰이다 [ASVS v5.0.0-2.3.4]', () => {
    const plan = planRebuild([], [], resolve, [], orders({ pinned: [pinned('order-2', ACCOUNT_A, ['A02', 'A03'])], pinnedLedger: [row('A02', 'hold-of-order-2', 5), row('A03', 'hold-of-order-2', 6)] }));
    expect(plan).toEqual({
      seats: [
        { mode: 'HELD', seat: ref('A02'), accountId: ACCOUNT_A, holdId: 'hold-of-order-2', purchaseSessionId: 'ps-of-order-2', fencingToken: 5, heldAtMs: NOW, expiresAtMs: NOW + TTL, kind: 'FAN' },
        { mode: 'HELD', seat: ref('A03'), accountId: ACCOUNT_A, holdId: 'hold-of-order-2', purchaseSessionId: 'ps-of-order-2', fencingToken: 6, heldAtMs: NOW, expiresAtMs: NOW + TTL, kind: 'FAN' },
      ],
      skipped: 0,
    });
  });

  test('rebuild_④ K1(리뷰 고침 M2·B①): 그 holdId의 원장 행이 RELEASED·EXPIRED이거나 없으면 그 좌석은 되살리지 않고(넘김으로 세지 않는다), HELD 행이 있는 좌석만 되살린다 [ASVS v5.0.0-2.3.4]', () => {
    const plan = planRebuild(
      [],
      [],
      resolve,
      [],
      orders({
        pinned: [pinned('order-2', ACCOUNT_A, ['A02', 'A03', 'A04', 'A05'])],
        pinnedLedger: [row('A02', 'hold-of-order-2', 5, 'RELEASED'), row('A03', 'hold-of-order-2', 6, 'EXPIRED'), row('A05', 'hold-of-order-2', 8)],
      }),
    );
    expect(plan.seats.map((s) => [s.seat.seatId, s.mode, s.holdId, s.fencingToken])).toEqual([['A05', 'HELD', 'hold-of-order-2', 8]]);
    expect(plan.skipped).toBe(0);
  });

  test('rebuild_④ K1(리뷰 고침 M2): 그 좌석에 그 HELD 행보다 토큰이 높은 다른 holdId의 행이 있으면(상태 상관없이, holdId가 빈 옛 행도) 되살리지 않는다. 낮은 토큰의 다른 행은 상관없다 [ASVS v5.0.0-2.3.4]', () => {
    const plan = planRebuild(
      [],
      [],
      resolve,
      [],
      orders({
        pinned: [pinned('order-2', ACCOUNT_A, ['A02', 'A03', 'A04', 'A05'])],
        pinnedLedger: [
          ...heldRows('order-2', ['A02', 'A03', 'A04', 'A05'], 10),
          row('A02', 'hold-of-later', 20, 'EXPIRED'),
          row('A03', 'hold-of-later', 21, 'HELD'),
          row('A04', null, 22, 'RELEASED'),
          row('A05', 'hold-of-earlier', 3, 'RELEASED'),
        ],
      }),
    );
    expect(plan.seats.map((s) => [s.seat.seatId, s.holdId, s.fencingToken])).toEqual([['A05', 'hold-of-order-2', 13]]);
  });

  test('rebuild_④ K1: 그 holdId의 HELD 행이 한 좌석에 여럿이면 가장 큰 토큰을 쓰고, 끝내기의 펜싱 카운터 최댓값(maxTokenOf)에 그 토큰이 들어간다 [ASVS v5.0.0-2.3.4]', () => {
    const plan = planRebuild([], [], resolve, [], orders({ pinned: [pinned('order-2', ACCOUNT_A, ['A02'])], pinnedLedger: [row('A02', 'hold-of-order-2', 5), row('A02', 'hold-of-order-2', 9)] }));
    expect(plan.seats.map((s) => s.fencingToken)).toEqual([9]);
  });

  test('rebuild_④ 같은 좌석에 묶인 주문 둘: 토큰이 높은 HELD 행의 주문만 되살린다(목록 차례와 상관없다) [ASVS v5.0.0-2.3.4]', () => {
    for (const list of [
      [pinned('order-x', ACCOUNT_A, ['A06']), pinned('order-y', ACCOUNT_B, ['A06'])],
      [pinned('order-y', ACCOUNT_B, ['A06']), pinned('order-x', ACCOUNT_A, ['A06'])],
    ]) {
      const plan = planRebuild([], [], resolve, [], orders({ pinned: list, pinnedLedger: [row('A06', 'hold-of-order-x', 8), row('A06', 'hold-of-order-y', 5)] }));
      expect(plan.seats.map((s) => [s.seat.seatId, s.accountId, s.holdId, s.fencingToken])).toEqual([['A06', ACCOUNT_A, 'hold-of-order-x', 8]]);
      expect(plan.skipped).toBe(0);
    }
  });

  test('rebuild_④ 우선순위: 같은 좌석에 판매·묶인 주문·원장 홀드가 있으면 판매가, 판매가 없으면 묶인 주문이 원장 홀드보다 앞선다 [ASVS v5.0.0-2.3.4]', () => {
    const other = ledger('A05', ACCOUNT_B, 9, { holdId: 'hold-of-other' });
    const plan = planRebuild(
      [sale('A04', ACCOUNT_B, 'order-sold')],
      [ledger('A04', ACCOUNT_A, 3, { holdId: 'h-a04' }), other],
      resolve,
      [],
      orders({ saleOrders: [saleOrder('order-sold')], pinned: [pinned('order-pin', ACCOUNT_A, ['A04', 'A05'])], pinnedLedger: heldRows('order-pin', ['A04', 'A05'], 11) }),
    );
    expect(plan.seats.map((s) => [s.seat.seatId, s.mode, s.accountId, s.holdId])).toEqual([
      ['A04', 'SOLD', ACCOUNT_B, 'hold-of-order-sold'],
      ['A05', 'HELD', ACCOUNT_A, 'hold-of-order-pin'],
    ]);
    // 판매에 덮인 묶인 주문 좌석·묶인 주문에 덮인 원장 홀드는 넘김으로 세지 않는다
    expect(plan.skipped).toBe(0);
  });

  test('rebuild_④ 보유 수는 판매 좌석 + 묶인 주문 좌석 + 되살린 원장 홀드를 계정마다 합친다 [ASVS v5.0.0-2.3.4]', () => {
    const plan = planRebuild(
      [sale('A01', ACCOUNT_A, 'order-1')],
      [ledger('A09', ACCOUNT_A, 4), ledger('A10', ACCOUNT_B, 6)],
      resolve,
      [],
      orders({
        saleOrders: [saleOrder('order-1')],
        pinned: [pinned('order-2', ACCOUNT_A, ['A02', 'A03']), pinned('order-3', ACCOUNT_B, ['A04'])],
        pinnedLedger: [...heldRows('order-2', ['A02', 'A03']), ...heldRows('order-3', ['A04'], 200)],
      }),
    );
    expect(Object.fromEntries(quotasOf(plan.seats))).toEqual({ [ACCOUNT_A]: 4, [ACCOUNT_B]: 2 });
  });

  test('rebuild_④ 좌석맵 판에 없는 묶인 주문 좌석은 넘김(skipped)이고 나머지 좌석은 되살린다 [ASVS v5.0.0-2.3.4]', () => {
    const plan = planRebuild([], [], resolve, [], orders({ pinned: [pinned('order-2', ACCOUNT_A, ['A02', 'NOPE'])], pinnedLedger: heldRows('order-2', ['A02', 'NOPE']) }));
    expect(plan.seats.map((s) => s.seat.seatId)).toEqual(['A02']);
    expect(plan.skipped).toBe(1);
  });

  test('rebuild_④ 판매 주문 목록에 없는 판매(주문 행 없음)는 옛 방식이다: 원장 행이 없으면 holdId = 주문 ID, psid = 빈 글 [ASVS v5.0.0-2.3.4]', () => {
    const plan = planRebuild([sale('A01', ACCOUNT_A, 'order-gone')], [], resolve, [], orders());
    expect(plan.seats).toEqual([{ mode: 'SOLD', seat: ref('A01'), accountId: ACCOUNT_A, holdId: 'order-gone', purchaseSessionId: '' }]);
  });
});

describe('SeatRebuilder 주문 근거 읽기(PRF-167)', () => {
  test('ST26_④_ orders가 있으면 판매 행의 주문 ID들(겹치지 않게)로 saleOrders, 회차로 pinnedOrders, 묶인 주문의 좌석들로 원장 행(ledgerRows)을 읽고 묶인 주문의 좌석을 HELD(만료 = 시계 + 7분, 토큰 = 원장 HELD 행)로 좌석 Redis에 쓴다. 보유 수·펜싱 카운터도 되살린다 [S-T26]', async () => {
    const eventId = 'evt-orders';
    const clock = fakeClock({ now: NOW });
    const seatMap = new MemorySeatMap();
    seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_DEFS.length, perAccountLimit: 4, saleEndsAtMs: NOW + 86_400_000 }, SEAT_DEFS);
    const store = new MemorySeatStore(clock);
    const calls: string[] = [];
    const source: SeatRebuildSource = {
      acquire: async () => 2,
      sales: async () => [sale('A01', ACCOUNT_A, 'order-1'), sale('A02', ACCOUNT_A, 'order-1')],
      holds: async () => [],
      saleHolds: async () => [],
      ledgerRows: async (e, seatIds) => {
        calls.push(`ledgerRows ${e} ${[...seatIds].join(',')}`);
        return [row('A03', 'hold-of-order-2', 777), row('A04', 'hold-of-order-2', 5, 'RELEASED')];
      },
      release: async () => undefined,
    };
    const orderSource: RebuildOrderSource = {
      saleOrders: async (e, ids) => {
        calls.push(`saleOrders ${e} ${[...ids].join(',')}`);
        return [saleOrder('order-1')];
      },
      pinnedOrders: async (e) => {
        calls.push(`pinnedOrders ${e}`);
        return [pinned('order-2', ACCOUNT_B, ['A03', 'A04'])];
      },
    };
    const r = await new SeatRebuilder({ source, target: store, seatMap, holder: 'pod-a', orders: orderSource, clock }).rebuild(eventId, { keepUntilMs: NOW + 86_400_000 });
    expect(r).toEqual({ result: 'REBUILT', gen: 2, sold: 2, held: 1, skipped: 0 });
    expect(calls.sort()).toEqual([`ledgerRows ${eventId} A03,A04`, `pinnedOrders ${eventId}`, `saleOrders ${eventId} order-1`]);
    const ev = store.db.peek(eventId)!;
    // 묶인 주문 계정 보유 수 1(A03만), 판매 계정 2. 펜싱 카운터는 되살린 토큰 이상
    expect(Object.fromEntries(ev.quota)).toEqual({ [ACCOUNT_A]: 2, [ACCOUNT_B]: 1 });
    expect(ev.holds.get(ref('A03').index)).toMatchObject({ holdId: 'hold-of-order-2', owner: ACCOUNT_B, fence: '777', exp: NOW + TTL });
    expect(Number(ev.fence)).toBeGreaterThanOrEqual(777);
  });

  test('ST26_④_ 묶인 주문이 없으면 원장 행(ledgerRows)을 읽지 않는다 [S-T26]', async () => {
    const eventId = 'evt-orders-none';
    const clock = fakeClock({ now: NOW });
    const seatMap = new MemorySeatMap();
    seatMap.put({ eventId, layoutVersion: 'v1', seatCount: SEAT_DEFS.length, perAccountLimit: 4, saleEndsAtMs: NOW + 86_400_000 }, SEAT_DEFS);
    const store = new MemorySeatStore(clock);
    let ledgerCalls = 0;
    const source: SeatRebuildSource = {
      acquire: async () => 2,
      sales: async () => [],
      holds: async () => [],
      saleHolds: async () => [],
      ledgerRows: async () => {
        ledgerCalls += 1;
        return [];
      },
      release: async () => undefined,
    };
    const orderSource: RebuildOrderSource = { saleOrders: async () => [], pinnedOrders: async () => [] };
    const r = await new SeatRebuilder({ source, target: store, seatMap, holder: 'pod-a', orders: orderSource, clock }).rebuild(eventId, { keepUntilMs: NOW + 86_400_000 });
    expect(r).toMatchObject({ result: 'REBUILT', held: 0, sold: 0 });
    expect(ledgerCalls).toBe(0);
  });
});
