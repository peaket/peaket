// 진입 3단계를 대기열 Redis(Valkey) Lua로 한다(docs/features/queue-admission.md §3·'묶음의 첫 구현', docs/data.md §3).
// 사람 키는 pid를 해시 태그로 둔다(q:dup:{pid}:E와 q:adm:{pid}:E가 한 슬롯이라 ①·③이 한 Lua다). 회차 키는 {event:E} 태그로 한 슬롯이다.
// 키에 넣는 값(회차 ID·pid)은 받는 층이 [A-Za-z0-9_-] 1~64자만 넘긴다(해시 태그를 깨지 않게). 이름은 명세 specs/queue.qnt의 동작 이름이다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import type { BatchedEntry, BatchOutcome, EntryStore, NumberInput, NumberResult, PreemptResult, RecordedEntry, RecordResult } from '../domain/ports.js';
import { BATCH_NO, QueueStoreUnavailable, type ReasonCategory, REASONS } from '../domain/queue.js';

export const QUEUE_REDIS = Symbol('queue.QueueRedis');

export const keys = {
  dup: (pid: string, e: string) => `q:dup:{${pid}}:${e}`,
  adm: (pid: string, e: string) => `q:adm:{${pid}}:${e}`,
  seq: (e: string) => `q:{event:${e}}:seq`,
  skipped: (e: string) => `q:{event:${e}}:skipped`,
  removed: (e: string) => `q:{event:${e}}:removed`,
  verify: (e: string) => `q:{event:${e}}:verify`,
  cfg: (e: string) => `q:{event:${e}}:cfg`,
  batchDone: (e: string) => `q:{event:${e}}:batch_done`,
  batchMembers: (e: string, n: number = BATCH_NO) => `q:{event:${e}}:batch_members:${n}`,
  lobbyMembers: (e: string) => `q:{event:${e}}:lobby_members`,
  /** 묶음 결과(회차 태그 없이 토큰 해시로 흩어 둔다, q:lobby:{hash}와 같음) */
  batchResult: (tokenHash: string) => `q:batch:{${tokenHash}}`,
};

// 회차 키의 수명은 부를 때마다 더 늦은 쪽으로만 늘린다(회차 연기로 판매 종료가 늦춰져도 옛 일정에 사라지지 않게. 당기지는 않는다).
// 수명이 없는 키(-1, 예: RB-05의 INCRBY로 먼저 생긴 카운터)에도 건다. 없는 키(-2)는 PEXPIREAT이 아무 일도 하지 않는다
const EXTEND = `
local function extend(key, at)
  if redis.call('PEXPIRETIME', key) < tonumber(at) then redis.call('PEXPIREAT', key, at) end
end
`;
// 사람 슬롯 값 읽기: 번호 기록 {번호}:{세대}:{요청 ID}:{jny}:{vr}, 묶음 기록 BATCH:1:{토큰 해시}:{요청 ID}:{jny}:{vr}
const RECORDED = `'^(%d+):(%d+):([^:]+):([^:]*):([^:]*)$'`;
const BATCHED = `'^BATCH:1:([0-9a-f]+):([^:]+):([^:]*):([^:]*)$'`;

// ① enterPreempt: 입장 키가 있으면 거절, 없으면 PENDING:{요청 ID}로 선점(같은 요청은 이어서, 기록이 끝났으면 그 기록)
const PREEMPT = redisScript(`
if redis.call('EXISTS', KEYS[2]) == 1 then return {'ADMITTED'} end
local v = redis.call('GET', KEYS[1])
if not v then
  redis.call('SET', KEYS[1], 'PENDING:' .. ARGV[1], 'PX', ARGV[2])
  return {'PROCEED'}
end
if v == 'PENDING:' .. ARGV[1] then return {'PROCEED'} end
local bh, brq, bjny, bvr = string.match(v, ${BATCHED})
if bh then
  if brq == ARGV[1] then return {'BATCH', bh, bjny, bvr} end
  return {'BUSY'}
end
local s, g, rq, jny, vr = string.match(v, ${RECORDED})
if s and rq == ARGV[1] then return {'RECORDED', s, g, jny, vr} end
return {'BUSY'}
`);

