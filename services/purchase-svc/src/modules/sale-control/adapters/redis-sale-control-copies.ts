// 판매 중지·명령 3 사본을 좌석 Redis s:{event:E}:ctl에 쓴다(BAT-465 R-584, F-02-1 OPS-300, docs/data.md §3 s:{event:E}:ctl, ADR-0103·0123·0365).
// 홀드 Lua가 이 칸을 비트맵과 같은 원자 연산에서 읽어 paused·allPaused·suspended 가운데 '1'이면 423 sale-paused로 거절한다.
// 종류마다 판·명령 칸이 따로다(ADR-0365 결정 6): 판매 중지 suspended·rev·cmd·suspRef, 명령 3 회차 범위 paused·pausedRev·pausedCmd,
// 전체 범위 allPaused·allRev·allCmd. 한 종류의 쓰기는 다른 종류의 칸을 건드리지 않는다. 명령 3 두 쓰기는 판이 지금 칸보다 클 때만 쓴다(비교하고 쓰기).
// 수명이 없는 키에는 30일 [가정] 수명을 건다(정지가 풀린 뒤에도 늦게 온 사본을 가릴 수 있게).
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

/**
 * 명령 3 사본 쓰기(회차 범위·전체 범위가 같은 Lua, 칸 이름만 다르다). KEYS: 1 s:{event:E}:ctl. ARGV: 1 값 칸, 2 판 칸, 3 명령 칸, 4 '1'·'0', 5 판, 6 명령 ID, 7 수명 ms.
 * 판이 지금 판 칸보다 클 때만 세 칸을 쓴다. 돌려주는 값은 쓴 뒤(또는 지금)의 판 글
 */
const WRITE_PAUSE = redisScript(`
local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[2]) or '0') or 0
local rev = tonumber(ARGV[5])
if rev <= cur then return string.format('%.0f', cur) end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[4], ARGV[2], ARGV[5], ARGV[3], ARGV[6])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[7])) end
return ARGV[5]
`);

const str = (v: unknown): string => (typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class RedisSaleControlCopies implements SaleControlCopies {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async write(c: Pick<SaleControl, 'eventId' | 'suspended' | 'revision' | 'commandId' | 'suspensionRef'>): Promise<void> {
    const key = seatKeys.ctl(c.eventId);
    await this.redis.evalScript(WRITE, [key], [c.suspended ? '1' : '0', String(c.revision), c.commandId ?? '', c.suspensionRef ?? '', String(SALE_CONTROL_COPY_TTL_MS)]);
  }

  async writePause(c: { eventId: string; paused: boolean; revision: number; commandId?: string }): Promise<number> {
    return this.#pause(c.eventId, 'paused', 'pausedRev', 'pausedCmd', c);
  }

  /** 회차 목록 s:ctl:events(다른 슬롯, SMEMBERS 한 번)의 회차마다 전체 범위 칸을 쓴다. 쓴 회차 수(판이 이미 같거나 큰 회차는 세지 않는다) */
  async writePlatformPause(c: { paused: boolean; revision: number; commandId?: string }): Promise<number> {
    const list = seatKeys.ctlEvents();
    const r = await this.redis.command(['SMEMBERS', list], { key: list });
    if (!Array.isArray(r)) throw new Error('s:ctl:events 응답이 배열이 아니다');
    let n = 0;
    for (const eventId of r.map(str).filter((e) => EVENT_ID.test(e))) {
      if ((await this.#pause(eventId, 'allPaused', 'allRev', 'allCmd', c)) === c.revision) n += 1;
    }
    return n;
  }

  async #pause(eventId: string, valueField: string, revField: string, cmdField: string, c: { paused: boolean; revision: number; commandId?: string }): Promise<number> {
    const key = seatKeys.ctl(eventId);
    const r = await this.redis.evalScript(WRITE_PAUSE, [key], [valueField, revField, cmdField, c.paused ? '1' : '0', String(c.revision), c.commandId ?? '', String(SALE_CONTROL_COPY_TTL_MS)]);
    const rev = Number(str(r));
    if (!Number.isSafeInteger(rev)) throw new Error('명령 3 사본 쓰기 Lua가 모르는 값을 돌려줬다');
    return rev;
  }
}
