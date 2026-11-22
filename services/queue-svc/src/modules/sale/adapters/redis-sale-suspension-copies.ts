// 판매 중지 사본을 대기열 Redis에 쓴다(BAT-465 R-584, docs/data.md §3 q:{event:E}:notice·ctl, ADR-0123).
// notice와 ctl은 같은 {event:E} 태그라 한 슬롯이다. 한 Lua에서 두 Hash를 함께 써서 대기 상태 파일과 리더가 서로 다른 순간을 보지 않게 한다.
// 수명이 없는 키에는 30일 [가정] 수명을 건다(사본이 정지가 풀린 뒤에도 늘 남는 것을 막는다).
import { type HotRedis, redisScript } from '@peaket/platform';
import { guard, keys } from '../../entry/index.js';
import type { SaleSuspensionCopies, SaleSuspensionCopyWrite } from '../domain/sale-suspension.js';

/** 수명이 없는 사본 키에 거는 수명 30일 [가정] */
export const SALE_SUSPENSION_COPY_TTL_MS = 30 * 86_400_000;

// KEYS: 1 notice, 2 ctl
// ARGV: 1 suspended('1'·'0'), 2 판 번호, 3 명령 ID, 4 수명(ms)
// 판 번호가 0보다 크면(제어 gRPC, F-02-1) notice의 suspRev보다 클 때만 쓰고, 같거나 작으면 지금 판을 돌려준다(ADR-0365 결정 1).
// 0이면(내부 HTTP 호환 경로) 전처럼 늘 쓴다. 돌려주는 값은 쓴 뒤(또는 지금)의 판 글이다
const WRITE = redisScript(`
local rev = tonumber(ARGV[2])
if rev > 0 then
  local cur = tonumber(redis.call('HGET', KEYS[1], 'suspRev') or '0') or 0
  if rev <= cur then return string.format('%.0f', cur) end
end
redis.call('HSET', KEYS[1], 'suspended', ARGV[1], 'suspRev', ARGV[2], 'suspCmd', ARGV[3])
redis.call('HSET', KEYS[2], 'suspended', ARGV[1], 'suspRev', ARGV[2], 'suspCmd', ARGV[3])
for i = 1, 2 do
  if redis.call('PTTL', KEYS[i]) < 0 then redis.call('PEXPIRE', KEYS[i], tonumber(ARGV[4])) end
end
return ARGV[2]
`);

export class RedisSaleSuspensionCopies implements SaleSuspensionCopies {
  constructor(private readonly redis: HotRedis) {}

  async write(c: SaleSuspensionCopyWrite): Promise<number> {
    const e = c.eventId;
    const r = await guard(this.redis.evalScript(WRITE, [keys.notice(e), keys.ctl(e)], [c.suspended ? '1' : '0', String(c.revision), c.commandId, String(SALE_SUSPENSION_COPY_TTL_MS)]));
    const applied = Number(typeof r === 'string' ? r : Buffer.isBuffer(r) ? r.toString('utf8') : String(r));
    return Number.isSafeInteger(applied) ? applied : c.revision;
  }
}
