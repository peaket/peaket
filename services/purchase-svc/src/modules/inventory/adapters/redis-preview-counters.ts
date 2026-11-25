// 세션 색인에서 purchaseSessions·paymentSessions를 세는 Redis 어댑터(F-02-5, ADR-0365 결정 11).
// 정리 색인(s:{event:E}:sessions)의 멤버를 읽어 세션 해시의 pay=1을 센다. 상한을 넘으면 'too-many'다.
// pay 읽기는 세션 키마다 다르므로(해시 태그가 {jti}) 서버 스크립트 하나로 묶을 수 없다. 대신 500개씩 함께 보내
// 왕복을 20번으로 줄인다. 10,000개도 PreviewControl의 1초 예산 안에 끝나야 한다(계획 14.1, F025-PREVIEW ④).
import { Inject, Injectable } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { PAYING_COUNT_MAX } from '../domain/preview.js';
import type { PurchaseSessionCounter } from '../domain/preview.js';
import { sessionKeys } from './redis-purchase-sessions.js';
import { SEAT_REDIS } from './redis-seat-store.js';

/** 한 번에 함께 보내는 HGET 수. 10,000개면 100묶음이다(파이프라인 대신 묶음 동시 호출). 한 명령의 100ms 마감 안에 들도록 작게 둔다 */
export const PAYING_READ_CHUNK = 100;

@Injectable()
export class RedisPurchaseSessionCounter implements PurchaseSessionCounter {
  constructor(@Inject(SEAT_REDIS) private readonly redis: HotRedis) {}

  async count(eventId: string): Promise<{ sessions: number; paying: number } | 'too-many'> {
    const key = sessionKeys.index(eventId);
    const raw = await this.redis.command(['ZRANGE', key, '0', String(PAYING_COUNT_MAX)], { key });
    const members = Array.isArray(raw) ? raw.map(String) : [];
    if (members.length > PAYING_COUNT_MAX) return 'too-many';

    // 운영 연결은 파이프라인 한 번으로 10,000 HGET을 보낸다. 시험 가짜처럼 pipeline이 없으면 100개씩 묶어 보낸다
    if (this.redis.pipeline) {
      const commands = members.map((jti) => {
        const sessionKey = sessionKeys.session(jti);
        return { key: sessionKey, args: ['HGET', sessionKey, 'pay'] };
      });
      const pays = await this.redis.pipeline(commands, { deadlineMs: 800 });
      let paying = 0;
      for (const pay of pays) {
        if (pay instanceof Error) throw pay;
        if (String(pay ?? '') === '1') paying += 1;
      }
      return { sessions: members.length, paying };
    }

    let paying = 0;
    for (let i = 0; i < members.length; i += PAYING_READ_CHUNK) {
      const chunk = members.slice(i, i + PAYING_READ_CHUNK);
      const pays = await Promise.all(
        chunk.map((jti) => {
          const sessionKey = sessionKeys.session(jti);
          return this.redis.command(['HGET', sessionKey, 'pay'], { key: sessionKey });
        }),
      );
      for (const pay of pays) if (String(pay ?? '') === '1') paying += 1;
    }
    return { sessions: members.length, paying };
  }
}
