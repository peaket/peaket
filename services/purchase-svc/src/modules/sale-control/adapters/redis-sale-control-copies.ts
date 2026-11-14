// 판매 중지 사본을 좌석 Redis s:{event:E}:ctl에 쓴다(BAT-465 R-584, docs/data.md §3 s:{event:E}:ctl, ADR-0103·0123).
// 홀드 Lua가 이 칸을 비트맵과 같은 원자 연산에서 읽어 suspended가 '1'이면 423 sale-paused로 거절한다.
// paused·allPaused·allRev·allCmd는 명령 3 몫이라 건드리지 않는다. 수명이 없는 키에는 30일 [가정] 수명을 건다(정지가 풀린 뒤에도 늦게 온 사본을 가릴 수 있게).
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { SEAT_REDIS, seatKeys } from '../../inventory/index.js';
import type { SaleControlCopies } from '../domain/ports.js';
import type { SaleControl } from '../domain/sale-control.js';

/** 수명이 없는 사본 키에 거는 수명 30일 [가정] */
export const SALE_CONTROL_COPY_TTL_MS = 30 * 86_400_000;

const WRITE = redisScript(`
redis.call('HSET', KEYS[1], 'suspended', ARGV[1], 'rev', ARGV[2], 'cmd', ARGV[3])
if ARGV[4] ~= '' then redis.call('HSET', KEYS[1], 'suspRef', ARGV[4]) end
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[5])) end
return 1
`);

@Injectable()
export class RedisSaleControlCopies implements SaleControlCopies {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async write(c: Pick<SaleControl, 'eventId' | 'suspended' | 'revision' | 'commandId' | 'suspensionRef'>): Promise<void> {
    const key = seatKeys.ctl(c.eventId);
    await this.redis.evalScript(WRITE, [key], [c.suspended ? '1' : '0', String(c.revision), c.commandId ?? '', c.suspensionRef ?? '', String(SALE_CONTROL_COPY_TTL_MS)]);
  }
}
