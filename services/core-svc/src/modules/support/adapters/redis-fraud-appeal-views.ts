// F-04-15 부정 예매 소명 화면용 사본(운영 세션·캐시 Redis, docs/data.md §3 sup:far:{account}).
// 해시 필드는 사건 ID이고 값은 사본 JSON이다. 같은 계정·사건은 더 큰 판만 덮는다.
// 필드 수명(결정된 뒤 30일)은 Redis 해시에 필드별 TTL이 없어 읽을 때 updatedAtMs로 거른다(메모리 사본과 같은 규칙).
import type { HotRedis } from '@peaket/platform';
import type { FraudAppealViewRecord } from '../domain/appeal.js';
import type { FraudAppealViews } from '../domain/ports.js';

const keyOf = (accountId: string): string => `sup:far:${accountId}`;
/** 화면 사본은 요청 경로에서 읽고 쓴다. Redis가 느리면 화면도 늦어지므로 짧게 끊는다 */
const DEADLINE_MS = 300;

type Command = Pick<HotRedis, 'command'>;

export class RedisFraudAppealViews implements FraudAppealViews {
  constructor(private readonly redis: Command) {}

  private call(args: string[], key: string): Promise<unknown> {
    return this.redis.command(args, { key, deadlineMs: DEADLINE_MS });
  }

  async set(v: FraudAppealViewRecord): Promise<void> {
    const key = keyOf(v.accountId);
    const current = await this.call(['HGET', key, v.caseId], key);
    if (typeof current === 'string') {
      try {
        const before = JSON.parse(current) as { version?: unknown };
        if (typeof before.version === 'number' && before.version >= v.version) return;
      } catch {
        // 깨진 값은 새 값으로 덮는다.
      }
    }
    await this.call(['HSET', key, v.caseId, JSON.stringify(v)], key);
  }

  async list(accountId: string): Promise<readonly FraudAppealViewRecord[]> {
    const key = keyOf(accountId);
    const reply = await this.call(['HGETALL', key], key);
    const fields = pairsOf(reply);
    const out: FraudAppealViewRecord[] = [];
    for (const value of fields) {
      try {
        const parsed = JSON.parse(value) as FraudAppealViewRecord;
        if (parsed && typeof parsed.caseId === 'string' && typeof parsed.version === 'number') out.push(parsed);
      } catch {
        // 읽을 수 없는 값은 없는 것으로 본다.
      }
    }
    return out;
  }
}

/** RESP2는 [필드, 값, …], RESP3는 { 필드: 값 }이다. 둘 다 값만 고른다 */
function pairsOf(reply: unknown): string[] {
  if (Array.isArray(reply)) return reply.filter((_, i) => i % 2 === 1).map(String);
  if (reply && typeof reply === 'object') return Object.values(reply as Record<string, unknown>).map(String);
  return [];
}
