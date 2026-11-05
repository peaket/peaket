// 좌석 Redis 다시 만들기(RB-06)의 값과 형(BUILD_ORDER PRF-143, docs/features/seat-hold.md §6 '다시 만들기(RB-06)의 첫 구현', 명세 specs/seat.qnt rebuild, ADR-0121).
import { HOLD_TTL_MS, KEY_PART, type SeatRef } from './hold.js';

/** 다시 만들기 임대 60초 [가정]. 이 안에 끝나야 다른 파드가 이어 받지 않는다 */
export const REBUILD_LEASE_MS = 60_000;
/** 좌석 Lua 한 번에 쓰는 좌석 수 200 [가정] */
export const REBUILD_BATCH = 200;

/** 회차의 활성 판매 행 하나(seat_sale PENDING·SOLD) */
export interface RebuildSale {
  seatId: string;
  accountId: string;
  orderId: string;
}

/**
 * 회차의 원장 홀드 하나(seat_hold HELD). holds()는 만료 전(expires_at > now())만, saleHolds()는 활성 판매가 있는 좌석·그 판매 계정의 행(만료 조건 없음)이다.
 * holdId가 없으면 되살리지 않는다
 */
export interface RebuildHold {
  seatId: string;
  accountId: string;
  fencingToken: number;
  kind: 'FAN' | 'PRIORITY';
  heldAtMs: number | null;
  expiresAtMs: number;
  holdId: string | null;
  purchaseSessionId: string | null;
}

/**
 * 판매 주문의 holdId·구매 세션 ID(K3, BUILD_ORDER PRF-167). 활성 판매 행의 주문 ID로 주문 행(purchase_order.hold_id·purchase_session_id)에서 받는다.
 * 원장 행이 없는 판매 좌석도 이 값으로 되살린다(전에는 holdId = 주문 ID, psid = 빈 글이라 실패 해제가 그 좌석을 풀지 못했다)
 */
export interface RebuildSaleOrder {
  orderId: string;
  holdId: string;
  purchaseSessionId: string;
}

/**
 * 결제를 접수했고(ACCEPTED) 묶인(purchase_order.pinned_at이 있음) 주문 하나(K1, BUILD_ORDER PRF-167). 좌석은 주문 항목의 좌석 ID 전부(줄 번호 차례)다.
 * 다시 만들기는 그 가운데 원장에 그 주문 holdId의 HELD 행이 있는 좌석(적재된 홀드, RebuildOrderInputs.pinnedLedger로 본다)만, 원장 만료 시각과 상관없이
 * 이 holdId·psid의 살아 있는 홀드(묶음 아님, 만료 = 지금 + 7분)로 되살린다(명세 rebuild)
 */
export interface RebuildPinnedOrder {
  orderId: string;
  accountId: string;
  holdId: string;
  purchaseSessionId: string;
  seatIds: string[];
}

/**
 * 묶인 주문 좌석의 원장 행 하나(seat_hold, 상태 상관없이, 리뷰 고침 M2). 묶인 주문 좌석을 되살릴지와 그 펜싱 토큰을 정한다
 * (SeatRebuildSource.ledgerRows: 그 회차·그 좌석들의 행)
 */
export interface RebuildLedgerRow {
  seatId: string;
  holdId: string | null;
  status: 'HELD' | 'RELEASED' | 'EXPIRED';
  fencingToken: number;
}

/** planRebuild의 주문 근거(docs/features/seat-hold.md §6 '주문 기준 되살리기'). nowMs는 묶인 주문 홀드의 잡은 시각(만료 = nowMs + HOLD_TTL_MS)이다 */
export interface RebuildOrderInputs {
  /** 활성 판매 행의 주문들(판매 좌석의 holdId·psid). 없는 주문은 옛 방식(원장 행, 없으면 holdId = 주문 ID)으로 둔다 */
  saleOrders: readonly RebuildSaleOrder[];
  /** 결제 접수했고 묶인 주문들 */
  pinned: readonly RebuildPinnedOrder[];
  /** 묶인 주문 좌석들의 원장 행(상태·holdId 상관없이 그 좌석들의 모든 행) */
  pinnedLedger: readonly RebuildLedgerRow[];
  /** 지금(유닉스 밀리초) */
  nowMs: number;
}

