// 세션 색인에서 purchaseSessions·paymentSessions를 세는 Redis 어댑터(F-02-5, ADR-0365 결정 11).
// 정리 색인(s:{event:E}:sessions)의 멤버를 읽어 세션 해시의 pay=1을 센다. 상한을 넘으면 'too-many'다.
import { Inject, Injectable } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { PAYING_COUNT_MAX } from '../domain/preview.js';
import type { PurchaseSessionCounter } from '../domain/preview.js';
import { sessionKeys } from './redis-purchase-sessions.js';
import { SEAT_REDIS } from './redis-seat-store.js';

@Injectable()
export class RedisPurchaseSessionCounter implements PurchaseSessionCounter {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async count(eventId: string): Promise<{ sessions: number; paying: number } | 'too-many'> {
    const key = sessionKeys.index(eventId);
    const raw = await this.redis.command(['ZRANGE', key, '0', String(PAYING_COUNT_MAX)], { key });
    const members = Array.isArray(raw) ? raw.map(String) : [];
    if (members.length > PAYING_COUNT_MAX) return 'too-many';
    let paying = 0;
    for (const jti of members) {
      const sessionKey = sessionKeys.session(jti);
      const pay = await this.redis.command(['HGET', sessionKey, 'pay'], { key: sessionKey });
      if (String(pay ?? '') === '1') paying += 1;
    }
    return { sessions: members.length, paying };
  }
}
