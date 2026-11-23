// 대기열 Redis의 자동 제어 상태 읽기(F-03-3 OPS-380, ADR-0371 결정 7, docs/security/asvs/control-tower.md 13.2.2).
// ops-svc는 이 키에 쓰지 않는다. 읽기 명령(ZRANGE·HGETALL)만 보내고, 운영에서는 읽기만 허락한 Redis 사용자로 붙는다(docs/infra.md §9).
// 회차 키는 해시 태그로 슬롯이 달라 묶지 않고 회차마다 한 번씩 읽는다.
import type { HotRedis } from '@peaket/platform';
import { ACTIVE_EVENTS_KEY, PLATFORM_CTL_KEY, ctlKeyOf } from '../domain/control.js';
import type { ControlReader } from '../domain/ports.js';

/** 한 번 읽기의 마감 1초 [가정](감시 주기와 같다) */
export const CONTROL_READ_DEADLINE_MS = 1_000;
/** 한 주기에 읽는 진행 중 회차 수의 상한 [가정] */
export const CONTROL_EVENTS_MAX = 500;

/** HGETALL 답(RESP2 평평한 배열·RESP3 맵)을 글 맵으로 */
function recordOf(reply: unknown): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  if (Array.isArray(reply)) {
    for (let i = 0; i + 1 < reply.length; i += 2) out[String(reply[i])] = String(reply[i + 1]);
  } else if (reply instanceof Map) {
    for (const [k, v] of reply) out[String(k)] = String(v);
  } else if (reply !== null && typeof reply === 'object') {
    for (const [k, v] of Object.entries(reply as Record<string, unknown>)) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class RedisControlReader implements ControlReader {
  constructor(private readonly redis: Pick<HotRedis, 'command' | 'close'>) {}

  async close(): Promise<void> {
    await this.redis.close();
  }

  async activeEvents(nowMs: number): Promise<string[]> {
    const reply = await this.redis.command(['ZRANGE', ACTIVE_EVENTS_KEY, `(${nowMs}`, '+inf', 'BYSCORE', 'LIMIT', '0', String(CONTROL_EVENTS_MAX)], {
      key: ACTIVE_EVENTS_KEY,
      deadlineMs: CONTROL_READ_DEADLINE_MS,
    });
    return Array.isArray(reply) ? reply.map(String) : [];
  }

  async hash(key: string): Promise<Record<string, string> | undefined> {
    return recordOf(await this.redis.command(['HGETALL', key], { key, deadlineMs: CONTROL_READ_DEADLINE_MS }));
  }
}

export { ctlKeyOf, PLATFORM_CTL_KEY, type ControlReader };
