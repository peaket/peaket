// 리더의 대기열 Redis 쓰기(docs/data.md §3: q:{event:E}:leader·ctl·serving·serving_log·calls·call_req·slots·soon·soon_at·batch_done·epoch, q:{admission}:events).
// 리더가 쓰는 일은 모두 세대를 확인하는 Lua 하나로 한다(ADR-0056 결정 2). Lua 원문은 leader-lua.ts에 있다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { type HotRedis, type RedisScript, redisScript } from '@peaket/platform';
import { ADMISSION_REDIS, WAIT_REDIS } from '../../batch/index.js';
import { BATCH_RESULT_DELAY_MS, CALLS_KEEP_MS, DISPERSAL_MS, LATE_DISPERSAL_MS, RATIO_WINDOW_MAX_MS, RATIO_WINDOW_MIN_MS, RB05_CONFIRM_WAIT_MS, SCAN_BUDGET, SOON_STALE_MS } from '../domain/plan.js';
import { isManualFixed, MEMORY_FIELDS } from '../domain/aimd.js';
import type { ArrivalCloseInput, ArrivalCloseResult, CloseInput, CloseResult, Control, EventPlan, LeaderStore, Rb05Confirm, Rb05Input, Rb05Result, TickInput, TickResult } from '../domain/ports.js';
import { ARRIVAL_CLOSE_LUA, BUMP_LUA, CLOSE_LUA, RB05_CLEAR_LUA, RB05_LUA, RB05_MARK_LUA, TICK_LUA } from './leader-lua.js';

export const keys = {
  leader: (e: string) => `q:{event:${e}}:leader`,
  ctl: (e: string) => `q:{event:${e}}:ctl`,
  cfg: (e: string) => `q:{event:${e}}:cfg`,
  serving: (e: string) => `q:{event:${e}}:serving`,
  seq: (e: string) => `q:{event:${e}}:seq`,
  removed: (e: string) => `q:{event:${e}}:removed`,
  skipped: (e: string) => `q:{event:${e}}:skipped`,
  servingLog: (e: string) => `q:{event:${e}}:serving_log`,
  calls: (e: string) => `q:{event:${e}}:calls`,
  callReq: (e: string) => `q:{event:${e}}:call_req`,
  slots: (e: string) => `q:{event:${e}}:slots`,
  soon: (e: string) => `q:{event:${e}}:soon`,
  soonAt: (e: string) => `q:{event:${e}}:soon_at`,
  /** 곧 입장 처음 시각(입장 확정이 쓴다, ADR-0183) */
  soonFirst: (e: string) => `q:{event:${e}}:soon_first`,
  batchDone: (e: string) => `q:{event:${e}}:batch_done`,
  batchMembers: (e: string) => `q:{event:${e}}:batch_members:1`,
  lobbyMembers: (e: string) => `q:{event:${e}}:lobby_members`,
  shuffle: (e: string) => `q:{event:${e}}:shuffle`,
  epoch: (e: string) => `q:{event:${e}}:epoch`,
  /** 진입 Degraded의 도착 시각 칸(진입 Lua가 떼고 리더가 닫는다, ADR-0223) */
  arrSlots: (e: string) => `q:{event:${e}}:arr_slots`,
  /** 대기 화면에 싣는 제어 상태(queue-svc가 쓴다): 판매 상태 saleState, soldOutLastSeq(ADR-0122) */
  notice: (e: string) => `q:{event:${e}}:notice`,
  /** 진행 중인 회차 목록(queue-svc가 일정 사본을 읽을 때 넣는다, ADR-0182 결정 2) */
  events: () => 'q:{admission}:events',
  /** 회차와 무관한 리더 상태(명령 11 autoStopped, ADR-0226 결정 7) */
  platformCtl: () => 'q:{admission}:ctl',
};

const BUMP = redisScript(BUMP_LUA);
const TICK = redisScript(TICK_LUA);
const CLOSE = redisScript(CLOSE_LUA);
const ARRIVAL_CLOSE = redisScript(ARRIVAL_CLOSE_LUA);
const RB05 = redisScript(RB05_LUA);
const RB05_MARK = redisScript(RB05_MARK_LUA);
const RB05_CLEAR = redisScript(RB05_CLEAR_LUA);

const str = (v: unknown): string | null => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const int = (v: string | null | undefined): number | null => (v !== null && v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : null);
const bit = (v: unknown): 0 | 1 => (Number(v) === 1 ? 1 : 0);
/** pgKey·pgTps는 둘 다 맞을 때만 쓴다(틀리면 결제사 상한을 걸지 않는다, ADR-0226 결정 9) */
function pgOf(key: string | null, tps: string | null): { pgKey?: string; pgTps?: number } {
  const t = int(tps);
  return key && /^[A-Za-z0-9_-]{1,32}$/.test(key) && t !== null && t >= 1 ? { pgKey: key, pgTps: t } : {};
}

