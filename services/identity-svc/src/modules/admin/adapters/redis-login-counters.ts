// 관리 계정 로그인의 출발지가 든 값과 없는 계정의 가짜 상태(세션·캐시 Redis id:alf:*, docs/data.md §3 유실 등급 C,
// identity §6 '관리 계정 로그인 1단계와 실패 제한의 첫 구현', BUILD_ORDER BOT-111).
// 스크립트 하나가 한 슬롯만 다루도록 대상 {a:…}·출발지 {s:…}·전체 {g} 해시 태그를 두고, 실패 하나를 태그마다 Lua 한 번으로 센다.
// 시각은 부르는 쪽 시계(ms)를 받는다. 키 수명(PEXPIRE)은 정리용이고 판정은 저장한 끝 시각과 창으로 한다.
import { randomUUID } from 'node:crypto';
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import { type AccountLoginState, FRESH_LOGIN_STATE } from '../domain/login-rules.js';
import { type LoginCounters, type LoginCountersPeek, LoginCountersUnavailable, type LoginFailureLimits, type LoginFailureRecorded } from '../domain/ports.js';

const MINUTE = 60_000;
/** 묶음 키 수명 24시간, 전체 분 키 10분, 없는 계정 상태 30일 [가정](진짜 계정의 셈은 DB에 남으므로 길게, 새 맥락 리뷰 2026-11-05) */
const PAIR_TTL_MS = 24 * 60 * MINUTE;
const GLOBAL_MINUTE_TTL_MS = 10 * MINUTE;
const GHOST_TTL_MS = 30 * 24 * 60 * MINUTE;

export const loginKeys = {
  pair: (subject: string, pair: string) => `id:alf:{a:${subject}}:pair:${pair}`,
  accountSources: (subject: string) => `id:alf:{a:${subject}}:src`,
  accountAlert: (subject: string) => `id:alf:{a:${subject}}:alert`,
  /** ghostKey = `{aud}:{이메일 해시}`(대상 g:{ghostKey}와 같은 태그) */
  ghost: (ghostKey: string) => `id:alf:{a:g:${ghostKey}}:state`,
  busy: (subject: string) => `id:alf:{a:${subject}}:busy`,
  /** 해제 링크 다시 받기 횟수(콘솔·이메일 해시마다, 1시간 창, BOT-121) */
  resend: (hash: string) => `id:alf:{r:${hash}}:resend`,
  sourceAccounts: (ipHash: string) => `id:alf:{s:${ipHash}}:acct`,
  sourceAlert: (ipHash: string) => `id:alf:{s:${ipHash}}:alert`,
  globalMinute: (minute: number) => `id:alf:{g}:min:${minute}`,
  globalAlert: () => 'id:alf:{g}:alert',
};

// Lua 5.1의 tostring은 큰 수를 1.7e+12처럼 쓰므로 ms 값은 %.0f로 바꿔 넘긴다
const SUBJECT_FAIL = redisScript(`
local now = tonumber(ARGV[1])
local n = tonumber(redis.call('HGET', KEYS[1], 'n') or '0')
local u = tonumber(redis.call('HGET', KEYS[1], 'until') or '0')
if u > 0 and u <= now then n = 0; u = 0 end
n = n + 1
local lockUntil = 0
if ARGV[2] ~= '' then lockUntil = tonumber(ARGV[2]) elseif n >= tonumber(ARGV[4]) then lockUntil = now + tonumber(ARGV[3]) end
if lockUntil > 0 then n = 0 end
redis.call('HSET', KEYS[1], 'n', string.format('%.0f', n), 'until', string.format('%.0f', lockUntil))
local ttl = tonumber(ARGV[9])
if lockUntil - now + 60000 > ttl then ttl = lockUntil - now + 60000 end
redis.call('PEXPIRE', KEYS[1], string.format('%.0f', ttl))
local win = tonumber(ARGV[6])
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', string.format('%.0f', now - win))
redis.call('ZADD', KEYS[2], string.format('%.0f', now), ARGV[5])
redis.call('PEXPIRE', KEYS[2], string.format('%.0f', win))
local ips = redis.call('ZCARD', KEYS[2])
local raised = 0
if ips >= tonumber(ARGV[7]) then
  local a = tonumber(redis.call('GET', KEYS[3]) or '0')
  if a <= now then
    redis.call('SET', KEYS[3], string.format('%.0f', now + tonumber(ARGV[8])), 'PX', ARGV[8])
    raised = 1
  end
end
return { n, lockUntil, raised }
`);