// ②가 번호를 주지 않았으면(서버 시각으로 오픈 전, 묶음 구간의 오픈 뒤 발급 토큰) 내 선점을 푼다. 남기면 새 요청 ID로 다시 온 같은 사람이 선점 수명 동안 409를 받는다
const RELEASE = redisScript(`
if redis.call('GET', KEYS[1]) == 'PENDING:' .. ARGV[1] then redis.call('DEL', KEYS[1]) return 1 end
return 0
`);

// ② enterNumber: 서버 시각(TIME)으로 구간을 보고, 로비 표시 → 묶음(구간 안이면 SADD, 오픈 뒤 발급 토큰은 WAIT) → 닫힘 표시 → INCR.
// 표시 값은 {첫 번호}:{크기}:{세대}이고 HSETNX라 리더와 겹쳐도 몫마다 한 번만 전진한다(중간-028). 참가자 목록(토큰 해시)은 판매 종료까지만 둔다
const NUMBER = redisScript(`${EXTEND}
local t = redis.call('TIME')
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
if now < tonumber(ARGV[2]) then return {'EARLY'} end
local gen = redis.call('LLEN', KEYS[2]) + 1
if ARGV[4] == '1' and redis.call('HEXISTS', KEYS[3], 'lobby') == 0 then
  local n = redis.call('SCARD', KEYS[5])
  local first = tonumber(redis.call('GET', KEYS[1]) or '0') + 1
  redis.call('HSETNX', KEYS[3], 'lobby', first .. ':' .. n .. ':' .. gen)
  if n > 0 then redis.call('INCRBY', KEYS[1], n) end
end
if ARGV[5] == '1' then
  local closeAt = tonumber(ARGV[3])
  local closed = redis.call('HEXISTS', KEYS[3], '1') == 1
  if not closed and now < closeAt then
    if ARGV[6] ~= '1' then return {'WAIT', math.ceil((closeAt - now) / 1000)} end
    redis.call('SADD', KEYS[4], ARGV[7])
    extend(KEYS[4], ARGV[8])
    extend(KEYS[3], ARGV[1])
    return {'BATCHING'}
  end
  if not closed then
    local size = redis.call('SCARD', KEYS[4])
    local first = tonumber(redis.call('GET', KEYS[1]) or '0') + 1
    redis.call('HSETNX', KEYS[3], '1', first .. ':' .. size .. ':' .. gen)
    if size > 0 then redis.call('INCRBY', KEYS[1], size) end
  end
end
local seq = redis.call('INCR', KEYS[1])
extend(KEYS[1], ARGV[1])
extend(KEYS[3], ARGV[1])
return {'NUMBERED', seq, gen}
`);

// ③ enterRecord: 입장 키가 있으면 거절(FND-130이 넘긴 것). 값이 내 PENDING이거나 비었을 때만 {번호}:{세대}:{요청 ID}:{jny}:{vr}로 기록, 수명은 판매 종료.
// 같은 요청의 다른 기록이 있으면(같은 요청이 동시에 두 번) 먼저 기록된 값을, 같은 요청이 구간 안에서 먼저 묶음에 들었으면 그 토큰 해시를 돌려준다
const RECORD = redisScript(`
if redis.call('EXISTS', KEYS[2]) == 1 then return {'ADMITTED'} end
local v = redis.call('GET', KEYS[1])
if v and v ~= 'PENDING:' .. ARGV[1] then
  local s, g, rq, jny, vr = string.match(v, ${RECORDED})
  if s and rq == ARGV[1] then return {'SAME', s, g, jny, vr} end
  local bh, brq = string.match(v, ${BATCHED})
  if bh and brq == ARGV[1] then return {'BATCH', bh} end
  return {'TAKEN'}
end
redis.call('SET', KEYS[1], ARGV[2] .. ':' .. ARGV[3] .. ':' .. ARGV[1] .. ':' .. ARGV[5] .. ':' .. ARGV[6], 'PXAT', ARGV[4])
return {'RECORDED'}
`);