function fieldsOf(raw: unknown): Record<string, string> {
  if (Array.isArray(raw)) {
    const o: Record<string, string> = {};
    for (let i = 0; i + 1 < raw.length; i += 2) o[str(raw[i])!] = str(raw[i + 1])!;
    return o;
  }
  if (raw && typeof raw === 'object') return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, str(v)!]));
  return {};
}

@Injectable()
export class RedisLeaderStore implements LeaderStore {
  constructor(
    @Inject(ADMISSION_REDIS) private readonly redis: HotRedis,
    @Optional() @Inject(WAIT_REDIS) private readonly waitRedis?: HotRedis,
  ) {}

  async activeEvents(nowMs: number): Promise<string[]> {
    const k = keys.events();
    await this.redis.command(['ZREMRANGEBYSCORE', k, '-inf', `(${nowMs}`], { key: k });
    const ids = (await this.redis.command(['ZRANGE', k, '0', '-1'], { key: k })) as unknown[];
    // 해시 태그를 깨는 값은 받지 않는다(queue-svc가 넣을 때 이미 거른다)
    return ids.map((x) => str(x)!).filter((id) => /^[A-Za-z0-9_-]{1,64}$/.test(id));
  }

  async schedule(eventId: string): Promise<EventPlan | null> {
    const k = keys.cfg(eventId);
    const f = fieldsOf(await this.redis.command(['HGETALL', k], { key: k }));
    const opensAtMs = int(f.opensAtMs);
    const startsAtMs = int(f.startsAtMs);
    // queue-svc parseSchedule과 같이 읽는다: 칸이 빠졌거나 형이 틀리면, 둘 다 끈 조합이면, 묶음 구간 길이가 1~60초 밖이면 없는 회차다
    if (opensAtMs === null || startsAtMs === null || (f.lobbyShuffle !== '0' && f.lobbyShuffle !== '1') || (f.openBatch !== '0' && f.openBatch !== '1')) return null;
    if (f.lobbyShuffle === '0' && f.openBatch === '0') return null;
    const window = f.batchWindowMs === undefined ? undefined : int(f.batchWindowMs);
    if (window === null || (window !== undefined && (window < 1 || window > 60_000))) return null;
    const pg = pgOf(f.pgKey ?? null, f.pgTps ?? null);
    const shuffleKey = keys.shuffle(eventId);
    const batchRound = int(str(await this.redis.command(['HGET', shuffleKey, 'round:1'], { key: shuffleKey })) ?? undefined);
    return { opensAtMs, startsAtMs, lobbyShuffle: f.lobbyShuffle === '1', openBatch: f.openBatch === '1', ...(window !== undefined ? { batchWindowMs: window } : {}), ...(batchRound !== null ? { batchRound } : {}), ...pg };
  }

  async control(eventId: string, nowMs: number): Promise<Control> {
    const k = keys.ctl(eventId);
    const raw = ((await this.redis.command(['HMGET', k, 'target', 'targetUntil', 'admitPaused', 'admitPausedUntil', 'paused', 'suspended', 'aimdResumeAt', 'pgKey', 'pgTps', ...MEMORY_FIELDS], { key: k })) as unknown[]).map(str);
    const [target, until, admitPaused, admitUntil, salePaused, suspended, resumeAt, pgKey, pgTps] = raw;
    const memory: Record<string, string | null> = {};
    MEMORY_FIELDS.forEach((name, i) => (memory[name] = raw[9 + i] ?? null));
    const t = int(target);
    const operator = { value: t, untilMs: int(until), resumeAtMs: int(resumeAt) };
    const manualEndedAt = int(memory.manualEndedAt);
    // 입장 일시정지·판매 일시정지(명령 3)·판매 중지 가운데 하나라도 참이면 serving 전진을 멈춘다(ADR-0123)
    const au = int(admitUntil);
    const admit = admitPaused === '1' && (au === null || nowMs < au);
    return { ...(t !== null && isManualFixed(operator, manualEndedAt, nowMs) ? { target: t } : {}), paused: admit || salePaused === '1' || suspended === '1', operator, memory, ...pgOf(pgKey ?? null, pgTps ?? null) };
  }

  async platformControl(): Promise<{ autoStopped: boolean }> {
    const k = keys.platformCtl();
    return { autoStopped: str(await this.redis.command(['HGET', k, 'autoStopped'], { key: k })) === '1' };
  }

  async bump(eventId: string, gen: number, keepUntilMs: number): Promise<'OK' | 'FENCED'> {
    const r = (await this.redis.evalScript(BUMP, [keys.leader(eventId)], [String(gen), String(keepUntilMs)])) as unknown[];
    return str(r[0]) === 'FENCED' ? 'FENCED' : 'OK';
  }

