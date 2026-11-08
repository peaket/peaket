// 시험용 묶음 기록과 결과 파일(Valkey 어댑터 redis-batch-store.ts와 같은 규칙). 구간(묶음 1·로비)마다 기록을 따로 둔다.
import type { BatchEntry, BatchSchedule, BatchStore, BeaconStopReason, ClosedBatch, EarlyRoot, PublishedBatch, ResultFiles, ResultObjectStore, ShuffleGroup, ShuffleRecord, ShuffleRecords } from '../domain/ports.js';

interface GroupState {
  startsAtMs: number;
  opensAtMs: number;
  members: string[];
  closed: ClosedBatch | null;
  publishedAt: number | null;
  root: string | null;
  rootAtMs: number | null;
  repairAt: number | null;
  verifying: Set<string>;
}

export class MemoryBatchStore implements BatchStore {
  readonly #groups = new Map<string, GroupState>();
  readonly #removed = new Map<string, number[]>();
  readonly #orphans = new Map<string, Set<string>>();
  readonly #results = new Map<string, { value: string; expireAtMs: number }>();
  #replicated = true;
  #writeCalls = 0;
  #memberCalls = 0;

  /** 시계는 저장소 시각(Redis TIME)을 흉내 낸다 */
  constructor(private readonly clock: { now(): number } = { now: () => Date.now() }) {}