// 창 안의 횟수가 한도 밑이면 하나 더한다. 넘으면 가장 오래된 것이 창을 벗어날 때까지 남은 ms
const RESEND = redisScript(`
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[2])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('%.0f', now - win))
local n = redis.call('ZCARD', KEYS[1])
if n >= tonumber(ARGV[3]) then
  local first = redis.call('ZRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  return { 0, tonumber(first[2]) + win - now }
end
redis.call('ZADD', KEYS[1], string.format('%.0f', now), ARGV[4])
redis.call('PEXPIRE', KEYS[1], string.format('%.0f', win))
return { 1, 0 }
`);

const RELEASE = redisScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end
return 0
`);

const SOURCE_FAIL = redisScript(`
local now = tonumber(ARGV[1])
local win = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', string.format('%.0f', now - win))
redis.call('ZADD', KEYS[1], string.format('%.0f', now), ARGV[2])
redis.call('PEXPIRE', KEYS[1], string.format('%.0f', win))
local emails = redis.call('ZCARD', KEYS[1])
local raised = 0
if emails >= tonumber(ARGV[4]) then
  local a = tonumber(redis.call('GET', KEYS[2]) or '0')
  if a <= now then
    redis.call('SET', KEYS[2], string.format('%.0f', now + tonumber(ARGV[5])), 'PX', ARGV[5])
    raised = 1
  end
end
return { emails, raised }
`);

// KEYS[1] 전체 경보, KEYS[2] 이번 분, KEYS[3..] 지난 분들
const GLOBAL_FAIL = redisScript(`
local now = tonumber(ARGV[1])
redis.call('INCR', KEYS[2])
redis.call('PEXPIRE', KEYS[2], ARGV[4])
local sum = 0
for i = 2, #KEYS do sum = sum + tonumber(redis.call('GET', KEYS[i]) or '0') end
local raised = 0
if sum >= tonumber(ARGV[2]) then
  local a = tonumber(redis.call('GET', KEYS[1]) or '0')
  if a <= now then
    redis.call('SET', KEYS[1], string.format('%.0f', now + tonumber(ARGV[3])), 'PX', ARGV[3])
    raised = 1
  end
