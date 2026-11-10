// 라벨 반영 저장소(docs/features/bot-defense.md §9 '첫 구현', docs/data.md §3 tr:lbl·tr:blkv·tr:refnext, §5 동시성 행, ADR-0258). 세션·캐시 클러스터, 핫패스 시간 초과 100ms.
// - 멱등 기록 tr:lbl:{건 ID}(Hash): src 같은 건 ID에 올 수 있는 출처 묶음, who 처음 받은 사람·회차의 해시, 라벨마다(칸 이름은 라벨 ID의 SHA-256 앞 32자)
//   판(:v)·라벨(:l)·진행 상태(:s, S 시작함·D 끝남)·결과(:r)·찾은 기기 가명(:d), 부정 예매 출처의 짝마다(p + (건 ID, pid)의 해시) 가장 큰 판과 그 출처.
//   판을 Lua 한 번으로 견주고 '시작함'으로 잡는다. pid 원문은 칸 이름에도 값에도 없다. 수명은 마지막으로 쓴 뒤 90일 [가정].
// - 차단 키 tr:block:{기기}와 판 가드 tr:blkv:{기기}(Hash: 라벨 칸 → '판|결과', 짝 칸 → '판|A·R', c + 사건 해시 → 그 기기로 조치 상태인 계정 수),
//   이어 달기 tr:refnext:{기기}는 같은 해시 태그라 한 Lua에서 본다. 더 큰 판이 반영됐으면 건너뛰고, 같은 판이면 처음 결과를 그대로 주며,
//   그 기기가 키 회전으로 새 판에 옮겨졌으면 바꾸지 않고 '옮겨짐'을 준다. 멱등 기록과는 해시 태그가 달라 한 Lua로 묶지 못한다.
// - 이 파일이 차단 키를 새로 올리는 유일한 곳이다(자동 신호로는 올리지 않는다, §9 '올리는 조건', B-T9 ①).
import type { HotRedis } from '@peaket/platform';
import { redisScript } from '@peaket/platform';
import { type BlockListChange, type BlockOp, DEVICE_REF, type Label, type LabelEvidence } from '../domain/labels.js';
import type { BlockApplied, FraudGuard, LabelClaim, LabelStore } from '../domain/ports.js';
import type { HardSignal } from '../domain/types.js';
import { keys } from './redis-feature-store.js';

const DAY_MS = 86_400_000;
/** 차단 키 수명 90일 [가정](§3.2 tr:block). 판 가드·멱등 기록도 마지막으로 쓴 뒤 같은 수명이다(docs/data.md §3) */
export const BLOCK_TTL_MS = 90 * DAY_MS;
/** 이어 달기를 따라가는 상한(이음 기간 30일 안에 회전이 겹치는 일은 드물다) */
const FOLLOW_MAX = 3;

const RESULTS = new Set<string>(['NONE', 'ADDED', 'REMOVED', 'DEVICE_NOT_FOUND']);
const asResult = (v: unknown): BlockListChange => (RESULTS.has(String(v)) ? (String(v) as BlockListChange) : 'NONE');
/** 부정 예매 짝의 차례: 같은 판이면 이의 인정(R)이 조치(A)보다 뒤다(늦게 온 조치가 같은 판의 이의 인정을 되돌리지 않게) */
const RANK = { A: '0', R: '1' } as const;

/**
 * 판 견주기와 잡기(KEYS[1] tr:lbl). ARGV: 출처 묶음, 사람·회차 해시, 라벨 칸, 판, 라벨, 수명, 짝 칸(없으면 ''), 짝 출처의 라벨 칸, 이 라벨의 차례(0 조치·1 이의 인정).
 * 돌려주는 값: {'CONFLICT'} / {'STALE', 결과} 저장한 판(짝 출처 포함)보다 작다 / {'DONE', 결과} 같은 판이 끝났다 / {'GO', 'NEW'|'RESUME', 앞 판이 찾은 기기} 잡았다
 */
const CLAIM_LUA = redisScript(`
local k, fam, who, e, ver, label, ttl, pair, partner, rank = KEYS[1], ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5], ARGV[6], ARGV[7], ARGV[8], tonumber(ARGV[9])
local cur = redis.call('HGET', k, 'src')
if cur and cur ~= fam then return {'CONFLICT', '', ''} end
local w = redis.call('HGET', k, 'who')
if w and w ~= who then return {'CONFLICT', '', ''} end
local v = tonumber(redis.call('HGET', k, e .. ':v') or '0')
local st = redis.call('HGET', k, e .. ':s')
local r = redis.call('HGET', k, e .. ':r') or 'NONE'
if ver < v then return {'STALE', r, ''} end
if ver == v and st == 'D' then return {'DONE', r, ''} end
if pair ~= '' then
  local pc = redis.call('HGET', k, 'p' .. pair)
  if pc then
    local sep = string.find(pc, '|', 1, true)
    local pv, pr = tonumber(string.sub(pc, 1, sep - 1)), tonumber(string.sub(pc, sep + 1))
    if ver < pv or (ver == pv and rank < pr) then return {'STALE', r, ''} end
  end
  redis.call('HSET', k, 'p' .. pair, ARGV[4] .. '|' .. ARGV[9])
end
local mode = 'RESUME'
if ver > v then
  mode = 'NEW'
  redis.call('HDEL', k, e .. ':r')
end
redis.call('HSET', k, 'src', fam, 'who', who, e .. ':v', ARGV[4], e .. ':l', label, e .. ':s', 'S')
redis.call('PEXPIRE', k, ttl)
local d = redis.call('HGET', k, e .. ':d')
if not d and partner ~= '' then d = redis.call('HGET', k, partner .. ':d') end
return {'GO', mode, d or ''}
`);

