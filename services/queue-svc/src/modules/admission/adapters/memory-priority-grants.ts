// 시험·로컬용 우선 구매 권리 사본. RedisPriorityGrantStore와 같은 판 번호·만료 규칙을 메모리에서 지킨다.
import { priorityGrantKeyOf, type PriorityGrantCopy } from '../domain/priority-grant.js';
import type { PriorityGrantStore } from '../domain/ports.js';

export class MemoryPriorityGrantStore implements PriorityGrantStore {
  readonly copies = new Map<string, PriorityGrantCopy>();

  async set(i: Parameters<PriorityGrantStore['set']>[0]): Promise<{ changed: boolean }> {
    const key = priorityGrantKeyOf(i.accountId, i.eventId);
    if (i.expiresAtMs <= i.nowMs) return { changed: this.copies.delete(key) };
    const cur = this.copies.get(key);
    if (cur && cur.version >= i.version) return { changed: false };
    this.copies.set(key, { grantId: i.grantId, state: i.state, expiresAtMs: i.expiresAtMs, version: i.version });
    return { changed: true };
  }

  async get(i: { accountId: string; eventId: string; grantId: string }): Promise<PriorityGrantCopy | undefined> {
    const copy = this.copies.get(priorityGrantKeyOf(i.accountId, i.eventId));
    return copy?.grantId === i.grantId ? copy : undefined;
  }
}
