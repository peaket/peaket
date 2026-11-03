// 시험용 묶음 기록과 결과 파일(Valkey 어댑터 redis-batch-store.ts와 같은 규칙).
import type { BatchEntry, BatchStore, ClosedBatch, PublishedBatch, ResultFiles } from '../domain/ports.js';

interface EventState {
  startsAtMs: number;
  members: string[];
  closed: ClosedBatch | null;
  publishedAt: number | null;
  root: string | null;
  repairAt: number | null;
  removed: number[];
}

export class MemoryBatchStore implements BatchStore {
  readonly #events = new Map<string, EventState>();
  readonly #results = new Map<string, { value: string; expireAtMs: number }>();

  async startsAtOf(eventId: string): Promise<number | null> {
    return this.#events.get(eventId)?.startsAtMs ?? null;
  }
  async closed(eventId: string): Promise<ClosedBatch | null> {
    return this.#events.get(eventId)?.closed ?? null;
  }
  async members(eventId: string): Promise<string[]> {
    return [...new Set(this.#events.get(eventId)?.members ?? [])];
  }
  async published(eventId: string): Promise<PublishedBatch | null> {
    const e = this.#events.get(eventId);
    return e && e.publishedAt !== null ? { atMs: e.publishedAt, root: e.root, repairAtMs: e.repairAt } : null;
  }
  async writeResults(entries: readonly BatchEntry[], gen: number, expireAtMs: number): Promise<void> {
    for (const e of entries) this.#results.set(e.tokenHash, { value: `${e.seq}:${gen}`, expireAtMs });
  }
  async markRemoved(eventId: string, seqs: readonly number[]): Promise<void> {
    this.#events.get(eventId)?.removed.push(...seqs);
  }
  async markPublished(eventId: string, _batchNo: number, atMs: number, root: string): Promise<void> {
    const e = this.#events.get(eventId);
    if (e) Object.assign(e, { publishedAt: atMs, root });
  }
  async clearRepair(eventId: string, _batchNo: number, repairAtMs: number): Promise<void> {
    const e = this.#events.get(eventId);
    if (e?.repairAt === repairAtMs) e.repairAt = null;
  }

  // 시험 도구
  setForTest(eventId: string, s: { startsAtMs: number; members: string[]; closed: ClosedBatch | null }): void {
    this.#events.set(eventId, { ...s, publishedAt: null, root: null, repairAt: null, removed: [] });
  }
  /** queue-svc가 결과 키를 잃은 참가자를 보고 쓰는 다시 쓰기 표시(HSETNX) */
  requestRepairForTest(eventId: string, atMs: number): void {
    const e = this.#events.get(eventId);
    if (e && e.repairAt === null) e.repairAt = atMs;
  }
  repairOf(eventId: string): number | null {
    return this.#events.get(eventId)?.repairAt ?? null;
  }
  dropResultForTest(tokenHash: string): void {
    this.#results.delete(tokenHash);
  }
  setMembersForTest(eventId: string, members: string[]): void {
    const e = this.#events.get(eventId);
    if (e) e.members = members;
  }
  publishedForTest(eventId: string): number | null {
    return this.#events.get(eventId)?.publishedAt ?? null;
  }
  resultOf(tokenHash: string): { value: string; expireAtMs: number } | null {
    return this.#results.get(tokenHash) ?? null;
  }
  removedOf(eventId: string): number[] {
    return [...(this.#events.get(eventId)?.removed ?? [])].sort((a, b) => a - b);
  }
}

export class MemoryResultFiles implements ResultFiles {
  readonly #files = new Map<string, Map<string, Record<string, number>>>();
  readonly #writes = new Map<string, number>();

  async write(eventId: string, _batchNo: number, files: ReadonlyMap<string, Record<string, number>>): Promise<void> {
    this.#files.set(eventId, new Map(files));
    this.#writes.set(eventId, (this.#writes.get(eventId) ?? 0) + 1);
  }

  writesOf(eventId: string): number {
    return this.#writes.get(eventId) ?? 0;
  }

  written(eventId: string): Map<string, Record<string, number>> {
    return this.#files.get(eventId) ?? new Map();
  }
}
