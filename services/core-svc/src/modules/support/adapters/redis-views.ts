// core-svc support 화면용 사본 Redis 어댑터(F-06-4, data.md §3 sup:rst·sup:far).
// 값은 행 하나를 JSON으로 둔다. 판이 클 때만 쓴다. 읽기-비교-쓰기는 Lua 한 명령(EVAL)으로 원자적으로 한다(IR-14).
import { redactFraudView, type FraudAppealViewRow, type RestrictionViewRow } from '../domain/appeal.js';
import type { FraudAppealViewStore, RestrictionViewStore } from '../domain/ports.js';

export interface RedisCommander {
  command(args: string[], o?: { key?: string }): Promise<unknown>;
}

const hget = async (redis: RedisCommander, key: string, field: string): Promise<string | undefined> => {
  const v = await redis.command(['HGET', key, field]);
  return typeof v === 'string' ? v : undefined;
};
const hvals = async (redis: RedisCommander, key: string): Promise<string[]> => {
  const v = await redis.command(['HVALS', key]);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

/** 같은 해시 칸에 더 큰 판만 쓴다(작은 판이 늦게 와도 덮지 않는다). 1=썼다, 0=무시 */
const APPLY_IF_GREATER = `
local cur = redis.call('HGET', KEYS[1], ARGV[1])
if cur then
  local ok, obj = pcall(cjson.decode, cur)
  local v = ok and obj and tonumber(obj['version'])
  if v and v >= tonumber(ARGV[2]) then return 0 end
end
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
return 1
`;

const applyIfGreater = async (redis: RedisCommander, key: string, field: string, version: number, value: string): Promise<boolean> => {
  const r = await redis.command(['EVAL', APPLY_IF_GREATER, '1', key, field, String(version), value], { key });
  return Number(r) === 1;
};

export class RedisRestrictionViewStore implements RestrictionViewStore {
  constructor(private readonly redis: RedisCommander) {}
  #key = (accountId: string) => `sup:rst:${accountId}`;

  async apply(i: RestrictionViewRow): Promise<{ changed: boolean }> {
    return { changed: await applyIfGreater(this.redis, this.#key(i.accountId), i.restrictionId, i.version, JSON.stringify(i)) };
  }
  async get(accountId: string, restrictionId: string): Promise<RestrictionViewRow | undefined> {
    const raw = await hget(this.redis, this.#key(accountId), restrictionId);
    return raw ? (JSON.parse(raw) as RestrictionViewRow) : undefined;
  }
  async list(accountId: string): Promise<RestrictionViewRow[]> {
    return (await hvals(this.redis, this.#key(accountId))).map((x) => JSON.parse(x) as RestrictionViewRow);
  }
  async clear(): Promise<void> {
    // 계정별 키라 전체 삭제는 하지 않는다(시험은 메모리 저장소를 쓴다)
  }
}

export class RedisFraudAppealViewStore implements FraudAppealViewStore {
  constructor(private readonly redis: RedisCommander) {}
  #key = (accountId: string) => `sup:far:${accountId}`;

  async apply(i: FraudAppealViewRow): Promise<{ changed: boolean }> {
    const safe = redactFraudView(i);
    return { changed: await applyIfGreater(this.redis, this.#key(safe.accountId), safe.caseId, safe.version, JSON.stringify(safe)) };
  }
  async get(accountId: string, caseId: string): Promise<FraudAppealViewRow | undefined> {
    const raw = await hget(this.redis, this.#key(accountId), caseId);
    return raw ? redactFraudView(JSON.parse(raw) as FraudAppealViewRow) : undefined;
  }
  async list(accountId: string): Promise<FraudAppealViewRow[]> {
    return (await hvals(this.redis, this.#key(accountId))).map((x) => redactFraudView(JSON.parse(x) as FraudAppealViewRow));
  }
  async clear(): Promise<void> {
    // 계정별 키라 전체 삭제는 하지 않는다(시험은 메모리 저장소를 쓴다)
  }
}
