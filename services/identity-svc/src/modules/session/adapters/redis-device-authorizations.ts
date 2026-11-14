// 기기 승인 요청 저장소(세션·캐시 Redis id:devauth:{deviceCodeHash}, Hash, 5분, identity §6.1, GAT-220).
// 사용자 확인 코드 색인은 id:devcode:{userCode} -> deviceCodeHash이고 같은 수명을 준다.
// 승인·거부·폴링은 Lua 하나로 처리해 승인과 폴링이 겹쳐도 한 번만 반영한다.
import { type HotRedis, isRedisUnavailable, redisScript } from '@peaket/platform';
import type { ApprovedScannerSession, DeviceAuthorizationPoll, DeviceAuthorizationRecord } from '../domain/device-approval.js';
import { type DeviceAuthorizationStore, DeviceAuthorizationUnavailable } from '../domain/ports.js';

export const deviceAuthorizationKey = (hash: string) => `id:devauth:${hash}`;
export const deviceUserCodeKey = (userCode: string) => `id:devcode:${userCode}`;

const SAVE = redisScript(`
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], unpack(ARGV, 3))
redis.call('PEXPIREAT', KEYS[1], ARGV[1])
redis.call('SET', KEYS[2], ARGV[2], 'PXAT', ARGV[1])
return 1
`);

const APPROVE = redisScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'PENDING' then return 0 end
if tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs')) <= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'status', 'APPROVED', 'approved', ARGV[2])
return 1
`);

const DENY = redisScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
if redis.call('HGET', KEYS[1], 'status') ~= 'PENDING' then return 0 end
if tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs')) <= tonumber(ARGV[1]) then return 0 end
redis.call('HSET', KEYS[1], 'status', 'DENIED')
return 1
`);

const POLL = redisScript(`
if redis.call('EXISTS', KEYS[1]) == 0 then return {'EXPIRED'} end
local exp = tonumber(redis.call('HGET', KEYS[1], 'expiresAtMs'))
if exp <= tonumber(ARGV[1]) then redis.call('DEL', KEYS[1]) return {'EXPIRED'} end
local status = redis.call('HGET', KEYS[1], 'status')
if status == 'APPROVED' then return {'APPROVED', redis.call('HGET', KEYS[1], 'approved')} end
if status == 'DENIED' then return {'DENIED'} end
local last = tonumber(redis.call('HGET', KEYS[1], 'lastPolledAtMs') or '0')
local interval = tonumber(redis.call('HGET', KEYS[1], 'intervalSec') or '5') * 1000
if last > 0 and tonumber(ARGV[1]) - last < interval then return {'SLOW_DOWN', tostring(interval - (tonumber(ARGV[1]) - last))} end
redis.call('HSET', KEYS[1], 'lastPolledAtMs', ARGV[1])
return {'PENDING'}
`);

const str = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v ?? ''));

async function guard<T>(p: Promise<T>): Promise<T> {
  try {
    return await p;
  } catch (err) {
    if (isRedisUnavailable(err)) throw new DeviceAuthorizationUnavailable(err);
    const e = err as { name?: unknown; message?: unknown };
    throw new Error(`기기 승인 저장소 오류(${typeof e?.name === 'string' ? e.name : 'Error'}): ${typeof e?.message === 'string' ? e.message.split('\n')[0]!.slice(0, 80) : ''}`);
  }
}

function fieldsOf(raw: unknown): Record<string, string> {
  const o: Record<string, string> = {};
  if (Array.isArray(raw)) for (let i = 0; i + 1 < raw.length; i += 2) o[str(raw[i])] = str(raw[i + 1]);
  else if (raw && typeof raw === 'object') for (const [k, v] of Object.entries(raw)) o[k] = str(v);
  return o;
}

function parse(hash: string, f: Record<string, string>, now: number): DeviceAuthorizationRecord | null {
  const num = (k: string) => (/^\d{1,16}$/.test(f[k] ?? '') ? Number(f[k]) : null);
  const createdAtMs = num('createdAtMs');
  const expiresAtMs = num('expiresAtMs');
  const intervalSec = num('intervalSec');
  const status = f.status;
  if (createdAtMs === null || expiresAtMs === null || intervalSec === null) return null;
  if (expiresAtMs <= now) return null;
  if (status !== 'PENDING' && status !== 'APPROVED' && status !== 'DENIED') return null;
  if (!f.userCode || !f.deviceId || !f.deviceName || !f.promoterId || !f.jkt) return null;
  let approved: ApprovedScannerSession | undefined;
  if (status === 'APPROVED') {
    if (!f.approved) return null;
    try {
      approved = JSON.parse(f.approved) as ApprovedScannerSession;
    } catch {
      return null;
    }
  }
  return {
    deviceCodeHash: hash,
    userCode: f.userCode,
    deviceId: f.deviceId,
    deviceName: f.deviceName,
    promoterId: f.promoterId,
    jkt: f.jkt,
    status,
    createdAtMs,
    expiresAtMs,
    intervalSec,
    ...(num('lastPolledAtMs') !== null ? { lastPolledAtMs: num('lastPolledAtMs')! } : {}),
    ...(approved ? { approved } : {}),
  };
}

