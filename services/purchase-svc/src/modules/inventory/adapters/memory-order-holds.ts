// 주문 생성의 홀드 확인 시험 대역(OrderHoldReader, BUILD_ORDER PRF-161). RedisOrderHolds·ORDER_HOLD_LUA(order-hold-lua.ts)와 같은 계약을 따른다:
// 같은 사례에서 같은 결과를 낸다. 시각은 주입 Clock(Redis TIME 대신)이다.
import type { Clock } from '@peaket/platform';
import { MAX_SEATS, type SeatRef } from '../domain/hold.js';
import type { OrderHoldCheck, OrderHoldLimitQuery, OrderHoldQuery, OrderHoldReader, SeatCallOptions, SeatMap } from '../domain/ports.js';
import type { MemoryPurchaseSessionStore } from './memory-purchase-session-store.js';
import type { MemorySeatStore } from './memory-seat-store.js';
import { heldSeatIdsOf, heldSeatOf, orderHoldQueryShaped } from './redis-order-holds.js';
import { seatKeys } from './redis-seat-store.js';

export interface MemoryOrderHoldsDeps {
  /** 홀드 Hash·세대 키(db.peek(eventId)의 holds·epoch) */
  seats: MemorySeatStore;
  /** 구매 세션의 홀드 목록(holdsOf(jti)) */
  sessions: MemoryPurchaseSessionStore;
  seatMap: SeatMap;
  clock: Clock;
  /** 있으면 check가 이 오류를 던지는 대신 STORE_UNAVAILABLE로 답한다(좌석 Redis 장애 흉내) */
  unavailable?: () => boolean;
}

const NOT_FOUND: OrderHoldCheck = { status: 'NOT_FOUND' };
const STORE_UNAVAILABLE: OrderHoldCheck = { status: 'STORE_UNAVAILABLE' };

/** 홀드 Hash의 시각 칸이 0 이상 안전한 정수인가(Lua의 '앞 0 없는 0 이상 10진 정수 글'과 같은 뜻) */
const isMs = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/**
 * 차례는 RedisOrderHolds와 같다: 모양 → sessions.holdsOf(jti)?.get(holdId)(없으면 NOT_FOUND) → seatMap(config 없음 STORE_UNAVAILABLE, 좌석 없음 NOT_FOUND)
 * → 회차 db의 epoch 없음 STORE_UNAVAILABLE → 좌석마다 holds.get(색인)의 holdId·owner·psid가 같고 kind가 FAN이며 exp > clock.now()이고 heldAt이 모두 같으면 OK(heldAt), 아니면 NOT_FOUND.
 * 시각 칸이 망가졌으면 'PEAKET_CORRUPT_KEY {그 hold 키}' Error다(Lua와 같은 차례: 칸 없음·주인 다름 → 형식 → 만료 → heldAt 다름). 아무것도 바꾸지 않는다
 */
export class MemoryOrderHolds implements OrderHoldReader {
  constructor(private readonly deps: MemoryOrderHoldsDeps) {}

  /** 홀드 Hash의 lim(1인 한도). 구매 세션 목록 없이 주문 좌석의 Hash만 읽는다(BAT-051) */
  async limit(q: OrderHoldLimitQuery, _o?: SeatCallOptions): Promise<number | undefined> {
    if (!orderHoldQueryShaped({ eventId: q.eventId, accountId: q.accountId, purchaseSessionId: q.purchaseSessionId, holdId: q.holdId })) return undefined;
    if (!Array.isArray(q.seatIds) || q.seatIds.length < 1 || q.seatIds.length > MAX_SEATS) return undefined;
    const refs = await this.deps.seatMap.resolve(q.eventId, q.seatIds);
    if (refs.some((r) => r === undefined)) return undefined;
    const ev = this.deps.seats.db.peek(q.eventId);
    if (!ev?.epoch) return undefined;
    const now = this.deps.clock.now();
    let limit: number | undefined;
    for (const r of refs as SeatRef[]) {
      const h = ev.holds.get(r.index);
      if (!h || h.holdId !== q.holdId || h.owner !== q.accountId || h.psid !== q.purchaseSessionId || h.kind !== 'FAN') return undefined;
      if (!isMs(h.exp) || h.exp <= now) return undefined;
      if (h.lim !== undefined && (!Number.isSafeInteger(h.lim) || h.lim < 1)) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.hold(q.eventId, r.index)}`);
      if (h.lim !== undefined) {
        if (limit === undefined) limit = h.lim;
        else if (limit !== h.lim) return undefined;
      }
    }
    return limit;
  }

  async check(q: OrderHoldQuery, _o?: SeatCallOptions): Promise<OrderHoldCheck> {
    if (!orderHoldQueryShaped(q)) return NOT_FOUND;
    if (this.deps.unavailable?.()) return STORE_UNAVAILABLE;
    const listed = this.deps.sessions.holdsOf(q.purchaseSessionId)?.get(q.holdId);
    if (listed === undefined) return NOT_FOUND;
    // Redis 칸과 같은 글로 이어 같은 규칙으로 나눈다(망가진 목록은 Error)
    const seatIds = heldSeatIdsOf(listed.join(','));
    if (!(await this.deps.seatMap.config(q.eventId))) return STORE_UNAVAILABLE;
    const refs = await this.deps.seatMap.resolve(q.eventId, seatIds);
    if (refs.some((r) => r === undefined)) return NOT_FOUND;
    const seats = refs as SeatRef[];
    const ev = this.deps.seats.db.peek(q.eventId);
    if (!ev?.epoch) return STORE_UNAVAILABLE;
    const now = this.deps.clock.now();
    let heldAt: number | undefined;
    let limit: number | undefined;
    for (const s of seats) {
      const h = ev.holds.get(s.index);
      if (!h) return NOT_FOUND;
      // 일반 홀드(FAN)만 받는다(우선 구매 PRIORITY 홀드의 주문은 GAT-135). 칸이 없어도 NOT_FOUND
      if (h.holdId !== q.holdId || h.owner !== q.accountId || h.psid !== q.purchaseSessionId || h.kind !== 'FAN') return NOT_FOUND;
      if (!isMs(h.heldAt) || !isMs(h.exp)) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.hold(q.eventId, s.index)}`);
      if (h.exp <= now) return NOT_FOUND;
      if (h.lim !== undefined && (!Number.isSafeInteger(h.lim) || h.lim < 1)) throw new Error(`PEAKET_CORRUPT_KEY ${seatKeys.hold(q.eventId, s.index)}`);
      if (heldAt === undefined) heldAt = h.heldAt;
      else if (heldAt !== h.heldAt) return NOT_FOUND;
      if (h.lim !== undefined) {
        if (limit === undefined) limit = h.lim;
        else if (limit !== h.lim) return NOT_FOUND;
      }
    }
    return { status: 'OK', heldAtMs: heldAt!, seats: seats.map(heldSeatOf), ...(limit !== undefined ? { limit } : {}) };
  }
}