  #key = (eventId: string, group: ShuffleGroup = 1) => `${eventId}|${group}`;
  #resultKey = (group: ShuffleGroup, hash: string) => `${group}|${hash}`;
  #of(eventId: string, group: ShuffleGroup): GroupState | undefined {
    return this.#groups.get(this.#key(eventId, group));
  }

  async scheduleOf(eventId: string): Promise<BatchSchedule | null> {
    const e = this.#of(eventId, 1) ?? this.#of(eventId, 'lobby');
    return e ? { startsAtMs: e.startsAtMs, opensAtMs: e.opensAtMs } : null;
  }
  async closed(eventId: string, group: ShuffleGroup): Promise<ClosedBatch | null> {
    return this.#of(eventId, group)?.closed ?? null;
  }
  async members(eventId: string, group: ShuffleGroup): Promise<string[]> {
    this.#memberCalls += 1;
    return [...new Set(this.#of(eventId, group)?.members ?? [])];
  }
  async published(eventId: string, group: ShuffleGroup): Promise<PublishedBatch | null> {
    const e = this.#of(eventId, group);
    return e && e.publishedAt !== null ? { atMs: e.publishedAt, root: e.root, repairAtMs: e.repairAt } : null;
  }
  async writeResults(group: ShuffleGroup, entries: readonly BatchEntry[], gen: number, expireAtMs: number): Promise<void> {
    this.#writeCalls += 1;
    for (const e of entries) this.#results.set(this.#resultKey(group, e.tokenHash), { value: `${e.seq}:${gen}`, expireAtMs });
  }
  async markRemoved(eventId: string, seqs: readonly number[]): Promise<void> {
    this.#removed.set(eventId, [...(this.#removed.get(eventId) ?? []), ...seqs]);
  }
  async toRemoveAmong(eventId: string, _group: ShuffleGroup, hashes: readonly string[]): Promise<string[]> {
    const lobby = this.#of(eventId, 'lobby')?.verifying;
    return hashes.filter((h) => lobby?.has(h) || this.#orphans.get(eventId)?.has(h));
  }
  /** 대기 취소가 남긴 주인 없는 자리(verify의 ORPHAN)를 흉내 낸다 */
  orphanForTest(eventId: string, hash: string): void {
    const s = this.#orphans.get(eventId) ?? new Set<string>();
    s.add(hash);
    this.#orphans.set(eventId, s);
  }
  async confirmReplicated(): Promise<boolean> {
    return this.#replicated;
  }
  /** 복제본이 받았는지(시험이 바꾼다) */
  replicatedForTest(v: boolean): void {
    this.#replicated = v;
  }
  async markPublished(eventId: string, group: ShuffleGroup, atMs: number, root: string): Promise<void> {
    const e = this.#of(eventId, group);
    if (e && e.publishedAt === null) Object.assign(e, { publishedAt: atMs, root: e.root ?? root });
  }
  async markRoot(eventId: string, group: ShuffleGroup, root: string): Promise<EarlyRoot> {
    const e = this.#of(eventId, group)!;
    if (e.root === null) Object.assign(e, { root, rootAtMs: this.clock.now() });
    return { root: e.root!, atMs: e.rootAtMs! };
  }
  async earlyRootOf(eventId: string, group: ShuffleGroup): Promise<EarlyRoot | null> {
    const e = this.#of(eventId, group);
    return e?.root && e.rootAtMs !== null ? { root: e.root, atMs: e.rootAtMs } : null;
  }
  async clearRepair(eventId: string, group: ShuffleGroup, repairAtMs: number): Promise<void> {
    const e = this.#of(eventId, group);
    if (e?.repairAt === repairAtMs) e.repairAt = null;
  }

  // 시험 도구
  setForTest(eventId: string, s: { startsAtMs: number; opensAtMs?: number; members: string[]; closed: ClosedBatch | null; group?: ShuffleGroup; verifying?: string[] }): void {
    const { group = 1, verifying = [], opensAtMs = 0, ...rest } = s;
    this.#groups.set(this.#key(eventId, group), { ...rest, opensAtMs, publishedAt: null, root: null, rootAtMs: null, repairAt: null, verifying: new Set(verifying) });
  }
  /** queue-svc가 결과 키를 잃은 참가자를 보고 쓰는 다시 쓰기 표시(HSETNX) */
  requestRepairForTest(eventId: string, atMs: number): void {
    const e = this.#of(eventId, 1);
    if (e && e.repairAt === null) e.repairAt = atMs;
  }
  repairOf(eventId: string): number | null {
    return this.#of(eventId, 1)?.repairAt ?? null;
  }
  dropResultForTest(tokenHash: string): void {
    this.#results.delete(this.#resultKey(1, tokenHash));
  }
  setMembersForTest(eventId: string, members: string[]): void {
    const e = this.#of(eventId, 1);
    if (e) e.members = members;
  }
  setClosedForTest(eventId: string, closed: ClosedBatch, group: ShuffleGroup = 1): void {
    const e = this.#of(eventId, group);
    if (e) e.closed = closed;
  }
  writeCallsForTest(): number {
    return this.#writeCalls;
  }
  membersCallsForTest(): number {
    return this.#memberCalls;
  }
  publishedForTest(eventId: string, group: ShuffleGroup = 1): number | null {
    return this.#of(eventId, group)?.publishedAt ?? null;
  }
  resultOf(tokenHash: string, group: ShuffleGroup = 1): { value: string; expireAtMs: number } | null {
    return this.#results.get(this.#resultKey(group, tokenHash)) ?? null;
  }
  removedOf(eventId: string): number[] {
    return [...(this.#removed.get(eventId) ?? [])].sort((a, b) => a - b);
  }
}

export class MemoryShuffleRecords implements ShuffleRecords {
  readonly #m = new Map<string, ShuffleRecord>();
  readonly #stops = new Map<string, { reason: BeaconStopReason; atMs: number }>();

  setForTest(eventId: string, group: ShuffleGroup, r: ShuffleRecord): void {
    this.#m.set(`${eventId}|${group}`, r);
  }
  async read(eventId: string, group: ShuffleGroup): Promise<ShuffleRecord | null> {
    const key = `${eventId}|${group}`;
    const r = this.#m.get(key);
    if (!r) return null;
    const stopped = this.#stops.get(key);
    return stopped ? { ...r, stopped } : r;
  }
  async stop(eventId: string, group: ShuffleGroup, atMs: number, reason: BeaconStopReason, _expireAtMs?: number): Promise<boolean> {
    const key = `${eventId}|${group}`;
    if (this.#stops.has(key)) return false;
    this.#stops.set(key, { reason, atMs });
    return true;
  }
  async recordBeacon(eventId: string, group: ShuffleGroup, value: string, signature: string): Promise<void> {
    const key = `${eventId}|${group}`;
    const r = this.#m.get(key);
    if (r && r.beacon === undefined) this.#m.set(key, { ...r, beacon: value, signature });
  }
  async reveal(eventId: string, group: ShuffleGroup, seed: string, atMs: number): Promise<void> {
    const key = `${eventId}|${group}`;
    const r = this.#m.get(key);
    if (r && r.seed === undefined) this.#m.set(key, { ...r, seed, seedAtMs: atMs });
  }
}

/** 객체 저장소 시험 대역(실제 S3 어댑터는 HOT-012) */
export class MemoryResultObjects implements ResultObjectStore {
  readonly #objects = new Map<string, { body: string; contentType: string; cacheControl: string }>();
  #inFlight = 0;
  #maxInFlight = 0;
  constructor(private readonly o: { delayMs?: number; failKey?: string } = {}) {}

  async put(i: { key: string; body: string; contentType: string; cacheControl: string }): Promise<void> {
    this.#inFlight += 1;
    this.#maxInFlight = Math.max(this.#maxInFlight, this.#inFlight);
    if (this.o.delayMs) await new Promise((r) => setTimeout(r, this.o.delayMs));
    this.#inFlight -= 1;
    if (i.key === this.o.failKey) throw new Error('S3 503');
    this.#objects.set(i.key, i);
  }

  get(key: string): { body: string; contentType: string; cacheControl: string } | undefined {
    return this.#objects.get(key);
  }
  size(): number {
    return this.#objects.size;
  }
  maxInFlight(): number {
    return this.#maxInFlight;
  }
}

export class MemoryResultFiles implements ResultFiles {
  readonly #files = new Map<string, Map<string, Record<string, number>>>();
  readonly #writes = new Map<string, number>();

  async write(eventId: string, group: ShuffleGroup, files: ReadonlyMap<string, Record<string, number>>): Promise<void> {
    this.#files.set(`${eventId}|${group}`, new Map(files));
    this.#writes.set(eventId, (this.#writes.get(eventId) ?? 0) + 1);
  }

  writesOf(eventId: string): number {
    return this.#writes.get(eventId) ?? 0;
  }

  written(eventId: string, group: ShuffleGroup = 1): Map<string, Record<string, number>> {
    return this.#files.get(`${eventId}|${group}`) ?? new Map();
  }
}
