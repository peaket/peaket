// 시험·로컬용 등록 코드 저장소. 운영은 RedisEnrollmentCodeStore다.
// 기기마다 지금 코드 하나만 유효하다(재발급은 옛 코드를 지운다).
import type { Clock } from '@peaket/platform';
import type { EnrollmentCodeStore } from '../domain/ports.js';

export class MemoryEnrollmentCodeStore implements EnrollmentCodeStore {
  readonly #codes = new Map<string, { deviceId: string; untilMs: number }>();
  readonly #current = new Map<string, string>();

  constructor(private readonly clock: Clock) {}

  async put(i: { codeHash: string; deviceId: string; ttlMs: number }): Promise<void> {
    const old = this.#current.get(i.deviceId);
    if (old !== undefined && old !== i.codeHash) this.#codes.delete(old);
    this.#current.set(i.deviceId, i.codeHash);
    this.#codes.set(i.codeHash, { deviceId: i.deviceId, untilMs: this.clock.now() + i.ttlMs });
  }

  async take(codeHash: string): Promise<string | undefined> {
    const hit = this.#codes.get(codeHash);
    if (!hit) return undefined;
    this.#codes.delete(codeHash);
    if (this.#current.get(hit.deviceId) === codeHash) this.#current.delete(hit.deviceId);
    return hit.untilMs > this.clock.now() ? hit.deviceId : undefined;
  }
}
