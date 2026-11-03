// 진입 3단계를 대기열 Redis(Valkey) Lua로 한다(docs/features/queue-admission.md §3·'묶음의 첫 구현', docs/data.md §3).
// 사람 키는 pid를 해시 태그로 둔다(q:dup:{pid}:E와 q:adm:{pid}:E가 한 슬롯이라 ①·③이 한 Lua다). 회차 키는 {event:E} 태그로 한 슬롯이다.
// 키에 넣는 값(회차 ID·pid)은 받는 층이 [A-Za-z0-9_-] 1~64자만 넘긴다(해시 태그를 깨지 않게). 이름은 명세 specs/queue.qnt의 동작 이름이다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import type { BatchedEntry, BatchOutcome, EntryStore, NumberBatchInput, NumberInput, NumberResult, PreemptResult, RecordedEntry, RecordResult } from '../domain/ports.js';
import { BATCH_NO, QueueStoreUnavailable, type ReasonCategory, REASONS } from '../domain/queue.js';
import {
  BATCH_RECORD_LUA,
  BATCH_STATE_LUA,
  CONVERT_LUA,
  DROP_BATCH_LUA,
  MARK_REMOVED_LUA,
  MARK_VERIFYING_LUA,
  NUMBER_BATCH_LUA,
  PREEMPT_LUA,
  RECORD_LUA,
  RELEASE_LUA,
  REQUEST_REPAIR_LUA,
} from './entry-lua.js';

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
  /** 리더가 쓰는 값(BUILD_ORDER PRF-090). 대기 상태 파일이 읽는다 */
  serving: (e: string) => `q:{event:${e}}:serving`,
  servingLog: (e: string) => `q:{event:${e}}:serving_log`,
  calls: (e: string) => `q:{event:${e}}:calls`,
  /** 묶음 결과(회차 태그 없이 토큰 해시로 흩어 둔다, q:lobby:{hash}와 같음) */
  batchResult: (tokenHash: string) => `q:batch:{${tokenHash}}`,
};

// Lua 원문은 entry-lua.ts에 있다(측정 도구와 같은 원문)
const PREEMPT = redisScript(PREEMPT_LUA);
const RELEASE = redisScript(RELEASE_LUA);
const NUMBER_BATCH = redisScript(NUMBER_BATCH_LUA);
const RECORD = redisScript(RECORD_LUA);
const BATCH_RECORD = redisScript(BATCH_RECORD_LUA);
const BATCH_STATE = redisScript(BATCH_STATE_LUA);
const REQUEST_REPAIR = redisScript(REQUEST_REPAIR_LUA);
const CONVERT = redisScript(CONVERT_LUA);
const DROP_BATCH = redisScript(DROP_BATCH_LUA);
const MARK_REMOVED = redisScript(MARK_REMOVED_LUA);
const MARK_VERIFYING = redisScript(MARK_VERIFYING_LUA);

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

  async numberBatch(i: NumberBatchInput): Promise<NumberResult[]> {
    const e = i.eventId;
    const args = [
      String(i.expireAtMs),
      String(i.opensAtMs ?? 0),
      String(i.closeAtMs ?? 0),
      i.lobbyShuffle ? '1' : '0',
      i.openBatch ? '1' : '0',
      String(i.batchExpireAtMs ?? i.expireAtMs),
      String(i.items.length),
      ...i.items.flatMap((it) => [it.eligible ? '1' : '0', it.tokenHash ?? '']),
    ];
    const r = (await guard(this.redis.evalScript(NUMBER_BATCH, [keys.seq(e), keys.skipped(e), keys.batchDone(e), keys.batchMembers(e), keys.lobbyMembers(e)], args))) as unknown[];
    const head = str(r[0]);
    if (head === 'EARLY') return i.items.map(() => ({ kind: 'EARLY' }));
    if (head !== 'OK') throw new Error(`번호 Lua가 모르는 값을 돌려줬다: ${head}`);
    const gen = Number(r[1]);
    return i.items.map((_, k): NumberResult => {
      const kind = str(r[2 + 2 * k]);
      const v = Number(r[3 + 2 * k]);
      if (kind === 'N') return { kind: 'NUMBERED', seq: v, gen };
      if (kind === 'B') return { kind: 'BATCHING' };
      if (kind === 'W') return { kind: 'WAIT', retryAfterSeconds: v };
      throw new Error(`번호 Lua가 모르는 값을 돌려줬다: ${kind}`);
    });
  }

  async number(i: NumberInput): Promise<NumberResult> {
    const { eligible, tokenHash, ...common } = i;
    return (await this.numberBatch({ ...common, items: [{ eligible, tokenHash }] }))[0]!;
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
