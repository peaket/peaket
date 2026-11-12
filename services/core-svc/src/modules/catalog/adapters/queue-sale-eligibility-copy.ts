// 판매 자격 명단 사본을 대기열 Redis에 쓰는 어댑터(ADR-0261 결정 9, OPEN[33] 소유자 결정 (가), BUILD_ORDER HOT-251).
// 키: q:{event:E}:elig:{listKey} (SET), 판: ...:v (문자열). 임시 키에 넣고 판이 클 때만 RENAME하며,
// 지우기는 그 판 이하일 때만 한다. 수명은 명단 파기 시각(destroy_due_at)이다.
import { randomBytes } from 'node:crypto';
import type { EligibilityCopyDrop, EligibilityCopyPut, SaleEligibilityCopy } from '../domain/eligibility-ports.js';

/** HotRedis의 command만 쓰는 최소 포트(시험은 가짜를 넣는다) */
export interface QueueRedis {
  command(args: string[], o?: { key?: string }): Promise<unknown>;
  close?(): Promise<void>;
}

const KEY = (eventId: string, listKey: string) => `q:${eventId.toLowerCase()}:elig:${listKey}`;
const VKEY = (eventId: string, listKey: string) => `${KEY(eventId, listKey)}:v`;
const BATCH = 10_000;

/** 판이 지금보다 클 때만 임시 키를 본 키로 바꾼다. 아니면 임시 키를 지운다 */
const RENAME_IF_NEWER = `
local cur = tonumber(redis.call('GET', KEYS[2]) or '-1')
local v = tonumber(ARGV[1])
if cur >= v then
  redis.call('DEL', KEYS[1])
  return 0
end
redis.call('RENAME', KEYS[1], KEYS[2])
redis.call('SET', KEYS[3], ARGV[1])
redis.call('PEXPIREAT', KEYS[2], ARGV[2])
redis.call('PEXPIREAT', KEYS[3], ARGV[2])
return 1
`;

/** 판이 지금보다 클 때만 빈 명단(본 키 없음)으로 바꾼다 */
const EMPTY_IF_NEWER = `
local cur = tonumber(redis.call('GET', KEYS[2]) or '-1')
local v = tonumber(ARGV[1])
if cur >= v then return 0 end
redis.call('DEL', KEYS[1])
redis.call('SET', KEYS[2], ARGV[1])
redis.call('PEXPIREAT', KEYS[2], ARGV[2])
return 1
`;

/** 그 판 이하일 때만 지운다(지운 뒤 다시 올린 더 큰 판은 남는다) */
const DROP_IF_NOT_NEWER = `
local cur = tonumber(redis.call('GET', KEYS[2]) or '-1')
local v = tonumber(ARGV[1])
if cur > v then return 0 end
redis.call('DEL', KEYS[1])
redis.call('DEL', KEYS[2])
return 1
`;

export class QueueSaleEligibilityCopy implements SaleEligibilityCopy {
  readonly connected = true;

  constructor(private readonly redis: QueueRedis) {}

  async put(c: EligibilityCopyPut): Promise<void> {
    const expire = String(c.expiresAt.getTime());
    for (const eventId of c.eventIds) {
      const final = KEY(eventId, c.listKey);
      const version = VKEY(eventId, c.listKey);
      const temp = `${final}:tmp:${randomBytes(8).toString('hex')}`;
      try {
        if (c.accountIds.length === 0) {
          await this.redis.command(['EVAL', EMPTY_IF_NEWER, '2', final, version, String(c.version), expire], { key: final });
          continue;
        }
        for (let i = 0; i < c.accountIds.length; i += BATCH) {
          const ids = c.accountIds.slice(i, i + BATCH);
          await this.redis.command(['SADD', temp, ...ids], { key: temp });
        }
        await this.redis.command(['EVAL', RENAME_IF_NEWER, '3', temp, final, version, String(c.version), expire], { key: final });
      } catch (e) {
        await this.redis.command(['DEL', temp], { key: temp }).catch(() => undefined);
        throw e;
      }
    }
  }

  async drop(c: EligibilityCopyDrop): Promise<void> {
    for (const eventId of c.eventIds) {
      await this.redis.command(['EVAL', DROP_IF_NOT_NEWER, '2', KEY(eventId, c.listKey), VKEY(eventId, c.listKey), String(c.version)], { key: KEY(eventId, c.listKey) });
    }
  }

  close(): Promise<void> {
    return this.redis.close?.() ?? Promise.resolve();
  }
}
