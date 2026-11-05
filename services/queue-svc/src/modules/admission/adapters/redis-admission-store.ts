// 입장 확정을 대기열 Redis(Valkey) Lua로 한다(docs/features/queue-admission.md §6 '입장 확정의 첫 구현', docs/data.md §3).
// 사람 키는 pid를 해시 태그로(q:adm·q:dup이 한 슬롯), 회차 키는 {event:E} 태그로 둔다. 키에 넣는 값은 받는 층이 [A-Za-z0-9_-] 1~64자만 넘긴다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { guard, keys, QUEUE_REDIS } from '../../entry/index.js';
import { DEFAULT_TARGET, FIRST_USE_MS, MAX_STAY_MS, NOT_YET_MAX_MS, NOT_YET_MIN_MS, RATE_WINDOW_SEC, SOON_RETRY_MAX_SEC, SOON_RETRY_MIN_SEC, TURN_GRACE_MS, type AdmitResult, type Claim, type Precheck } from '../domain/admission.js';
import type { AdmissionStore } from '../domain/ports.js';
import { ADMIT_LUA, CLAIM_LUA, EXPIRE_LUA, MARK_REMOVED_LUA, PRECHECK_LUA, SETTLE_LUA } from './admission-lua.js';

export const admissionKeys = {
  ...keys,
  notice: (e: string) => `q:{event:${e}}:notice`,
  ctl: (e: string) => `q:{event:${e}}:ctl`,
  callReq: (e: string) => `q:{event:${e}}:call_req`,
  slots: (e: string) => `q:{event:${e}}:slots`,
  soon: (e: string) => `q:{event:${e}}:soon`,
  soonAt: (e: string) => `q:{event:${e}}:soon_at`,
  soonFirst: (e: string) => `q:{event:${e}}:soon_first`,
  admitted: (e: string) => `q:{event:${e}}:admitted`,
  /** 최근 입장 속도(1초 칸 16개, ADR-0183) */
  admits: (e: string) => `q:{event:${e}}:admits`,
  /** 대기표 해시 → 그 대기표가 받은 입장 자리 jti(ADR-0183) */
  slotOf: (e: string) => `q:{event:${e}}:slot_of`,
  /** 처음 요청을 센 번호의 비트맵(ADR-0183) */
  req: (e: string) => `q:{event:${e}}:req`,
};
const k = admissionKeys;

const PRECHECK = redisScript(PRECHECK_LUA);
const CLAIM = redisScript(CLAIM_LUA);
const ADMIT = redisScript(ADMIT_LUA);
const SETTLE = redisScript(SETTLE_LUA);
const EXPIRE = redisScript(EXPIRE_LUA);
const MARK_REMOVED = redisScript(MARK_REMOVED_LUA);

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
/** Lua의 -1(없음)을 undefined로 */
const opt = (v: unknown): number | undefined => {
  const n = Number(str(v));
  return n >= 0 ? n : undefined;
};

@Injectable()
export class RedisAdmissionStore implements AdmissionStore {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async precheck(i: { eventId: string; seq: number; gen: number; ticketHash: string }): Promise<Precheck> {
    const e = i.eventId;
    const ks = [k.serving(e), k.servingLog(e), k.removed(e), k.skipped(e), k.verify(e), k.notice(e), k.soon(e), k.slotOf(e), k.slots(e)];
    const args = [i.seq, i.gen, i.ticketHash, TURN_GRACE_MS, NOT_YET_MIN_MS, NOT_YET_MAX_MS, RATE_WINDOW_SEC].map(String);
    const r = (await guard(this.redis.evalScript(PRECHECK, ks, args))) as unknown[];
    const kind = str(r[0]);
    switch (kind) {
      case 'SOLD_OUT':
      case 'ENDED':
      case 'REMOVED':
        return { kind };
      case 'VERIFYING':
        return { kind, reason: str(r[1] ?? '') };
      case 'NOT_YET':
        return { kind, serving: Number(str(r[1])), retryAfterMs: Number(str(r[2])) };
      case 'EXPIRED':
        return { kind, turnAtMs: Number(str(r[1])) };
      case 'OK': {
        const turnAtMs = opt(r[2]);
        return { kind, serving: Number(str(r[1])), ...(turnAtMs !== undefined ? { turnAtMs } : {}), inSoon: str(r[3]) === '1', skipped: str(r[4]) === '1' };
      }
      default:
        throw new Error(`입장 확인 Lua가 모르는 값을 돌려줬다: ${kind}`);
    }
  }