// ③ enterBatchRecord(OPEN[14]): 선점 값을 판매 종료까지 남는 묶음 기록으로 바꾼다. 입장 키도 본다. 기록된 토큰 해시를 돌려준다
// (같은 요청이 다른 토큰으로 먼저 기록했으면 그 해시라, 202의 결과 파일 경로가 사람 슬롯의 기록과 같다). 같은 요청이 구간 끝을 걸쳐
// 와서 먼저 번호를 기록했으면 그 기록을 돌려준다(SAME)
const BATCH_RECORD = redisScript(`
if redis.call('EXISTS', KEYS[2]) == 1 then return {'ADMITTED'} end
local v = redis.call('GET', KEYS[1])
if v and v ~= 'PENDING:' .. ARGV[1] then
  local bh, brq = string.match(v, ${BATCHED})
  if bh and brq == ARGV[1] then return {'BATCHED', bh} end
  local s, g, rq, jny, vr = string.match(v, ${RECORDED})
  if s and rq == ARGV[1] then return {'SAME', s, g, jny, vr} end
  return {'TAKEN'}
end
redis.call('SET', KEYS[1], 'BATCH:1:' .. ARGV[2] .. ':' .. ARGV[1] .. ':' .. ARGV[3] .. ':' .. ARGV[4], 'PXAT', ARGV[5])
return {'BATCHED', ARGV[2]}
`);

// 결과 키가 없을 때 회차 슬롯에서 본다: 게시 전(PENDING), 참가자(MEMBER, 결과 키를 잃음), 참가자 목록에 없음(MISSING, SADD를 잃음)
const BATCH_STATE = redisScript(`
if redis.call('HEXISTS', KEYS[1], 'pub:1') == 0 then return 'PENDING' end
if redis.call('SISMEMBER', KEYS[2], ARGV[1]) == 1 then return 'MEMBER' end
return 'MISSING'
`);

// 다시 쓰기 청하기: admission-ctrl이 같은 입력으로 결과를 다시 쓰고 지운다. 값은 처음 청한 서버 시각이다
const REQUEST_REPAIR = redisScript(`
local t = redis.call('TIME')
redis.call('HSETNX', KEYS[1], 'repair:1', tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000))
return 1
`);

// 게시 뒤 같은 요청의 묶음 기록을 번호 기록으로 바꾼다. 이미 바뀌었으면(같은 요청의 동시 재시도) 그 기록을 돌려준다
const CONVERT = redisScript(`
local v = redis.call('GET', KEYS[1])
if not v then return {'GONE'} end
local bh, brq, bjny, bvr = string.match(v, ${BATCHED})
if bh and brq == ARGV[1] and bh == ARGV[2] then
  redis.call('SET', KEYS[1], ARGV[3] .. ':' .. ARGV[4] .. ':' .. ARGV[1] .. ':' .. bjny .. ':' .. bvr, 'PXAT', ARGV[5])
  return {'RECORDED', ARGV[3], ARGV[4], bjny, bvr}
end
local s, g, rq, jny, vr = string.match(v, ${RECORDED})
if s and rq == ARGV[1] then return {'RECORDED', s, g, jny, vr} end
return {'GONE'}
`);

