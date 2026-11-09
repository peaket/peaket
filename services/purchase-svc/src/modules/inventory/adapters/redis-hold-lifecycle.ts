// 홀드 수명 연산의 좌석 Redis 구현(HoldLifecycle, docs/features/seat-hold.md §5, Lua 계약은 hold-lifecycle-lua.ts, BUILD_ORDER HOT-070).
import { type HotRedis, redisScript } from '@peaket/platform';
import { HOLD_EXTENSION_MS, type HoldExtendResult, type HoldFreezeResult, type HoldLifecycle, type HoldMarkResult, type HoldMemberPage, type HoldReadResult, type HoldReleaseResult, type HoldTarget } from '../domain/hold-lifecycle.js';
import { REHOLD_WAIT_MS } from '../domain/hold.js';
import type { SeatCallOptions } from '../domain/ports.js';
import { HOLD_EXTEND_LUA, HOLD_FREEZE_LUA, HOLD_MARK_ORDERED_LUA, HOLD_READ_LUA, HOLD_RELEASE_LUA, HOLD_THAW_LUA } from './hold-lifecycle-lua.js';
import { guard, seatKeys } from './redis-seat-store.js';

const READ = redisScript(HOLD_READ_LUA);
const RELEASE = redisScript(HOLD_RELEASE_LUA);
const EXTEND = redisScript(HOLD_EXTEND_LUA);
const MARK = redisScript(HOLD_MARK_ORDERED_LUA);
const FREEZE = redisScript(HOLD_FREEZE_LUA);
const THAW = redisScript(HOLD_THAW_LUA);

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const deadlineOf = (o: SeatCallOptions | undefined): { deadlineMs?: number } => (o?.deadlineMs !== undefined ? { deadlineMs: o.deadlineMs } : {});
const MEMBER = /^(0|[1-9][0-9]*)$/;

function num(v: unknown, what: string): number {
  const s = str(v);
  const n = Number(s);
  if (!/^[0-9]+$/.test(s) || !Number.isSafeInteger(n)) throw new Error(`홀드 수명 Lua의 ${what}이(가) 0 이상의 정수가 아니다`);
  return n;
}

/** 키 이름 묶음(docs/data.md §3) */
export const holdLifecycleKeys = { ordered: seatKeys.ordered, paused: seatKeys.paused };

export class RedisHoldLifecycle implements HoldLifecycle {
  constructor(private readonly redis: HotRedis) {}

  async read(t: HoldTarget, o?: SeatCallOptions): Promise<HoldReadResult> {
    const keys = [seatKeys.epoch(t.eventId), ...t.seats.map((s) => seatKeys.hold(t.eventId, s.index))];
    const r = (await guard(this.redis.evalScript(READ, keys, [t.holdId, t.accountId, t.purchaseSessionId], deadlineOf(o)))) as unknown[];
    if (!Array.isArray(r)) throw new Error('홀드 읽기 Lua가 모르는 값을 돌려줬다');
    const kind = str(r[0]);
    if (kind === 'NOT_READY' || kind === 'NOT_FOUND') return { kind };
    if (kind !== 'OK') throw new Error('홀드 읽기 Lua가 모르는 결과를 돌려줬다');
    return { kind: 'OK', expiresAtMs: num(r[1], '만료 시각'), extended: str(r[2]) === '1', fencingToken: num(r[3], '토큰') };
  }

  async release(t: HoldTarget, keepUntilMs: number, o?: SeatCallOptions): Promise<HoldReleaseResult> {
    const e = t.eventId;
    const a = t.accountId;
    const keys = [
      seatKeys.bitmap(e),
      seatKeys.expiry(e),
      seatKeys.quota(e, a),
      seatKeys.stream(e),
      seatKeys.epoch(e),
      seatKeys.secver(e),
      seatKeys.rel(e, a),
      holdLifecycleKeys.ordered(e),
      holdLifecycleKeys.paused(e),
      ...t.seats.map((s) => seatKeys.hold(e, s.index)),
    ];
    const args = [a, t.holdId, t.purchaseSessionId, String(REHOLD_WAIT_MS), String(keepUntilMs), seatKeys.section(e, ''), ...t.seats.flatMap((s) => [String(s.index), String(s.sectionIndex), String(s.seatOffset), s.seatId, s.tierId, s.sectionId])];
    const r = (await guard(this.redis.evalScript(RELEASE, keys, args, deadlineOf(o)))) as unknown[];
    if (!Array.isArray(r)) throw new Error('홀드 해제 Lua가 모르는 값을 돌려줬다');
    const kind = str(r[0]);
    if (kind === 'NOT_READY' || kind === 'NOT_FOUND' || kind === 'PINNED') return { kind };
    if (kind !== 'OK') throw new Error('홀드 해제 Lua가 모르는 결과를 돌려줬다');
    const released = num(r[1], '푼 수');
    if (released > t.seats.length) throw new Error('홀드 해제 Lua의 푼 수가 넘긴 좌석 수보다 크다');
    return { kind: 'OK', released };
  }

