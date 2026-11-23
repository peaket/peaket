// 등록 코드 저장소(Redis): 코드의 SHA-256 키(`scanner:enroll:{해시}`)에 기기 ID를 TTL로 두고, 기기 키(`scanner:enroll-device:{deviceId}`)가
// 그 기기의 지금 코드 해시를 가리킨다. 원문 코드는 저장하지 않는다(offline-gate §6.1, ADR-0062).
// 기기마다 지금 코드 하나만 유효하다(offline-gate §6.1 'GAT-170 마감 규칙', O-T42 ⑤):
// - take: 코드 키의 값·남은 수명·지우기를 한 Lua로 한 번만 꺼낸다(한 키). 그다음 기기 키가 그 코드를 가리킬 때만 받아들이고
//   그 기기 키를 지운다(값이 같을 때만 지우는 한 키 Lua). 기기 키가 다른 코드를 가리키면 꺼낸 코드는 버린다.
// - put(재발급): 기기 키를 새 코드로 먼저 바꾸고, 옛 코드 키를 지운 뒤 새 코드 키를 쓴다.
// - restore: 기기 키가 비었을 때만(SET NX) 옛 코드로 되돌리고 그다음 코드 키를 남은 수명으로 쓴다.
// 두 키는 해시 슬롯이 달라(묶음 Redis) 한 스크립트로 묶지 않는다. 대신 위 차례와 take의 기기 키 확인으로, put과 restore가 어떻게 겹쳐도
// 새 코드가 나온 뒤에는 옛 코드를 꺼낼 수 없다(되살림·새 코드 겨룸 시험, 시험 리뷰 2 TR-16).
import { type Clock, type HotRedis, redisScript, systemClock } from '@peaket/platform';
import type { EnrollmentCodeStore } from '../domain/ports.js';

const keyOf = (codeHash: string): string => `scanner:enroll:${codeHash}`;
const deviceKeyOf = (deviceId: string): string => `scanner:enroll-device:${deviceId}`;

/** 값·남은 수명(ms)을 읽고 지운다. 없거나 수명이 없으면 nil */
const TAKE = redisScript(`
local v = redis.call('GET', KEYS[1])
if not v then return nil end
local t = redis.call('PTTL', KEYS[1])
redis.call('DEL', KEYS[1])
if t < 0 then return nil end
return {v, t}
`);

/** 값이 ARGV[1]일 때만 지운다. 지웠으면 1 */
const DELETE_IF = redisScript(`
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`);

/**
 * 남은 수명(상대 ms)으로 만료 시각을 되짚으면 이 서비스와 Redis 사이 왕복 지연만큼 어긋난다(되살림은 그만큼 늦게, 꺼냄은 그만큼 이르게 잰다).
 * 처음 만료를 넘지 않게 꺼낸 만료 시각을 이만큼 앞당긴다(되살릴 때마다 코드 수명이 최대 이만큼 줄 뿐이다)
 */
const EXPIRY_MARGIN_MS = 1_000;

const str = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v));

export class RedisEnrollmentCodeStore implements EnrollmentCodeStore {
  constructor(
    private readonly redis: HotRedis,
    private readonly clock: Clock = systemClock,
  ) {}

  async put(i: { codeHash: string; deviceId: string; ttlMs: number }): Promise<void> {
    const deviceKey = deviceKeyOf(i.deviceId);
    const old = await this.redis.command(['GET', deviceKey], { key: deviceKey });
    // 기기 키를 먼저 바꾼다: 이 뒤로는 옛 코드를 꺼내도(또는 되살려도) take가 받아들이지 않는다
    await this.redis.command(['SET', deviceKey, i.codeHash, 'PX', String(i.ttlMs)], { key: deviceKey });
    if (old !== null && old !== undefined && str(old) !== i.codeHash) await this.redis.command(['DEL', keyOf(str(old))], { key: keyOf(str(old)) });
    const key = keyOf(i.codeHash);
    await this.redis.command(['SET', key, i.deviceId, 'PX', String(i.ttlMs)], { key });
  }

  async take(codeHash: string): Promise<{ deviceId: string; expiresAtMs: number } | undefined> {
    const key = keyOf(codeHash);
    // 남은 수명을 재기 전의 시각으로 만료 시각을 만들고, 왕복 지연 여유만큼 앞당긴다(처음 만료를 넘지 않게)
    const before = this.clock.now();
    const got = await this.redis.evalScript(TAKE, [key], []);
    if (!Array.isArray(got) || got.length !== 2) return undefined;
    const deviceId = str(got[0]);
    const remainingMs = Number(got[1]);
    if (!Number.isFinite(remainingMs) || remainingMs <= 0) return undefined;
    const deviceKey = deviceKeyOf(deviceId);
    const current = await this.redis.evalScript(DELETE_IF, [deviceKey], [codeHash]);
    if (Number(current) !== 1) return undefined;
    // 코드는 아직 살아 있었으므로 받는다. 만료 시각만 여유만큼 앞당긴다(마지막 1초 안이면 되살리지 못하는 값이 된다)
    return { deviceId, expiresAtMs: before + Math.max(1, remainingMs - EXPIRY_MARGIN_MS) };
  }

  async restore(i: { codeHash: string; deviceId: string; expiresAtMs: number }): Promise<boolean> {
    const remainingMs = i.expiresAtMs - this.clock.now();
    if (remainingMs < 1) return false;
    const px = String(Math.floor(remainingMs));
    const deviceKey = deviceKeyOf(i.deviceId);
    const set = await this.redis.command(['SET', deviceKey, i.codeHash, 'NX', 'PX', px], { key: deviceKey });
    if (set === null || set === undefined) {
      const current = await this.redis.command(['GET', deviceKey], { key: deviceKey });
      if (current === null || current === undefined || str(current) !== i.codeHash) return false;
    }
    const key = keyOf(i.codeHash);
    await this.redis.command(['SET', key, i.deviceId, 'PX', px], { key });
    return true;
  }
}
