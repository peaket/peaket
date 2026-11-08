// 이번 초 경계에 S3 사본을 쓸 파드 하나를 고른다(SET q:{event:E}:mirror NX PX 900 [가정], ADR-0223 결정 9).
import { Inject, Injectable } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import { guard, keys, QUEUE_REDIS } from '../../entry/index.js';
import type { StateMirrorLease } from '../domain/ports.js';

const LEASE_TTL_MS = 900;

@Injectable()
export class RedisStateMirrorLease implements StateMirrorLease {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async claim(eventId: string): Promise<boolean> {
    const k = keys.mirror(eventId);
    return (await guard(this.redis.command(['SET', k, '1', 'NX', 'PX', String(LEASE_TTL_MS)], { key: k }))) !== null;
  }
}
