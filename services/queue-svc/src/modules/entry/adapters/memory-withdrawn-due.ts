// 시험용 탈퇴 사건 처리할 때 집합(Valkey 어댑터 redis-withdrawn-due.ts와 같은 규칙).
import type { Clock } from '@peaket/platform';
import { DUE_LEASE_MAX_MS, type DueWithdrawal, type WithdrawnDue } from '../domain/ports.js';

export class MemoryWithdrawnDue implements WithdrawnDue {
  readonly #items = new Map<string, DueWithdrawal & { leaseUntil: number; attempts: number; valueGone: boolean }>();
  /** 다음 꺼내기를 실패시킨다(대기열 Redis 일시 장애 흉내) */
  failClaimNext: unknown = null;

  constructor(private readonly clock: Clock) {}

  async schedule(i: DueWithdrawal): Promise<void> {
    if (!this.#items.has(i.eventKey)) this.#items.set(i.eventKey, { ...i, pids: [...i.pids], leaseUntil: 0, attempts: 0, valueGone: false });
  }

  async claim(i: { leaseMs: number; limit: number }): Promise<{ items: DueWithdrawal[]; expired: number }> {
    if (this.failClaimNext) {
      const err = this.failClaimNext;
      this.failClaimNext = null;
      throw err;
    }
    const now = this.clock.now();
    const items: DueWithdrawal[] = [];
    let expired = 0;
    for (const x of [...this.#items.values()].sort((a, b) => a.dueAt - b.dueAt)) {
      if (x.dueAt > now || items.length >= i.limit) break;
      if (x.leaseUntil > now) continue;
      x.attempts += 1;
      x.leaseUntil = now + Math.min(DUE_LEASE_MAX_MS, i.leaseMs * 2 ** (x.attempts - 1));
      // 값이 수명(purgeBy)으로 사라졌을 때만 버린다. 값이 있으면 purgeBy가 지났어도 지금 처리한다(만료 당기기로 키를 바로 지운다)
      if (x.valueGone) {
        this.#items.delete(x.eventKey);
        expired++;
        continue;
      }
      items.push({ eventKey: x.eventKey, pids: [...x.pids], purgeBy: x.purgeBy, dueAt: x.dueAt });
    }
    return { items, expired };
  }

  async done(eventKey: string): Promise<void> {
    this.#items.delete(eventKey);
  }

  async oldestDue(): Promise<number | null> {
    let min: number | null = null;
    for (const x of this.#items.values()) if (min === null || x.dueAt < min) min = x.dueAt;
    return min;
  }

  itemsForTest(): DueWithdrawal[] {
    return [...this.#items.values()].map((x) => ({ eventKey: x.eventKey, pids: x.pids, purgeBy: x.purgeBy, dueAt: x.dueAt }));
  }

  /** 값이 수명(purgeBy)으로 사라진 것을 흉내 낸다 */
  dropValueForTest(eventKey: string): void {
    const x = this.#items.get(eventKey);
    if (x) x.valueGone = true;
  }
}