export class RedisDeviceAuthorizations implements DeviceAuthorizationStore {
  constructor(
    private readonly redis: HotRedis,
    private readonly now: () => number,
  ) {}

  async save(r: DeviceAuthorizationRecord): Promise<void> {
    const key = deviceAuthorizationKey(r.deviceCodeHash);
    const fields = [
      ['userCode', r.userCode],
      ['deviceId', r.deviceId],
      ['deviceName', r.deviceName],
      ['promoterId', r.promoterId],
      ['jkt', r.jkt],
      ['status', r.status],
      ['createdAtMs', String(r.createdAtMs)],
      ['expiresAtMs', String(r.expiresAtMs)],
      ['intervalSec', String(r.intervalSec)],
      ...(r.lastPolledAtMs !== undefined ? [['lastPolledAtMs', String(r.lastPolledAtMs)]] : []),
      ...(r.approved !== undefined ? [['approved', JSON.stringify(r.approved)]] : []),
    ].flat();
    await guard(this.redis.evalScript(SAVE, [key, deviceUserCodeKey(r.userCode)], [String(r.expiresAtMs), r.deviceCodeHash, ...fields]));
  }

  async findByUserCode(userCode: string): Promise<DeviceAuthorizationRecord | null> {
    const indexKey = deviceUserCodeKey(userCode);
    const hash = str(await guard(this.redis.command(['GET', indexKey], { key: indexKey })));
    return hash ? this.get(hash) : null;
  }

  async get(deviceCodeHash: string): Promise<DeviceAuthorizationRecord | null> {
    const key = deviceAuthorizationKey(deviceCodeHash);
    return parse(deviceCodeHash, fieldsOf(await guard(this.redis.command(['HGETALL', key], { key }))), this.now());
  }

  async approve(i: { deviceCodeHash: string; approved: ApprovedScannerSession; nowMs: number }): Promise<boolean> {
    const key = deviceAuthorizationKey(i.deviceCodeHash);
    return Number(await guard(this.redis.evalScript(APPROVE, [key], [String(i.nowMs), JSON.stringify(i.approved)]))) === 1;
  }

  async deny(deviceCodeHash: string, nowMs: number): Promise<boolean> {
    const key = deviceAuthorizationKey(deviceCodeHash);
    return Number(await guard(this.redis.evalScript(DENY, [key], [String(nowMs)]))) === 1;
  }

  async notePoll(deviceCodeHash: string, nowMs: number): Promise<DeviceAuthorizationPoll> {
    const key = deviceAuthorizationKey(deviceCodeHash);
    const raw = await guard(this.redis.evalScript(POLL, [key], [String(nowMs)]));
    const parts = Array.isArray(raw) ? raw.map(str) : [];
    const result = parts[0];
    if (result === 'APPROVED' && parts[1]) return { result: 'APPROVED', approved: JSON.parse(parts[1]) as ApprovedScannerSession };
    if (result === 'DENIED') return { result: 'DENIED' };
    if (result === 'SLOW_DOWN') return { result: 'SLOW_DOWN', retryAfterMs: Number(parts[1] ?? 0) };
    if (result === 'PENDING') return { result: 'PENDING' };
    return { result: 'EXPIRED' };
  }
}

export class RedisDeviceApprovalLimits {
  constructor(private readonly redis: HotRedis) {}

  private async allow(key: string, windowMs: number, max: number, nowMs: number): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
    const n = Number(await guard(this.redis.command(['INCR', key], { key })));
    if (n === 1) await guard(this.redis.command(['PEXPIRE', key, String(windowMs)], { key }));
    if (n <= max) return { allowed: true };
    const ttl = Number(await guard(this.redis.command(['PTTL', key], { key })));
    return { allowed: false, retryAfterMs: Math.max(0, Number.isFinite(ttl) ? ttl : windowMs) };
  }

  async allowIssue(deviceId: string, nowMs: number): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
    return this.allow(`id:devrate:issue:${deviceId}`, 60 * 60_000, 10, nowMs);
  }

  async allowApproval(accountId: string, nowMs: number): Promise<{ allowed: true } | { allowed: false; retryAfterMs: number }> {
    return this.allow(`id:devrate:approve:${accountId}`, 10 * 60_000, 5, nowMs);
  }
}