/**
 * 좌석 Redis에 쓸 좌석 하나. SOLD는 판매(묶음), HELD는 되살린 홀드.
 * SOLD의 fencingToken·heldAtMs·expiresAtMs는 대조한 원장 행의 값이고 셋이 함께 있거나 함께 없다(없으면 좌석 쓰기 Lua가 TIME으로 채운다, 코드 리뷰 PRF-143)
 */
export type RebuildSeat =
  | { mode: 'SOLD'; seat: SeatRef; accountId: string; holdId: string; purchaseSessionId: string; fencingToken?: number; heldAtMs?: number; expiresAtMs?: number }
  | { mode: 'HELD'; seat: SeatRef; accountId: string; holdId: string; purchaseSessionId: string; fencingToken: number; heldAtMs: number; expiresAtMs: number; kind: 'FAN' | 'PRIORITY' };

/** 다시 만들기 한 회차의 결과 */
export type RebuildReport =
  | { result: 'REBUILT'; gen: number; sold: number; held: number; skipped: number }
  | { result: 'READY' }
  | { result: 'BUSY' };

/**
 * 다시 만들기 Lua 한 번(begin·writeSeats·finish)의 결과: OK, READY(세대 키가 이미 있음. gen = 세대 키의 gen 칸, 없으면 1),
 * STALE(rebuild 키의 판 번호가 내 gen이 아님 = 더 새 시도가 시작했거나 시작 표시가 사라졌다. 아무것도 쓰지 않았다)
 */
export type RebuildStep = { result: 'OK' } | { result: 'READY'; gen: number } | { result: 'STALE' };

/**
 * 묶인 주문 좌석의 되살릴 펜싱 토큰(리뷰 고침 M2·L4): 그 좌석 원장 행 가운데 그 holdId의 HELD 행의 가장 큰 토큰. 그런 행이 없거나, 그 토큰보다 큰 다른 holdId의 행
 * (상태 상관없이, holdId가 빈 옛 행 포함)이 있으면 undefined(되살리지 않는다: 더 새 홀드가 그 좌석을 잡았다)
 */
function pinnedTokenOf(rows: readonly RebuildLedgerRow[], holdId: string): number | undefined {
  let mine: number | undefined;
  for (const r of rows) if (r.holdId === holdId && r.status === 'HELD' && (mine === undefined || r.fencingToken > mine)) mine = r.fencingToken;
  if (mine === undefined) return undefined;
  const top = mine;
  return rows.some((r) => r.holdId !== holdId && r.fencingToken > top) ? undefined : mine;
}

/** 토큰이 더 큰 원장 홀드(같으면 먼저 온 것) */
const newer = (a: RebuildHold | undefined, b: RebuildHold): RebuildHold => (a === undefined || b.fencingToken > a.fencingToken ? b : a);

/** 잡은 시각이 빈 원장 홀드는 만료 시각 − 7분(연장하지 않은 홀드의 잡은 시각) */
const heldAtOf = (h: RebuildHold): number => h.heldAtMs ?? h.expiresAtMs - HOLD_TTL_MS;

