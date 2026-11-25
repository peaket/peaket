// 대기열 Redis에서 대기 인원을 한 번에 읽는 어댑터(F-02-5, ADR-0365 결정 11).
// seq·serving·skipped를 읽기만 하고 아무것도 쓰지 않는다. 발급 번호가 없으면 undefined(no-source)다.
import { Inject, Injectable } from '@nestjs/common';
import type { HotRedis } from '@peaket/platform';
import type { QueueWaitingReader } from '../domain/preview.js';
import { keys, QUEUE_REDIS } from './redis-entry-store.js';

@Injectable()
export class RedisQueueWaitingReader implements QueueWaitingReader {
  constructor(@Inject(QUEUE_REDIS) private readonly redis: HotRedis) {}

  async waiting(eventId: string): Promise<{ waiting: number; measuredAtMs: number } | undefined> {
    const at = Date.now();
    const seqRaw = await this.redis.command(['GET', keys.seq(eventId)], { key: keys.seq(eventId) });
    if (seqRaw === null || seqRaw === undefined) return undefined;
    const seq = Number(seqRaw);
    const servingRaw = await this.redis.command(['GET', keys.serving(eventId)], { key: keys.serving(eventId) });
    const serving = servingRaw === null || servingRaw === undefined ? 0 : Number(servingRaw);
    const linesRaw = await this.redis.command(['LRANGE', keys.skipped(eventId), '0', '-1'], { key: keys.skipped(eventId) });
    const lines = Array.isArray(linesRaw) ? linesRaw.map(String) : [];
    let skipped = 0;
    for (const line of lines) {
      const [a, b] = line.split(':').map(Number) as [number, number];
      if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
      const lo = Math.max(a, serving + 1);
      const hi = Math.min(b, seq);
      if (hi >= lo) skipped += hi - lo + 1;
    }
    return { waiting: Math.max(0, seq - serving - skipped), measuredAtMs: at };
  }
}
