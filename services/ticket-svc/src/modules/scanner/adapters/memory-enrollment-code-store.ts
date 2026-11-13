// 시험·로컬용 등록 코드 저장소. 운영은 RedisEnrollmentCodeStore다.
import type { Clock } from '@peaket/platform';
import type { EnrollmentCodeStore } from '../domain/ports.js';

export class MemoryEnrollmentCodeStore implements EnrollmentCodeStore {
  readonly #codes = new Map<string, { deviceId: string; untilMs: number }>();

  constructor(private readonly clock: Clock) {}

  async put(i: { codeHash: string; deviceId: string; ttlMs: number }): Promise<void> {
    this.#codes.set(i.codeHash, { deviceId: i.deviceId, untilMs: this.clock.now() + i.ttlMs });
  }

  async take(codeHash: string): Promise<string | undefined> {
    const hit = this.#codes.get(codeHash);
    if (!hit) return undefined;
    this.#codes.delete(codeHash);
    return hit.untilMs > this.clock.now() ? hit.deviceId : undefined;
  }
}
