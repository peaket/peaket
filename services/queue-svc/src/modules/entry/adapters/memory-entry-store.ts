// 시험용 진입 저장소와 회차 일정 사본. Valkey의 Lua(redis-entry-store.ts)와 같은 규칙을 메모리로 둔다(같은 사례를 test/entry-cases.ts가 둘 다에 돈다).
import type { Clock } from '@peaket/platform';
import type { EntryStore, EventSchedules, PreemptResult, RecordedEntry, RecordResult } from '../domain/ports.js';
import { type EventSchedule, type ReasonCategory, REASONS } from '../domain/queue.js';

const RECORDED = /^(\d+):(\d+):([^:]+):([^:]*):([^:]*)$/;

/** 기록 값 {번호}:{세대}:{요청 ID}:{jny}:{vr}을 읽는다(요청 ID가 같을 때만) */
function recorded(v: string, requestId: string): RecordedEntry | null {
  const m = RECORDED.exec(v);
  if (!m || m[3] !== requestId) return null;
  const vr = REASONS.find((r) => r === m[5]) as ReasonCategory | undefined;
  return { seq: Number(m[1]), gen: Number(m[2]), jny: m[4]!, ...(vr ? { vr } : {}) };
}

export class MemoryEntryStore implements EntryStore {
  readonly #dup = new Map<string, { v: string; until: number }>();
  readonly #adm = new Map<string, string>();
  readonly #seq = new Map<string, number>();
  readonly #skipped = new Map<string, string[]>();
  readonly #removed = new Map<string, Set<number>>();
  readonly #verify = new Map<string, Map<string, string>>();

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

  async preempt(i: { pid: string; eventId: string; requestId: string; pendingTtlMs: number }): Promise<PreemptResult> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#adm.has(k)) return { kind: 'ADMITTED' };
    const v = this.#dupOf(k);
    if (v === null) {
      this.#dup.set(k, { v: `PENDING:${i.requestId}`, until: this.clock.now() + i.pendingTtlMs });
      return { kind: 'PROCEED' };
    }
    if (v === `PENDING:${i.requestId}`) return { kind: 'PROCEED' };
    const r = recorded(v, i.requestId);
    return r ? { kind: 'RECORDED', ...r } : { kind: 'BUSY' };
  }

  async number(i: { eventId: string }): Promise<{ seq: number; gen: number }> {
    const seq = (this.#seq.get(i.eventId) ?? 0) + 1;
    this.#seq.set(i.eventId, seq);
    return { seq, gen: (this.#skipped.get(i.eventId)?.length ?? 0) + 1 };
  }

  async record(i: { pid: string; eventId: string; requestId: string; seq: number; gen: number; jny: string; vr?: ReasonCategory; expireAtMs: number }): Promise<RecordResult> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#adm.has(k)) return { kind: 'ADMITTED' };
    const v = this.#dupOf(k);
    if (v !== null && v !== `PENDING:${i.requestId}`) {
      const r = recorded(v, i.requestId);
      return r ? { kind: 'SAME', ...r } : { kind: 'TAKEN' };
    }
    this.#dup.set(k, { v: `${i.seq}:${i.gen}:${i.requestId}:${i.jny}:${i.vr ?? ''}`, until: i.expireAtMs });
    return { kind: 'RECORDED' };
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
  isRemoved(eventId: string, seq: number): boolean {
    return this.#removed.get(eventId)?.has(seq) ?? false;
  }
  verifyOf(eventId: string, ticketHash: string): string | null {
    return this.#verify.get(eventId)?.get(ticketHash) ?? null;
  }
  counterOf(eventId: string): number {
    return this.#seq.get(eventId) ?? 0;
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
