// 판정 피처 Redis 저장소(docs/features/bot-defense.md §3.2·§4.1, docs/data.md §3). 세션·캐시 클러스터, 핫패스 시간 초과 100ms(플랫폼 createHotRedis).
// 키의 해시 태그는 기기 가명 또는 pid다. 키마다 슬롯이 달라 한 Lua로 묶지 않고 명령을 따로 보내고, 키마다 성공·실패를 따로 받는다(실패한 피처만 값 없음, §18).
// tr:devacct는 정렬 집합(점수는 마지막으로 본 시각)이고 쓸 때 30일 지난 사람을 지운다. tr:devhist는 날짜 칸(`sent:{일}` 등)으로 나눠 지난 30일만 더한다.
// 회차별 기기 공유 수(tr:devshare)와 호스팅·프록시 대역 진입 수(tr:asnhost)는 다른 키 읽기와 함께 넣고 센다(§4.9, ADR-0251). 허니팟 적중 표시(tr:hp)의 쓰기는 BOT-055가 더했다.
// 차단 키(tr:block)는 여기서 읽기(EXISTS)와 키 회전 이음의 옮기기(있는 키를 새 판 이름으로 되살리기)만 한다. 새로 올리는 곳은 라벨 반영 저장소(redis-label-store.ts) 하나다(§9, B-T9 ①).
import { type HotRedis, redisScript } from '@peaket/platform';
import { HONEYPOT_EVENTS_PER_PID } from '../domain/honeypot.js';
import { type FeatureName, type FeatureRead, type FeatureStore, MIGRATION_FEATURES, type MigrationFeature, type MigrationOutcome, type MigrationResult, type VerdictEvidence } from '../domain/ports.js';
import { DEV_SHARE_CAP } from '../domain/rules.js';
import type { DeviceHistory } from '../domain/types.js';

const DAY_MS = 86_400_000;
/** 기기 신뢰 이력의 '지난 30일'(§3.2)과 키 전체 수명 */
const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;
/** 판정 근거 키 30일 [가정] */
const EVIDENCE_TTL_MS = 30 * DAY_MS;
/** 허니팟 적중 표시 24시간 [가정](§3.2) */
const HONEYPOT_TTL_MS = DAY_MS;
/** pid별 하루 새 기기 수 키의 수명: 하루 칸이 끝나고 지워질 때까지 */
const NEW_DEVICES_TTL_MS = 2 * DAY_MS;
/** 기기 하나의 본인확인 계정 수 상한 [가정](§3.2 tr:devacct) */
export const DEV_ACCOUNT_CAP = 20;
/** 회차별 기기 공유 수의 수명 10분 [가정]. 첫 원소를 넣을 때만 정한다 */
const DEV_SHARE_TTL_MS = 600_000;
/** 호스팅·프록시 대역 진입 수의 칸(§3.2 tr:asnhost) */
const ASN_HOST_BUCKET_MS = 10_000;
/** 호스팅·프록시 대역 진입 수 키의 수명 30초 [가정] */
const ASN_HOST_TTL_MS = 30_000;

export const keys = {
  devAccounts: (ref: string) => `tr:devacct:{${ref}}`,
  devHistory: (ref: string) => `tr:devhist:{${ref}}`,
  block: (ref: string) => `tr:block:{${ref}}`,
  honeypot: (pid: string) => `tr:hp:{${pid}}`,
  honeypotEvents: (pid: string) => `tr:hp:{${pid}}:ev`,
  evidence: (pid: string, eventId: string) => `tr:vb:{${pid}}:${eventId}`,
  newDevices: (pid: string, day: number) => `tr:pidnew:{${pid}}:${day}`,
  devShare: (ref: string, eventId: string) => `tr:devshare:{${ref}}:${eventId}`,
  asnHost: (asn: number, eventId: string, bucket: number) => `tr:asnhost:{${asn}}:${eventId}:${bucket}`,
  /** 라벨 반영의 멱등 기록(해시 태그는 건 ID, §9 '첫 구현') */
  label: (sourceRef: string) => `tr:lbl:{${sourceRef}}`,
  /** 차단 키의 판 가드(tr:block과 같은 해시 태그) */
  blockVersion: (ref: string) => `tr:blkv:{${ref}}`,
  /** 키 회전의 이어 달기: 옛 판 값 → 새 판 값(해시 태그는 옛 판 값, §4.10) */
  refNext: (oldRef: string) => `tr:refnext:{${oldRef}}`,
};

