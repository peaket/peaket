// 회차 판매 상태를 대기열 Redis(Valkey) q:{event:E}:notice에 쓴다(docs/data.md §3, ADR-0214 결정 2).
// notice와 seq는 같은 {event:E} 태그라 한 슬롯이다. 판 번호 비교, 쓰기, 매진 판의 seq 읽기, 수명 늘리기를 Lua 하나로 한다.
import { type HotRedis, redisScript } from '@peaket/platform';
import { guard, keys } from '../../entry/index.js';
import type { SaleApplyOutcome, SaleChange, SaleStates } from '../domain/sale.js';

// KEYS: 1 notice, 2 seq
// ARGV: 1 판 번호, 2 판매 상태, 3 매진 등급(JSON 배열), 4 만료 시각(ms, 늘리기만), 5 STALE에도 늘리나(1/0. 일정 사본이 없으면 0),
//       6 남은 좌석 수(셈이 없으면 ''), 7 셈 시각(ms), 8 평균 구매 매수(없으면 '': 칸을 지운다)
// 수명은 판이 같거나 작아도(STALE) 늘린다: 연기된 회차는 내는 쪽이 같은 판을 다시 낼 때 새 판매 종료 + 1일로 늘고, 리더 주기도 늘린다(HOT-010 리뷰)
// 셈은 판 번호가 지금 판 이상이고 셈 시각이 둔 것(seatsAtMs)보다 늦을 때만 쓴다. 같은 판의 다시 내기(STALE)도 더 늦은 셈이면 고친다(HOT-011, ADR-0219 결정 5)
// 돌려주는 값: {'STALE', 지금 saleState, 지금 saleVersion} 또는 {'APPLIED', 매진 판이면 soldOutLastSeq, 아니면 -1}
export const SALE_STATE_LUA = `
local function extend()
  if redis.call('EXISTS', KEYS[1]) == 1 and redis.call('PEXPIRETIME', KEYS[1]) < tonumber(ARGV[4]) then redis.call('PEXPIREAT', KEYS[1], ARGV[4]) end
end
local function counts()
  if ARGV[6] == '' then return end
  local at = tonumber(redis.call('HGET', KEYS[1], 'seatsAtMs') or '')
  if at and at >= tonumber(ARGV[7]) then return end
  redis.call('HSET', KEYS[1], 'remainingSeats', ARGV[6], 'seatsAtMs', ARGV[7])
  if ARGV[8] == '' then redis.call('HDEL', KEYS[1], 'avgTicketsPerOrder') else redis.call('HSET', KEYS[1], 'avgTicketsPerOrder', ARGV[8]) end
end
local cur = tonumber(redis.call('HGET', KEYS[1], 'saleVersion') or '')
local v = tonumber(ARGV[1])
if cur and cur >= v then
  if cur == v then counts() end
  if ARGV[5] == '1' then extend() end
  return {'STALE', redis.call('HGET', KEYS[1], 'saleState') or '', redis.call('HGET', KEYS[1], 'saleVersion')}
end
redis.call('HSET', KEYS[1], 'saleState', ARGV[2], 'saleVersion', ARGV[1], 'soldOutTiers', ARGV[3])
local sold = -1
if ARGV[2] == 'SOLD_OUT' then
  sold = tonumber(redis.call('GET', KEYS[2]) or '0')
  redis.call('HSET', KEYS[1], 'soldOutLastSeq', sold)
end
counts()
extend()
return {'APPLIED', sold}
`;

const SALE_STATE = redisScript(SALE_STATE_LUA);
const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

export class RedisSaleStates implements SaleStates {
  constructor(private readonly redis: HotRedis) {}

  async apply(c: SaleChange): Promise<SaleApplyOutcome> {
    const e = c.eventId;
    const n = c.counts;
    const args = [String(c.version), c.state, JSON.stringify(c.soldOutTiers), String(c.expireAtMs), c.extendOnStale ? '1' : '0', n ? String(n.remaining) : '', n ? String(n.countedAtMs) : '0', n?.avgTicketsPerOrder !== undefined ? String(n.avgTicketsPerOrder) : ''];
    const r = (await guard(this.redis.evalScript(SALE_STATE, [keys.notice(e), keys.seq(e)], args))) as unknown[];
    const head = str(r[0]);
    if (head === 'STALE') return { kind: 'STALE', current: { state: str(r[1]), version: Number(str(r[2])) } };
    if (head !== 'APPLIED') throw new Error(`판매 상태 Lua가 모르는 값을 돌려줬다: ${head}`);
    const sold = Number(r[1]);
    const current = { state: c.state, version: c.version };
    return sold >= 0 ? { kind: 'APPLIED', soldOutLastSeq: sold, current } : { kind: 'APPLIED', current };
  }

  async current(eventId: string): Promise<{ state: string; version: number } | null> {
    const k = keys.notice(eventId);
    const r = ((await guard(this.redis.command(['HMGET', k, 'saleState', 'saleVersion'], { key: k }))) as unknown[]) ?? [];
    const state = r[0] === null || r[0] === undefined ? '' : str(r[0]);
    const version = r[1] === null || r[1] === undefined ? Number.NaN : Number(str(r[1]));
    return state !== '' && Number.isFinite(version) ? { state, version } : null;
  }
}
