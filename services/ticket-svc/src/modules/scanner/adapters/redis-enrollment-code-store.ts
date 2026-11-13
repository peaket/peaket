// 등록 코드 저장소(Redis): 코드의 SHA-256 키에 기기 ID를 TTL로 두고, 등록할 때 GETDEL로 한 번만 꺼낸다.
// 원문 코드는 저장하지 않는다(offline-gate §6.1, ADR-0062).
import type { HotRedis } from '@peaket/platform';
import type { EnrollmentCodeStore } from '../domain/ports.js';

const keyOf = (codeHash: string): string => `scanner:enroll:${codeHash}`;

export class RedisEnrollmentCodeStore implements EnrollmentCodeStore {
  constructor(private readonly redis: HotRedis) {}

  async put(i: { codeHash: string; deviceId: string; ttlMs: number }): Promise<void> {
    const key = keyOf(i.codeHash);
    await this.redis.command(['SET', key, i.deviceId, 'PX', String(i.ttlMs)], { key });
  }

  async take(codeHash: string): Promise<string | undefined> {
    const key = keyOf(codeHash);
    const v = await this.redis.command(['GETDEL', key], { key });
    return v === null || v === undefined ? undefined : String(v);
  }
}
