// 다시 만들기(RB-06)의 계획 값: planRebuild·quotasOf(BUILD_ORDER PRF-143, docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현' 쓰기,
// 명세 specs/seat.qnt rebuild ①~③: 판매 좌석이 먼저, 판매가 없는 좌석에만 원장 홀드, 보유 수 = 계정마다 판매 좌석 + 되살린 홀드).
// 좌석맵 판은 test/hold-cases.ts의 시험 판(A01 ~ A20 = 색인 0 ~ 19, B01 ~ B10 = 색인 20 ~ 29)이다.
import { describe, expect, test } from 'vitest';
import { planRebuild, quotasOf, type RebuildHold, type RebuildSale, type RebuildSeat, type SeatRef } from '../src/modules/inventory/index.js';
import { ACCOUNT_A, ACCOUNT_B, ACCOUNT_C, ref, SEAT_DEFS } from './hold-cases.js';

const NOW = Date.parse('2026-11-04T03:00:00.000Z');
/** 홀드 수명 7분(HOLD_TTL_MS). 잡은 시각이 빈 원장 행의 잡은 시각을 이것으로 되짚는다 */
const TTL = 420_000;

/** 시험 판의 좌석(판에 없는 좌석·판매 제외석 X01은 undefined) */
const resolve = (seatId: string): SeatRef | undefined => {
  const d = SEAT_DEFS.find((s) => s.seatId === seatId);
  return d && !d.saleExcluded ? ref(seatId) : undefined;
};

const sale = (seatId: string, accountId: string, orderId: string): RebuildSale => ({ seatId, accountId, orderId });
/** 원장 홀드 하나(기본은 FAN, 1분 전에 잡아 6분 뒤 만료) */
function ledger(seatId: string, accountId: string, fencingToken: number, over: Partial<RebuildHold> = {}): RebuildHold {
  const heldAtMs = NOW - 60_000;
  return {
    seatId,
    accountId,
    fencingToken,
    kind: 'FAN',
    heldAtMs,
    expiresAtMs: heldAtMs + TTL,
    holdId: `h-${seatId}-${fencingToken}`,
    purchaseSessionId: `ps-${accountId.slice(-4)}`,
    ...over,
  };
}
/** 원장 홀드가 되살린 HELD 좌석(원장 값 그대로) */
const heldOf = (h: RebuildHold): RebuildSeat => ({
  mode: 'HELD',
  seat: ref(h.seatId),
  accountId: h.accountId,
  holdId: h.holdId!,
  purchaseSessionId: h.purchaseSessionId ?? '',
  fencingToken: h.fencingToken,
  heldAtMs: h.heldAtMs!,
  expiresAtMs: h.expiresAtMs,
  kind: h.kind,
});

/** 16자리 µs 토큰(지금 시각 근처) */
const tok = (n: number) => (NOW - 120_000) * 1000 + n;

