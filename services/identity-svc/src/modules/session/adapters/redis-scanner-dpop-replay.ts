// 기기 DPoP jti 저장소(세션·캐시 Redis scanner:dpop:{jti}, SET NX PX, offline-gate §6.1).
// 파드가 여럿이면 같은 jti가 다른 파드에서 다시 쓰이지 않게 Redis에 둔다.
import { type DpopReplayStore, type HotRedis, isRedisUnavailable } from '@peaket/platform';

export class RedisScannerDpopReplayStore implements DpopReplayStore {
  constructor(private readonly redis: HotRedis) {}

  async claim(jti: string, ttlMs: number): Promise<boolean> {
    try {
      const r = await this.redis.command(['SET', `scanner:dpop:${jti}`, '1', 'NX', 'PX', String(ttlMs)], { key: `scanner:dpop:${jti}` });
      return r === 'OK';
    } catch (e) {
      if (isRedisUnavailable(e)) throw e;
      throw new Error('기기 DPoP jti 저장소 오류');
    }
  }
}
