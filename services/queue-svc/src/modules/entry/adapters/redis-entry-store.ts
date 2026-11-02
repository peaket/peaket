// 진입 3단계를 대기열 Redis(Valkey) Lua로 한다(docs/features/queue-admission.md §3, docs/data.md §3).
// 사람 키는 pid를 해시 태그로 둔다(q:dup:{pid}:E와 q:adm:{pid}:E가 한 슬롯이라 ①·③이 한 Lua다). 회차 키는 {event:E} 태그로 한 슬롯이다.
// 키에 넣는 값(회차 ID·pid)은 받는 층이 [A-Za-z0-9_-] 1~64자만 넘긴다(해시 태그를 깨지 않게).
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import type { EntryStore, PreemptResult, RecordedEntry, RecordResult } from '../domain/ports.js';
import { QueueStoreUnavailable, type ReasonCategory, REASONS } from '../domain/queue.js';

export const QUEUE_REDIS = Symbol('queue.QueueRedis');

export const keys = {
  dup: (pid: string, e: string) => `q:dup:{${pid}}:${e}`,
  adm: (pid: string, e: string) => `q:adm:{${pid}}:${e}`,
  seq: (e: string) => `q:{event:${e}}:seq`,
  skipped: (e: string) => `q:{event:${e}}:skipped`,
  removed: (e: string) => `q:{event:${e}}:removed`,
  verify: (e: string) => `q:{event:${e}}:verify`,
  cfg: (e: string) => `q:{event:${e}}:cfg`,
};

// ① 사람 슬롯: 입장 키가 있으면 거절, 없으면 PENDING:{요청 ID}로 선점(같은 요청은 이어서, 기록이 끝났으면 그 번호)
const PREEMPT = redisScript(`
if redis.call('EXISTS', KEYS[2]) == 1 then return {'ADMITTED'} end
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], 'PENDING:' .. ARGV[1], 'PX', ARGV[2])
  return {'PROCEED'}
end
if v == 'PENDING:' .. ARGV[1] then return {'PROCEED'} end
local s, g, rq, jny, vr = string.match(v, '^(%d+):(%d+):([^:]+):([^:]*):([^:]*)$')
if s and rq == ARGV[1] then return {'RECORDED', s, g, jny, vr} end
return {'BUSY'}
`);

// 회차 키의 수명은 부를 때마다 더 늦은 쪽으로만 늘린다(회차 연기로 판매 종료가 늦춰져도 옛 일정에 사라지지 않게. 당기지는 않는다).
// 수명이 없는 키(-1, 예: RB-05의 INCRBY로 먼저 생긴 카운터)에도 건다. 없는 키(-2)는 PEXPIREAT이 아무 일도 하지 않는다
const EXTEND = `
local function extend(key, at)
  if redis.call('PEXPIRETIME', key) < tonumber(at) then redis.call('PEXPIREAT', key, at) end
end
`;

// ② 회차 슬롯: 순번 카운터와 세대(건너뛴 구간 줄 수 + 1). 카운터 수명은 회차 일정 사본과 같다
const NUMBER = redisScript(`${EXTEND}
local seq = redis.call('INCR', KEYS[1])
extend(KEYS[1], ARGV[1])
return {seq, redis.call('LLEN', KEYS[2]) + 1}
`);

// ③ 사람 슬롯: 입장 키가 있으면 거절(FND-130이 넘긴 것). 값이 내 PENDING이거나 비었을 때만 {번호}:{세대}:{요청 ID}:{jny}:{vr}로 기록, 수명은 판매 종료.
// 같은 요청의 다른 기록이 있으면(같은 요청이 동시에 두 번) 먼저 기록된 값을 돌려준다
const RECORD = redisScript(`
if redis.call('EXISTS', KEYS[2]) == 1 then return {'ADMITTED'} end
local v = redis.call('GET', KEYS[1])
if v and v ~= 'PENDING:' .. ARGV[1] then
  local s, g, rq, jny, vr = string.match(v, '^(%d+):(%d+):([^:]+):([^:]*):([^:]*)$')
  if s and rq == ARGV[1] then return {'SAME', s, g, jny, vr} end
  return {'TAKEN'}
end
redis.call('SET', KEYS[1], ARGV[2] .. ':' .. ARGV[3] .. ':' .. ARGV[1] .. ':' .. ARGV[5] .. ':' .. ARGV[6], 'PXAT', ARGV[4])
return {'RECORDED'}
`);

