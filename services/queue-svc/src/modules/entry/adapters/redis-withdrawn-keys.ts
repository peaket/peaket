// 탈퇴 계정의 사람 키 만료 당기기의 대기열 Redis 쪽(docs/features/queue-admission.md §3 '탈퇴 계정의 사람 키', BUILD_ORDER BOT-037).
// 진행 중인 회차 목록(q:{admission}:events, 점수 = 회차 키 수명)을 나눠 읽고, 한 pid의 키에 EXPIRE_BY Lua를 건다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import type { WithdrawnKeys } from '../domain/ports.js';
import { EXPIRE_BY_LUA } from './entry-lua.js';
import { guard, keys, QUEUE_REDIS } from './redis-entry-store.js';
import { EVENTS_KEY } from './redis-event-schedules.js';

const EXPIRE_BY = redisScript(EXPIRE_BY_LUA);
/** 회차 목록을 한 번에 읽는 수 [가정] */
export const EVENTS_PAGE = 500;
/** 회차 ID는 키의 해시 태그에 들어간다. 진입 컨트롤러의 KEY_PART와 같은 모양만 쓴다 */
const KEY_PART = /^[A-Za-z0-9_-]{1,64}$/;

@Injectable()
export class RedisWithdrawnKeys implements WithdrawnKeys {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async activeEvents(now: number): Promise<string[]> {
    const out: string[] = [];
    for (let offset = 0; ; offset += EVENTS_PAGE) {
      const page = (await guard(this.redis.command(['ZRANGEBYSCORE', EVENTS_KEY, `(${now}`, '+inf', 'LIMIT', String(offset), String(EVENTS_PAGE)], { key: EVENTS_KEY }))) as unknown[];
      for (const v of page) {
        const id = Buffer.isBuffer(v) ? v.toString('utf8') : String(v);
        if (KEY_PART.test(id)) out.push(id);
      }
      if (page.length < EVENTS_PAGE) return out;
    }
  }

  async expireBy(pid: string, eventIds: readonly string[], at: number): Promise<number> {
    if (eventIds.length === 0) return 0;
    const ks = eventIds.flatMap((e) => [keys.dup(pid, e), keys.adm(pid, e)]);
    return Number(await guard(this.redis.evalScript(EXPIRE_BY, ks, [String(Math.floor(at))])));
  }
}