end
return { sum, raised }
`);

const str = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('utf8') : v === null || v === undefined ? '' : String(v));
const num = (v: unknown) => {
  const n = Number(str(v));
  return Number.isFinite(n) ? n : 0;
};
const f0 = (n: number) => String(Math.round(n));

/** 장애는 LoginCountersUnavailable로. 그 밖의 오류는 인자가 로그에 실리지 않게 이름과 짧은 문구만 남긴다 */
async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRedisUnavailable(err)) throw new LoginCountersUnavailable(err instanceof Error ? err.name : undefined);
    const e = err as { name?: unknown; message?: unknown };
    throw new Error(`로그인 실패 셈 저장소 오류(${typeof e?.name === 'string' ? e.name : 'Error'}): ${typeof e?.message === 'string' ? e.message.split('\n')[0]!.slice(0, 80) : ''}`);
  }
}

function parseGhost(raw: string): AccountLoginState {
  try {
    const o = JSON.parse(raw) as Partial<AccountLoginState>;
    const int = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : 0);
    return {
      failedAttempts: int(o.failedAttempts),
      passwordFailureTotal: int(o.passwordFailureTotal),
      secondFactorFailures: int(o.secondFactorFailures),
      lockKind: o.lockKind === 'TIMED' || o.lockKind === 'PROTECT' ? o.lockKind : 'NONE',
      lockedUntil: Number.isFinite(o.lockedUntil) ? (o.lockedUntil as number) : null,
      recentLockAt: Array.isArray(o.recentLockAt) ? o.recentLockAt.filter((t): t is number => Number.isFinite(t)) : [],
      lockReason: o.lockReason === 'FAILED_ATTEMPTS' || o.lockReason === 'SECOND_FACTOR_FAILURES' || o.lockReason === 'PASSWORD_FAILURE_TOTAL' ? o.lockReason : null,
      lockedAt: Number.isFinite(o.lockedAt) ? (o.lockedAt as number) : null,
    };
  } catch {
    return structuredClone(FRESH_LOGIN_STATE);
  }
}

export class RedisLoginCounters implements LoginCounters {
  constructor(private readonly redis: HotRedis) {}

  #get(key: string): Promise<unknown> {
    return guard(this.redis.command(['GET', key], { key }));
  }

  async peek(i: { subject: string; pair: string; ipHash: string; now: number }): Promise<LoginCountersPeek> {
    const pk = loginKeys.pair(i.subject, i.pair);
    const [pair, aa, sa, ga] = await Promise.all([
      guard(this.redis.command(['HMGET', pk, 'n', 'until'], { key: pk })),
      this.#get(loginKeys.accountAlert(i.subject)),
      this.#get(loginKeys.sourceAlert(i.ipHash)),
      this.#get(loginKeys.globalAlert()),
    ]);
    const [n, until] = Array.isArray(pair) ? pair : [];
    const u = num(until);
    const live = u > i.now;
    return {
      pairFailures: u > 0 && !live ? 0 : num(n),
      pairLockedUntil: live ? u : null,
      accountAlert: num(aa) > i.now,
      sourceAlert: num(sa) > i.now,
      globalAlert: num(ga) > i.now,
    };
  }

  async recordFailure(i: { subject: string; pair: string; ipHash: string; emailHash: string; now: number; accountLockedUntil: number | null; pairLockMs: number; limits: LoginFailureLimits }): Promise<LoginFailureRecorded> {
    const L = i.limits;
    const minute = Math.floor(i.now / MINUTE);
    const minutes = Math.max(1, Math.ceil(L.globalWindowMs / MINUTE));
    const [subj, src, glob] = await Promise.all([
      guard(
        this.redis.evalScript(
          SUBJECT_FAIL,
          [loginKeys.pair(i.subject, i.pair), loginKeys.accountSources(i.subject), loginKeys.accountAlert(i.subject)],
          [f0(i.now), i.accountLockedUntil === null ? '' : f0(i.accountLockedUntil), f0(i.pairLockMs), String(L.pairLockAfter), i.ipHash, f0(L.windowMs), String(L.multiSourceIps), f0(L.accountAlertMs), f0(PAIR_TTL_MS)],
        ),
      ),
      guard(this.redis.evalScript(SOURCE_FAIL, [loginKeys.sourceAccounts(i.ipHash), loginKeys.sourceAlert(i.ipHash)], [f0(i.now), i.emailHash, f0(L.windowMs), String(L.sourceAccounts), f0(L.sourceAlertMs)])),
      guard(
        this.redis.evalScript(
          GLOBAL_FAIL,
          [loginKeys.globalAlert(), ...Array.from({ length: minutes }, (_, k) => loginKeys.globalMinute(minute - k))],
          [f0(i.now), String(L.globalFailures), f0(L.globalAlertMs), f0(GLOBAL_MINUTE_TTL_MS)],
        ),
      ),
    ]);
    const [n, lockUntil, accountRaised] = (subj as unknown[]).map(num);
    const [, sourceRaised] = (src as unknown[]).map(num);
    const [, globalRaised] = (glob as unknown[]).map(num);
    return { pairFailures: n!, pairLockedUntil: lockUntil! > 0 ? lockUntil! : null, newAccountAlert: accountRaised === 1, newSourceAlert: sourceRaised === 1, newGlobalAlert: globalRaised === 1 };
  }

  async acquire(subject: string, _now: number, ttlMs: number): Promise<string | null> {
    const k = loginKeys.busy(subject);
    const token = randomUUID();
    const r = await guard(this.redis.command(['SET', k, token, 'NX', 'PX', f0(ttlMs)], { key: k }));
    return str(r) === 'OK' ? token : null;
  }

  async release(subject: string, token: string): Promise<void> {
    await guard(this.redis.evalScript(RELEASE, [loginKeys.busy(subject)], [token]));
  }

  async countResend(emailHash: string, now: number, windowMs: number, limit: number): Promise<{ allowed: boolean; retryAfterMs: number }> {
    const r = (await guard(this.redis.evalScript(RESEND, [loginKeys.resend(emailHash)], [f0(now), f0(windowMs), String(limit), randomUUID()]))) as unknown[];
    const [ok, wait] = r.map(num);
    return { allowed: ok === 1, retryAfterMs: Math.max(0, wait ?? 0) };
  }

  async clearPair(subject: string, pair: string): Promise<void> {
    const k = loginKeys.pair(subject, pair);
    await guard(this.redis.command(['DEL', k], { key: k }));
  }

  async ghostState(ghostKey: string, _now?: number): Promise<AccountLoginState> {
    const raw = str(await this.#get(loginKeys.ghost(ghostKey)));
    return raw ? parseGhost(raw) : structuredClone(FRESH_LOGIN_STATE);
  }

  async setGhostState(ghostKey: string, state: AccountLoginState, _now?: number): Promise<void> {
    const k = loginKeys.ghost(ghostKey);
    await guard(this.redis.command(['SET', k, JSON.stringify(state), 'PX', f0(GHOST_TTL_MS)], { key: k }));
  }
}
