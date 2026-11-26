// F-04-15 support 메모리 저장소(local·ci·시험). 실제 저장소 시험이 이 클래스를 직접 쓴다.
import type { AppealRecord } from '../domain/appeal.js';
import type { IdempotentLookup, IdempotentWrite, SupportAppealStore } from '../domain/ports.js';

const sameHash = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

interface IdemRow {
  readonly requestHash: Uint8Array;
  readonly result: unknown;
}

export class MemorySupportAppealStore implements SupportAppealStore {
  readonly rows = new Map<string, AppealRecord>();
  readonly idem = new Map<string, IdemRow>();
  private readonly keyOf = (i: IdempotentWrite): string => `${i.accountRef}:${i.operation}:${i.key}`;

  async put(a: AppealRecord, o?: { idem?: IdempotentWrite; result?: unknown }): Promise<{ replayed: boolean; result?: unknown }> {
    if (o?.idem) {
      const k = this.keyOf(o.idem);
      const found = this.idem.get(k);
      if (found) return sameHash(found.requestHash, o.idem.requestHash) ? { replayed: true, ...(found.result === undefined ? {} : { result: found.result }) } : { replayed: true, result: undefined };
      this.idem.set(k, { requestHash: new Uint8Array(o.idem.requestHash), result: o.result });
    }
    this.rows.set(a.id, { ...a });
    return { replayed: false };
  }

  async get(appealId: string): Promise<AppealRecord | null> {
    return this.rows.get(appealId) ?? null;
  }

  async listByAccount(accountId: string, q: { cursor?: string; limit: number }): Promise<{ items: AppealRecord[]; nextCursor: string | null }> {
    const all = [...this.rows.values()].filter((a) => a.accountId === accountId).sort((a, b) => b.submittedAtMs - a.submittedAtMs || a.id.localeCompare(b.id));
    const start = q.cursor ? all.findIndex((a) => a.id === q.cursor) + 1 : 0;
    const items = all.slice(start, start + q.limit);
    return { items, nextCursor: start + q.limit < all.length ? items.at(-1)?.id ?? null : null };
  }

  async update(a: AppealRecord): Promise<boolean> {
    if (!this.rows.has(a.id)) return false;
    this.rows.set(a.id, { ...a });
    return true;
  }

  async findIdempotent(idem: IdempotentWrite): Promise<IdempotentLookup> {
    const found = this.idem.get(this.keyOf(idem));
    if (!found) return { kind: 'none' };
    return sameHash(found.requestHash, idem.requestHash) ? { kind: 'replay', result: found.result } : { kind: 'reused' };
  }
}
