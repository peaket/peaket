// 진입 3단계를 대기열 Redis(Valkey) Lua로 한다(docs/features/queue-admission.md §3·'묶음의 첫 구현', docs/data.md §3).
// 사람 키는 pid를 해시 태그로 둔다(q:dup:{pid}:E와 q:adm:{pid}:E가 한 슬롯이라 ①·③이 한 Lua다). 회차 키는 {event:E} 태그로 한 슬롯이다.
// 키에 넣는 값(회차 ID·pid)은 받는 층이 [A-Za-z0-9_-] 1~64자만 넘긴다(해시 태그를 깨지 않게). 이름은 명세 specs/queue.qnt의 동작 이름이다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { type HotRedis, isRedisUnavailable, type RedisScript, redisScript } from '@peaket/platform';
import { ALGORITHM, DRAND_CHAIN, type ShuffleGroup } from '@peaket/shuffle';
import type { BatchedEntry, BatchOutcome, CommitRecord, EntryStore, NumberBatchInput, NumberInput, NumberResult, Rb05Confirm, Rb05Input, Rb05Result, PreemptResult, RecordedEntry, RecordResult, ShuffleCommitStore } from '../domain/ports.js';
import { ARRIVAL_SLOT_INITIAL, BATCH_NO, type HeldRecord, parseHeld, QueueStoreUnavailable, RB05_CONFIRM_WAIT_MS, type ReasonCategory, REASONS } from '../domain/queue.js';
import {
  ADD_LOBBY_MEMBER_LUA,
  LEAVE_MEMBER_LUA,
  LEAVE_NUMBER_LUA,
  LOBBY_WINDOW_LUA,
  DROP_LOBBY_LUA,
  RECORD_LOBBY_LUA,
  REMOVE_LOBBY_MEMBER_LUA,
  WRITE_COMMIT_LUA,
  BATCH_RECORD_LUA,
  BATCH_STATE_LUA,
  CLAIM_ARRIVAL_LUA,
  CONVERT_LUA,
  DROP_BATCH_LUA,
  DROP_OWN_LUA,
  MARK_REMOVED_LUA,
  MARK_VERIFYING_LUA,
  MIRROR_LUA,
  NUMBER_BATCH_LUA,
  PREEMPT_LUA,
  RB05_CLEAR_LUA,
  RB05_LUA,
  RB05_MARK_LUA,
  READ_OWN_LUA,
  RECORD_LUA,
  RELEASE_LUA,
  REQUEST_REPAIR_LUA,
  SWAP_HELD_LUA,
} from './entry-lua.js';

export const QUEUE_REDIS = Symbol('queue.QueueRedis');
/** RB-05 복제 확인의 WAIT 전용 연결(ADR-0186): WAIT는 그 연결을 막으므로, 노드마다 하나뿐인 공유 연결로 보내면 같은 노드의 다른 명령이 기다린다. 없으면 공유 연결 */
export const QUEUE_WAIT_REDIS = Symbol('queue.WaitRedis');

