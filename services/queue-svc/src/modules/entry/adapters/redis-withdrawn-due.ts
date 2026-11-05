// 탈퇴 사건의 '처리할 때' 집합을 대기열 Redis(Valkey)에 둔다(docs/data.md §3 q:{wdr}, ADR-0214 결정 7).
// 모든 키가 {wdr} 태그 한 슬롯이다(탈퇴는 드물어 한 슬롯으로 넉넉하다). 지금 시각은 앱 시계로 넘긴다.
// - due: 꺼낼 수 있는 항목(멤버 eventKey, 점수 = 처리할 때). leased: 빌려 간 항목(점수 = 빌림 끝). all: 처리하지 못한 모든 항목(점수 = 처리할 때, 경보와 되돌리기에 쓴다)
// - n: eventKey → 꺼낸 횟수(빌림을 두 배씩 늘린다). v:<eventKey>: 값 JSON(pid·purgeBy·처리할 때), 수명 = purgeBy
// 빌린 항목은 due에서 빠지므로, 계속 실패하는 항목이 쌓여도 뒤의 항목을 훑는 범위를 막지 않는다(HOT-010 리뷰).
import { type Clock, type HotRedis, redisScript, systemClock } from '@peaket/platform';
import { DUE_LEASE_MAX_MS, type DueWithdrawal, type WithdrawnDue } from '../domain/ports.js';
import { guard } from './redis-entry-store.js';

export const wdrKeys = {
  due: 'q:{wdr}:due',
  leased: 'q:{wdr}:leased',
  all: 'q:{wdr}:all',
  attempts: 'q:{wdr}:n',
  value: (eventKey: string) => `q:{wdr}:v:${eventKey}`,
};

// KEYS: 1 due, 2 leased, 3 all, 4 v:<eventKey>. ARGV: 1 eventKey, 2 처리할 때, 3 값 JSON, 4 purgeBy. 같은 eventKey는 한 번만(값 SET NX, all ZADD NX)
const SCHEDULE = redisScript(`
redis.call('SET', KEYS[4], ARGV[3], 'NX', 'PXAT', ARGV[4])
if redis.call('ZADD', KEYS[3], 'NX', ARGV[2], ARGV[1]) == 1 then redis.call('ZADD', KEYS[1], ARGV[2], ARGV[1]) end
return 1
`);
// KEYS: 1 due, 2 leased, 3 all, 4 n. ARGV: 1 지금, 2 빌림(ms), 3 꺼낼 수, 4 빌림 상한(ms)
// 빌림이 끝난 항목을 처음 처리할 때의 점수로 due에 되돌린 뒤, 때가 된 것을 꺼내 leased로 옮긴다. 빌림은 꺼낸 횟수마다 두 배다
const CLAIM = redisScript(`
local now = tonumber(ARGV[1])
local back = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, 1000)
for _, id in ipairs(back) do
  redis.call('ZREM', KEYS[2], id)
  local at = redis.call('ZSCORE', KEYS[3], id)
  if at then redis.call('ZADD', KEYS[1], at, id) end
end
local ids = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', now, 'LIMIT', 0, tonumber(ARGV[3]))
for _, id in ipairs(ids) do
  local n = redis.call('HINCRBY', KEYS[4], id, 1)
  local lease = math.min(tonumber(ARGV[4]), tonumber(ARGV[2]) * math.pow(2, n - 1))
  redis.call('ZREM', KEYS[1], id)
  redis.call('ZADD', KEYS[2], math.floor(now + lease), id)
end
return ids
`);
// KEYS: 1 due, 2 leased, 3 all, 4 n, 5 v:<eventKey>. ARGV: 1 eventKey
const DONE = redisScript(`
redis.call('ZREM', KEYS[1], ARGV[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('ZREM', KEYS[3], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
redis.call('DEL', KEYS[5])
return 1
`);
// KEYS: 1 all. 가장 이른 처리할 때(없으면 nil). 응답 모양(RESP2·3)에 기대지 않게 점수만 돌려받는다
const OLDEST = redisScript(`
local r = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
return r[2]
`);

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

function parse(eventKey: string, raw: string): DueWithdrawal | null {
  try {
    const v = JSON.parse(raw) as { pids?: unknown; purgeBy?: unknown; dueAt?: unknown };
    if (!Array.isArray(v.pids) || !v.pids.every((p) => typeof p === 'string') || typeof v.purgeBy !== 'number' || typeof v.dueAt !== 'number') return null;
    return { eventKey, pids: v.pids as string[], purgeBy: v.purgeBy, dueAt: v.dueAt };
  } catch {
    return null;
  }
}

export class RedisWithdrawnDue implements WithdrawnDue {
  constructor(
    private readonly redis: HotRedis,
    private readonly clock: Clock = systemClock,
  ) {}

  async schedule(i: DueWithdrawal): Promise<void> {
    const json = JSON.stringify({ pids: i.pids, purgeBy: i.purgeBy, dueAt: i.dueAt });
    await guard(this.redis.evalScript(SCHEDULE, [wdrKeys.due, wdrKeys.leased, wdrKeys.all, wdrKeys.value(i.eventKey)], [i.eventKey, String(i.dueAt), json, String(i.purgeBy)]));
  }

  async claim(i: { leaseMs: number; limit: number }): Promise<{ items: DueWithdrawal[]; expired: number }> {
    const now = this.clock.now();
    const args = [String(now), String(i.leaseMs), String(i.limit), String(DUE_LEASE_MAX_MS)];
    const ids = ((await guard(this.redis.evalScript(CLAIM, [wdrKeys.due, wdrKeys.leased, wdrKeys.all, wdrKeys.attempts], args))) as unknown[]).map(str);
    const items: DueWithdrawal[] = [];
    let expired = 0;
    for (const id of ids) {
      const k = wdrKeys.value(id);
      const raw = await guard(this.redis.command(['GET', k], { key: k }));
      const item = raw === null || raw === undefined ? null : parse(id, str(raw));
      // 값이 수명(purgeBy)으로 사라졌을 때만 버린다(그 사람 키는 판매 종료 TTL로 지워진다, 남는 한계).
      // 값이 있으면 purgeBy가 지났어도 지금 처리한다(만료 당기기가 키를 바로 지운다, HOT-010 리뷰)
      if (!item) {
        await this.done(id);
        expired++;
        continue;
      }
      items.push(item);
    }
    return { items, expired };
  }

  async done(eventKey: string): Promise<void> {
    await guard(this.redis.evalScript(DONE, [wdrKeys.due, wdrKeys.leased, wdrKeys.all, wdrKeys.attempts, wdrKeys.value(eventKey)], [eventKey]));
  }

  async oldestDue(): Promise<number | null> {
    const r = await guard(this.redis.evalScript(OLDEST, [wdrKeys.all], []));
    return r === null || r === undefined || r === false ? null : Number(str(r));
  }
}
