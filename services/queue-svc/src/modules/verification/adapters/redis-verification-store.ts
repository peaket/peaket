// 추가 검증을 대기열 Redis(Valkey) Lua로 한다(docs/data.md §3, ADR-0259). 키에 넣는 값(회차 ID·pid·건 ID)은 받는 층이 [A-Za-z0-9_-] 1~64자만 넘기고,
// 이의 ID는 UUID다(해시 태그를 깨지 않게). 사람 키는 pid를 해시 태그로(q:dup·q:vsub·q:appeal이 한 슬롯), 회차 키는 {event:E} 태그로 둔다.
import { Inject, Injectable } from '@nestjs/common';
import { type HotRedis, redisScript } from '@peaket/platform';
import { guard, keys, QUEUE_REDIS } from '../../entry/index.js';
import type { ResolveBegin, SettleOutcome, VerificationStore } from '../domain/ports.js';
import type { AppealDraft, AppealOutcome, ResolveResult, StoredAppeal } from '../domain/verification.js';
import { APPEAL_FIELDS, BEGIN_RESOLVE_LUA, CLAIM_CASE_LUA, COMMIT_RESOLVE_LUA, COUNT_SUBMIT_LUA, MARK_SENT_LUA, OPEN_APPEAL_LUA, SETTLE_VERIFY_LUA, TURN_OF_LUA, UNCOUNT_SUBMIT_LUA } from './verification-lua.js';

export const verificationKeys = {
  dup: keys.dup,
  verify: keys.verify,
  serving: keys.serving,
  servingLog: keys.servingLog,
  lobbyResult: keys.lobbyResult,
  /** 한 대기 참여의 challengeToken 제출 수(10분 [가정]) */
  vsub: (pid: string, e: string) => `q:vsub:{${pid}}:${e}`,
  /** 이의 임시 보관(판매 종료 + 7일 [가정]) */
  appeal: (pid: string, e: string) => `q:appeal:{${pid}}:${e}`,
  /** 이의 ID → '{회차 ID}:{pid}' */
  appealId: (appealId: string) => `q:appealid:{${appealId}}`,
  /** 처리함 건 ID → 이의 ID */
  appealCase: (caseId: string) => `q:appealcase:{${caseId}}`,
};
const k = verificationKeys;

const SETTLE_VERIFY = redisScript(SETTLE_VERIFY_LUA);
const COUNT_SUBMIT = redisScript(COUNT_SUBMIT_LUA);
const UNCOUNT_SUBMIT = redisScript(UNCOUNT_SUBMIT_LUA);
const TURN_OF = redisScript(TURN_OF_LUA);
const OPEN_APPEAL = redisScript(OPEN_APPEAL_LUA);
const MARK_SENT = redisScript(MARK_SENT_LUA);
const CLAIM_CASE = redisScript(CLAIM_CASE_LUA);
const BEGIN_RESOLVE = redisScript(BEGIN_RESOLVE_LUA);
const COMMIT_RESOLVE = redisScript(COMMIT_RESOLVE_LUA);

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : str(v));
const RESULTS: readonly ResolveResult[] = ['APPLIED', 'UNCHANGED', 'NOT_ISOLATED'];
const OUTCOMES: readonly AppealOutcome[] = ['ACCEPTED', 'REJECTED'];

/** APPEAL_FIELDS 차례의 값들 → 이의(이의 ID가 비었으면 null) */
export function appealOf(values: readonly unknown[]): StoredAppeal | null {
  const f = Object.fromEntries(APPEAL_FIELDS.map((name, i) => [name, strOrNull(values[i]) ?? ''])) as Record<(typeof APPEAL_FIELDS)[number], string>;
  if (!f.id) return null;
  const result = RESULTS.find((r) => r === f.res);
  const applied = OUTCOMES.find((o) => o === f.ap);
  return {
    appealId: f.id,
    accountId: f.acc,
    fieldHash: f.th,
    reason: f.cat,
    text: f.txt,
    eventKey: f.ek,
    receivedAtMs: Number(f.at),
    expireAtMs: Number(f.exp),
    sent: f.sent === '1',
    ...(f.cid ? { caseId: f.cid } : {}),
    ...(f.cv ? { caseVersion: Number(f.cv) } : {}),
    ...(result ? { result } : {}),
    ...(applied ? { appliedOutcome: applied } : {}),
  };
}

const LOCATION = /^([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,64})$/;
const RESULT_SEAT = /^(\d+):(\d+)$/;