export const keys = {
  dup: (pid: string, e: string) => `q:dup:{${pid}}:${e}`,
  adm: (pid: string, e: string) => `q:adm:{${pid}}:${e}`,
  seq: (e: string) => `q:{event:${e}}:seq`,
  skipped: (e: string) => `q:{event:${e}}:skipped`,
  removed: (e: string) => `q:{event:${e}}:removed`,
  verify: (e: string) => `q:{event:${e}}:verify`,
  cfg: (e: string) => `q:{event:${e}}:cfg`,
  /** 세대 키: 이 회차 키를 쓴 주 노드 ID(ADR-0181) */
  epoch: (e: string) => `q:{event:${e}}:epoch`,
  batchDone: (e: string) => `q:{event:${e}}:batch_done`,
  batchMembers: (e: string, n: number = BATCH_NO) => `q:{event:${e}}:batch_members:${n}`,
  lobbyMembers: (e: string) => `q:{event:${e}}:lobby_members`,
  /** 리더가 쓰는 값(BUILD_ORDER PRF-090). 대기 상태 파일이 읽는다 */
  serving: (e: string) => `q:{event:${e}}:serving`,
  servingLog: (e: string) => `q:{event:${e}}:serving_log`,
  calls: (e: string) => `q:{event:${e}}:calls`,
  /** 대기 화면에 싣는 제어 상태와 회차 판매 상태(ADR-0103·0214, docs/data.md §3). 범위가 전체면 회차 자리에 PLATFORM */
  notice: (e: string) => `q:{event:${e}}:notice`,
  /** 리더 상태(입장 일시정지 admitPaused 등, admission-ctrl이 쓴다) */
  ctl: (e: string) => `q:{event:${e}}:ctl`,
  /** 대기 상태 파일의 S3 사본을 이번 초에 쓰는 파드(ADR-0223 결정 9) */
  mirror: (e: string) => `q:{event:${e}}:mirror`,
  /** 도착 시각 칸(진입 Degraded, ADR-0223) */
  arrSlots: (e: string) => `q:{event:${e}}:arr_slots`,
  /** 도착 시각 쿠키 요청 ID 한 번만 받기(요청 ID로 샤드 전체에 흩는다, ADR-0053 결정 2) */
  arr: (reqId: string, e: string) => `q:arr:{${reqId}}:${e}`,
  /** 묶음 결과(회차 태그 없이 토큰 해시로 흩어 둔다, q:lobby:{hash}와 같음) */
  batchResult: (tokenHash: string) => `q:batch:{${tokenHash}}`,
  /** 로비 셔플 결과(ADR-0231 결정 9): {번호}:{세대} */
  lobbyResult: (tokenHash: string) => `q:lobby:{${tokenHash}}`,
  /** 셔플 공시 기록(ADR-0231 결정 6) */
  shuffle: (e: string) => `q:{event:${e}}:shuffle`,
  /** 곧 입장 대기열 셋(ADR-0104·0183). 입장 확정이 쓰고 대기 취소가 뺀다(ADR-0233) */
  soon: (e: string) => `q:{event:${e}}:soon`,
  soonAt: (e: string) => `q:{event:${e}}:soon_at`,
  soonFirst: (e: string) => `q:{event:${e}}:soon_first`,
};

// Lua 원문은 entry-lua.ts에 있다(측정 도구와 같은 원문)
const PREEMPT = redisScript(PREEMPT_LUA);
const RELEASE = redisScript(RELEASE_LUA);
const NUMBER_BATCH = redisScript(NUMBER_BATCH_LUA);
const CLAIM_ARRIVAL = redisScript(CLAIM_ARRIVAL_LUA);
const RB05 = redisScript(RB05_LUA);
const RB05_MARK = redisScript(RB05_MARK_LUA);
const RB05_CLEAR = redisScript(RB05_CLEAR_LUA);
const RECORD = redisScript(RECORD_LUA);
const READ_OWN = redisScript(READ_OWN_LUA);
const MIRROR = redisScript(MIRROR_LUA);
const DROP_OWN = redisScript(DROP_OWN_LUA);
const BATCH_RECORD = redisScript(BATCH_RECORD_LUA);
const BATCH_STATE = redisScript(BATCH_STATE_LUA);
const REQUEST_REPAIR = redisScript(REQUEST_REPAIR_LUA);
const CONVERT = redisScript(CONVERT_LUA);
const DROP_BATCH = redisScript(DROP_BATCH_LUA);
const MARK_REMOVED = redisScript(MARK_REMOVED_LUA);
const MARK_VERIFYING = redisScript(MARK_VERIFYING_LUA);
const ADD_LOBBY_MEMBER = redisScript(ADD_LOBBY_MEMBER_LUA);
const LOBBY_WINDOW = redisScript(LOBBY_WINDOW_LUA);
const REMOVE_LOBBY_MEMBER = redisScript(REMOVE_LOBBY_MEMBER_LUA);
const RECORD_LOBBY = redisScript(RECORD_LOBBY_LUA);
const DROP_LOBBY = redisScript(DROP_LOBBY_LUA);
const WRITE_COMMIT = redisScript(WRITE_COMMIT_LUA);
const LEAVE_NUMBER = redisScript(LEAVE_NUMBER_LUA);
const LEAVE_MEMBER = redisScript(LEAVE_MEMBER_LUA);
const SWAP_HELD = redisScript(SWAP_HELD_LUA);

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const reason = (v: unknown) => REASONS.find((x) => x === str(v ?? '')) as ReasonCategory | undefined;