const dayOf = (ms: number): number => Math.floor(ms / DAY_MS);

/** 지난 30일 사람 수. 아직 없는(이번 요청의) pid도 하나로 센다. 읽기만 한다(쓰기는 사람 확인을 통과한 뒤) */
const COUNT_ACCOUNTS_LUA = redisScript(`
local key, cutoff, pid = KEYS[1], ARGV[1], ARGV[2]
local n = redis.call('ZCOUNT', key, cutoff, '+inf')
if pid ~= '' then
  local s = redis.call('ZSCORE', key, pid)
  if not s or tonumber(s) < tonumber(cutoff) then n = n + 1 end
end
return n
`);

/**
 * 사람 한 명을 기기 집합에 넣는다. 30일 지난 사람을 먼저 지워, 있는지·꽉 찼는지를 한 번에 본다(KEYS[1] 기기 집합).
 * 돌려주는 값: 1 끝남(이미 있어 시각을 고쳤거나 넣음), 2 꽉 차서 넣지 않음, 0 새 사람이라 몫이 필요함(granted가 '0'일 때). granted '1'이면 몫을 받은 뒤의 넣기다
 */
const ADD_ACCOUNT_LUA = redisScript(`
local key, pid, now, cutoff, cap, ttl, granted = KEYS[1], ARGV[1], ARGV[2], ARGV[3], tonumber(ARGV[4]), ARGV[5], ARGV[6]
redis.call('ZREMRANGEBYSCORE', key, '-inf', '(' .. cutoff)
if not redis.call('ZSCORE', key, pid) then
  if redis.call('ZCARD', key) >= cap then return 2 end
  if granted == '0' then return 0 end
end
redis.call('ZADD', key, now, pid)
redis.call('PEXPIRE', key, ttl)
return 1
`);

/** 오늘 이 pid가 새로 넣은 기기 수를 상한 안에서만 올린다. 넘었으면 0 */
const NEW_DEVICE_LUA = redisScript(`
local key, cap, ttl = KEYS[1], tonumber(ARGV[1]), ARGV[2]
local n = tonumber(redis.call('GET', key) or '0')
if n >= cap then return 0 end
redis.call('INCR', key)
redis.call('PEXPIRE', key, ttl)
return 1
`);

/**
 * 적중 표시를 쓰고(수명을 다시 시작한다), 회차가 있으면 pid의 회차 집합(정렬 집합, 점수는 시각)에 넣는다. 처음 넣었으면 1.
 * 24시간 지난 칸을 지우고, 이미 있거나 상한에 닿았으면 넣지 않는다. 세기와 넣기가 Lua 한 번이라 겹쳐도 상한을 넘지 않는다. 두 키는 해시 태그(pid)가 같다
 */
const RECORD_HONEYPOT_LUA = redisScript(`
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
if #KEYS < 2 then return 0 end
local now, ttl = tonumber(ARGV[4]), tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now - ttl)
if redis.call('ZSCORE', KEYS[2], ARGV[3]) then return 0 end
if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[5]) then return 0 end
redis.call('ZADD', KEYS[2], now, ARGV[3])
redis.call('PEXPIRE', KEYS[2], ttl)
return 1
`);

/** 날짜 칸을 올린다. 30일 지난 칸을 지운다. 필드는 '{sent|passed|failed}:{일}'이다 */
const BUMP_HISTORY_LUA = redisScript(`
local key, field, minDay, ttl = KEYS[1], ARGV[1], tonumber(ARGV[2]), ARGV[3]
redis.call('HINCRBY', key, field, 1)
for _, f in ipairs(redis.call('HKEYS', key)) do
  local d = tonumber(string.match(f, ':(%d+)$'))
  if d and d < minDay then redis.call('HDEL', key, f) end
end
redis.call('PEXPIRE', key, ttl)
return 1
`);