/**
 * 판매·원장 홀드를 좌석 Redis에 쓸 좌석으로 맞춘다(명세 rebuild): 판매 좌석이 먼저(판매 좌석의 holdId는 그 좌석·계정의 가장 최근(토큰이 큰) 원장 홀드의 holdId, 없으면 주문 ID),
 * 판매가 없는 좌석에만 원장 홀드(같은 좌석에 여럿이면 토큰이 가장 큰 것), holdId가 없는 원장 홀드와 좌석맵 판에 없는 좌석은 넘긴다(skipped).
 * 결과는 좌석 색인 오름차순이다. resolve는 좌석 ID → 좌석맵 판의 SeatRef(없으면 undefined).
 * saleHolds는 판매 좌석 대조에 쓰는 원장 행(SeatRebuildSource.saleHolds, 만료 조건 없음)이고 없으면 holds다
 *
 * 구현에서 정한 세부(PRF-143, 코드 리뷰로 고침):
 * - 판매 좌석의 holdId·purchaseSessionId·토큰·잡은 시각·만료 시각: saleHolds에서 같은 좌석 ID·같은 계정의 행 가운데 토큰이 가장 큰 것 하나를 고른다
 *   (만료 시각이 지났어도. 묶인 홀드는 사건을 내지 않아 원장 행이 HELD인 채 처음 만료 시각이 지난다). 그 행의 holdId가 null이면(옛 행) 원장 행이 없는 것과 같다
 *   (holdId = 주문 ID, purchaseSessionId = '', 토큰·시각 칸 없음). 구매 세션 ID가 null이면 ''다. 잡은 시각이 비면 만료 시각 − 7분이다.
 * - 같은 좌석(색인)에 판매가 둘 이상이면 처음 것만 쓴다(DB의 활성 판매 부분 유일 인덱스가 막으므로 생기지 않는다).
 * - 판매가 없는 좌석의 원장 홀드는 그 좌석에서 토큰이 가장 큰 것 하나만 본다(낮은 토큰은 이미 끝난 홀드라 세지 않는다). 그것의 holdId가 null이면 넘김 하나다.
 * - skipped = 좌석맵 판에 없는 판매 + 좌석맵 판에 없는 원장 홀드 + holdId가 null이라 되살리지 않은 좌석. 판매에 덮인 원장 홀드는 세지 않는다.
 * - 잡은 시각이 빈 원장 홀드(heldAtMs null)는 expiresAtMs − HOLD_TTL_MS(7분)로 둔다(연장하지 않은 홀드의 잡은 시각).
 * - 원장 행은 먼저 '좌석 ID|계정'·좌석 색인 키로 묶는다(O(판매 + 홀드)).
 *
 * 주문 근거(orders, BUILD_ORDER PRF-167 '주문 기준 되살리기', K1·K3)가 있으면:
 * - 우선순위는 판매 > 묶인 주문 > 원장 홀드다(같은 좌석에 여러 근거가 있으면 앞의 것만 쓴다). 보유 수(quotasOf)는 세 근거를 합쳐 계정마다 센다.
 * - 판매 좌석의 holdId·psid는 그 판매 주문(orders.saleOrders의 같은 주문 ID)의 것이다(원장 행이 없어도). 토큰·시각 칸은 원장 행이 있을 때만 싣는다.
 * - 묶인 주문(orders.pinned)의 좌석은 판매가 없고, 원장(orders.pinnedLedger)에 그 좌석·그 주문 holdId의 HELD 행이 있고, 그 좌석에 그 HELD 행보다
 *   토큰이 높은 다른 holdId의 행(상태 상관없이, holdId가 빈 옛 행 포함)이 없을 때만 HELD(묶음 아님, kind FAN)로 되살린다(리뷰 고침 M2·L3):
 *   holdId·psid = 그 주문의 것, 펜싱 토큰 = 그 HELD 행의 토큰(여럿이면 가장 큰 것, 리뷰 고침 L4), 잡은 시각 = nowMs, 만료 = nowMs + HOLD_TTL_MS(7분).
 *   원장 만료 시각과 상관없다. 조건에 맞지 않는 좌석은 그냥 되살리지 않는다(넘김으로 세지 않는다).
 *
 * 주문 근거에서 구현이 정한 세부(PRF-167, 정본에 없다):
 * - 판매 주문 목록에 없는 판매(주문 행 없음)는 옛 방식이다(원장 행, 없으면 holdId = 주문 ID·psid = '').
 * - 판매 좌석의 토큰·시각 칸은 옛 방식과 같은 원장 행(같은 좌석·계정의 토큰이 가장 큰 행, holdId가 null이면 없는 것)에서 온다.
 * - 같은 좌석이 두 묶인 주문에 있으면 위 토큰 조건이 높은 쪽만 남긴다(둘 다 남으면 앞 주문의 것). 좌석맵 판에 없는 묶인 주문 좌석은 조건에 맞을 때 넘김 하나다.
 * orders가 없으면 지금 방식 그대로다(원장만).
 */
