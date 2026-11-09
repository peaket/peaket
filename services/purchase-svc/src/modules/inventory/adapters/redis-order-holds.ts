// 주문 생성의 홀드 확인 운영 어댑터(OrderHoldReader, docs/features/payment.md §2 '주문 생성의 첫 구현' 홀드 확인, Lua 계약은 order-hold-lua.ts, BUILD_ORDER PRF-161).
// 구매 세션의 홀드 목록(s:session:{jti}의 h:{holdId}, jti 슬롯)을 HGET 한 번으로 읽고, 좌석맵 판으로 색인을 붙인 뒤 회차 슬롯의 읽기 전용 Lua 한 번을 부른다.
// 키에 넣는 값(jti·회차 ID·holdId)은 KEY_PART 모양을 다시 확인한다(해시 태그를 깨는 값이 키로 가지 않게. 모양이 틀리면 저장소를 부르지 않고 NOT_FOUND).
// 주문 만료의 '홀드 남음' 읽기(holdLeft, BUILD_ORDER PRF-172)도 여기 둔다. 회차 ID가 좌석맵 판을 지나야 키가 되므로 모양을 따로 보지 않는다.
import { type HotRedis, redisScript } from '@peaket/platform';
import { KEY_PART, MAX_SEATS, SEAT_ID_PATTERN, SeatStoreUnavailable, type SeatRef } from '../domain/hold.js';
import type { OrderHoldCheck, OrderHoldQuery, OrderHoldReader, SeatCallOptions, SeatMap } from '../domain/ports.js';
import { ORDER_HOLD_EXPIRY_LUA, ORDER_HOLD_LEFT_LUA, ORDER_HOLD_LUA } from './order-hold-lua.js';
import { sessionKeys } from './redis-purchase-sessions.js';
import { guard, seatKeys } from './redis-seat-store.js';

const ORDER_HOLD = redisScript(ORDER_HOLD_LUA);
const ORDER_HOLD_LEFT = redisScript(ORDER_HOLD_LEFT_LUA);
const ORDER_HOLD_EXPIRY = redisScript(ORDER_HOLD_EXPIRY_LUA);

const NOT_FOUND: OrderHoldCheck = { status: 'NOT_FOUND' };
const STORE_UNAVAILABLE: OrderHoldCheck = { status: 'STORE_UNAVAILABLE' };

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const isKeyPart = (v: unknown): v is string => typeof v === 'string' && KEY_PART.test(v);
const deadlineOf = (o: SeatCallOptions | undefined): { deadlineMs?: number } => (o?.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {});

/** 질의 모양이 키에 넣을 수 있는가(회차·구매 세션·holdId는 KEY_PART, 계정은 글) */
export function orderHoldQueryShaped(q: OrderHoldQuery): boolean {
  return isKeyPart(q.eventId) && isKeyPart(q.purchaseSessionId) && isKeyPart(q.holdId) && typeof q.accountId === 'string' && q.accountId.length > 0;
}

/**
 * 구매 세션 상태의 h:{holdId} 칸(좌석 ID 쉼표 목록)을 좌석 ID들로 나눈다. 비었거나, 좌석 ID 모양이 아닌 조각·빈 조각·같은 좌석이 있거나, MAX_SEATS를 넘으면
 * Error(망가진 칸. NOT_FOUND로 숨기지 않는다). 오류 글에 칸 값을 싣지 않는다
 */
export function heldSeatIdsOf(text: string): string[] {
  const ids = text.split(',');
  if (text === '' || ids.length > MAX_SEATS || ids.some((s) => !SEAT_ID_PATTERN.test(s)) || new Set(ids).size !== ids.length) {
    throw new Error('구매 세션 상태의 홀드 목록 칸(h:{holdId})이 망가졌다');
  }
  return ids;
}

/** 좌석맵 판의 좌석 → 홀드 확인 결과의 좌석(좌석 ID·등급·구역) */
export const heldSeatOf = (r: SeatRef): { seatId: string; tierId: string; sectionId: string } => ({ seatId: r.seatId, tierId: r.tierId, sectionId: r.sectionId });

/**
 * OrderHoldReader의 좌석 Redis 구현. 차례(ports.ts OrderHoldReader):
 * ① 모양 확인(eventId·purchaseSessionId·holdId가 KEY_PART가 아니면 NOT_FOUND, 부르지 않는다)
 * ② HGET s:session:{jti} h:{holdId} → 없으면 NOT_FOUND. 좌석 ID 쉼표 목록이 비었거나 좌석 ID 모양이 아니면 Error(망가진 칸)
 * ③ seatMap.config가 없으면 STORE_UNAVAILABLE, seatMap.resolve로 좌석 → 색인·등급·구역(하나라도 없으면 NOT_FOUND)
 * ④ ORDER_HOLD_LUA(KEYS = [epoch, hold:{색인} …], ARGV = [holdId, accountId, purchaseSessionId], o.deadlineMs) → NOT_READY는 STORE_UNAVAILABLE, NOT_FOUND, OK(heldAt)
 * 일시 장애(platform isRedisUnavailable)·메모리 부족(guard가 SeatStoreUnavailable로 바꾼 것)은 STORE_UNAVAILABLE로 답하고, 스크립트 오류·모르는 결과는 그대로 던진다
 */
export class RedisOrderHolds implements OrderHoldReader {
  /** main.ts가 좌석 Redis(SEAT_REDIS와 같은 연결)와 운영 좌석맵 판(LayoutSeatMap)으로 만든다 */
  constructor(
    private readonly redis: HotRedis,
    private readonly seatMap: SeatMap,
  ) {}

