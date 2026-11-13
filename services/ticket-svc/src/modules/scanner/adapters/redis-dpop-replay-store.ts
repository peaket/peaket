// DPoP jti 재사용 차단(Redis `scanner:dpop:{jti}`, offline-gate §6.1). SET NX PX로 처음 쓴 것만 true다.
import type { HotRedis } from '@peaket/platform';
import type { DpopReplayStore } from '../domain/ports.js';

const keyOf = (jti: string): string => `scanner:dpop:${jti}`;

export class RedisDpopReplayStore implements DpopReplayStore {
  constructor(private readonly redis: HotRedis) {}

  async claim(jti: string, ttlMs: number): Promise<boolean> {
    const key = keyOf(jti);
    const r = await this.redis.command(['SET', key, '1', 'NX', 'PX', String(ttlMs)], { key });
    return r === 'OK';
  }
}