describe('planRebuild: 판매 좌석(SOLD)', () => {
  test('rebuild_① 판매 좌석은 SOLD이고 owner = 판매 계정, holdId·purchaseSessionId·토큰·잡은 시각·만료 시각 = 같은 좌석·같은 계정의 원장 홀드 가운데 토큰이 가장 큰 것의 값이다(입력 차례와 관계없이, 남의 계정 홀드는 토큰이 더 커도 보지 않는다) [ASVS v5.0.0-2.3.4]', () => {
    const older = ledger('A01', ACCOUNT_A, tok(5), { holdId: 'h-old', purchaseSessionId: 'ps-old' });
    const newer = ledger('A01', ACCOUNT_A, tok(9), { holdId: 'h-new', purchaseSessionId: 'ps-new' });
    const other = ledger('A01', ACCOUNT_B, tok(12), { holdId: 'h-b', purchaseSessionId: 'ps-b' });
    const want: RebuildSeat[] = [{ mode: 'SOLD', seat: ref('A01'), accountId: ACCOUNT_A, holdId: 'h-new', purchaseSessionId: 'ps-new', fencingToken: tok(9), heldAtMs: newer.heldAtMs!, expiresAtMs: newer.expiresAtMs }];
    for (const holds of [
      [older, newer, other],
      [newer, older, other],
      [other, older, newer],
      [other, newer, older],
    ]) {
      expect(planRebuild([sale('A01', ACCOUNT_A, 'o-1')], holds, resolve), holds.map((h) => h.holdId).join(',')).toEqual({ seats: want, skipped: 0 });
    }
  });

  test('rebuild_① 판매 좌석에 그 계정의 원장 홀드가 없으면 holdId = 주문 ID, purchaseSessionId = 빈 글이고 토큰·시각 칸이 없다(남의 계정 홀드만 있어도 같다) [ASVS v5.0.0-2.3.4]', () => {
    expect(planRebuild([sale('A02', ACCOUNT_A, 'o-2')], [], resolve)).toEqual({
      seats: [{ mode: 'SOLD', seat: ref('A02'), accountId: ACCOUNT_A, holdId: 'o-2', purchaseSessionId: '' }],
      skipped: 0,
    });
    expect(planRebuild([sale('A02', ACCOUNT_A, 'o-2')], [ledger('A02', ACCOUNT_B, tok(1))], resolve)).toEqual({
      seats: [{ mode: 'SOLD', seat: ref('A02'), accountId: ACCOUNT_A, holdId: 'o-2', purchaseSessionId: '' }],
      skipped: 0,
    });
    // 같은 계정의 홀드가 다른 좌석에만 있으면 그 좌석의 holdId를 빌려 오지 않는다
    expect(planRebuild([sale('A02', ACCOUNT_A, 'o-2')], [ledger('A03', ACCOUNT_A, tok(1), { holdId: 'h-a03' })], resolve).seats[0]).toEqual({
      mode: 'SOLD',
      seat: ref('A02'),
      accountId: ACCOUNT_A,
      holdId: 'o-2',
      purchaseSessionId: '',
    });
  });

  test('rebuild_① 판매가 있는 좌석의 원장 홀드는 HELD로 되살리지 않고 넘김(skipped)으로도 세지 않는다(같은 계정의 것이든 남의 것이든) [ASVS v5.0.0-2.3.4]', () => {
    const r = planRebuild([sale('A04', ACCOUNT_A, 'o-4')], [ledger('A04', ACCOUNT_B, tok(30)), ledger('A04', ACCOUNT_A, tok(20), { holdId: 'h-a' })], resolve);
    expect(r).toEqual({ seats: [{ mode: 'SOLD', seat: ref('A04'), accountId: ACCOUNT_A, holdId: 'h-a', purchaseSessionId: 'ps-00a1', fencingToken: tok(20), heldAtMs: NOW - 60_000, expiresAtMs: NOW - 60_000 + TTL }], skipped: 0 });
    expect(r.seats.filter((s) => s.mode === 'HELD')).toEqual([]);
  });
});

describe('planRebuild: 되살린 홀드(HELD)', () => {
  test('rebuild_② 판매가 없는 좌석의 원장 홀드는 HELD이고 계정·holdId·구매 세션·토큰·잡은 시각·만료 시각·종류가 원장 값 그대로다 [ASVS v5.0.0-2.3.4]', () => {
    const h = ledger('B03', ACCOUNT_B, tok(77), { holdId: 'h-b03', purchaseSessionId: 'ps-b03', heldAtMs: NOW - 90_000, expiresAtMs: NOW - 90_000 + TTL });
    expect(planRebuild([], [h], resolve)).toEqual({
      seats: [{ mode: 'HELD', seat: ref('B03'), accountId: ACCOUNT_B, holdId: 'h-b03', purchaseSessionId: 'ps-b03', fencingToken: tok(77), heldAtMs: NOW - 90_000, expiresAtMs: NOW - 90_000 + TTL, kind: 'FAN' }],
      skipped: 0,
    });
  });

  test('rebuild_② 같은 좌석에 원장 홀드가 여럿이면 토큰이 가장 큰 것 하나만 HELD다(입력 차례와 관계없이) [ASVS v5.0.0-2.3.4]', () => {
    const low = ledger('A05', ACCOUNT_A, tok(3));
    const high = ledger('A05', ACCOUNT_B, tok(7));
    for (const holds of [
      [low, high],
      [high, low],
    ]) {
      expect(planRebuild([], holds, resolve)).toEqual({ seats: [heldOf(high)], skipped: 0 });
    }
  });

  test('rebuild_② 우선 구매 보류(PRIORITY)는 종류를 그대로 두고, 구매 세션 ID가 없으면(null) 빈 글로 싣는다 [ASVS v5.0.0-2.3.4]', () => {
    const p = ledger('A06', ACCOUNT_C, tok(4), { kind: 'PRIORITY', purchaseSessionId: null, holdId: 'h-prio' });
    const [s] = planRebuild([], [p], resolve).seats;
    expect(s).toEqual({ ...heldOf(p), purchaseSessionId: '', kind: 'PRIORITY' });
  });

  test('rebuild_② 잡은 시각이 빈 원장 홀드(heldAtMs null)는 heldAtMs = expiresAtMs − 420000(7분)으로 둔다(정본에 없어 이 단계가 정한다: 연장하지 않은 홀드의 잡은 시각) [ASVS v5.0.0-2.3.4]', () => {
    const exp = NOW + 123_456;
    const h = ledger('A07', ACCOUNT_A, tok(8), { heldAtMs: null, expiresAtMs: exp });
    const [s] = planRebuild([], [h], resolve).seats;
    expect(s).toMatchObject({ mode: 'HELD', heldAtMs: exp - 420_000, expiresAtMs: exp });
    // 잡은 시각이 있으면 그 값 그대로다(되짚지 않는다)
    const [t] = planRebuild([], [ledger('A07', ACCOUNT_A, tok(8), { heldAtMs: NOW - 5, expiresAtMs: exp })], resolve).seats;
    expect(t).toMatchObject({ heldAtMs: NOW - 5 });
  });
});

