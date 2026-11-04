// 회차별 만료 임대를 좌석 Redis로 한다(BUILD_ORDER PRF-135, docs/data.md §3 s:{event:E}:sweep, docs/features/seat-hold.md §5 '1초 반복과 회차별 임대').
// 한 번에 끝나는 작은 Lua 하나로 잡는다(추천 적용 2026-11-04 L2, 계약은 expire-lua.ts SWEEP_LEASE_LUA): 내 임대를 읽은 뒤 키가 사라지고 다른 파드가 잡아도
// 남의 임대를 늘리지 않는다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { assertSweepLeaseArgs } from '../domain/expiry.js';
import type { SweepLane, SweepLeases } from '../domain/ports.js';
import { SWEEP_LEASE_LUA } from './expire-lua.js';
import { guard, SEAT_REDIS, seatKeys } from './redis-seat-store.js';

const SWEEP_LEASE = redisScript(SWEEP_LEASE_LUA);
const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/**
 * SweepLeases의 좌석 Redis 구현. acquire는 임대 Lua 한 번(KEYS = [seatKeys.sweep(eventId)], ARGV = [owner, String(ttlMs)], 기본 마감 100ms)이고
 * 답 1('1')이면 true, 0('0')이면 false다(그 밖의 답은 Error). 일반 명령(SET·GET·PEXPIRE)을 따로 보내지 않는다.
 * 일시 장애(platform isRedisUnavailable)는 SeatStoreUnavailable(err), 메모리 부족(platform isRedisOutOfMemory)은 SeatStoreUnavailable(err, 'oom')로
 * 바꿔 던지고, 그 밖(스크립트 오류)은 그대로 던진다. 모양이 틀리면 RangeError(부르지 않는다)
 */
@Injectable()
export class RedisSweepLeases implements SweepLeases {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async acquire(eventId: string, owner: string, ttlMs: number, lane: SweepLane = 'expiry'): Promise<boolean> {
    assertSweepLeaseArgs(eventId, owner, ttlMs);
    const key = lane === 'session' ? seatKeys.sessionSweep(eventId) : seatKeys.sweep(eventId);
    const r = str(await guard(this.redis.evalScript(SWEEP_LEASE, [key], [owner, String(ttlMs)])));
    if (r === '1') return true;
    if (r === '0') return false;
    throw new Error(`임대 Lua가 모르는 값을 돌려줬다: ${r}`);
  }
}
