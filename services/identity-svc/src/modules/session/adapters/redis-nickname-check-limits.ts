// 닉네임 확인의 세션별 요청 수(세션·캐시 Redis id:nick:{세션 ID}, 1분 [가정], docs/data.md §3, ADR-0235 결정 5).
// 세기와 수명 걸기를 스크립트 한 번으로 한다. 따로 보내면 INCR 뒤 수명 걸기가 실패했을 때 수명 없는 키가 남아 그 세션이 영영 한도에 걸릴 수 있다.
// 저장소에 닿지 못하면 통과시킨다: 닉네임 확인은 참고이고 확정은 가입 마무리의 409다.
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import type { NicknameCheckLimits } from '../domain/ports.js';
import { NICKNAME_CHECK_LIMIT, NICKNAME_CHECK_WINDOW_MS } from '../domain/signup.js';

export const nicknameCheckKey = (sessionId: string): string => `id:nick:${sessionId}`;

/** ARGV[1] 창(ms). 돌려주는 값은 { 올린 뒤 수, 남은 수명(ms) }. 수명이 없는 키는 여기서 수명을 얻는다 */
const COUNT = redisScript(`
local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { n, ttl }
`);

export class RedisNicknameCheckLimits implements NicknameCheckLimits {
  constructor(private readonly redis: HotRedis) {}

  async allow(sessionId: string) {
    try {
      const [count, ttl] = (await this.redis.evalScript(COUNT, [nicknameCheckKey(sessionId)], [String(NICKNAME_CHECK_WINDOW_MS)])) as [number, number];
      return Number(count) <= NICKNAME_CHECK_LIMIT ? ({ allowed: true } as const) : ({ allowed: false, retryAfterMs: Math.max(1, Number(ttl)) } as const);
    } catch (err) {
      if (isRedisUnavailable(err)) return { allowed: true } as const;
      throw err;
    }
  }
}