/**
 * 차단 키 바꾸기(KEYS[1] tr:block, KEYS[2] tr:blkv, KEYS[3] tr:refnext. 같은 해시 태그).
 * ARGV: 라벨 칸, 판, 방법, 올릴 값, 수명, 건 ID, 판정 근거가 차단 목록인가('1'), 짝 칸(없으면 ''), 사건 칸, 이 라벨이 조치(A)·이의 인정(R).
 * 이어 달기가 있으면 {'MOVED', 새 판 값}. 판 가드에 더 큰 판이 있으면 {'SUPERSEDED', 그 판의 결과}, 같은 판이면 {'REPLAY', 처음 결과}.
 * 아니면 방법대로 하고 판과 결과를 적어 {'APPLIED', 결과}. 키 값을 읽고 지우는 일은 이 Lua 안에서 한다(읽은 뒤 다른 건이 올린 키를 지우지 않게).
 * 부정 예매 조치가 올린 키는 같은 사건의 이의 인정만 지우고, 그 사건의 다른 계정이 그 기기로 아직 조치 상태이면(c 칸이 0보다 크면) 지우지 않는다
 */
const BLOCK_LUA = redisScript(`
local bk, gk, nk = KEYS[1], KEYS[2], KEYS[3]
local e, ver, op, value, ttl, case, ev, pair, cf, fk = ARGV[1], tonumber(ARGV[2]), ARGV[3], ARGV[4], ARGV[5], ARGV[6], ARGV[7], ARGV[8], ARGV[9], ARGV[10]
local nxt = redis.call('GET', nk)
if nxt then return {'MOVED', nxt} end
local cur = redis.call('HGET', gk, e)
if cur then
  local sep = string.find(cur, '|', 1, true)
  local v = tonumber(string.sub(cur, 1, sep - 1))
  local r = string.sub(cur, sep + 1)
  if v > ver then return {'SUPERSEDED', r} end
  if v == ver then return {'REPLAY', r} end
end
if pair ~= '' then
  local rank = (fk == 'R') and 1 or 0
  local state = ''
  local pc = redis.call('HGET', gk, 'p' .. pair)
  if pc then
    local sep = string.find(pc, '|', 1, true)
    local pv = tonumber(string.sub(pc, 1, sep - 1))
    state = string.sub(pc, sep + 1)
    local pr = (state == 'R') and 1 or 0
    if pv > ver or (pv == ver and pr > rank) then return {'SUPERSEDED', 'NONE'} end
  end
  if fk == 'A' and state ~= 'A' then redis.call('HINCRBY', gk, 'c' .. cf, 1) end
  if fk == 'R' and state == 'A' then redis.call('HINCRBY', gk, 'c' .. cf, -1) end
  redis.call('HSET', gk, 'p' .. pair, ARGV[2] .. '|' .. fk)
end
local function current()
  local raw = redis.call('GET', bk)
  if not raw then return nil end
  local ok, v = pcall(cjson.decode, raw)
  if ok and type(v) == 'table' then return v end
  return {}
end
local result = 'NONE'
if op == 'ADD' then
  if redis.call('EXISTS', bk) == 0 then
    redis.call('SET', bk, value, 'PX', ttl)
    result = 'ADDED'
  end
elseif op == 'DEL' then
  local v = current()
  if v and v['source'] ~= 'FRAUD_ACTIONED' then
    redis.call('DEL', bk)
    result = 'REMOVED'
  end
elseif op == 'DEL_CASE' then
  local v = current()
  if v and v['caseId'] == case and v['source'] ~= 'FRAUD_ACTIONED' then
    redis.call('DEL', bk)
    result = 'REMOVED'
  end
elseif op == 'FRAUD_RELEASE' then
  local v = current()
  local left = tonumber(redis.call('HGET', gk, 'c' .. cf) or '0')
  if v and left <= 0 then
    local same = v['caseId'] == case
    if (same or ev == '1') and (same or v['source'] ~= 'FRAUD_ACTIONED') then
      redis.call('DEL', bk)
      result = 'REMOVED'
    end
  end
end
redis.call('HSET', gk, e, ARGV[2] .. '|' .. result)
redis.call('PEXPIRE', gk, ttl)
return {'APPLIED', result}
`);