// batchMissing: 결과에 없는 같은 요청의 묶음 기록을 지운다
const DROP_BATCH = redisScript(`
local v = redis.call('GET', KEYS[1])
if not v then return 0 end
local bh, brq = string.match(v, ${BATCHED})
if bh and brq == ARGV[1] and bh == ARGV[2] then redis.call('DEL', KEYS[1]) return 1 end
return 0
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
const reason = (v: unknown) => REASONS.find((x) => x === str(v ?? '')) as ReasonCategory | undefined;

/** 일시 장애(마감 초과·끊김·클러스터 재구성)는 업무 오류로 바꿔 503으로 답하게 한다. 그 밖(스크립트 오류 같은 버그)은 그대로 던진다 */
export async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRedisUnavailable(err)) throw new QueueStoreUnavailable(err);
    throw err;
  }
}

/** Lua가 돌려준 번호 기록 칸(번호·세대·jny·vr) */
function entry(r: unknown[]): RecordedEntry {
  const vr = reason(r[4]);
  return { seq: Number(str(r[1])), gen: Number(str(r[2])), jny: str(r[3]), ...(vr ? { vr } : {}) };
}

/** Lua가 돌려준 묶음 기록 칸(토큰 해시·jny·vr) */
function batchEntry(r: unknown[]): BatchedEntry {
  const vr = reason(r[3]);
  return { tokenHash: str(r[1]), jny: str(r[2]), ...(vr ? { vr } : {}) };
}

const RESULT = /^(\d+):(\d+)$/;

@Injectable()
export class RedisEntryStore implements EntryStore {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async preempt(i: { pid: string; eventId: string; requestId: string; pendingTtlMs: number }): Promise<PreemptResult> {
    const r = (await guard(this.redis.evalScript(PREEMPT, [keys.dup(i.pid, i.eventId), keys.adm(i.pid, i.eventId)], [i.requestId, String(i.pendingTtlMs)]))) as unknown[];
    const kind = str(r[0]);
    if (kind === 'RECORDED') return { kind, ...entry(r) };
    if (kind === 'BATCH') return { kind, ...batchEntry(r) };
    if (kind === 'PROCEED' || kind === 'ADMITTED' || kind === 'BUSY') return { kind };
    throw new Error(`선점 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async release(i: { pid: string; eventId: string; requestId: string }): Promise<void> {
    await guard(this.redis.evalScript(RELEASE, [keys.dup(i.pid, i.eventId)], [i.requestId]));
  }

  async number(i: NumberInput): Promise<NumberResult> {
    const e = i.eventId;
    const args = [
      String(i.expireAtMs),
      String(i.opensAtMs ?? 0),
      String(i.closeAtMs ?? 0),
      i.lobbyShuffle ? '1' : '0',
      i.openBatch ? '1' : '0',
      i.eligible ? '1' : '0',
      i.tokenHash ?? '',
      String(i.batchExpireAtMs ?? i.expireAtMs),
    ];
    const r = (await guard(this.redis.evalScript(NUMBER, [keys.seq(e), keys.skipped(e), keys.batchDone(e), keys.batchMembers(e), keys.lobbyMembers(e)], args))) as unknown[];
    const kind = str(r[0]);
    if (kind === 'NUMBERED') return { kind, seq: Number(r[1]), gen: Number(r[2]) };
    if (kind === 'WAIT') return { kind, retryAfterSeconds: Number(r[1]) };
    if (kind === 'BATCHING' || kind === 'EARLY') return { kind };
    throw new Error(`번호 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async record(i: { pid: string; eventId: string; requestId: string; seq: number; gen: number; jny: string; vr?: ReasonCategory; expireAtMs: number }): Promise<RecordResult> {
    const args = [i.requestId, String(i.seq), String(i.gen), String(i.expireAtMs), i.jny, i.vr ?? ''];
    const r = (await guard(this.redis.evalScript(RECORD, [keys.dup(i.pid, i.eventId), keys.adm(i.pid, i.eventId)], args))) as unknown[];
    const kind = str(r[0]);
    if (kind === 'SAME') return { kind, ...entry(r) };
    if (kind === 'BATCH') return { kind, tokenHash: str(r[1]) };
    if (kind === 'RECORDED' || kind === 'ADMITTED' || kind === 'TAKEN') return { kind };
    throw new Error(`기록 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async batchRecord(i: {
    pid: string;
    eventId: string;
    requestId: string;
    tokenHash: string;
    jny: string;
    vr?: ReasonCategory;
    expireAtMs: number;
  }): Promise<{ kind: 'BATCHED'; tokenHash: string } | ({ kind: 'SAME' } & RecordedEntry) | { kind: 'ADMITTED' } | { kind: 'TAKEN' }> {
    const args = [i.requestId, i.tokenHash, i.jny, i.vr ?? '', String(i.expireAtMs)];
    const r = (await guard(this.redis.evalScript(BATCH_RECORD, [keys.dup(i.pid, i.eventId), keys.adm(i.pid, i.eventId)], args))) as unknown[];
    const kind = str(r[0]);
    if (kind === 'BATCHED') return { kind, tokenHash: str(r[1]) };
    if (kind === 'SAME') return { kind, ...entry(r) };
    if (kind === 'ADMITTED' || kind === 'TAKEN') return { kind };
    throw new Error(`묶음 기록 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  // 결과 키를 먼저 본다. 게시 뒤 묶음 참가자가 모두 다시 올 때 회차 슬롯(한 샤드)을 거치지 않게 하려는 것이다
  async batchResult(i: { eventId: string; tokenHash: string }): Promise<BatchOutcome> {
    const hit = await this.#result(i.tokenHash);
    if (hit) return hit;
    const done = keys.batchDone(i.eventId);
    const state = str(await guard(this.redis.evalScript(BATCH_STATE, [done, keys.batchMembers(i.eventId)], [i.tokenHash])));
    if (state === 'PENDING' || state === 'MISSING') return { kind: state };
    if (state !== 'MEMBER') throw new Error(`묶음 상태 Lua가 모르는 값을 돌려줬다: ${state}`);
    // 결과 키를 처음 본 뒤에 게시가 끝났을 수 있으니 한 번 더 본다. 그래도 없으면 잃은 것이다
    const again = await this.#result(i.tokenHash);
    if (again) return again;
    await guard(this.redis.evalScript(REQUEST_REPAIR, [done], []));
    return { kind: 'REPAIRING' };
  }

  async #result(tokenHash: string): Promise<BatchOutcome | null> {
    const rk = keys.batchResult(tokenHash);
    const v = await guard(this.redis.command(['GET', rk], { key: rk }));
    if (v === null || v === undefined) return null;
    const m = RESULT.exec(str(v));
    if (!m) throw new Error(`묶음 결과 값의 모양이 틀렸다: ${rk}`);
    return { kind: 'RESULT', seq: Number(m[1]), gen: Number(m[2]) };
  }

  async convertBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string; seq: number; gen: number; expireAtMs: number }): Promise<({ kind: 'RECORDED' } & RecordedEntry) | { kind: 'GONE' }> {
    const args = [i.requestId, i.tokenHash, String(i.seq), String(i.gen), String(i.expireAtMs)];
    const r = (await guard(this.redis.evalScript(CONVERT, [keys.dup(i.pid, i.eventId)], args))) as unknown[];
    return str(r[0]) === 'RECORDED' ? { kind: 'RECORDED', ...entry(r) } : { kind: 'GONE' };
  }

  async dropBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string }): Promise<void> {
    await guard(this.redis.evalScript(DROP_BATCH, [keys.dup(i.pid, i.eventId)], [i.requestId, i.tokenHash]));
  }

  async markRemoved(i: { eventId: string; seq: number; expireAtMs: number }): Promise<void> {
    await guard(this.redis.evalScript(MARK_REMOVED, [keys.removed(i.eventId)], [String(i.seq), String(i.expireAtMs)]));
  }

  async markVerifying(i: { eventId: string; seq: number; ticketHash: string; atMs: number; reason: ReasonCategory; expireAtMs: number; verifyExpireAtMs: number }): Promise<void> {
    const args = [String(i.seq), i.ticketHash, `VERIFYING:${i.atMs}:${i.reason}`, String(i.expireAtMs), String(i.verifyExpireAtMs)];
    await guard(this.redis.evalScript(MARK_VERIFYING, [keys.removed(i.eventId), keys.verify(i.eventId)], args));
  }
}
