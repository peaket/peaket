// 등록 코드 저장소(Redis): 코드의 SHA-256 키에 기기 ID를 TTL로 두고, 등록할 때 GETDEL로 한 번만 꺼낸다.
// 기기마다 지금 코드 하나만 유효하다: 재발급은 `scanner:enroll-device:{deviceId}`가 가리키던 옛 코드 키를 지운다.
// 원문 코드는 저장하지 않는다(offline-gate §6.1, ADR-0062).
import type { HotRedis } from '@peaket/platform';
import type { EnrollmentCodeStore } from '../domain/ports.js';

const keyOf = (codeHash: string): string => `scanner:enroll:${codeHash}`;
const deviceKeyOf = (deviceId: string): string => `scanner:enroll-device:${deviceId}`;

export class RedisEnrollmentCodeStore implements EnrollmentCodeStore {
  constructor(private readonly redis: HotRedis) {}

  async put(i: { codeHash: string; deviceId: string; ttlMs: number }): Promise<void> {
    const deviceKey = deviceKeyOf(i.deviceId);
    const old = await this.redis.command(['GET', deviceKey], { key: deviceKey });
    if (typeof old === 'string' && old !== i.codeHash) await this.redis.command(['DEL', keyOf(old)], { key: keyOf(old) });
    const key = keyOf(i.codeHash);
    await this.redis.command(['SET', key, i.deviceId, 'PX', String(i.ttlMs)], { key });
    await this.redis.command(['SET', deviceKey, i.codeHash, 'PX', String(i.ttlMs)], { key: deviceKey });
  }

  async take(codeHash: string): Promise<string | undefined> {
    const key = keyOf(codeHash);
    const v = await this.redis.command(['GETDEL', key], { key });
    if (v === null || v === undefined) return undefined;
    const deviceId = String(v);
    const deviceKey = deviceKeyOf(deviceId);
    const current = await this.redis.command(['GET', deviceKey], { key: deviceKey });
    if (current === codeHash) await this.redis.command(['DEL', deviceKey], { key: deviceKey });
    return deviceId;
  }
}