  async extend(t: HoldTarget, o?: SeatCallOptions): Promise<HoldExtendResult> {
    const keys = [seatKeys.expiry(t.eventId), seatKeys.epoch(t.eventId), ...t.seats.map((s) => seatKeys.hold(t.eventId, s.index))];
    const r = (await guard(this.redis.evalScript(EXTEND, keys, [t.accountId, t.holdId, t.purchaseSessionId, String(HOLD_EXTENSION_MS)], deadlineOf(o)))) as unknown[];
    if (!Array.isArray(r)) throw new Error('홀드 연장 Lua가 모르는 값을 돌려줬다');
    const kind = str(r[0]);
    if (kind === 'NOT_READY' || kind === 'NOT_FOUND' || kind === 'PINNED' || kind === 'ALREADY') return { kind };
    if (kind !== 'OK') throw new Error('홀드 연장 Lua가 모르는 결과를 돌려줬다');
    return { kind: 'OK', expiresAtMs: num(r[1], '새 만료 시각'), fencingToken: num(r[2], '토큰') };
  }

  async markOrdered(t: HoldTarget, maxStayMs: number, keepUntilMs: number, o?: SeatCallOptions): Promise<HoldMarkResult> {
    const keys = [holdLifecycleKeys.ordered(t.eventId), seatKeys.epoch(t.eventId), ...t.seats.map((s) => seatKeys.hold(t.eventId, s.index))];
    const r = (await guard(this.redis.evalScript(MARK, keys, [t.accountId, t.holdId, t.purchaseSessionId, String(maxStayMs), String(keepUntilMs), ...t.seats.map((s) => String(s.index))], deadlineOf(o)))) as unknown[];
    if (!Array.isArray(r)) throw new Error('주문 표시 Lua가 모르는 값을 돌려줬다');
    const kind = str(r[0]);
    if (kind === 'NOT_READY' || kind === 'NOT_FOUND') return { kind };
    if (kind !== 'OK') throw new Error('주문 표시 Lua가 모르는 결과를 돌려줬다');
    return { kind: 'OK', added: num(r[1], '넣은 수') };
  }

  /** 정수가 아닌 멤버는 키를 만들 수 없어 그 자리에서 지우고 수만 돌려준다(앞줄을 막지 않게) */
  async #page(key: string, range: readonly string[]): Promise<HoldMemberPage> {
    const r = await guard(this.redis.command(['ZRANGE', key, ...range], { key }));
    if (!Array.isArray(r)) throw new Error('ZRANGE 답이 배열이 아니다');
    const indexes: number[] = [];
    const bad: string[] = [];
    for (const v of r) {
      const m = str(v);
      const n = Number(m);
      if (MEMBER.test(m) && Number.isSafeInteger(n)) indexes.push(n);
      else bad.push(m);
    }
    if (bad.length > 0) await guard(this.redis.command(['ZREM', key, ...bad], { key }));
    return { indexes, malformed: bad.length };
  }

  orderedPage(eventId: string, limit: number): Promise<HoldMemberPage> {
    return this.#page(holdLifecycleKeys.ordered(eventId), ['0', String(limit - 1)]);
  }

  frozenPage(eventId: string, limit: number, dueBeforeMs?: number): Promise<HoldMemberPage> {
    const key = holdLifecycleKeys.paused(eventId);
    return dueBeforeMs === undefined ? this.#page(key, ['0', String(limit - 1)]) : this.#page(key, ['-inf', String(dueBeforeMs), 'BYSCORE', 'LIMIT', '0', String(limit)]);
  }

  async frozenCount(eventId: string): Promise<number> {
    const key = holdLifecycleKeys.paused(eventId);
    return num(await guard(this.redis.command(['ZCARD', key], { key })), '멈춘 홀드 수');
  }

  async #batch(script: typeof FREEZE, keys: string[], args: string[], what: string): Promise<HoldFreezeResult> {
    const r = (await guard(this.redis.evalScript(script, keys, args))) as unknown[];
    if (!Array.isArray(r)) throw new Error(`${what} Lua가 모르는 값을 돌려줬다`);
    const kind = str(r[0]);
    if (kind === 'NOT_READY') return { kind };
    if (kind !== 'OK') throw new Error(`${what} Lua가 모르는 결과를 돌려줬다`);
    return { kind: 'OK', moved: num(r[1], '옮긴 수'), dropped: num(r[2], '뺀 수'), corrupt: num(r[3], '망가진 수') };
  }

  freeze(eventId: string, pausedSinceMs: number, keepUntilMs: number, indexes: readonly number[]): Promise<HoldFreezeResult> {
    const e = eventId;
    return this.#batch(FREEZE, [holdLifecycleKeys.ordered(e), seatKeys.expiry(e), holdLifecycleKeys.paused(e), seatKeys.epoch(e), ...indexes.map((i) => seatKeys.hold(e, i))], [String(pausedSinceMs), String(keepUntilMs), ...indexes.map(String)], '옮기기');
  }

  thaw(eventId: string, keepUntilMs: number, indexes: readonly number[]): Promise<HoldFreezeResult> {
    const e = eventId;
    return this.#batch(THAW, [holdLifecycleKeys.paused(e), seatKeys.expiry(e), holdLifecycleKeys.ordered(e), seatKeys.epoch(e), ...indexes.map((i) => seatKeys.hold(e, i))], [String(keepUntilMs), ...indexes.map(String)], '되돌리기');
  }
}