/** 주 노드의 INFO replication에서 붙은 온라인 복제본 수(slaveN:...,state=online) */
export function onlineReplicas(info: string): number {
  return info.split(/\r?\n/).filter((l) => /^slave\d+:/.test(l) && /(^|,)state=online(,|$)/.test(l.slice(l.indexOf(':') + 1))).length;
}

/** CLIENT INFO에서 이 연결의 표지: 서버가 붙인 연결 번호(id)와 그 서버의 주소(laddr). 다시 붙으면 id가 바뀌고 다른 노드면 laddr가 다르다 */
export function connOf(info: string): string | null {
  const id = /(?:^|\s)id=(\d+)/.exec(info)?.[1];
  const laddr = /(?:^|\s)laddr=(\S+)/.exec(info)?.[1];
  return id && laddr ? `${id}@${laddr}` : null;
}

/**
 * RB-05 복제 확인(ADR-0186): 연결 표지 → 표시 Lua → 붙은 온라인 복제본 수 n → 같은 연결로 WAIT n → 연결 표지를 다시 견줌 → 지우기 Lua.
 * 클러스터에서는 세대 키로 주 노드를 고르므로 호출이 모두 그 주 노드로 간다. WAIT는 이 연결이 쓴 것까지만 세므로 표시 Lua의 쓰기가 RB-05 쓰기 뒤에 있어야 하고,
 * 표시와 WAIT가 같은 연결이어야 한다(연결 표지로 확인). 지우기는 표시가 돌려준 노드 표지를 넘겨 그 노드에서만 지운다.
 * 키 없는 명령(CLIENT INFO·INFO·WAIT)은 클러스터 클라이언트가 key를 무시하고 모든 샤드나 아무 노드로 보내므로 pin으로 key 슬롯의 주 노드에만 보낸다.
 * WAIT는 그 연결을 막으므로 부르는 쪽은 WAIT 전용 연결을 넘긴다(묶음 게시 확인과 같은 까닭). 그 연결에서는 다른 회차의 WAIT 뒤에 줄을 설 수 있어
 * 호출 모두에 WAIT만큼의 마감을 준다. admission-ctrl 리더 저장소에도 같은 글이 있다(leader-lua.test.ts가 견준다)
 */