/** '끝남'과 결과·찾은 기기(KEYS[1] tr:lbl). ARGV: 라벨 칸, 판, 결과, 수명, 기기(없으면 ''). 그사이 다른 판이 잡았으면 적지 않고 0 */
const FINISH_LUA = redisScript(`
local k, e, ver = KEYS[1], ARGV[1], tonumber(ARGV[2])
local v = tonumber(redis.call('HGET', k, e .. ':v') or '0')
if v ~= ver then return 0 end
redis.call('HSET', k, e .. ':s', 'D', e .. ':r', ARGV[3])
if ARGV[5] ~= '' then redis.call('HSET', k, e .. ':d', ARGV[5]) end
redis.call('PEXPIRE', k, ARGV[4])
return 1
`);

const HARD = new Set<HardSignal>(['NONE', 'BLOCK_LIST', 'HONEYPOT']);

export class RedisLabelStore implements LabelStore {
  constructor(private readonly redis: HotRedis) {}

  async claim(i: { sourceRef: string; family: string; who: string; entry: string; version: number; label: Label; fraud?: { pair: string; partner: string; kind: 'A' | 'R' } }): Promise<LabelClaim> {
    const f = i.fraud;
    const out = (await this.redis.evalScript(CLAIM_LUA, [keys.label(i.sourceRef)], [i.family, i.who, i.entry, String(i.version), i.label, String(BLOCK_TTL_MS), f?.pair ?? '', f?.partner ?? '', f ? RANK[f.kind] : '0'])) as unknown[];
    const kind = String(out[0]);
    if (kind === 'CONFLICT') return { kind: 'CONFLICT' };
    if (kind === 'STALE' || kind === 'DONE') return { kind, result: asResult(out[1]) };
    if (kind === 'GO') {
      const d = String(out[2] ?? '');
      return { kind: 'GO', resume: String(out[1]) === 'RESUME', device: DEVICE_REF.test(d) ? d : undefined };
    }
    throw new Error('라벨 멱등 기록 Lua의 답이 틀렸다');
  }

  /** 판정 근거 키의 사건 키·기기 가명·확정 신호. 모양이 틀린 값은 근거가 없는 것으로 본다 */
  async evidence(pid: string, eventId: string): Promise<LabelEvidence | undefined> {
    const k = keys.evidence(pid, eventId);
    const raw = await this.redis.command(['GET', k], { key: k });
    if (raw === null || raw === undefined) return undefined;
    let v: unknown;
    try {
      v = JSON.parse(String(raw));
    } catch {
      return undefined;
    }
    if (!v || typeof v !== 'object') return undefined;
    const o = v as { eventKey?: unknown; deviceRef?: unknown; hardSignal?: unknown };
    const hardSignal = HARD.has(o.hardSignal as HardSignal) ? (o.hardSignal as HardSignal) : 'NONE';
    const deviceRef = typeof o.deviceRef === 'string' && DEVICE_REF.test(o.deviceRef) ? o.deviceRef : undefined;
    const eventKey = typeof o.eventKey === 'string' ? o.eventKey.toLowerCase() : undefined;
    return { eventKey, deviceRef, hardSignal };
  }

  async follow(deviceRef: string): Promise<string> {
    let ref = deviceRef;
    for (let n = 0; n < FOLLOW_MAX; n++) {
      const k = keys.refNext(ref);
      const next = await this.redis.command(['GET', k], { key: k });
      if (typeof next !== 'string' || !DEVICE_REF.test(next) || next === ref) break;
      ref = next;
    }
    return ref;
  }

  async applyBlock(i: { deviceRef: string; entry: string; version: number; op: BlockOp; evidenceBlock: boolean; value: string; caseId: string; fraud?: FraudGuard }): Promise<BlockApplied> {
    const f = i.fraud;
    const out = (await this.redis.evalScript(
      BLOCK_LUA,
      [keys.block(i.deviceRef), keys.blockVersion(i.deviceRef), keys.refNext(i.deviceRef)],
      [i.entry, String(i.version), i.op, i.value, String(BLOCK_TTL_MS), i.caseId, i.evidenceBlock ? '1' : '0', f?.pair ?? '', f?.caseField ?? '', f?.kind ?? ''],
    )) as unknown[];
    const kind = String(out[0]);
    if (kind === 'MOVED') {
      const next = String(out[1]);
      if (!DEVICE_REF.test(next)) throw new Error('이어 달기의 값이 기기 가명 모양이 아니다');
      return { kind: 'MOVED', next };
    }
    if (kind !== 'APPLIED' && kind !== 'REPLAY' && kind !== 'SUPERSEDED') throw new Error('차단 키 Lua의 답이 틀렸다');
    const result = asResult(out[1]);
    return { kind, result: result === 'DEVICE_NOT_FOUND' ? 'NONE' : result };
  }

  async finish(i: { sourceRef: string; entry: string; version: number; result: BlockListChange; device: string | undefined }): Promise<boolean> {
    return Number(await this.redis.evalScript(FINISH_LUA, [keys.label(i.sourceRef)], [i.entry, String(i.version), i.result, String(BLOCK_TTL_MS), i.device ?? ''])) === 1;
  }
}
