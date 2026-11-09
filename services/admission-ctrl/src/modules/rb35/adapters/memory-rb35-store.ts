// 시험용 RB-35 저장소(Valkey 어댑터 redis-rb35-store.ts와 같은 규칙)
import type { BatchSchedule, ShuffleGroup } from '../../batch/index.js';
import type { Rb35Apply, Rb35ApplyResult, Rb35State, Rb35Store } from '../domain/ports.js';

export interface MemoryRb35State extends Rb35State {
  /** 커밋을 쓴 시각 */
  atMs?: number;
  /** 비콘을 기록했는가 */
  beacon?: boolean;
  waitUntilMs?: number;
  emergency?: { at: number; stop: string; reason: string; signed?: unknown };
  recommits?: { at: number; prev: number; round: number; reason: string; signed?: unknown }[];
}

export class MemoryRb35Store implements Rb35Store {
  readonly #groups = new Map<string, MemoryRb35State>();
  readonly #schedules = new Map<string, BatchSchedule>();
  readonly #pending = new Map<string, string>();
  readonly #done = new Set<string>();
  readonly #results = new Map<string, string>();

  constructor(private readonly clock: { now(): number } = { now: () => Date.now() }) {}

  #key = (eventId: string, group: ShuffleGroup) => `${eventId}|${group}`;

  setForTest(eventId: string, group: ShuffleGroup, s: MemoryRb35State): void {
    this.#groups.set(this.#key(eventId, group), s);
  }
  setSchedule(eventId: string, s: BatchSchedule): void {
    this.#schedules.set(eventId, s);
  }
  stateOf(eventId: string, group: ShuffleGroup): MemoryRb35State {
    return this.#groups.get(this.#key(eventId, group))!;
  }
  pendingOf(eventId: string, group: ShuffleGroup): string | undefined {
    return this.#pending.get(this.#key(eventId, group));
  }
  resultOf(eventId: string, commandId: string): string | undefined {
    return this.#results.get(`${eventId}|${commandId}`);
  }
  markResultForTest(eventId: string, commandId: string, result: string): void {
    this.#results.set(`${eventId}|${commandId}`, result);
  }

  async scheduleOf(eventId: string): Promise<BatchSchedule | null> {
    return this.#schedules.get(eventId) ?? null;
  }
  async state(eventId: string, group: ShuffleGroup): Promise<Rb35State> {
    const s = this.#groups.get(this.#key(eventId, group));
    return s ? { stop: s.stop, commit: s.commit, round: s.round, published: s.published } : { stop: null, commit: null, round: null, published: false };
  }
  async deposit(eventId: string, group: ShuffleGroup, commandId: string, raw: string): Promise<boolean> {
    const key = this.#key(eventId, group);
    const cur = this.#pending.get(key);
    if (cur !== undefined && !cur.includes(commandId)) return false;
    this.#pending.set(key, raw);
    return true;
  }
  async pending(eventId: string): Promise<{ group: ShuffleGroup; raw: string }[]> {
    const groups: ShuffleGroup[] = ['lobby', 1];
    return groups.flatMap((group) => {
      const raw = this.#pending.get(this.#key(eventId, group));
      return raw ? [{ group, raw }] : [];
    });
  }
  #finish(a: Rb35Apply, result: Rb35ApplyResult, write: string | null): Rb35ApplyResult {
    const key = this.#key(a.eventId, a.group);
    if (this.#pending.get(key) === a.raw) this.#pending.delete(key);
    if (write) this.#results.set(`${a.eventId}|${a.commandId}`, write);
    return result;
  }
  async apply(a: Rb35Apply): Promise<Rb35ApplyResult> {
    if (this.#done.has(`${a.eventId}|${a.commandId}`)) return this.#finish(a, 'replay', null);
    const s = this.#groups.get(this.#key(a.eventId, a.group));
    if (!s) return this.#finish(a, 'stale_state', 'rejected:stale_state');
    if (s.published) return this.#finish(a, 'published', 'rejected:published');
    if (a.kind !== 'wait' && s.beacon) return this.#finish(a, 'beacon_recorded', 'rejected:beacon_recorded');
    if (s.stop !== a.expect.stop || s.commit !== a.expect.commit || s.round !== a.expect.round) return this.#finish(a, 'stale_state', 'rejected:stale_state');
    const now = this.clock.now();
    if (a.kind === 'wait') s.waitUntilMs = now + a.extendMs!;
    if (a.kind === 'emergency') s.emergency = { at: now, stop: a.stopReason!, reason: a.reason, signed: JSON.parse(a.signedJson) as unknown };
    if (a.kind === 'recommit') {
      if (s.emergency) return this.#finish(a, 'already_emergency', 'rejected:already_emergency');
      if (a.newRoundTimeMs! - now < a.minLeadMs!) return this.#finish(a, 'too_late', 'rejected:too_late');
      if ((s.atMs ?? 0) + a.minDelayMs! > a.newRoundTimeMs!) return this.#finish(a, 'too_late', 'rejected:too_late');
      if (a.expect.stop === null && a.currentRoundTimeMs! - now < a.publicMarginMs!) return this.#finish(a, 'round_public', 'rejected:round_public');
      if (a.scheduledRound !== undefined && s.recommits && a.expect.round >= a.scheduledRound) return this.#finish(a, 'already_recommitted', 'rejected:already_recommitted');
      s.recommits = [...(s.recommits ?? []), { at: now, prev: a.expect.round, round: a.newRound!, reason: a.reason, signed: JSON.parse(a.signedJson) as unknown }];
      s.round = a.newRound!;
      delete s.waitUntilMs;
    }
    s.stop = null;
    this.#done.add(`${a.eventId}|${a.commandId}`);
    return this.#finish(a, 'applied', 'applied');
  }
  async reject(eventId: string, group: ShuffleGroup, commandId: string | null, raw: string, reason: string): Promise<void> {
    const key = this.#key(eventId, group);
    if (this.#pending.get(key) === raw) this.#pending.delete(key);
    if (commandId) this.#results.set(`${eventId}|${commandId}`, `rejected:${reason}`);
  }
  async result(eventId: string, commandId: string): Promise<string | null> {
    return this.#results.get(`${eventId}|${commandId}`) ?? null;
  }
}