  async tick(i: TickInput): Promise<TickResult> {
    const e = i.eventId;
    const ks = [keys.leader(e), keys.serving(e), keys.seq(e), keys.removed(e), keys.skipped(e), keys.servingLog(e), keys.calls(e), keys.callReq(e), keys.slots(e), keys.soon(e), keys.soonAt(e), keys.batchDone(e), keys.notice(e), keys.ctl(e), keys.soonFirst(e)];
    const args = [
      i.gen,
      i.target,
      i.ratioFloor,
      i.windowMs,
      i.maxAdvance,
      i.keepUntilMs,
      i.lobbyShuffle ? 1 : 0,
      i.openBatch ? 1 : 0,
      i.closeAtMs,
      SOON_STALE_MS,
      CALLS_KEEP_MS,
      DISPERSAL_MS,
      LATE_DISPERSAL_MS,
      i.batchResultDelayMs ?? BATCH_RESULT_DELAY_MS,
      SCAN_BUDGET,
      i.saleEndMs,
      RATIO_WINDOW_MIN_MS,
      RATIO_WINDOW_MAX_MS,
      i.saleStateFallback,
      ...Object.entries(i.fields ?? {}).flat(),
    ].map(String);
    const r = (await this.redis.evalScript(TICK, ks, args)) as unknown[];
    if (str(r[0]) === 'FENCED') return { kind: 'FENCED' };
    const n = (k: number) => Number(r[k]);
    return { kind: 'OK', serving: n(1), advanced: n(2), slots: n(3), soon: n(4), inFlight: n(5), dropped: n(6), lobbyMarked: bit(r[7]), batchMarked: bit(r[8]), batchPublished: bit(r[9]), repair: bit(r[10]), lobbyPublished: bit(r[14]), lobbyRepair: bit(r[15]), gated: bit(r[16]), ratio: n(11) / 1000, saleState: str(r[12])!, waiting: n(13) };
  }

  async close(i: CloseInput): Promise<CloseResult> {
    const e = i.eventId;
    const ks = [keys.leader(e), keys.seq(e), keys.skipped(e), keys.batchDone(e), keys.batchMembers(e), keys.lobbyMembers(e), keys.epoch(e)];
    const args = [i.gen, i.keepUntilMs, i.opensAtMs, i.closeAtMs, i.lobbyShuffle ? 1 : 0, i.openBatch ? 1 : 0].map(String);
    const r = (await this.redis.evalScript(CLOSE, ks, args)) as unknown[];
    return str(r[0]) as CloseResult;
  }

  async closeArrivalSlots(i: ArrivalCloseInput): Promise<ArrivalCloseResult> {
    const e = i.eventId;
    const r = (await this.redis.evalScript(ARRIVAL_CLOSE, [keys.leader(e), keys.arrSlots(e), keys.removed(e), keys.skipped(e), keys.epoch(e)], [String(i.gen), String(i.keepUntilMs)])) as unknown[];
    return { kind: str(r[0]) as ArrivalCloseResult['kind'], slots: Number(r[1] ?? 0), returned: Number(r[2] ?? 0) };
  }

  async rb05(i: Rb05Input): Promise<Rb05Result> {
    const e = i.eventId;
    const args = [i.expireAtMs, i.skippedExpireAtMs, i.skipBase, i.opensAtMs, i.closeAtMs ?? 0, i.lobbyShuffle ? 1 : 0, i.openBatch ? 1 : 0].map(String);
    const r = (await this.redis.evalScript(RB05, [keys.seq(e), keys.skipped(e), keys.epoch(e), keys.batchDone(e), keys.batchMembers(e), keys.lobbyMembers(e)], args)) as unknown[];
    if (str(r[0]) === 'DONE') return { kind: 'DONE' };
    if (str(r[0]) === 'PENDING') return { kind: 'PENDING' };
    return { kind: 'SKIPPED', start: Number(r[1]), end: Number(r[2]), gen: Number(r[3]) };
  }

  async confirmRb05(i: { eventId: string }): Promise<Rb05Confirm> {
    return confirmRb05(this.waitRedis ?? this.redis, keys.epoch(i.eventId), RB05_MARK, RB05_CLEAR, RB05_CONFIRM_WAIT_MS);
  }
}

/** 주 노드의 INFO replication에서 붙은 온라인 복제본 수(queue-svc redis-entry-store.ts와 같다) */
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
 * RB-05 복제 확인(ADR-0186): queue-svc redis-entry-store.ts의 confirmRb05와 같은 글이다(leader-lua.test.ts가 견준다). 순서와 까닭은 그쪽 설명을 본다.
 * 연결은 묶음 게시 확인과 같은 WAIT 전용 연결이다
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