describe('planRebuild: 넘김(skipped)과 차례', () => {
  test('rebuild_ holdId가 빈(null) 원장 홀드는 되살리지 않고 skipped에 하나씩 센다(그 좌석은 빈 좌석이 된다) [ASVS v5.0.0-2.3.4]', () => {
    const r = planRebuild([], [ledger('A08', ACCOUNT_A, tok(1), { holdId: null }), ledger('A09', ACCOUNT_B, tok(2), { holdId: null }), ledger('A10', ACCOUNT_B, tok(3))], resolve);
    expect(r).toEqual({ seats: [heldOf(ledger('A10', ACCOUNT_B, tok(3)))], skipped: 2 });
  });

  test('rebuild_ 좌석맵 판에 없는 좌석은 판매든 원장 홀드든 쓰지 않고 skipped에 하나씩 센다 [ASVS v5.0.0-2.3.4]', () => {
    const r = planRebuild([sale('Z99', ACCOUNT_A, 'o-z'), sale('A11', ACCOUNT_A, 'o-11')], [ledger('Z98', ACCOUNT_B, tok(1))], resolve);
    expect(r).toEqual({ seats: [{ mode: 'SOLD', seat: ref('A11'), accountId: ACCOUNT_A, holdId: 'o-11', purchaseSessionId: '' }], skipped: 2 });
  });

  test('rebuild_ 결과는 좌석 색인 오름차순이다(판매·홀드가 섞이고 입력 차례가 뒤죽박죽이어도). 여러 좌석 홀드의 판매된 좌석은 SOLD, 남은 좌석은 HELD다 [ASVS v5.0.0-2.3.4]', () => {
    const multi = (seatId: string) => ledger(seatId, ACCOUNT_A, tok(50), { holdId: 'h-multi', purchaseSessionId: 'ps-multi' });
    const r = planRebuild(
      [sale('B02', ACCOUNT_B, 'o-b02'), sale('A12', ACCOUNT_A, 'o-a')],
      [ledger('A03', ACCOUNT_C, tok(60)), multi('A13'), multi('A12'), ledger('B01', ACCOUNT_C, tok(61))],
      resolve,
    );
    expect(r.seats.map((s) => [s.seat.index, s.mode])).toEqual([
      [2, 'HELD'],
      [11, 'SOLD'],
      [12, 'HELD'],
      [20, 'HELD'],
      [21, 'SOLD'],
    ]);
    expect(r.seats[1]).toEqual({ mode: 'SOLD', seat: ref('A12'), accountId: ACCOUNT_A, holdId: 'h-multi', purchaseSessionId: 'ps-multi', fencingToken: tok(50), heldAtMs: NOW - 60_000, expiresAtMs: NOW - 60_000 + TTL });
    expect(r.seats[2]).toEqual(heldOf(multi('A13')));
    expect(r.skipped).toBe(0);
  });

  test('rebuild_ 판매도 원장 홀드도 없으면 좌석도 넘김도 없다', () => {
    expect(planRebuild([], [], resolve)).toEqual({ seats: [], skipped: 0 });
  });
});