const MARK_REMOVED = redisScript(`${EXTEND}
redis.call('SETBIT', KEYS[1], ARGV[1], 1)
extend(KEYS[1], ARGV[2])
return 1
`);

// 빠진 번호 비트맵은 회차 일정 사본처럼(판매 종료 + 1일), q:{event:E}:verify는 q:dup처럼(판매 종료) 지운다(docs/data.md §3)
const MARK_VERIFYING = redisScript(`${EXTEND}
redis.call('SETBIT', KEYS[1], ARGV[1], 1)
redis.call('HSETNX', KEYS[2], ARGV[2], ARGV[3])
extend(KEYS[1], ARGV[4])
extend(KEYS[2], ARGV[5])
return 1
`);

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

/** 일시 장애(마감 초과·끊김·클러스터 재구성)는 업무 오류로 바꿔 503으로 답하게 한다. 그 밖(스크립트 오류 같은 버그)은 그대로 던진다 */
export async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRedisUnavailable(err)) throw new QueueStoreUnavailable(err);
    throw err;
  }
}

/** Lua가 돌려준 기록 값 칸(번호·세대·jny·vr) */
function entry(r: unknown[]): RecordedEntry {
  const vr = REASONS.find((x) => x === str(r[4] ?? '')) as ReasonCategory | undefined;
  return { seq: Number(str(r[1])), gen: Number(str(r[2])), jny: str(r[3]), ...(vr ? { vr } : {}) };
}

@Injectable()
export class RedisEntryStore implements EntryStore {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async preempt(i: { pid: string; eventId: string; requestId: string; pendingTtlMs: number }): Promise<PreemptResult> {
    const r = (await guard(this.redis.evalScript(PREEMPT, [keys.dup(i.pid, i.eventId), keys.adm(i.pid, i.eventId)], [i.requestId, String(i.pendingTtlMs)]))) as unknown[];
    const kind = str(r[0]);
    if (kind === 'RECORDED') return { kind, ...entry(r) };
    if (kind === 'PROCEED' || kind === 'ADMITTED' || kind === 'BUSY') return { kind };
    throw new Error(`선점 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async number(i: { eventId: string; expireAtMs: number }): Promise<{ seq: number; gen: number }> {
    const r = (await guard(this.redis.evalScript(NUMBER, [keys.seq(i.eventId), keys.skipped(i.eventId)], [String(i.expireAtMs)]))) as unknown[];
    return { seq: Number(r[0]), gen: Number(r[1]) };
  }

  async record(i: { pid: string; eventId: string; requestId: string; seq: number; gen: number; jny: string; vr?: ReasonCategory; expireAtMs: number }): Promise<RecordResult> {
    const args = [i.requestId, String(i.seq), String(i.gen), String(i.expireAtMs), i.jny, i.vr ?? ''];
    const r = (await guard(this.redis.evalScript(RECORD, [keys.dup(i.pid, i.eventId), keys.adm(i.pid, i.eventId)], args))) as unknown[];
    const kind = str(r[0]);
    if (kind === 'SAME') return { kind, ...entry(r) };
    if (kind === 'RECORDED' || kind === 'ADMITTED' || kind === 'TAKEN') return { kind };
    throw new Error(`기록 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async markRemoved(i: { eventId: string; seq: number; expireAtMs: number }): Promise<void> {
    await guard(this.redis.evalScript(MARK_REMOVED, [keys.removed(i.eventId)], [String(i.seq), String(i.expireAtMs)]));
  }

  async markVerifying(i: { eventId: string; seq: number; ticketHash: string; atMs: number; reason: ReasonCategory; expireAtMs: number; verifyExpireAtMs: number }): Promise<void> {
    const args = [String(i.seq), i.ticketHash, `VERIFYING:${i.atMs}:${i.reason}`, String(i.expireAtMs), String(i.verifyExpireAtMs)];
    await guard(this.redis.evalScript(MARK_VERIFYING, [keys.removed(i.eventId), keys.verify(i.eventId)], args));
  }
}