export function planRebuild(
  sales: readonly RebuildSale[],
  holds: readonly RebuildHold[],
  resolve: (seatId: string) => SeatRef | undefined,
  saleHolds: readonly RebuildHold[] = holds,
  orders?: RebuildOrderInputs,
): { seats: RebuildSeat[]; skipped: number } {
  let skipped = 0;
  const mineBy = new Map<string, RebuildHold>();
  for (const h of saleHolds) {
    const k = `${h.seatId}|${h.accountId}`;
    mineBy.set(k, newer(mineBy.get(k), h));
  }
  const saleOrderBy = new Map<string, RebuildSaleOrder>();
  for (const o of orders?.saleOrders ?? []) if (!saleOrderBy.has(o.orderId)) saleOrderBy.set(o.orderId, o);
  const sold = new Map<number, RebuildSeat>();
  for (const s of sales) {
    const seat = resolve(s.seatId);
    if (seat === undefined) {
      skipped += 1;
      continue;
    }
    if (sold.has(seat.index)) continue;
    const mine = mineBy.get(`${s.seatId}|${s.accountId}`);
    const ledger = mine !== undefined && mine.holdId !== null ? mine : undefined;
    const order = saleOrderBy.get(s.orderId);
    if (order !== undefined) {
      // K3: holdId·psid는 판매 주문의 것, 토큰·시각 칸은 원장 행이 있을 때만
      sold.set(seat.index, {
        mode: 'SOLD',
        seat,
        accountId: s.accountId,
        holdId: order.holdId,
        purchaseSessionId: order.purchaseSessionId,
        ...(ledger !== undefined ? { fencingToken: ledger.fencingToken, heldAtMs: heldAtOf(ledger), expiresAtMs: ledger.expiresAtMs } : {}),
      });
    } else if (ledger !== undefined && ledger.holdId !== null) {
      sold.set(seat.index, {
        mode: 'SOLD',
        seat,
        accountId: s.accountId,
        holdId: ledger.holdId,
        purchaseSessionId: ledger.purchaseSessionId ?? '',
        fencingToken: ledger.fencingToken,
        heldAtMs: heldAtOf(ledger),
        expiresAtMs: ledger.expiresAtMs,
      });
    } else {
      sold.set(seat.index, { mode: 'SOLD', seat, accountId: s.accountId, holdId: s.orderId, purchaseSessionId: '' });
    }
  }

  // K1: 판매가 없는 좌석의 묶인 주문(원장에 그 holdId의 HELD 행이 있고 더 새 다른 홀드의 행이 없을 때, 살아 있는 홀드, 만료 = 지금 + 7분)
  const pinnedSeats = new Map<number, RebuildSeat>();
  if (orders !== undefined && orders.pinned.length > 0) {
    const rowsBy = new Map<string, RebuildLedgerRow[]>();
    for (const r of orders.pinnedLedger) {
      const list = rowsBy.get(r.seatId);
      if (list === undefined) rowsBy.set(r.seatId, [r]);
      else list.push(r);
    }
    for (const o of orders.pinned) {
      for (const seatId of o.seatIds) {
        const token = pinnedTokenOf(rowsBy.get(seatId) ?? [], o.holdId);
        if (token === undefined) continue;
        const seat = resolve(seatId);
        if (seat === undefined) {
          skipped += 1;
          continue;
        }
        if (sold.has(seat.index) || pinnedSeats.has(seat.index)) continue;
        pinnedSeats.set(seat.index, {
          mode: 'HELD',
          seat,
          accountId: o.accountId,
          holdId: o.holdId,
          purchaseSessionId: o.purchaseSessionId,
          fencingToken: token,
          heldAtMs: orders.nowMs,
          expiresAtMs: orders.nowMs + HOLD_TTL_MS,
          kind: 'FAN',
        });
      }
    }
  }

  // 판매·묶인 주문이 없는 좌석마다 토큰이 가장 큰 원장 홀드
  const latest = new Map<number, { seat: SeatRef; hold: RebuildHold }>();
  for (const h of holds) {
    const seat = resolve(h.seatId);
    if (seat === undefined) {
      skipped += 1;
      continue;
    }
    if (sold.has(seat.index) || pinnedSeats.has(seat.index)) continue;
    const cur = latest.get(seat.index);
    if (cur === undefined || h.fencingToken > cur.hold.fencingToken) latest.set(seat.index, { seat, hold: h });
  }
  const held: RebuildSeat[] = [];
  for (const { seat, hold: h } of latest.values()) {
    if (h.holdId === null) {
      skipped += 1;
      continue;
    }
    held.push({
      mode: 'HELD',
      seat,
      accountId: h.accountId,
      holdId: h.holdId,
      purchaseSessionId: h.purchaseSessionId ?? '',
      fencingToken: h.fencingToken,
      heldAtMs: heldAtOf(h),
      expiresAtMs: h.expiresAtMs,
      kind: h.kind,
    });
  }
  const seats = [...sold.values(), ...pinnedSeats.values(), ...held].sort((a, b) => a.seat.index - b.seat.index);
  return { seats, skipped };
}