/**
 * 옛 판 키들을 한 번에 읽는다(키는 모두 옛 판 기기 가명의 해시 태그라 한 슬롯이다): 키마다 없으면 nil, 있으면 {DUMP 값, 남은 수명(밀리초)}.
 * 이음 기간의 판정마다 부르므로 명령 하나로 둔다(이미 옮긴 기기는 이것으로 끝난다)
 */
const DUMP_LUA = redisScript(`
local out = {}
for i, k in ipairs(KEYS) do
  local p = redis.call('DUMP', k)
  if p then out[i] = {p, redis.call('PTTL', k)} else out[i] = false end
end
return out
`);

/**
 * 옮긴 뒤 옛 판 키 지우기(KEYS[1] 옛 판 키, KEYS[2] tr:refnext:{옛 판}. 해시 태그가 같다). ARGV: 읽은 사본, 새 판 값, 이어 달기 수명, 이어 달기를 함께 둘지('1', 차단 키).
 * 옛 판 키가 읽은 때와 같을 때만 지운다(그사이 라벨 반영이 바꾸거나 지웠으면 지우지 않는다): 1 지움, -1 달라짐, 0 없음, 2 없고 이어 달기가 있음(다른 판정이 옮겼다).
 * 차단 키는 지우는 일과 이어 달기를 한 번에 둔다(그 사이에 온 라벨 반영이 옛 판 키도 이어 달기도 못 보는 틈이 없게)
 */
const FINISH_MOVE_LUA = redisScript(`
local cur = redis.call('DUMP', KEYS[1])
if not cur then
  if redis.call('EXISTS', KEYS[2]) == 1 then return 2 end
  return 0
end
if cur ~= ARGV[1] then return -1 end
redis.call('DEL', KEYS[1])
if ARGV[4] == '1' then redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3]) end
return 1
`);

/** 되살린 새 판 키 되돌리기(KEYS[1] 새 판 키). 읽은 사본(ARGV[1])과 같을 때만 지운다(그사이 새 판 키를 다른 쪽이 바꿨으면 둔다) */
const UNDO_MOVE_LUA = redisScript(`
if redis.call('DUMP', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`);

/**
 * DUMP 값(바이트)을 명령 인자로 넘긴다. node-redis는 Buffer 인자를 바이트 그대로 보내지만 HotRedis의 인자 형은 글뿐이라 여기서만 넓힌다.
 * 글로 바꾸면 UTF-8로 다시 써져 0x80 이상 바이트가 깨지고 RESTORE가 거절된다
 */
const bytes = (b: Buffer): string => b as unknown as string;

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

/**
 * 회차별 기기 공유 수에 pid를 넣고 센다. 키 하나만 쓴다(클러스터 슬롯을 넘지 않는다). 있는 사람이면 지금 수, 상한이면 상한(상한 이상은 같게 본다), 새 사람이면 넣고 지금 수 + 1이다.
 * 수명은 첫 원소를 넣을 때만 정해 뒤 원소가 늘리지 않는다
 */
const COUNT_SHARE_LUA = redisScript(`
local key, pid, cap, ttl = KEYS[1], ARGV[1], tonumber(ARGV[2]), ARGV[3]
local n = redis.call('SCARD', key)
if redis.call('SISMEMBER', key, pid) == 1 then return n end
if n >= cap then return n end
redis.call('SADD', key, pid)
if n == 0 then redis.call('PEXPIRE', key, ttl) end
return n + 1
`);

/** 호스팅·프록시 대역의 이번 칸 진입 수를 올린다. 수명은 칸의 첫 진입에만 정한다 */
const COUNT_HOST_ENTRY_LUA = redisScript(`
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return n
`);

