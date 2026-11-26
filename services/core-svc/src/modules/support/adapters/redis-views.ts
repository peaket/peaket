// core-svc support 화면용 사본 Redis 어댑터(F-06-4, data.md §3 sup:rst·sup:far).
// 값은 행 하나를 JSON으로 둔다. 판이 클 때만 쓴다(읽고-비교-쓰기, 원자성은 다음 작업).
import type { FraudAppealViewRow, RestrictionViewRow } from '../domain/appeal.js';
import type { FraudAppealViewStore, RestrictionViewStore } from '../domain/ports.js';

export interface RedisCommander {
  command(args: string[]): Promise<unknown>;
}

const hget = async (redis: RedisCommander, key: string, field: string): Promise<string | undefined> => {
  const v = await redis.command(['HGET', key, field]);
  return typeof v === 'string' ? v : undefined;
};
const hvals = async (redis: RedisCommander, key: string): Promise<string[]> => {
  const v = await redis.command(['HVALS', key]);
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
};

export class RedisRestrictionViewStore implements RestrictionViewStore {
  constructor(private readonly redis: RedisCommander) {}
  #key = (accountId: string) => `sup:rst:${accountId}`;

  async apply(i: RestrictionViewRow): Promise<{ changed: boolean }> {
    const cur = await this.get(i.accountId, i.restrictionId);
    if (cur && cur.version >= i.version) return { changed: false };
    await this.redis.command(['HSET', this.#key(i.accountId), i.restrictionId, JSON.stringify(i)]);
    return { changed: true };
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
    const cur = await this.get(i.accountId, i.caseId);
    if (cur && cur.version >= i.version) return { changed: false };
    await this.redis.command(['HSET', this.#key(i.accountId), i.caseId, JSON.stringify(i)]);
    return { changed: true };
  }
  async get(accountId: string, caseId: string): Promise<FraudAppealViewRow | undefined> {
    const raw = await hget(this.redis, this.#key(accountId), caseId);
    return raw ? (JSON.parse(raw) as FraudAppealViewRow) : undefined;
  }
  async list(accountId: string): Promise<FraudAppealViewRow[]> {
    return (await hvals(this.redis, this.#key(accountId))).map((x) => JSON.parse(x) as FraudAppealViewRow);
  }
  async clear(): Promise<void> {
    // 계정별 키라 전체 삭제는 하지 않는다(시험은 메모리 저장소를 쓴다)
  }
}
