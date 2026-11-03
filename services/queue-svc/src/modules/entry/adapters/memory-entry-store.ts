// 시험용 진입 저장소와 회차 일정 사본. Valkey의 Lua(redis-entry-store.ts)와 같은 규칙을 메모리로 둔다(같은 사례를 test/entry-cases.ts·batch-cases.ts가 둘 다에 돈다).
// 서버 시각은 주입한 시계다(Lua는 Redis TIME을 쓴다).
import type { Clock } from '@peaket/platform';
import type { BatchedEntry, BatchOutcome, EntryStore, EventSchedules, NumberBatchInput, NumberInput, NumberResult, PreemptResult, RecordedEntry, RecordResult } from '../domain/ports.js';
import { BATCH_NO, type EventSchedule, type ReasonCategory, REASONS } from '../domain/queue.js';

const RECORDED = /^(\d+):(\d+):([^:]+):([^:]*):([^:]*)$/;
const BATCHED = /^BATCH:1:([0-9a-f]+):([^:]+):([^:]*):([^:]*)$/;
const reason = (v: string | undefined) => REASONS.find((r) => r === v) as ReasonCategory | undefined;

/** 기록 값 {번호}:{세대}:{요청 ID}:{jny}:{vr}을 읽는다(요청 ID가 같을 때만) */
function recorded(v: string, requestId: string): RecordedEntry | null {
  const m = RECORDED.exec(v);
  if (!m || m[3] !== requestId) return null;
  const vr = reason(m[5]);
  return { seq: Number(m[1]), gen: Number(m[2]), jny: m[4]!, ...(vr ? { vr } : {}) };
}

/** 묶음 기록 BATCH:1:{토큰 해시}:{요청 ID}:{jny}:{vr}을 읽는다 */
function batched(v: string): (BatchedEntry & { requestId: string }) | null {
  const m = BATCHED.exec(v);
  if (!m) return null;
  const vr = reason(m[4]);
  return { tokenHash: m[1]!, requestId: m[2]!, jny: m[3]!, ...(vr ? { vr } : {}) };
}

export class MemoryEntryStore implements EntryStore {
  readonly #dup = new Map<string, { v: string; until: number }>();
  readonly #adm = new Map<string, string>();
  readonly #seq = new Map<string, number>();
  readonly #skipped = new Map<string, string[]>();
  readonly #removed = new Map<string, Set<number>>();
  readonly #verify = new Map<string, Map<string, string>>();
  readonly #done = new Map<string, Map<string, string>>();
  readonly #members = new Map<string, Set<string>>();
  readonly #lobby = new Map<string, Set<string>>();
  readonly #results = new Map<string, string>();

  constructor(private readonly clock: Clock) {}

