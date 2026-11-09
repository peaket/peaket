// 판정 피처 Redis 저장소(docs/features/bot-defense.md §3.2·§4.1, docs/data.md §3). 세션·캐시 클러스터, 핫패스 시간 초과 100ms(플랫폼 createHotRedis).
// 키의 해시 태그는 기기 가명 또는 pid다. 키마다 슬롯이 달라 한 Lua로 묶지 않고 명령을 따로 보내고, 키마다 성공·실패를 따로 받는다(실패한 피처만 값 없음, §18).
// tr:devacct는 정렬 집합(점수는 마지막으로 본 시각)이고 쓸 때 30일 지난 사람을 지운다. tr:devhist는 날짜 칸(`sent:{일}` 등)으로 나눠 지난 30일만 더한다.
// 회차별 기기 공유 수·호스팅 대역 진입 수(tr:devshare·tr:asnhost)는 BUILD_ORDER BOT-060이다.
import { type HotRedis, redisScript } from '@peaket/platform';
import type { FeatureName, FeatureRead, FeatureStore, VerdictEvidence } from '../domain/ports.js';
import type { DeviceHistory } from '../domain/types.js';

const DAY_MS = 86_400_000;
/** 기기 신뢰 이력의 '지난 30일'(§3.2)과 키 전체 수명 */
const WINDOW_DAYS = 30;
const WINDOW_MS = WINDOW_DAYS * DAY_MS;
/** 판정 근거 키 30일 [가정] */
const EVIDENCE_TTL_MS = 30 * DAY_MS;
/** pid별 하루 새 기기 수 키의 수명: 하루 칸이 끝나고 지워질 때까지 */
const NEW_DEVICES_TTL_MS = 2 * DAY_MS;
/** 기기 하나의 본인확인 계정 수 상한 [가정](§3.2 tr:devacct) */
export const DEV_ACCOUNT_CAP = 20;

export const keys = {
  devAccounts: (ref: string) => `tr:devacct:{${ref}}`,
  devHistory: (ref: string) => `tr:devhist:{${ref}}`,
  block: (ref: string) => `tr:block:{${ref}}`,
  honeypot: (pid: string) => `tr:hp:{${pid}}`,
  evidence: (pid: string, eventId: string) => `tr:vb:{${pid}}:${eventId}`,
  newDevices: (pid: string, day: number) => `tr:pidnew:{${pid}}:${day}`,
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

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) && n >= 0 ? n : 0;
};

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

/** 반드시 부르는 읽기 넷의 결과를 키마다 받는다. deviceRef가 없으면 기기 키는 묻지 않는다(값 없음이지만 실패는 아니다) */
export class RedisFeatureStore implements FeatureStore {
  constructor(private readonly redis: HotRedis) {}

  async read(i: { deviceRef: string | undefined; pid: string; now: number }): Promise<FeatureRead> {
    const ref = i.deviceRef;
    const cutoff = String(i.now - WINDOW_MS);
    const minDay = dayOf(i.now) - WINDOW_DAYS + 1;
    const [accounts, history, blocked, honeypot] = await Promise.allSettled([
      ref ? this.redis.evalScript(COUNT_ACCOUNTS_LUA, [keys.devAccounts(ref)], [cutoff, i.pid]) : Promise.resolve(undefined),
      ref ? this.redis.command(['HGETALL', keys.devHistory(ref)], { key: keys.devHistory(ref) }) : Promise.resolve(undefined),
      ref ? this.redis.command(['EXISTS', keys.block(ref)], { key: keys.block(ref) }) : Promise.resolve(undefined),
      i.pid ? this.redis.command(['EXISTS', keys.honeypot(i.pid)], { key: keys.honeypot(i.pid) }) : Promise.resolve(undefined),
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
    return {
      accounts: a === undefined ? undefined : num(a),
      history: h === undefined ? undefined : historyOf(h, minDay),
      blocked: b === undefined ? undefined : num(b) > 0,
      honeypot: p === undefined ? undefined : num(p) > 0,
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

  async recordVerification(i: { deviceRef: string; passed: boolean; now: number }): Promise<void> {
    await this.#bump(i.deviceRef, i.passed ? 'passed' : 'failed', i.now);
  }

  #bump(deviceRef: string, kind: keyof DeviceHistory, now: number): Promise<unknown> {
    const day = dayOf(now);
    return this.redis.evalScript(BUMP_HISTORY_LUA, [keys.devHistory(deviceRef)], [`${kind}:${day}`, String(day - WINDOW_DAYS + 1), String(WINDOW_MS)]);
  }
}