/** 좌석들이 싣는 원장 토큰의 최댓값(없으면 0). 끝내기가 펜싱 카운터를 이 값 이상으로 되살린다 */
export function maxTokenOf(seats: readonly RebuildSeat[]): number {
  let m = 0;
  for (const s of seats) if (s.fencingToken !== undefined && s.fencingToken > m) m = s.fencingToken;
  return m;
}

/** 계정마다 보유 수(판매 좌석 + 되살린 홀드). 키는 계정 ID */
export function quotasOf(seats: readonly RebuildSeat[]): Map<string, number> {
  const q = new Map<string, number>();
  for (const s of seats) q.set(s.accountId, (q.get(s.accountId) ?? 0) + 1);
  return q;
}

const isNonNegativeInt = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** 판 번호의 모양: 1 이상의 정수(15자리 이하, 묶기 Lua가 받는 값) */
function assertGen(gen: number): void {
  if (!Number.isSafeInteger(gen) || gen < 1 || gen >= 1e15) throw new RangeError(`판 번호가 1 이상의 정수가 아니다: ${gen}`);
}

/**
 * 다시 만들기 시작(SeatRebuildTarget.begin) 입력의 모양: eventId는 KEY_PART, gen은 assertGen, keepUntilMs는 양의 안전한 정수
 * @throws RangeError 위 모양이 아님
 */
export function assertRebuildBegin(eventId: string, gen: number, keepUntilMs: number): void {
  if (!KEY_PART.test(eventId)) throw new RangeError('회차 ID가 키 조각 모양이 아니다');
  assertGen(gen);
  if (!Number.isSafeInteger(keepUntilMs) || keepUntilMs < 1) throw new RangeError(`keepUntilMs가 양의 정수가 아니다: ${keepUntilMs}`);
}

/**
 * 좌석 쓰기(SeatRebuildTarget.writeSeats) 입력의 모양(Redis·메모리 구현이 같이 쓴다, 저장소를 부르기 전).
 * eventId·계정은 KEY_PART, 좌석은 1 ~ REBUILD_BATCH개이고 색인이 겹치지 않는 0 이상의 정수, holdId는 빈 글이 아님,
 * HELD는 토큰이 1 이상의 안전한 정수이고 잡은 시각·만료 시각이 0 이상의 안전한 정수, SOLD의 토큰·시각 칸은 셋이 함께 없거나 HELD와 같은 모양,
 * keepUntilMs는 양의 안전한 정수, gen은 assertGen
 * @throws RangeError 위 모양이 아님
 */