export async function confirmRb05(redis: HotRedis, epochKey: string, mark: RedisScript, clear: RedisScript, waitMs: number): Promise<Rb05Confirm> {
  const deadlineMs = waitMs + 300;
  const o = { key: epochKey, deadlineMs, pin: true };
  const conn = connOf(String((await redis.command(['CLIENT', 'INFO'], o)) ?? ''));
  const node = await redis.evalScript(mark, [epochKey], [], { deadlineMs });
  if (typeof node !== 'string') return 'NONE';
  const n = onlineReplicas(String((await redis.command(['INFO', 'replication'], o)) ?? ''));
  if (n > 0) {
    const acked = Number(await redis.command(['WAIT', String(n), String(waitMs)], o));
    if (acked < n) return 'WAITING';
  }
  // 표시·INFO·WAIT가 한 연결에서 돌았나: 사이에 다시 붙었으면(플랫폼이 끊긴 명령을 새 연결로 다시 보낸다) WAIT가 표시 쓰기를 세지 않았을 수 있다
  if (conn === null || connOf(String((await redis.command(['CLIENT', 'INFO'], o)) ?? '')) !== conn) return 'WAITING';
  return Number(await redis.evalScript(clear, [epochKey], [node], { deadlineMs })) > 0 ? 'CONFIRMED' : 'NONE';
}

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
  constructor(
    @Inject(QUEUE_REDIS) private readonly redis: HotRedis,
    @Optional() @Inject(QUEUE_WAIT_REDIS) private readonly waitRedis?: HotRedis,
  ) {}

  async preempt(i: { pid: string; eventId: string; requestId: string; pendingTtlMs: number }): Promise<PreemptResult> {
    const r = (await guard(this.redis.evalScript(PREEMPT, [keys.dup(i.pid, i.eventId), keys.adm(i.pid, i.eventId)], [i.requestId, String(i.pendingTtlMs)]))) as unknown[];
    const kind = str(r[0]);
    if (kind === 'RECORDED') return { kind, ...entry(r) };
    if (kind === 'BATCH') return { kind, ...batchEntry(r) };
    if (kind === 'PROCEED' || kind === 'ADMITTED' || kind === 'BUSY' || kind === 'LEFT') return { kind };
    throw new Error(`선점 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async release(i: { pid: string; eventId: string; requestId: string }): Promise<void> {
    await guard(this.redis.evalScript(RELEASE, [keys.dup(i.pid, i.eventId)], [i.requestId]));
  }

  async numberBatch(i: NumberBatchInput): Promise<NumberResult[]> {
    const e = i.eventId;
    const arrival = i.items.some((it) => it.arrivalSlot !== undefined);
    const args = [
      String(i.expireAtMs),
      String(i.opensAtMs ?? 0),
      String(i.closeAtMs ?? 0),
      i.lobbyShuffle ? '1' : '0',
      i.openBatch ? '1' : '0',
      String(i.batchExpireAtMs ?? i.expireAtMs),
      String(i.items.length),
      ...i.items.flatMap((it) => [it.eligible ? '1' : '0', it.tokenHash ?? '']),
      // 쿠키가 있는 요청이 있을 때만 칸 인수를 뒤에 붙인다(ADR-0223 결정 6)
      ...(arrival ? [String(i.arrivalInitial ?? ARRIVAL_SLOT_INITIAL), ...i.items.map((it) => (it.arrivalSlot === undefined ? '' : String(it.arrivalSlot)))] : []),
    ];
    const ks = [keys.seq(e), keys.skipped(e), keys.batchDone(e), keys.batchMembers(e), keys.lobbyMembers(e), keys.epoch(e), keys.notice(e), ...(arrival ? [keys.arrSlots(e)] : [])];
    const r = (await guard(this.redis.evalScript(NUMBER_BATCH, ks, args))) as unknown[];
    const head = str(r[0]);
    if (head === 'RB05') return i.items.map(() => ({ kind: 'RECOVERING' }));
    if (head === 'EARLY') return i.items.map(() => ({ kind: 'EARLY' }));
    if (head === 'SOLD_OUT' || head === 'ENDED') return i.items.map(() => ({ kind: head }));
    if (head !== 'OK') throw new Error(`번호 Lua가 모르는 값을 돌려줬다: ${head}`);
    const gen = Number(r[1]);
    return i.items.map((_, k): NumberResult => {
      const kind = str(r[2 + 2 * k]);
      const v = Number(r[3 + 2 * k]);
      if (kind === 'N') return { kind: 'NUMBERED', seq: v, gen };
      if (kind === 'S') return { kind: 'NUMBERED', seq: v, gen, arrival: 'slot' };
      if (kind === 'L') return { kind: 'NUMBERED', seq: v, gen, arrival: 'late' };
      if (kind === 'O') return { kind: 'NUMBERED', seq: v, gen, arrival: 'overflow' };
      if (kind === 'B') return { kind: 'BATCHING' };
      if (kind === 'W') return { kind: 'WAIT', retryAfterSeconds: v };
      throw new Error(`번호 Lua가 모르는 값을 돌려줬다: ${kind}`);
    });
  }

  async rb05(i: Rb05Input): Promise<Rb05Result> {
    const e = i.eventId;
    const args = [i.expireAtMs, i.skippedExpireAtMs, i.skipBase, i.opensAtMs, i.closeAtMs ?? 0, i.lobbyShuffle ? 1 : 0, i.openBatch ? 1 : 0].map(String);
    const r = (await guard(this.redis.evalScript(RB05, [keys.seq(e), keys.skipped(e), keys.epoch(e), keys.batchDone(e), keys.batchMembers(e), keys.lobbyMembers(e)], args))) as unknown[];
    if (str(r[0]) === 'DONE') return { kind: 'DONE' };
    if (str(r[0]) === 'PENDING') return { kind: 'PENDING' };
    if (str(r[0]) !== 'SKIPPED') throw new Error(`RB-05 Lua가 모르는 값을 돌려줬다: ${str(r[0])}`);
    return { kind: 'SKIPPED', start: Number(r[1]), end: Number(r[2]), gen: Number(r[3]) };
  }

  async confirmRb05(i: { eventId: string }): Promise<Rb05Confirm> {
    return guard(confirmRb05(this.waitRedis ?? this.redis, keys.epoch(i.eventId), RB05_MARK, RB05_CLEAR, RB05_CONFIRM_WAIT_MS));
  }

  async number(i: NumberInput): Promise<NumberResult> {
    const { eligible, tokenHash, ...common } = i;
    return (await this.numberBatch({ ...common, items: [{ eligible, tokenHash }] }))[0]!;
  }

  async record(i: { pid: string; eventId: string; requestId: string; seq: number; gen: number; jny: string; vr?: ReasonCategory; expireAtMs: number; ticketHash?: string }): Promise<RecordResult> {
    const args = [i.requestId, String(i.seq), String(i.gen), String(i.expireAtMs), i.jny, i.vr ?? '', i.ticketHash ?? ''];
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

  async convertBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string; seq: number; gen: number; expireAtMs: number; ticketHash?: string }): Promise<({ kind: 'RECORDED' } & RecordedEntry) | { kind: 'GONE' }> {
    const args = [i.requestId, i.tokenHash, String(i.seq), String(i.gen), String(i.expireAtMs), i.ticketHash ?? ''];
    const r = (await guard(this.redis.evalScript(CONVERT, [keys.dup(i.pid, i.eventId)], args))) as unknown[];
    return str(r[0]) === 'RECORDED' ? { kind: 'RECORDED', ...entry(r) } : { kind: 'GONE' };
  }

  async dropBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string }): Promise<void> {
    await guard(this.redis.evalScript(DROP_BATCH, [keys.dup(i.pid, i.eventId)], [i.requestId, i.tokenHash]));
  }

  async mirror(i: { from: string; to: string; eventId: string; requestId: string }): Promise<'COPIED' | 'TAKEN' | 'ADMITTED'> {
    const own = (await guard(this.redis.evalScript(READ_OWN, [keys.dup(i.from, i.eventId)], [i.requestId]))) as unknown[];
    if (own.length === 0) return 'COPIED';
    const r = str(await guard(this.redis.evalScript(MIRROR, [keys.dup(i.to, i.eventId), keys.adm(i.to, i.eventId)], [str(own[0]), String(Number(own[1])), i.requestId])));
    if (r === 'COPIED' || r === 'TAKEN' || r === 'ADMITTED') return r;
    throw new Error(`옮겨 쓰기 Lua가 모르는 값을 돌려줬다: ${r}`);
  }

  async dropOwn(i: { pid: string; eventId: string; requestId: string }): Promise<void> {
    await guard(this.redis.evalScript(DROP_OWN, [keys.dup(i.pid, i.eventId)], [i.requestId]));
  }

  async claimArrival(i: { eventId: string; reqId: string; requestId: string; ttlMs: number }): Promise<boolean> {
    return Number(await guard(this.redis.evalScript(CLAIM_ARRIVAL, [keys.arr(i.reqId, i.eventId)], [i.requestId, String(i.ttlMs)]))) === 1;
  }

  async markRemoved(i: { eventId: string; seq: number; expireAtMs: number }): Promise<void> {
    await guard(this.redis.evalScript(MARK_REMOVED, [keys.removed(i.eventId)], [String(i.seq), String(i.expireAtMs)]));
  }

  async markVerifying(i: { eventId: string; seq: number; ticketHash: string; atMs: number; reason: ReasonCategory; expireAtMs: number; verifyExpireAtMs: number }): Promise<void> {
    const args = [String(i.seq), i.ticketHash, `VERIFYING:${i.atMs}:${i.reason}`, String(i.expireAtMs), String(i.verifyExpireAtMs)];
    await guard(this.redis.evalScript(MARK_VERIFYING, [keys.removed(i.eventId), keys.verify(i.eventId)], args));
  }

  async addLobbyMember(i: { eventId: string; tokenHash: string; opensAtMs: number; lobbyOpensAtMs: number; expireAtMs: number; verify?: { value: string; expireAtMs: number } }): Promise<'ADDED' | 'NOT_OPEN' | 'CLOSED'> {
    const args = [String(i.opensAtMs), String(i.lobbyOpensAtMs), i.tokenHash, String(i.expireAtMs), i.verify?.value ?? '', String(i.verify?.expireAtMs ?? 0)];
    const r = str(await guard(this.redis.evalScript(ADD_LOBBY_MEMBER, [keys.batchDone(i.eventId), keys.lobbyMembers(i.eventId), keys.verify(i.eventId)], args)));
    return r === 'ADDED' || r === 'NOT_OPEN' || r === 'CLOSED' ? r : 'CLOSED';
  }

  async lobbyWindow(i: { eventId: string; opensAtMs: number; lobbyOpensAtMs: number }): Promise<'OPEN' | 'NOT_OPEN' | 'CLOSED'> {
    const r = str(await guard(this.redis.evalScript(LOBBY_WINDOW, [keys.batchDone(i.eventId)], [String(i.opensAtMs), String(i.lobbyOpensAtMs)])));
    return r === 'OPEN' || r === 'NOT_OPEN' ? r : 'CLOSED';
  }

  async removeLobbyMember(i: { eventId: string; tokenHash: string; expireAtMs: number }): Promise<void> {
    await guard(this.redis.evalScript(REMOVE_LOBBY_MEMBER, [keys.batchDone(i.eventId), keys.lobbyMembers(i.eventId), keys.verify(i.eventId)], [i.tokenHash, String(i.expireAtMs)]));
  }

  async recordLobby(i: { pid: string; eventId: string; requestId: string; tokenHash: string; expireAtMs: number }): Promise<'RECORDED' | 'ADMITTED' | 'TAKEN'> {
    const r = str(await guard(this.redis.evalScript(RECORD_LOBBY, [keys.dup(i.pid, i.eventId), keys.adm(i.pid, i.eventId)], [`LOBBY:${i.tokenHash}:${i.requestId}`, i.requestId, String(i.expireAtMs)])));
    return r === 'RECORDED' || r === 'ADMITTED' ? r : 'TAKEN';
  }

  async dropLobbyRecord(i: { pid: string; eventId: string; requestId: string; tokenHash: string }): Promise<void> {
    await guard(this.redis.evalScript(DROP_LOBBY, [keys.dup(i.pid, i.eventId)], [`LOBBY:${i.tokenHash}:${i.requestId}`]));
  }

  async readHeld(i: { pid: string; eventId: string }): Promise<HeldRecord | null> {
    const k = keys.dup(i.pid, i.eventId);
    const v = await guard(this.redis.command(['GET', k], { key: k }));
    return v === null || v === undefined ? null : parseHeld(str(v));
  }

  async leaveNumber(i: { eventId: string; seq: number; ticketHash?: string; expireAtMs: number }): Promise<void> {
    const e = i.eventId;
    await guard(this.redis.evalScript(LEAVE_NUMBER, [keys.removed(e), keys.verify(e), keys.soon(e), keys.soonAt(e), keys.soonFirst(e)], [String(i.seq), i.ticketHash ?? '', String(i.expireAtMs)]));
  }

  async leaveMember(i: { eventId: string; group: ShuffleGroup; tokenHash: string; closesAtMs?: number; verifyExpireAtMs: number }): Promise<'REMOVED' | 'FIXED' | 'CLOSED'> {
    const e = i.eventId;
    const members = i.group === 'lobby' ? keys.lobbyMembers(e) : keys.batchMembers(e, i.group);
    const r = str(await guard(this.redis.evalScript(LEAVE_MEMBER, [keys.batchDone(e), members, keys.verify(e)], [String(i.group), i.tokenHash, String(i.verifyExpireAtMs), String(i.closesAtMs ?? 0)])));
    if (r === 'REMOVED' || r === 'FIXED' || r === 'CLOSED') return r;
    throw new Error(`참가 취소 Lua가 모르는 값을 돌려줬다: ${r}`);
  }

  async resultSeat(i: { group: ShuffleGroup; tokenHash: string }): Promise<{ seq: number; gen: number } | null> {
    const k = i.group === 'lobby' ? keys.lobbyResult(i.tokenHash) : keys.batchResult(i.tokenHash);
    const v = await guard(this.redis.command(['GET', k], { key: k }));
    if (v === null || v === undefined) return null;
    const m = RESULT.exec(str(v));
    if (!m) throw new Error(`셔플 결과 값의 모양이 틀렸다: ${k}`);
    return { seq: Number(m[1]), gen: Number(m[2]) };
  }

  async swapHeld(i: { pid: string; eventId: string; from: string; to: string }): Promise<boolean> {
    return Number(await guard(this.redis.evalScript(SWAP_HELD, [keys.dup(i.pid, i.eventId)], [i.from, i.to]))) === 1;
  }
}

/** 셔플 공시 기록(docs/data.md §3 q:{event:E}:shuffle, ADR-0231 결정 6) */
@Injectable()
export class RedisShuffleCommits implements ShuffleCommitStore {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async read(eventId: string, group: ShuffleGroup): Promise<CommitRecord | null> {
    const k = keys.shuffle(eventId);
    return commitRecord((await guard(this.redis.command(['HMGET', k, `commit:${group}`, `round:${group}`, `sealed:${group}`, `at:${group}`], { key: k }))) as unknown[]);
  }

  async write(eventId: string, group: ShuffleGroup, rec: Omit<CommitRecord, 'atMs'>, expireAtMs: number): Promise<CommitRecord> {
    const args = [String(group), rec.commit, String(rec.round), rec.sealed, DRAND_CHAIN, ALGORITHM, String(expireAtMs)];
    const r = commitRecord((await guard(this.redis.evalScript(WRITE_COMMIT, [keys.shuffle(eventId)], args))) as unknown[]);
    if (!r) throw new Error('공시 기록을 쓴 뒤 읽지 못했다');
    return r;
  }
}

function commitRecord(raw: unknown[]): CommitRecord | null {
  const [commit, round, sealed, at] = raw.map((v) => (v === null || v === undefined ? null : str(v)));
  return commit && round && sealed && at ? { commit, round: Number(round), sealed, atMs: Number(at) } : null;
}
