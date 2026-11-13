// 취소표 즉시 재판매: 좌석 Redis 비트맵을 끄고 구역 델타를 발행한다(GAT-080).
// seat_sale RETURNED(DB) 뒤에만 부른다. 세대 키가 없으면(다시 만들기 중) NOT_READY이고 아무것도 쓰지 않는다.
import { type HotRedis, redisScript } from '@peaket/platform';
import type { SeatReturnNotices } from '../domain/ports.js';

const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

const RETURN_SOLD_LUA = `#!lua
-- KEYS: 1 bitmap, 2 epoch, 3 secver
-- ARGV: 1 keepUntilMs, 2 channel prefix, 3.. seat triples (index, sectionIndex, seatOffset)
local keep = ARGV[1]
local prefix = ARGV[2]
local epoch = redis.call('HGET', KEYS[2], 'epoch')
if not epoch then return {'NOT_READY'} end
local now = redis.call('TIME')[1]
local versions = {}
local deltas = {}
local released = 0
for i = 3, #ARGV, 3 do
  local idx = ARGV[i]
  local sec = ARGV[i + 1]
  local off = ARGV[i + 2]
  local bit = redis.call('BITFIELD_RO', KEYS[1], 'GET', 'u1', idx)[1]
  if tonumber(bit) == 1 then
    redis.call('BITFIELD', KEYS[1], 'SET', 'u1', idx, 0)
    versions[sec] = redis.call('HINCRBY', KEYS[3], sec, 1)
    if not deltas[sec] then deltas[sec] = {} end
    table.insert(deltas[sec], off .. ':0')
    released = released + 1
  end
end
for sec, list in pairs(deltas) do
  redis.call('SPUBLISH', prefix .. sec, '1 ' .. epoch .. ' ' .. sec .. ' ' .. versions[sec] .. ' ' .. now .. ' ' .. table.concat(list, ' '))
end
redis.call('PEXPIREAT', KEYS[1], keep)
redis.call('PEXPIREAT', KEYS[2], keep)
redis.call('PEXPIREAT', KEYS[3], keep)
return {'OK', released}
`;

const SCRIPT = redisScript(RETURN_SOLD_LUA);

export class RedisSeatReturnNotices implements SeatReturnNotices {
  constructor(private readonly redis: HotRedis) {}

  async returnSold(q: Parameters<SeatReturnNotices['returnSold']>[0]): Promise<'OK' | 'NOT_READY'> {
    if (!KEY_PART.test(q.eventId)) throw new RangeError('회차 ID가 키 조각 모양이 아니다');
    const base = `s:{event:${q.eventId}}`;
    const keys = [`${base}:bitmap`, `${base}:epoch`, `${base}:secver`];
    const args = [String(q.keepUntilMs), `${base}:sec:`, ...q.seats.flatMap((s) => [String(s.index), String(s.sectionIndex), String(s.seatOffset)])];
    const r = (await this.redis.evalScript(SCRIPT, keys, args)) as unknown[];
    const kind = Array.isArray(r) && r[0] !== undefined ? String(r[0]) : '';
    if (kind === 'NOT_READY') return 'NOT_READY';
    if (kind !== 'OK') throw new Error(`취소표 Lua가 모르는 값을 돌려줬다: ${kind}`);
    return 'OK';
  }
}