/** HGETALL 응답을 더한다(node-redis는 RESP2에서 필드·값이 번갈아 오는 배열이다). 지난 30일 칸만 센다 */
function historyOf(raw: unknown, minDay: number): DeviceHistory {
  const fields: Record<string, unknown> = {};
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) fields[String(raw[i])] = raw[i + 1];
  else if (raw && typeof raw === 'object') Object.assign(fields, raw);
  const out: DeviceHistory = { sent: 0, passed: 0, failed: 0 };
  for (const [f, v] of Object.entries(fields)) {
    const [kind, day] = f.split(':');
    if (kind !== 'sent' && kind !== 'passed' && kind !== 'failed') continue;
    if (Number(day) >= minDay) out[kind] += num(v);
  }
  return out;
}

/** 읽기의 결과를 키마다 받는다. deviceRef가 없으면 기기 키는 묻지 않고, hostEntry·shareEventId가 없으면 그 키를 세지 않는다(값 없음이지만 실패는 아니다) */
export class RedisFeatureStore implements FeatureStore {
  constructor(private readonly redis: HotRedis) {}

  async read(i: { deviceRef: string | undefined; pid: string; now: number; hostEntry?: { asn: number; eventId: string } | undefined; shareEventId?: string | undefined }): Promise<FeatureRead> {
    const ref = i.deviceRef;
    const cutoff = String(i.now - WINDOW_MS);
    const minDay = dayOf(i.now) - WINDOW_DAYS + 1;
    const host = i.hostEntry;
    const [accounts, history, blocked, honeypot, entries, shared] = await Promise.allSettled([
      ref ? this.redis.evalScript(COUNT_ACCOUNTS_LUA, [keys.devAccounts(ref)], [cutoff, i.pid]) : Promise.resolve(undefined),
      ref ? this.redis.command(['HGETALL', keys.devHistory(ref)], { key: keys.devHistory(ref) }) : Promise.resolve(undefined),
      ref ? this.redis.command(['EXISTS', keys.block(ref)], { key: keys.block(ref) }) : Promise.resolve(undefined),
      i.pid ? this.redis.command(['EXISTS', keys.honeypot(i.pid)], { key: keys.honeypot(i.pid) }) : Promise.resolve(undefined),
      host ? this.redis.evalScript(COUNT_HOST_ENTRY_LUA, [keys.asnHost(host.asn, host.eventId, Math.floor(i.now / ASN_HOST_BUCKET_MS))], [String(ASN_HOST_TTL_MS)]) : Promise.resolve(undefined),
      ref && i.pid && i.shareEventId ? this.redis.evalScript(COUNT_SHARE_LUA, [keys.devShare(ref, i.shareEventId)], [i.pid, String(DEV_SHARE_CAP), String(DEV_SHARE_TTL_MS)]) : Promise.resolve(undefined),
    ]);
    const failed: FeatureName[] = [];
    const value = (r: PromiseSettledResult<unknown>, name: FeatureName): unknown => {
      if (r.status === 'fulfilled') return r.value;
      failed.push(name);
      return undefined;
    };
    const a = value(accounts, 'accounts');
    const h = value(history, 'history');
    const b = value(blocked, 'block');
    const p = value(honeypot, 'honeypot');
    const e = value(entries, 'entries');
    const c = value(shared, 'shared');
    return {
      accounts: a === undefined ? undefined : num(a),
      history: h === undefined ? undefined : historyOf(h, minDay),
      blocked: b === undefined ? undefined : num(b) > 0,
      honeypot: p === undefined ? undefined : num(p) > 0,
      hostEntries: e === undefined ? undefined : num(e),
      shared: c === undefined ? undefined : num(c),
      failed,
    };
  }

  /**
   * 있는지·꽉 찼는지는 기기 키의 Lua 한 번으로 본다(30일 지난 사람은 새 사람이다). 이미 있으면 시각만 고치고, 꽉 찼으면 몫을 쓰지 않는다.
   * 새 사람이면 pid의 오늘 몫을 받고 다시 Lua로 넣는다. 기기 키와 pid 키는 해시 슬롯이 달라 클러스터에서 한 Lua로 묶을 수 없다(CROSSSLOT).
   * 그래서 같은 pid·기기가 겹치면 몫이 하나 더 줄 수 있고, 몫을 받은 사이 기기가 꽉 차면 몫이 하나 준다(몫이 남는 쪽으로는 틀리지 않는다)
   */
  async addAccount(i: { deviceRef: string; pid: string; now: number; newDevicesPerDay: number }): Promise<void> {
    const key = keys.devAccounts(i.deviceRef);
    const run = (granted: '0' | '1') => this.redis.evalScript(ADD_ACCOUNT_LUA, [key], [i.pid, String(i.now), String(i.now - WINDOW_MS), String(DEV_ACCOUNT_CAP), String(WINDOW_MS), granted]);
    if (Number(await run('0')) !== 0) return;
    const ok = await this.redis.evalScript(NEW_DEVICE_LUA, [keys.newDevices(i.pid, dayOf(i.now))], [String(i.newDevicesPerDay), String(NEW_DEVICES_TTL_MS)]);
    if (Number(ok) !== 1) return;
    await run('1');
  }

