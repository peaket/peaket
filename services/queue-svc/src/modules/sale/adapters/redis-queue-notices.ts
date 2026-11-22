// 대기 화면 제어 상태를 대기열 Redis q:{event:E}:notice(전체는 q:{event:PLATFORM}:notice)에 쓴다(F-02-1 OPS-300, ADR-0365 결정 6, docs/data.md §3).
// 종류마다 판 칸(pausedRev·bannerRev)과 비교해 클 때만 값·판·명령 칸과 마지막 적용 칸(version·commandId)을 쓴다(비교하고 쓰기, 한 Lua).
// 배너가 null이면 값 칸을 지운다. 수명이 없는 키에는 판매 중지 사본과 같은 30일 [가정] 수명을 건다.
import { type HotRedis, redisScript } from '@peaket/platform';
import { guard, keys } from '../../entry/index.js';
import { QUEUE_NOTICE_FIELDS, type QueueNotices, type QueueNoticeWrite } from '../domain/queue-notice.js';
import { SALE_SUSPENSION_COPY_TTL_MS } from './redis-sale-suspension-copies.js';

// KEYS: 1 notice
// ARGV: 1 값 칸, 2 판 칸, 3 명령 칸, 4 값, 5 '1'이면 값 칸 지움, 6 판, 7 명령 ID, 8 수명(ms)
const WRITE = redisScript(`
local cur = tonumber(redis.call('HGET', KEYS[1], ARGV[2]) or '0') or 0
local rev = tonumber(ARGV[6])
if rev <= cur then return string.format('%.0f', cur) end
if ARGV[5] == '1' then
  redis.call('HDEL', KEYS[1], ARGV[1])
else
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
end
redis.call('HSET', KEYS[1], ARGV[2], ARGV[6], ARGV[3], ARGV[7], 'version', ARGV[6], 'commandId', ARGV[7])
if redis.call('PTTL', KEYS[1]) < 0 then redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[8])) end
return ARGV[6]
`);

const str = (v: unknown): string => (typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

export class RedisQueueNotices implements QueueNotices {
  constructor(private readonly redis: HotRedis) {}

  async write(w: QueueNoticeWrite): Promise<number> {
    const f = QUEUE_NOTICE_FIELDS[w.kind];
    const r = await guard(
      this.redis.evalScript(WRITE, [keys.notice(w.scope)], [f.value, f.rev, f.cmd, w.value ?? '', w.value === null ? '1' : '0', String(w.revision), w.commandId, String(SALE_SUSPENSION_COPY_TTL_MS)]),
    );
    const applied = Number(str(r));
    if (!Number.isSafeInteger(applied)) throw new Error('notice 쓰기 Lua가 모르는 값을 돌려줬다');
    return applied;
  }
}