  async claim(i: { pid: string; eventId: string; ticketHash: string; nonce: string; expireAtMs: number }): Promise<Claim> {
    const kind = str(await guard(this.redis.evalScript(CLAIM, [k.adm(i.pid, i.eventId)], [i.ticketHash, i.nonce, String(i.expireAtMs)])));
    if (kind === 'NEW' || kind === 'SAME' || kind === 'DUP') return { kind };
    throw new Error(`1인 1순번 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async admit(i: Parameters<AdmissionStore['admit']>[0]): Promise<AdmitResult> {
    const e = i.eventId;
    const ks = [k.serving(e), k.removed(e), k.slots(e), k.soon(e), k.soonAt(e), k.soonFirst(e), k.admitted(e), k.calls(e), k.callReq(e), k.ctl(e), k.admits(e), k.slotOf(e), k.req(e)];
    const args = [
      i.seq,
      i.ticketHash,
      i.freshJti,
      i.turnAtMs ?? -1,
      i.skipped ? 1 : 0,
      FIRST_USE_MS,
      DEFAULT_TARGET,
      i.keepUntilMs,
      i.soonExpireAtMs,
      SOON_RETRY_MIN_SEC,
      SOON_RETRY_MAX_SEC,
      RATE_WINDOW_SEC,
      MAX_STAY_MS,
    ].map(String);
    const r = (await guard(this.redis.evalScript(ADMIT, ks, args))) as unknown[];
    const kind = str(r[0]);
    if (kind === 'ADMITTED') {
      const arrivalDelayMs = opt(r[4]);
      const soonWaitMs = opt(r[5]);
      const issuedAtMs = opt(r[7]);
      return {
        kind,
        jti: str(r[1]),
        again: str(r[2]) === '1',
        firstSlot: str(r[6]) === '1',
        serving: Number(str(r[3])),
        ...(arrivalDelayMs !== undefined ? { arrivalDelayMs } : {}),
        ...(soonWaitMs !== undefined ? { soonWaitMs } : {}),
        ...(issuedAtMs !== undefined ? { issuedAtMs } : {}),
      };
    }
    if (kind === 'SOON') {
      const arrivalDelayMs = opt(r[2]);
      return { kind, retryAfterSeconds: Number(str(r[1])), ...(arrivalDelayMs !== undefined ? { arrivalDelayMs } : {}) };
    }
    if (kind === 'REMOVED' || kind === 'NOT_YET' || kind === 'EXPIRED') return { kind };
    throw new Error(`입장 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async settle(i: { pid: string; eventId: string; ticketHash: string; outcome: 'ADMITTED' | 'RELEASE'; nonce: string; expireAtMs: number }): Promise<void> {
    await guard(this.redis.evalScript(SETTLE, [k.adm(i.pid, i.eventId), k.dup(i.pid, i.eventId)], [i.outcome, i.ticketHash, i.nonce, String(i.expireAtMs)]));
  }

  async expire(i: { pid: string; eventId: string; seq: number; gen: number }): Promise<{ admittedBefore: boolean }> {
    const r = await guard(this.redis.evalScript(EXPIRE, [k.dup(i.pid, i.eventId), k.adm(i.pid, i.eventId)], [`${i.seq}:${i.gen}:`]));
    return { admittedBefore: Number(str(r)) === 1 };
  }

  async markRemoved(i: { eventId: string; seq: number; expireAtMs: number }): Promise<void> {
    await guard(this.redis.evalScript(MARK_REMOVED, [k.removed(i.eventId)], [String(i.seq), String(i.expireAtMs)]));
  }

  async sessionStarted(i: { eventId: string; jti: string; maxStayUntilMs: number }): Promise<boolean> {
    const key = k.slots(i.eventId);
    // 자리가 남아 있고 더 늦을 때만 올린다(회수된 자리를 늦게 온 사건이 되살리지 않게, ADR-0183 결정 11)
    return Number(str(await guard(this.redis.command(['ZADD', key, 'XX', 'GT', 'CH', String(i.maxStayUntilMs), i.jti], { key })))) === 1;
  }

  async sessionEnded(i: { eventId: string; jti: string }): Promise<boolean> {
    const key = k.slots(i.eventId);
    return Number(str(await guard(this.redis.command(['ZREM', key, i.jti], { key })))) === 1;
  }
}