  /** 판정 근거는 처음 CHALLENGE 때의 것을 남긴다(나중 판정이 이의 심사의 근거를 덮지 않게, SET NX) */
  async recordChallenge(i: { deviceRef: string | undefined; pid: string; eventId: string; evidence: VerdictEvidence; now: number }): Promise<void> {
    const e = keys.evidence(i.pid, i.eventId);
    await Promise.all([
      i.deviceRef ? this.#bump(i.deviceRef, 'sent', i.now) : Promise.resolve(0),
      i.pid && i.eventId ? this.redis.command(['SET', e, JSON.stringify(i.evidence), 'NX', 'PX', String(EVIDENCE_TTL_MS)], { key: e }) : Promise.resolve('OK'),
    ]);
  }

  /** 다음 판정이 확정 신호로 쓴다. 값은 적중 시각과 회차다(§3.2). 같은 사람의 뒤 적중은 수명을 다시 시작한다 */
  async recordHoneypot(i: { pid: string; eventId: string; now: number }): Promise<boolean> {
    const k = [keys.honeypot(i.pid), ...(i.eventId ? [keys.honeypotEvents(i.pid)] : [])];
    return Number(await this.redis.evalScript(RECORD_HONEYPOT_LUA, k, [JSON.stringify({ atMs: i.now, eventId: i.eventId }), String(HONEYPOT_TTL_MS), i.eventId, String(i.now), String(HONEYPOT_EVENTS_PER_PID)])) === 1;
  }