export function assertRebuildSeats(eventId: string, seats: readonly RebuildSeat[], keepUntilMs: number, gen: number): void {
  if (!KEY_PART.test(eventId)) throw new RangeError('회차 ID가 키 조각 모양이 아니다');
  if (!Number.isSafeInteger(keepUntilMs) || keepUntilMs < 1) throw new RangeError(`keepUntilMs가 양의 정수가 아니다: ${keepUntilMs}`);
  assertGen(gen);
  if (seats.length < 1 || seats.length > REBUILD_BATCH) throw new RangeError(`좌석 수는 1 ~ ${REBUILD_BATCH}다: ${seats.length}`);
  const seen = new Set<number>();
  for (const s of seats) {
    if (!isNonNegativeInt(s.seat.index) || seen.has(s.seat.index)) throw new RangeError(`좌석 색인이 0 이상의 정수가 아니거나 겹친다: ${s.seat.index}`);
    seen.add(s.seat.index);
    if (!KEY_PART.test(s.accountId)) throw new RangeError('계정 ID가 키 조각 모양이 아니다');
    if (typeof s.holdId !== 'string' || s.holdId.length === 0) throw new RangeError('holdId가 비었다');
    if (typeof s.purchaseSessionId !== 'string') throw new RangeError('구매 세션 ID가 글이 아니다');
    if (s.mode !== 'HELD' && s.mode !== 'SOLD') throw new RangeError(`좌석 방식이 SOLD·HELD가 아니다: ${String((s as { mode: unknown }).mode)}`);
    const timed = s.mode === 'HELD' || s.fencingToken !== undefined || s.heldAtMs !== undefined || s.expiresAtMs !== undefined;
    if (timed) {
      if (!Number.isSafeInteger(s.fencingToken) || (s.fencingToken as number) < 1) throw new RangeError(`펜싱 토큰이 1 이상의 안전한 정수가 아니다: ${s.fencingToken}`);
      if (!isNonNegativeInt(s.heldAtMs) || !isNonNegativeInt(s.expiresAtMs)) throw new RangeError('잡은 시각·만료 시각이 0 이상의 정수가 아니다');
    }
    if (s.mode === 'HELD' && s.kind !== 'FAN' && s.kind !== 'PRIORITY') throw new RangeError(`홀드 종류가 FAN·PRIORITY가 아니다: ${String(s.kind)}`);
  }
}

/**
 * 끝내기(SeatRebuildTarget.finish) 입력. maxToken은 되살린 원장 토큰의 최댓값(없으면 0으로 본다).
 * 세대 키의 node는 넘기지 않는다: 끝내기 Lua가 그 노드의 표지(판매 열기와 같은 nodeId())를 구해 쓴다(BUILD_ORDER PRF-168, 전에는 다시 만든 파드 이름이었다)
 */
export interface RebuildFinishInput {
  quotas: ReadonlyMap<string, number>;
  gen: number;
  keepUntilMs: number;
  maxToken?: number;
}

/**
 * 끝내기(SeatRebuildTarget.finish) 입력의 모양: eventId·계정은 KEY_PART, 보유 수는 1 이상의 안전한 정수, gen은 assertGen,
 * keepUntilMs는 양의 안전한 정수, maxToken은 있으면 0 이상의 안전한 정수
 * @throws RangeError 위 모양이 아님
 */
export function assertRebuildFinish(eventId: string, input: RebuildFinishInput): void {
  if (!KEY_PART.test(eventId)) throw new RangeError('회차 ID가 키 조각 모양이 아니다');
  assertGen(input.gen);
  if (input.maxToken !== undefined && !isNonNegativeInt(input.maxToken)) throw new RangeError(`maxToken이 0 이상의 안전한 정수가 아니다: ${input.maxToken}`);
  if (!Number.isSafeInteger(input.keepUntilMs) || input.keepUntilMs < 1) throw new RangeError(`keepUntilMs가 양의 정수가 아니다: ${input.keepUntilMs}`);
  for (const [a, n] of input.quotas) {
    if (!KEY_PART.test(a)) throw new RangeError('계정 ID가 키 조각 모양이 아니다');
    if (!Number.isSafeInteger(n) || n < 1) throw new RangeError(`보유 수가 1 이상의 정수가 아니다: ${n}`);
  }
}