@Injectable()
export class RedisVerificationStore implements VerificationStore {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  #get(key: string): Promise<unknown> {
    return guard(this.redis.command(['GET', key], { key }));
  }

  async readDup(pid: string, eventId: string): Promise<string | null> {
    return strOrNull(await this.#get(k.dup(pid, eventId)));
  }

  async readVerify(eventId: string, fieldHash: string): Promise<string | null> {
    const key = k.verify(eventId);
    return strOrNull(await guard(this.redis.command(['HGET', key, fieldHash], { key })));
  }

  async lobbySeq(tokenHash: string): Promise<number | null> {
    const m = RESULT_SEAT.exec(strOrNull(await this.#get(k.lobbyResult(tokenHash))) ?? '');
    return m ? Number(m[1]) : null;
  }

  async turnOf(eventId: string, seq: number): Promise<{ serving: number; turnAtMs?: number }> {
    const r = (await guard(this.redis.evalScript(TURN_OF, [k.serving(eventId), k.servingLog(eventId)], [String(seq)]))) as unknown[];
    const turnAt = Number(str(r[1]));
    return { serving: Number(str(r[0])) || 0, ...(turnAt >= 0 ? { turnAtMs: turnAt } : {}) };
  }

  async countSubmit(pid: string, eventId: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const r = (await guard(this.redis.evalScript(COUNT_SUBMIT, [k.vsub(pid, eventId)], [String(windowMs)]))) as unknown[];
    return { count: Number(str(r[0])), ttlMs: Number(str(r[1])) };
  }

  async uncountSubmit(pid: string, eventId: string): Promise<void> {
    await guard(this.redis.evalScript(UNCOUNT_SUBMIT, [k.vsub(pid, eventId)], []));
  }

  async settleVerify(eventId: string, fieldHash: string, target: 'PASSED' | 'BLOCKED'): Promise<SettleOutcome> {
    const r = (await guard(this.redis.evalScript(SETTLE_VERIFY, [k.verify(eventId), k.serving(eventId)], [fieldHash, target]))) as unknown[];
    const kind = str(r[0]);
    const serving = Number(str(r[2])) || 0;
    if (kind === 'GONE') return { kind, serving };
    if (kind === 'APPLIED' || kind === 'CURRENT') return { kind, value: str(r[1]), serving };
    throw new Error(`추가 검증 칸 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async openAppeal(pid: string, eventId: string, d: AppealDraft): Promise<{ created: boolean; appeal: StoredAppeal }> {
    const args = [d.appealId, d.accountId, d.fieldHash, d.reason, d.text, d.eventKey, String(d.receivedAtMs), String(d.expireAtMs)];
    const r = (await guard(this.redis.evalScript(OPEN_APPEAL, [k.appeal(pid, eventId)], args))) as unknown[];
    const appeal = appealOf(r.slice(1));
    if (!appeal) throw new Error('이의 열기 Lua가 이의 ID 없이 끝났다');
    return { created: str(r[0]) === 'NEW', appeal };
  }

  async readAppeal(pid: string, eventId: string): Promise<StoredAppeal | null> {
    const key = k.appeal(pid, eventId);
    return appealOf((await guard(this.redis.command(['HMGET', key, ...APPEAL_FIELDS], { key }))) as unknown[]);
  }

  async indexAppeal(appealId: string, eventId: string, pid: string, expireAtMs: number): Promise<void> {
    const key = k.appealId(appealId);
    await guard(this.redis.command(['SET', key, `${eventId}:${pid}`, 'PXAT', String(expireAtMs)], { key }));
  }

  async findAppeal(appealId: string): Promise<{ eventId: string; pid: string } | null> {
    const m = LOCATION.exec(strOrNull(await this.#get(k.appealId(appealId))) ?? '');
    return m ? { eventId: m[1]!, pid: m[2]! } : null;
  }

  async markSent(pid: string, eventId: string, appealId: string): Promise<boolean> {
    return Number(str(await guard(this.redis.evalScript(MARK_SENT, [k.appeal(pid, eventId)], [appealId])))) === 1;
  }

  async claimCase(caseId: string, appealId: string, expireAtMs: number): Promise<string> {
    return str(await guard(this.redis.evalScript(CLAIM_CASE, [k.appealCase(caseId)], [appealId, String(expireAtMs)])));
  }

  async beginResolve(pid: string, eventId: string, appealId: string, r: { caseId: string; version: number; outcome: string }): Promise<ResolveBegin> {
    const out = (await guard(this.redis.evalScript(BEGIN_RESOLVE, [k.appeal(pid, eventId)], [appealId, r.caseId, String(r.version), r.outcome]))) as unknown[];
    const kind = str(out[0]);
    if (kind === 'PROCEED') return { kind, retry: str(out[1]) === '1' };
    if (kind === 'NOT_FOUND' || kind === 'UNCHANGED' || kind === 'OTHER_CASE') return { kind };
    throw new Error(`결과 반영 시작 Lua가 모르는 값을 돌려줬다: ${kind}`);
  }

  async commitResolve(pid: string, eventId: string, appealId: string, r: { caseId: string; version: number; outcome: string; result: ResolveResult }): Promise<void> {
    await guard(this.redis.evalScript(COMMIT_RESOLVE, [k.appeal(pid, eventId)], [appealId, r.caseId, String(r.version), r.result, r.outcome]));
  }
}
