// F-04-15 support 메모리 저장소(local·ci·시험). 실제 저장소 시험이 이 클래스를 직접 쓴다.
import type { AppealRecord } from '../domain/appeal.js';
import type { IdempotentClaim, IdempotentLookup, IdempotentWrite, SupportAppealStore } from '../domain/ports.js';

const sameHash = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
};

interface IdemRow {
  readonly requestHash: Uint8Array;
  readonly result: unknown;
  /** finishClaim까지 끝났는가. false면 아직 처리 중이다. */
  readonly done: boolean;
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
      this.idem.set(k, { requestHash: new Uint8Array(o.idem.requestHash), result: o.result, done: true });
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
    if (!sameHash(found.requestHash, idem.requestHash)) return { kind: 'reused' };
    if (!found.done) return { kind: 'in_progress' };
    return { kind: 'replay', result: found.result };
  }

  async claim(idem: IdempotentWrite): Promise<IdempotentClaim> {
    const k = this.keyOf(idem);
    const found = this.idem.get(k);
    if (found) {
      if (!sameHash(found.requestHash, idem.requestHash)) return { kind: 'reused' };
      if (!found.done) return { kind: 'in_progress' };
      return { kind: 'replay', result: found.result };
    }
    this.idem.set(k, { requestHash: new Uint8Array(idem.requestHash), result: undefined, done: false });
    return { kind: 'claimed' };
  }

  async finishClaim(o: { record: AppealRecord; idem: IdempotentWrite; result: unknown }): Promise<void> {
    const k = this.keyOf(o.idem);
    const found = this.idem.get(k);
    if (!found) throw new Error('멱등 키 선점이 사라졌습니다');
    this.idem.set(k, { ...found, result: o.result, done: true });
    this.rows.set(o.record.id, { ...o.record });
  }

  async releaseClaim(idem: IdempotentWrite): Promise<void> {
    const k = this.keyOf(idem);
    const found = this.idem.get(k);
    if (found && !found.done) this.idem.delete(k);
  }
}
