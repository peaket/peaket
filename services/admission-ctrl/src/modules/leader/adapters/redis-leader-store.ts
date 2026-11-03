// 리더의 대기열 Redis 쓰기(docs/data.md §3: q:{event:E}:leader·ctl·serving·serving_log·calls·call_req·slots·soon·soon_at·batch_done·epoch, q:{admission}:events).
// 리더가 쓰는 일은 모두 세대를 확인하는 Lua 하나로 한다(ADR-0056 결정 2). Lua 원문은 leader-lua.ts에 있다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { ADMISSION_REDIS } from '../../batch/index.js';
import { BATCH_RESULT_DELAY_MS, CALLS_KEEP_MS, DISPERSAL_MS, LATE_DISPERSAL_MS, RATIO_WINDOW_MAX_MS, RATIO_WINDOW_MIN_MS, SCAN_BUDGET, SOON_STALE_MS } from '../domain/plan.js';
import type { CloseInput, CloseResult, Control, EventPlan, LeaderStore, Rb05Input, Rb05Result, TickInput, TickResult } from '../domain/ports.js';
import { BUMP_LUA, CLOSE_LUA, RB05_LUA, TICK_LUA } from './leader-lua.js';

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
  epoch: (e: string) => `q:{event:${e}}:epoch`,
  /** 대기 화면에 싣는 제어 상태(queue-svc가 쓴다): 판매 상태 saleState, soldOutLastSeq(ADR-0122) */
  notice: (e: string) => `q:{event:${e}}:notice`,
  /** 진행 중인 회차 목록(queue-svc가 일정 사본을 읽을 때 넣는다, ADR-0182 결정 2) */
  events: () => 'q:{admission}:events',
};

const BUMP = redisScript(BUMP_LUA);
const TICK = redisScript(TICK_LUA);
const CLOSE = redisScript(CLOSE_LUA);
const RB05 = redisScript(RB05_LUA);

const str = (v: unknown): string | null => (v === null || v === undefined ? null : Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const int = (v: string | null | undefined): number | null => (v !== null && v !== undefined && /^\d{1,16}$/.test(v) ? Number(v) : null);
const bit = (v: unknown): 0 | 1 => (Number(v) === 1 ? 1 : 0);

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
  constructor(@Inject(ADMISSION_REDIS) private readonly redis: HotRedis) {}

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
    return { opensAtMs, startsAtMs, lobbyShuffle: f.lobbyShuffle === '1', openBatch: f.openBatch === '1', ...(window !== undefined ? { batchWindowMs: window } : {}) };
  }

  async control(eventId: string, nowMs: number): Promise<Control> {
    const k = keys.ctl(eventId);
    const [target, until, admitPaused, admitUntil, salePaused, suspended] = ((await this.redis.command(['HMGET', k, 'target', 'targetUntil', 'admitPaused', 'admitPausedUntil', 'paused', 'suspended'], { key: k })) as unknown[]).map(str);
    const t = int(target);
    const u = int(until);
    const fixed = t !== null && (u === null || nowMs < u);
    // 입장 일시정지·판매 일시정지(명령 3)·판매 중지 가운데 하나라도 참이면 serving 전진을 멈춘다(ADR-0123)
    const au = int(admitUntil);
    const admit = admitPaused === '1' && (au === null || nowMs < au);
    return { ...(fixed ? { target: t } : {}), paused: admit || salePaused === '1' || suspended === '1' };
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
      BATCH_RESULT_DELAY_MS,
      SCAN_BUDGET,
      i.saleEndMs,
      RATIO_WINDOW_MIN_MS,
      RATIO_WINDOW_MAX_MS,
      i.saleStateFallback,
    ].map(String);
    const r = (await this.redis.evalScript(TICK, ks, args)) as unknown[];
    if (str(r[0]) === 'FENCED') return { kind: 'FENCED' };
    const n = (k: number) => Number(r[k]);
    return { kind: 'OK', serving: n(1), advanced: n(2), slots: n(3), soon: n(4), inFlight: n(5), dropped: n(6), lobbyMarked: bit(r[7]), batchMarked: bit(r[8]), batchPublished: bit(r[9]), repair: bit(r[10]), ratio: n(11) / 1000, saleState: str(r[12])! };
  }

  async close(i: CloseInput): Promise<CloseResult> {
    const e = i.eventId;
    const ks = [keys.leader(e), keys.seq(e), keys.skipped(e), keys.batchDone(e), keys.batchMembers(e), keys.lobbyMembers(e), keys.epoch(e)];
    const args = [i.gen, i.keepUntilMs, i.opensAtMs, i.closeAtMs, i.lobbyShuffle ? 1 : 0, i.openBatch ? 1 : 0].map(String);
    const r = (await this.redis.evalScript(CLOSE, ks, args)) as unknown[];
    return str(r[0]) as CloseResult;
  }

  async rb05(i: Rb05Input): Promise<Rb05Result> {
    const e = i.eventId;
    const args = [i.expireAtMs, i.skippedExpireAtMs, i.skipBase, i.opensAtMs, i.closeAtMs ?? 0, i.lobbyShuffle ? 1 : 0, i.openBatch ? 1 : 0].map(String);
    const r = (await this.redis.evalScript(RB05, [keys.seq(e), keys.skipped(e), keys.epoch(e), keys.batchDone(e), keys.batchMembers(e), keys.lobbyMembers(e)], args)) as unknown[];
    if (str(r[0]) === 'DONE') return { kind: 'DONE' };
    return { kind: 'SKIPPED', start: Number(r[1]), end: Number(r[2]), gen: Number(r[3]) };
  }
}