  /**
   * 키 회전의 이음(§4.10, secrets-and-keys '`inv-ref-key` 회전 절차' ⑤): 옛 판 키를 DUMP·PTTL로 읽어 새 판 키로 RESTORE(남은 수명 그대로)하고,
   * 옛 판 키가 읽은 때와 같을 때만 지운다. 다르면(그사이 라벨 반영이 바꿨으면) 되살린 새 판 키를 되돌리고 그 키를 실패로 본다.
   * 새 판 키가 그사이 생겼으면 RESTORE가 BUSYKEY로 거절해 건너뛴다(덮지 않는다). 차단 키만은 새 판으로 이미 막고 있어 잃는 것이 없으므로 옛 판 키를 지우고 이어 달기를 둔다.
   * 차단 키를 지울 때는 이어 달기를 같은 Lua에서 두고, 다른 키를 옮겼으면 끝에 둔다(차단 키·판 가드를 옮기지 못했으면 두지 않아 라벨 반영이 옛 판 키를 바꾸게 한다).
   * 옛 판 키와 새 판 키는 해시 태그가 달라 한 Lua로 묶지 못한다. 키마다 결과를 따로 주고 던지지 않는다(옛 판 키를 읽지 못하면 모두 failed)
   */
  async migrate(i: { from: string; to: string; eventId: string; until: number; now: number }): Promise<MigrationResult> {
    const pairs: Record<MigrationFeature, readonly [string, string]> = {
      accounts: [keys.devAccounts(i.from), keys.devAccounts(i.to)],
      history: [keys.devHistory(i.from), keys.devHistory(i.to)],
      block: [keys.block(i.from), keys.block(i.to)],
      shared: [keys.devShare(i.from, i.eventId), keys.devShare(i.to, i.eventId)],
      block_version: [keys.blockVersion(i.from), keys.blockVersion(i.to)],
    };
    const failed = Object.fromEntries(MIGRATION_FEATURES.map((f) => [f, 'failed'])) as MigrationResult;
    let dumps: unknown;
    try {
      dumps = await this.redis.evalScript(DUMP_LUA, MIGRATION_FEATURES.map((f) => pairs[f][0]), [], { binary: true });
    } catch {
      return failed;
    }
    if (!Array.isArray(dumps) || dumps.length !== MIGRATION_FEATURES.length) return failed;
    const nextTtl = String(Math.max(1, i.until - i.now));
    const refNext = keys.refNext(i.from);
    const outcomes = await Promise.all(MIGRATION_FEATURES.map((f, n) => this.#move(dumps[n], pairs[f][0], pairs[f][1], refNext, i.to, nextTtl, f === 'block')));
    const result = Object.fromEntries(MIGRATION_FEATURES.map((f, n) => [f, outcomes[n]!])) as MigrationResult;
    if (outcomes.includes('moved') && result.block !== 'failed' && result.block_version !== 'failed') {
      try {
        await this.redis.command(['SET', refNext, i.to, 'PX', nextTtl], { key: refNext });
      } catch {
        // 이어 달기는 차단 키를 옮길 때 이미 함께 둔다. 다른 키의 이어 달기를 못 두면 라벨 반영은 옛 판 키를 바꾼다(다음 판정이 옮긴다)
      }
    }
    return result;
  }

  /** 읽은 옛 판 키 하나를 새 판으로 되살리고, 옛 판 키가 읽은 때와 같으면 지운다. 다르면 되살린 키를 되돌리고 실패다 */
  async #move(dump: unknown, from: string, to: string, refNext: string, newRef: string, nextTtl: string, block: boolean): Promise<MigrationOutcome> {
    try {
      if (!Array.isArray(dump)) return 'none';
      const [payload, pttl] = dump as [unknown, unknown];
      const left = Number(pttl);
      // 남은 수명이 0이면 이미 끝난 키다. 옮기면 수명 없는 키가 생긴다(RESTORE의 수명 0은 '수명 없음'이다). -1(수명 없음)만 수명 없이 되살린다
      if (!Buffer.isBuffer(payload) || !(left > 0 || left === -1)) return 'none';
      const finish = async () => Number(await this.redis.evalScript(FINISH_MOVE_LUA, [from, refNext], [bytes(payload), newRef, nextTtl, block ? '1' : '0'], { binary: true }));
      try {
        await this.redis.command(['RESTORE', to, String(left > 0 ? left : 0), bytes(payload)], { key: to });
      } catch (e) {
        if (!(e instanceof Error && e.message.startsWith('BUSYKEY'))) throw e;
        if (!block) return 'skipped';
        // 차단 키: 새 판으로 이미 막고 있다. 옛 판 키를 지우고 이어 달기를 둔다(지운 뒤 옛 판으로 다시 걸리지 않게). 그사이 바뀌었으면 실패다
        return (await finish()) === -1 ? 'failed' : 'skipped';
      }
      const done = await finish();
      // 1 지웠다, 2 다른 판정이 이미 옮기고 이어 달기를 뒀다
      if (done === 1 || done === 2) return 'moved';
      // 그사이 라벨 반영이 옛 판 키를 바꾸거나 지웠다: 되살린 새 판 키를 (읽은 사본과 같을 때만) 되돌린다
      await this.redis.evalScript(UNDO_MOVE_LUA, [to], [bytes(payload)], { binary: true });
      return 'failed';
    } catch {
      return 'failed';
    }
  }

  async recordVerification(i: { deviceRef: string; passed: boolean; now: number }): Promise<void> {
    await this.#bump(i.deviceRef, i.passed ? 'passed' : 'failed', i.now);
  }

  #bump(deviceRef: string, kind: keyof DeviceHistory, now: number): Promise<unknown> {
    const day = dayOf(now);
    return this.redis.evalScript(BUMP_HISTORY_LUA, [keys.devHistory(deviceRef)], [`${kind}:${day}`, String(day - WINDOW_DAYS + 1), String(WINDOW_MS)]);
  }
}