  async check(q: OrderHoldQuery, o?: SeatCallOptions): Promise<OrderHoldCheck> {
    if (!orderHoldQueryShaped(q)) return NOT_FOUND;
    try {
      // ② 구매 세션의 홀드 목록(jti 슬롯, 일반 명령)
      const sessionKey = sessionKeys.session(q.purchaseSessionId);
      const listed = await guard(this.redis.command(['HGET', sessionKey, `h:${q.holdId}`], { key: sessionKey, ...deadlineOf(o) }));
      if (listed === null || listed === undefined) return NOT_FOUND;
      const seatIds = heldSeatIdsOf(str(listed));
      // ③ 좌석맵 판
      if (!(await this.seatMap.config(q.eventId))) return STORE_UNAVAILABLE;
      const refs = await this.seatMap.resolve(q.eventId, seatIds);
      if (refs.some((r) => r === undefined)) return NOT_FOUND;
      const seats = refs as SeatRef[];
      // ④ 회차 슬롯의 읽기 전용 Lua 한 번
      const keys = [seatKeys.epoch(q.eventId), ...seats.map((s) => seatKeys.hold(q.eventId, s.index))];
      const r = await guard(this.redis.evalScript(ORDER_HOLD, keys, [q.holdId, q.accountId, q.purchaseSessionId], deadlineOf(o)));
      if (!Array.isArray(r) || r.length < 1) throw new Error(`홀드 확인 Lua가 모르는 값을 돌려줬다: ${str(r)}`);
      const kind = str(r[0]);
      if (kind === 'NOT_READY') return STORE_UNAVAILABLE;
      if (kind === 'NOT_FOUND') return NOT_FOUND;
      if (kind === 'OK' && r.length === 2) {
        const text = str(r[1]);
        const heldAtMs = Number(text);
        if (!/^(0|[1-9][0-9]*)$/.test(text) || !Number.isSafeInteger(heldAtMs)) throw new Error('홀드 확인 Lua가 돌려준 heldAt이 0 이상 정수 글이 아니다');
        return { status: 'OK', heldAtMs, seats: seats.map(heldSeatOf) };
      }
      throw new Error(`홀드 확인 Lua가 모르는 결과를 돌려줬다: ${kind}`);
    } catch (e) {
      // 일시 장애·메모리 부족(guard가 바꾼 것)만 답으로 돌린다. WRONGTYPE·CORRUPT_KEY·망가진 칸은 그대로 던진다
      if (e instanceof SeatStoreUnavailable) return STORE_UNAVAILABLE;
      throw e;
    }
  }

  /**
   * 주문 좌석에 그 holdId의 홀드가 남았나(주문 만료의 조건 ②, Lua 계약은 order-hold-lua.ts ORDER_HOLD_LEFT_LUA, BUILD_ORDER PRF-172).
   * 구매 세션의 홀드 목록을 읽지 않으므로 세션이 끝난 뒤에도 살아 있는 홀드를 본다.
   * 좌석을 모르거나(빈 목록) 좌석맵 판에 없는 좌석이 있으면 true(아직. 어느 키를 읽을지 몰라 풀렸다고 할 수 없다, 안전망이 다시 본다. 좌석 Redis를 부르지 않는다).
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족
   * @throws Error 키 형이 틀림(PEAKET_CORRUPT_KEY)·스크립트가 모르는 값을 돌려줌
   */
  async holdLeft(eventId: string, holdId: string, seatIds: readonly string[]): Promise<boolean> {
    if (seatIds.length === 0) return true;
    const refs = await this.seatMap.resolve(eventId, seatIds);
    if (refs.some((r) => r === undefined)) return true;
    const keys = (refs as SeatRef[]).map((s) => seatKeys.hold(eventId, s.index));
    const left = Number(await guard(this.redis.evalScript(ORDER_HOLD_LEFT, keys, [holdId], {})));
    if (!Number.isSafeInteger(left) || left < 0) throw new Error('홀드 남음 Lua가 0 이상 정수가 아닌 값을 돌려줬다');
    return left > 0;
  }

  /**
   * 주문 좌석 가운데 그 holdId가 남은 좌석의 홀드 exp 중 가장 이른 값(결제 시도 응답의 holdExpiresAt, Lua 계약은 order-hold-lua.ts ORDER_HOLD_EXPIRY_LUA, BUILD_ORDER PRF-191).
   * 좌석을 모르거나 좌석맵 판에 없는 좌석이 있거나 남은 좌석이 없으면 undefined다(칸을 뺀다, 앞의 둘은 좌석 Redis를 부르지 않는다).
   * @throws SeatStoreUnavailable 좌석 Redis 일시 장애·메모리 부족
   * @throws Error 키 형이 틀림(PEAKET_CORRUPT_KEY)·스크립트가 모르는 값을 돌려줌
   */
  async holdExpiry(eventId: string, holdId: string, seatIds: readonly string[], o?: SeatCallOptions): Promise<number | undefined> {
    if (seatIds.length === 0) return undefined;
    const refs = await this.seatMap.resolve(eventId, seatIds);
    if (refs.some((r) => r === undefined)) return undefined;
    const keys = (refs as SeatRef[]).map((s) => seatKeys.hold(eventId, s.index));
    const r = await guard(this.redis.evalScript(ORDER_HOLD_EXPIRY, keys, [holdId], deadlineOf(o)));
    if (r === null || r === undefined) return undefined;
    const expiresAtMs = Number(str(r));
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs < 0) throw new Error('홀드 만료 Lua가 0 이상 정수가 아닌 값을 돌려줬다');
    return expiresAtMs;
  }
}