  #dupOf(k: string): string | null {
    const x = this.#dup.get(k);
    if (!x) return null;
    if (this.clock.now() >= x.until) {
      this.#dup.delete(k);
      return null;
    }
    return x.v;
  }

  #doneOf(eventId: string): Map<string, string> {
    const m = this.#done.get(eventId) ?? new Map<string, string>();
    this.#done.set(eventId, m);
    return m;
  }

  async preempt(i: { pid: string; eventId: string; requestId: string; pendingTtlMs: number }): Promise<PreemptResult> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#adm.has(k)) return { kind: 'ADMITTED' };
    const v = this.#dupOf(k);
    if (v === null) {
      this.#dup.set(k, { v: `PENDING:${i.requestId}`, until: this.clock.now() + i.pendingTtlMs });
      return { kind: 'PROCEED' };
    }
    if (v === `PENDING:${i.requestId}`) return { kind: 'PROCEED' };
    const b = batched(v);
    if (b) {
      const { requestId, ...entry } = b;
      return requestId === i.requestId ? { kind: 'BATCH', ...entry } : { kind: 'BUSY' };
    }
    const r = recorded(v, i.requestId);
    return r ? { kind: 'RECORDED', ...r } : { kind: 'BUSY' };
  }

  async release(i: { pid: string; eventId: string; requestId: string }): Promise<void> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#dupOf(k) === `PENDING:${i.requestId}`) this.#dup.delete(k);
  }

  async numberBatch(i: NumberBatchInput): Promise<NumberResult[]> {
    const now = this.clock.now();
    if (i.opensAtMs !== undefined && now < i.opensAtMs) return i.items.map(() => ({ kind: 'EARLY' }));
    const gen = (this.#skipped.get(i.eventId)?.length ?? 0) + 1;
    const done = this.#doneOf(i.eventId);
    const seqOf = () => this.#seq.get(i.eventId) ?? 0;
    if (i.lobbyShuffle && !done.has('lobby')) {
      const n = this.#lobby.get(i.eventId)?.size ?? 0;
      done.set('lobby', `${seqOf() + 1}:${n}:${gen}`);
      this.#seq.set(i.eventId, seqOf() + n);
    }
    if (i.openBatch) {
      const closed = done.has(String(BATCH_NO));
      const members = this.#members.get(i.eventId) ?? new Set<string>();
      this.#members.set(i.eventId, members);
      if (!closed && now < (i.closeAtMs ?? 0)) {
        return i.items.map((it): NumberResult => {
          if (!it.eligible) return { kind: 'WAIT', retryAfterSeconds: Math.ceil(((i.closeAtMs ?? 0) - now) / 1000) };
          members.add(it.tokenHash ?? '');
          return { kind: 'BATCHING' };
        });
      }
      if (!closed) {
        done.set(String(BATCH_NO), `${seqOf() + 1}:${members.size}:${gen}`);
        this.#seq.set(i.eventId, seqOf() + members.size);
      }
    }
    const first = seqOf() + 1;
    this.#seq.set(i.eventId, seqOf() + i.items.length);
    return i.items.map((_, k) => ({ kind: 'NUMBERED', seq: first + k, gen }));
  }

  async number(i: NumberInput): Promise<NumberResult> {
    const { eligible, tokenHash, ...common } = i;
    return (await this.numberBatch({ ...common, items: [{ eligible, tokenHash }] }))[0]!;
  }

  async record(i: { pid: string; eventId: string; requestId: string; seq: number; gen: number; jny: string; vr?: ReasonCategory; expireAtMs: number }): Promise<RecordResult> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#adm.has(k)) return { kind: 'ADMITTED' };
    const v = this.#dupOf(k);
    if (v !== null && v !== `PENDING:${i.requestId}`) {
      const r = recorded(v, i.requestId);
      if (r) return { kind: 'SAME', ...r };
      const b = batched(v);
      return b?.requestId === i.requestId ? { kind: 'BATCH', tokenHash: b.tokenHash } : { kind: 'TAKEN' };
    }
    this.#dup.set(k, { v: `${i.seq}:${i.gen}:${i.requestId}:${i.jny}:${i.vr ?? ''}`, until: i.expireAtMs });
    return { kind: 'RECORDED' };
  }

  async batchRecord(i: {
    pid: string;
    eventId: string;
    requestId: string;
    tokenHash: string;
    jny: string;
    vr?: ReasonCategory;
    expireAtMs: number;
  }): Promise<{ kind: 'BATCHED'; tokenHash: string } | ({ kind: 'SAME' } & RecordedEntry) | { kind: 'ADMITTED' } | { kind: 'TAKEN' }> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#adm.has(k)) return { kind: 'ADMITTED' };
    const v = this.#dupOf(k);
    if (v !== null && v !== `PENDING:${i.requestId}`) {
      const b = batched(v);
      if (b?.requestId === i.requestId) return { kind: 'BATCHED', tokenHash: b.tokenHash };
      const r = recorded(v, i.requestId);
      return r ? { kind: 'SAME', ...r } : { kind: 'TAKEN' };
    }
    this.#dup.set(k, { v: `BATCH:${BATCH_NO}:${i.tokenHash}:${i.requestId}:${i.jny}:${i.vr ?? ''}`, until: i.expireAtMs });
    return { kind: 'BATCHED', tokenHash: i.tokenHash };
  }

  async batchResult(i: { eventId: string; tokenHash: string }): Promise<BatchOutcome> {
    const r = this.#results.get(i.tokenHash);
    if (r) {
      const [seq, gen] = r.split(':').map(Number);
      return { kind: 'RESULT', seq: seq!, gen: gen! };
    }
    const done = this.#doneOf(i.eventId);
    if (!done.has(`pub:${BATCH_NO}`)) return { kind: 'PENDING' };
    if (!(this.#members.get(i.eventId)?.has(i.tokenHash) ?? false)) return { kind: 'MISSING' };
    if (!done.has(`repair:${BATCH_NO}`)) done.set(`repair:${BATCH_NO}`, String(this.clock.now()));
    return { kind: 'REPAIRING' };
  }

  async convertBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string; seq: number; gen: number; expireAtMs: number }): Promise<({ kind: 'RECORDED' } & RecordedEntry) | { kind: 'GONE' }> {
    const k = `${i.pid}|${i.eventId}`;
    const v = this.#dupOf(k);
    if (v === null) return { kind: 'GONE' };
    const b = batched(v);
    if (!b || b.requestId !== i.requestId || b.tokenHash !== i.tokenHash) {
      const r = recorded(v, i.requestId);
      return r ? { kind: 'RECORDED', ...r } : { kind: 'GONE' };
    }
    this.#dup.set(k, { v: `${i.seq}:${i.gen}:${i.requestId}:${b.jny}:${b.vr ?? ''}`, until: i.expireAtMs });
    return { kind: 'RECORDED', seq: i.seq, gen: i.gen, jny: b.jny, ...(b.vr ? { vr: b.vr } : {}) };
  }

  async dropBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string }): Promise<void> {
    const k = `${i.pid}|${i.eventId}`;
    const v = this.#dupOf(k);
    const b = v === null ? null : batched(v);
    if (b && b.requestId === i.requestId && b.tokenHash === i.tokenHash) this.#dup.delete(k);
  }

  async markRemoved(i: { eventId: string; seq: number }): Promise<void> {
    const s = this.#removed.get(i.eventId) ?? new Set<number>();
    s.add(i.seq);
    this.#removed.set(i.eventId, s);
  }

  async markVerifying(i: { eventId: string; seq: number; ticketHash: string; atMs: number; reason: string }): Promise<void> {
    await this.markRemoved(i);
    const m = this.#verify.get(i.eventId) ?? new Map<string, string>();
    if (!m.has(i.ticketHash)) m.set(i.ticketHash, `VERIFYING:${i.atMs}:${i.reason}`);
    this.#verify.set(i.eventId, m);
  }

  // 시험 도구
  admitForTest(pid: string, eventId: string, ticketHash: string): void {
    this.#adm.set(`${pid}|${eventId}`, ticketHash);
  }
  addSkippedForTest(eventId: string, line: string): void {
    this.#skipped.set(eventId, [...(this.#skipped.get(eventId) ?? []), line]);
  }
  addLobbyForTest(eventId: string, n: number): void {
    const s = this.#lobby.get(eventId) ?? new Set<string>();
    for (let k = 0; k < n; k++) s.add(`lobby-${s.size}`);
    this.#lobby.set(eventId, s);
  }
  publishForTest(eventId: string, results: Record<string, string>): void {
    for (const [h, v] of Object.entries(results)) this.#results.set(h, v);
    this.#doneOf(eventId).set(`pub:${BATCH_NO}`, String(this.clock.now()));
  }
  isRemoved(eventId: string, seq: number): boolean {
    return this.#removed.get(eventId)?.has(seq) ?? false;
  }
  verifyOf(eventId: string, ticketHash: string): string | null {
    return this.#verify.get(eventId)?.get(ticketHash) ?? null;
  }
  counterOf(eventId: string): number {
    return this.#seq.get(eventId) ?? 0;
  }
  dropMemberForTest(eventId: string, tokenHash: string): void {
    this.#members.get(eventId)?.delete(tokenHash);
  }
  membersOf(eventId: string): string[] {
    return [...(this.#members.get(eventId) ?? [])].sort();
  }
  markerOf(eventId: string, field: string): string | null {
    return this.#done.get(eventId)?.get(field) ?? null;
  }
  dupForTest(pid: string, eventId: string): { value: string | null; expireAtMs: number | null } {
    const k = `${pid}|${eventId}`;
    const value = this.#dupOf(k);
    return { value, expireAtMs: value === null ? null : (this.#dup.get(k)?.until ?? null) };
  }
}

export class MemoryEventSchedules implements EventSchedules {
  readonly #m = new Map<string, EventSchedule>();

  async get(eventId: string): Promise<EventSchedule | null> {
    return this.#m.get(eventId) ?? null;
  }

  async set(eventId: string, s: EventSchedule): Promise<void> {
    this.#m.set(eventId, { ...s });
  }
}