describe('코드 리뷰 재현(PRF-143)', () => {
  test('코드 리뷰_ 판매 좌석의 holdId·구매 세션·토큰·시각은 넷째 인자(판매 좌석의 HELD 원장 행, 만료 조건 없음)에서 고른다: 묶인 홀드는 사건이 없어 만료 시각이 지나도 HELD로 남는다 [ASVS v5.0.0-2.3.4]', () => {
    // 묶인 지 7분이 넘어 원장 만료 시각이 지났다(holds()에는 빠지고 saleHolds()에만 있다)
    const pinned = ledger('A01', ACCOUNT_A, tok(9), { holdId: 'h-pinned', purchaseSessionId: 'ps-pinned', heldAtMs: NOW - 600_000, expiresAtMs: NOW - 180_000 });
    const older = ledger('A01', ACCOUNT_A, tok(3), { holdId: 'h-older', heldAtMs: NOW - 900_000, expiresAtMs: NOW - 480_000 });
    const r = planRebuild([sale('A01', ACCOUNT_A, 'o-1')], [], resolve, [older, pinned]);
    expect(r).toEqual({
      seats: [{ mode: 'SOLD', seat: ref('A01'), accountId: ACCOUNT_A, holdId: 'h-pinned', purchaseSessionId: 'ps-pinned', fencingToken: tok(9), heldAtMs: NOW - 600_000, expiresAtMs: NOW - 180_000 }],
      skipped: 0,
    });
    // 넷째 인자가 없으면 holds로 대조한다(지금처럼), 잡은 시각이 빈 행은 만료 시각 − 7분
    const live = ledger('A02', ACCOUNT_A, tok(4), { holdId: 'h-live', heldAtMs: null, expiresAtMs: NOW + 100_000 });
    expect(planRebuild([sale('A02', ACCOUNT_A, 'o-2')], [live], resolve).seats[0]).toMatchObject({ holdId: 'h-live', fencingToken: tok(4), heldAtMs: NOW + 100_000 - TTL, expiresAtMs: NOW + 100_000 });
    // 대조할 원장 행이 없거나 holdId가 빈 옛 행이면 토큰·시각 칸이 없다(좌석 쓰기 Lua가 TIME으로 채운다)
    const none = planRebuild([sale('A03', ACCOUNT_A, 'o-3')], [], resolve, [ledger('A03', ACCOUNT_A, tok(5), { holdId: null })]).seats[0]!;
    expect(none).toEqual({ mode: 'SOLD', seat: ref('A03'), accountId: ACCOUNT_A, holdId: 'o-3', purchaseSessionId: '' });
  });

  test('코드 리뷰_ planRebuild는 판매 2만 × 원장 홀드 2만을 1초 [가정] 안에 끝낸다(좌석·계정 키로 먼저 묶어 O(판매 + 홀드))', () => {
    const N = 20_000;
    const seats = new Map<string, SeatRef>();
    const sales: RebuildSale[] = [];
    const holds: RebuildHold[] = [];
    for (let i = 0; i < 2 * N; i++) {
      const id = `S${String(i).padStart(6, '0')}`;
      seats.set(id, { seatId: id, index: i, sectionId: 'A', sectionIndex: 0, seatOffset: i, tierId: 'R' });
      const acc = `0190f3a1-7c2e-7a00-8000-${(i % 10_000).toString(16).padStart(12, '0')}`;
      if (i < N) sales.push({ seatId: id, accountId: acc, orderId: 'o' });
      else holds.push(ledger(id, acc, tok(i)));
    }
    const t0 = performance.now();
    const r = planRebuild(sales, holds, (id) => seats.get(id), holds);
    const ms = performance.now() - t0;
    expect(r.seats).toHaveLength(2 * N);
    expect(ms).toBeLessThan(1_000);
  });
});

describe('quotasOf: 계정마다 보유 수', () => {
  test('rebuild_③ 보유 수는 계정마다 판매 좌석 수 + 되살린 홀드 수이고, 좌석이 없는 계정은 키가 없다 [ASVS v5.0.0-2.3.4]', () => {
    const { seats } = planRebuild(
      [sale('A01', ACCOUNT_A, 'o-1'), sale('A02', ACCOUNT_A, 'o-1'), sale('B01', ACCOUNT_B, 'o-2')],
      [ledger('A03', ACCOUNT_A, tok(1)), ledger('A04', ACCOUNT_B, tok(2)), ledger('A05', ACCOUNT_B, tok(3)), ledger('A01', ACCOUNT_C, tok(4)), ledger('A06', ACCOUNT_C, tok(5), { holdId: null })],
      resolve,
    );
    const q = quotasOf(seats);
    expect(Object.fromEntries([...q].sort(([a], [b]) => (a < b ? -1 : 1)))).toEqual({ [ACCOUNT_A]: 3, [ACCOUNT_B]: 3 });
    // 판매 좌석에 가린 홀드·넘긴 홀드만 있는 계정(C)은 보유 수가 없다
    expect(q.has(ACCOUNT_C)).toBe(false);
  });

  test('rebuild_③ 좌석이 없으면 빈 Map이다', () => {
    expect(quotasOf([]).size).toBe(0);
  });
});
