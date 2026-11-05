// 회차 판매 상태를 대기열 Redis(Valkey) q:{event:E}:notice에 쓴다(docs/data.md §3, ADR-0214 결정 2).
// notice와 seq는 같은 {event:E} 태그라 한 슬롯이다. 판 번호 비교, 쓰기, 매진 판의 seq 읽기, 수명 늘리기를 Lua 하나로 한다.
import { type HotRedis, redisScript } from '@peaket/platform';
import { guard, keys } from '../../entry/index.js';
import type { SaleApplyResult, SaleChange, SaleStates } from '../domain/sale.js';

// KEYS: 1 notice, 2 seq
// ARGV: 1 판 번호, 2 판매 상태, 3 매진 등급(JSON 배열), 4 만료 시각(ms, 늘리기만), 5 STALE에도 늘리나(1/0. 일정 사본이 없으면 0)
// 수명은 판이 같거나 작아도(STALE) 늘린다: 연기된 회차는 내는 쪽이 같은 판을 다시 낼 때 새 판매 종료 + 1일로 늘고, 리더 주기도 늘린다(HOT-010 리뷰)
// 돌려주는 값: {'STALE'} 또는 {'APPLIED', 매진 판이면 soldOutLastSeq, 아니면 -1}
export const SALE_STATE_LUA = `
local function extend()
  if redis.call('EXISTS', KEYS[1]) == 1 and redis.call('PEXPIRETIME', KEYS[1]) < tonumber(ARGV[4]) then redis.call('PEXPIREAT', KEYS[1], ARGV[4]) end
end
local cur = tonumber(redis.call('HGET', KEYS[1], 'saleVersion') or '')
local v = tonumber(ARGV[1])
if cur and cur >= v then
  if ARGV[5] == '1' then extend() end
  return {'STALE'}
end
redis.call('HSET', KEYS[1], 'saleState', ARGV[2], 'saleVersion', ARGV[1], 'soldOutTiers', ARGV[3])
local sold = -1
if ARGV[2] == 'SOLD_OUT' then
  sold = tonumber(redis.call('GET', KEYS[2]) or '0')
  redis.call('HSET', KEYS[1], 'soldOutLastSeq', sold)
end
extend()
return {'APPLIED', sold}
`;

const SALE_STATE = redisScript(SALE_STATE_LUA);
const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

export class RedisSaleStates implements SaleStates {
  constructor(private readonly redis: HotRedis) {}

  async apply(c: SaleChange): Promise<SaleApplyResult> {
    const e = c.eventId;
    const r = (await guard(this.redis.evalScript(SALE_STATE, [keys.notice(e), keys.seq(e)], [String(c.version), c.state, JSON.stringify(c.soldOutTiers), String(c.expireAtMs), c.extendOnStale ? '1' : '0']))) as unknown[];
    const head = str(r[0]);
    if (head === 'STALE') return { kind: 'STALE' };
    if (head !== 'APPLIED') throw new Error(`판매 상태 Lua가 모르는 값을 돌려줬다: ${head}`);
    const sold = Number(r[1]);
    return sold >= 0 ? { kind: 'APPLIED', soldOutLastSeq: sold } : { kind: 'APPLIED' };
  }
}
