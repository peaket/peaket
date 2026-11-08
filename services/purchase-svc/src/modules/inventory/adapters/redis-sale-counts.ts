// 판매 상태 셈을 좌석 Redis에서 읽는다(docs/features/seat-hold.md §4 '판정의 첫 구현', BUILD_ORDER PRF-144, Lua 계약은 sale-count-lua.ts).
// read는 읽기 Lua 한 번, holdIndexes는 ZRANGE 한 번이다. 오류 가르기는 redis-seat-store.ts guard를 쓴다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { KEY_PART } from '../domain/hold.js';
import type { SaleCountsRead, SaleCountsReader, SaleHoldPage } from '../domain/ports.js';
import { SALE_TIER_SCAN_PAGE } from '../domain/sale-state.js';
import { SALE_COUNT_LUA } from './sale-count-lua.js';
import { guard, SEAT_REDIS, seatKeys } from './redis-seat-store.js';

const SALE_COUNT = redisScript(SALE_COUNT_LUA);

const text = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

function assertEventId(eventId: string): void {
  if (!KEY_PART.test(eventId)) throw new RangeError('회차 ID가 키 조각 모양이 아니다');
}

/**
 * SaleCountsReader의 좌석 Redis 구현. 모든 호출은 platform HotRedis의 기본 마감(100ms)이고, 일시 장애·메모리 부족은 guard로 SeatStoreUnavailable이 된다.
 * eventId가 KEY_PART 모양이 아니면 RangeError(부르지 않는다)
 */
@Injectable()
export class RedisSaleCounts implements SaleCountsReader {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async read(eventId: string): Promise<SaleCountsRead> {
    assertEventId(eventId);
    const keys = [seatKeys.bitmap(eventId), seatKeys.expiry(eventId), seatKeys.epoch(eventId)];
    // 비트맵 바이트를 글자로 풀면 0x80 같은 바이트가 깨져 응답을 Buffer로 받는다(platform CallOptions.binary)
    const r = await guard(this.redis.evalScript(SALE_COUNT, keys, [], { binary: true }));
    if (!Array.isArray(r) || r.length < 1) throw new Error('판매 상태 셈 Lua가 모르는 값을 돌려줬다');
    const kind = text(r[0]);
    if (kind === 'NOT_READY') return { kind: 'NOT_READY' };
    if (kind !== 'OK' || r.length !== 3) throw new Error('판매 상태 셈 Lua가 모르는 값을 돌려줬다');
    const held = Number(text(r[2]));
    if (!Number.isSafeInteger(held) || held < 0) throw new Error('판매 상태 셈 Lua의 만료 인덱스 수가 0 이상의 정수가 아니다');
    return { kind: 'OK', bitmap: Buffer.isBuffer(r[1]) ? r[1] : Buffer.from(String(r[1]), 'latin1'), held };
  }

  async holdIndexes(eventId: string, start: number, count: number): Promise<SaleHoldPage> {
    assertEventId(eventId);
    if (!Number.isInteger(start) || start < 0) throw new RangeError('시작 순위는 0 이상의 정수다');
    if (!Number.isInteger(count) || count < 1 || count > SALE_TIER_SCAN_PAGE) throw new RangeError(`읽을 수는 1~${SALE_TIER_SCAN_PAGE}의 정수다`);
    const key = seatKeys.expiry(eventId);
    const r = await guard(this.redis.command(['ZRANGE', key, String(start), String(start + count - 1)], { key }));
    if (!Array.isArray(r)) throw new Error('ZRANGE 답이 배열이 아니다');
    const indexes: number[] = [];
    let badMembers = 0;
    for (const member of r) {
      const m = text(member);
      const index = Number(m);
      if (/^(0|[1-9][0-9]*)$/.test(m) && Number.isSafeInteger(index)) indexes.push(index);
      else badMembers += 1;
    }
    return { indexes, badMembers };
  }
}
