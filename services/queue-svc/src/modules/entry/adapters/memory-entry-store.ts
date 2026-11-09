// 시험용 진입 저장소와 회차 일정 사본. Valkey의 Lua(redis-entry-store.ts)와 같은 규칙을 메모리로 둔다(같은 사례를 test/entry-cases.ts·batch-cases.ts가 둘 다에 돈다).
// 서버 시각은 주입한 시계다(Lua는 Redis TIME을 쓴다).
import type { Clock } from '@peaket/platform';
import type { ShuffleGroup } from '@peaket/shuffle';
import type { BatchedEntry, BatchOutcome, CommitRecord, EntryStore, EventSchedules, NumberBatchInput, NumberInput, NumberResult, Rb05Confirm, Rb05Input, Rb05Result, PreemptResult, RecordedEntry, RecordResult, ShuffleCommitStore } from '../domain/ports.js';
import { ARRIVAL_CARVE_MAX, ARRIVAL_CARVE_WINDOW_MAX, ARRIVAL_CARVE_WINDOW_MS, ARRIVAL_CLOSE_AFTER_MS, ARRIVAL_FUTURE_MS, ARRIVAL_SLOT_INITIAL, ARRIVAL_SLOT_MS, ARRIVAL_WINDOW_SLOTS, BATCH_NO, type EventSchedule, type HeldRecord, parseHeld, type ReasonCategory, REASONS } from '../domain/queue.js';

const RECORDED = /^(\d+):(\d+):([^:]+):([^:]*):([^:]*)(?::[0-9a-f]*)?$/;
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

/** q:{event:E}:arr_slots */
interface ArrivalState {
  next?: number;
  first?: number;
  gen?: number;
  closed: number;
  lost: number;
  /** 칸 떼기 시간 창(ADR-0243): 창 번호와 그 창에서 뗀 번호 수 */
  cw?: number;
  cn: number;
  slots: Map<number, { base: number; size: number; used: number }>;
}

export class MemoryEntryStore implements EntryStore {
  readonly #arr = new Map<string, ArrivalState>();
  readonly #arrClaims = new Map<string, string>();
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
  /** 곧 입장 대기열(회차 → 해시 → 번호). 입장 확정 메모리 저장소와는 따로이고 대기 취소 시험만 쓴다 */
  readonly #soon = new Map<string, Map<string, number>>();
  /** 세대 키(회차 → 노드 표지 '{ID}:{설정 세대}')와 지금 노드 표지. 시험이 failoverForTest로 지금 노드를 바꾼다(ADR-0181) */
  readonly #epoch = new Map<string, string>();
  /** notice의 회차 판매 상태(saleState, ADR-0214) */
  readonly #saleState = new Map<string, string>();
  #node = 'node-1:1';
  /** RB-05가 건너뛰었고 복제 확인 전인 회차(세대 키의 pend, ADR-0186). 복제본이 없는 메모리 저장소라 확인은 곧바로 되고, 시험이 blockConfirmForTest로 막는다 */
  readonly #pend = new Set<string>();
  #confirmBlocked = false;

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

  /** 기록 단계가 보는 값: 다른 요청의 취소 끝 표지는 빈 키와 같다(Lua의 OTHER_LEFT_IS_EMPTY, ADR-0233) */
  #recordable(k: string, requestId: string): string | null {
    const v = this.#dupOf(k);
    return v !== null && v.startsWith('LEFT:') && v !== `LEFT:${requestId}` ? null : v;
  }

  #doneOf(eventId: string): Map<string, string> {
    const m = this.#done.get(eventId) ?? new Map<string, string>();
    this.#done.set(eventId, m);
    return m;
  }

  async preempt(i: { pid: string; eventId: string; requestId: string; pendingTtlMs: number }): Promise<PreemptResult> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#adm.has(k)) return { kind: 'ADMITTED' };
    let v = this.#dupOf(k);
    // 대기 취소 표지(ADR-0233): 이 요청의 것이면 LEFT, 다른 요청의 LEFT는 빈 키, 다른 요청의 LEAVING은 BUSY
    if (v !== null && v === `LEFT:${i.requestId}`) return { kind: 'LEFT' };
    if (v !== null && v.startsWith(`LEAVING:${i.requestId}:`)) return { kind: 'LEFT' };
    if (v !== null && v.startsWith('LEAVING:')) return { kind: 'BUSY' };
    if (v !== null && v.startsWith('LEFT:')) v = null;
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
    const held = this.#epoch.get(i.eventId);
    if (held === undefined) this.#epoch.set(i.eventId, this.#node);
    else if (held !== this.#node) return i.items.map(() => ({ kind: 'RECOVERING' }));
    if (this.#pend.has(i.eventId)) return i.items.map(() => ({ kind: 'RECOVERING' }));
    const now = this.clock.now();
    if (i.opensAtMs !== undefined && now < i.opensAtMs) return i.items.map(() => ({ kind: 'EARLY' }));
    const sale = this.#saleState.get(i.eventId);
    if (sale === 'SOLD_OUT' || sale === 'ENDED') return i.items.map(() => ({ kind: sale }));
    const gen = (this.#skipped.get(i.eventId)?.length ?? 0) + 1;
    const done = this.#doneOf(i.eventId);
    const seqOf = () => this.#seq.get(i.eventId) ?? 0;
    if (i.lobbyShuffle && !done.has('lobby')) {
      const n = this.#lobby.get(i.eventId)?.size ?? 0;
      done.set('lobby', `${seqOf() + 1}:${n}:${gen}`);
      // Lua처럼 인원이 0이면 카운터 키를 만들지 않는다(RB-05·일정 읽기의 '카운터가 없으면'과 맞춘다)
      if (n > 0) this.#seq.set(i.eventId, seqOf() + n);
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
        if (members.size > 0) this.#seq.set(i.eventId, seqOf() + members.size);
      }
    }
    const arrival = i.items.some((it) => it.arrivalSlot !== undefined);
    if (!arrival) {
      const first = seqOf() + 1;
      this.#seq.set(i.eventId, seqOf() + i.items.length);
      return i.items.map((_, k) => ({ kind: 'NUMBERED', seq: first + k, gen }));
    }
    // 진입 Degraded의 도착 시각 칸(Lua NUMBER_BATCH_LUA와 같은 규칙, ADR-0223 결정 6)
    const initial = i.arrivalInitial ?? ARRIVAL_SLOT_INITIAL;
    const st = this.#arrOf(i.eventId);
    if (st.gen !== undefined && st.gen !== gen) {
      if (st.next !== undefined && st.next - 1 > st.lost) st.lost = st.next - 1;
      st.gen = gen;
    }
    const carved = { n: 0 };
    const cw = Math.floor(now / ARRIVAL_CARVE_WINDOW_MS);
    if (st.cw !== cw) {
      st.cw = cw;
      st.cn = 0;
    }
    const out: (NumberResult | null)[] = i.items.map((it) => {
      const k = it.arrivalSlot;
      if (k === undefined) return null;
      if (k <= st.closed || k <= st.lost || k * ARRIVAL_SLOT_MS > now + ARRIVAL_FUTURE_MS || (k + 1) * ARRIVAL_SLOT_MS + ARRIVAL_CLOSE_AFTER_MS <= now) return { kind: 'NUMBERED', seq: 0, gen, arrival: 'late' };
      this.#carve(i.eventId, st, k, gen, initial, carved);
      const s = st.slots.get(k);
      if (!s) return { kind: 'NUMBERED', seq: 0, gen, arrival: 'late' };
      if (s.used >= s.size) return { kind: 'NUMBERED', seq: 0, gen, arrival: 'overflow' };
      const seq = s.base + s.used;
      s.used++;
      return { kind: 'NUMBERED', seq, gen, arrival: 'slot' };
    });
    return out.map((r) => {
      if (r && r.kind === 'NUMBERED' && r.arrival === 'slot') return r;
      const seq = seqOf() + 1;
      this.#seq.set(i.eventId, seq);
      return r && r.kind === 'NUMBERED' ? { ...r, seq } : { kind: 'NUMBERED', seq, gen };
    });
  }

  #arrOf(eventId: string): ArrivalState {
    const s = this.#arr.get(eventId) ?? { closed: -1, lost: -1, cn: 0, slots: new Map() };
    this.#arr.set(eventId, s);
    return s;
  }

  /** k칸까지 차례로 뗀다. 처음 100칸은 첫 크기, 그 뒤는 직전 100칸이 쓴 번호 최댓값 × 1.5. 직전 칸이 모두 비면 빈 칸을 건너뛰고 k를 새 첫 칸으로 삼아 첫 크기로 다시 뗀다. 한 번에 떼는 양은 ARRIVAL_CARVE_MAX까지, 시간 창 하나에서는 ARRIVAL_CARVE_WINDOW_MAX까지다 */
  #carve(eventId: string, st: ArrivalState, k: number, gen: number, initial: number, carved: { n: number }): void {
    if (st.next === undefined) {
      st.next = k;
      st.first = k;
      st.gen = gen;
    }
    if (k < st.next) return;
    let j = st.next;
    while (j <= k && carved.n < ARRIVAL_CARVE_MAX && st.cn < ARRIVAL_CARVE_WINDOW_MAX) {
      let desired = initial;
      if (j - st.first! >= ARRIVAL_WINDOW_SLOTS) {
        let mx = 0;
        for (let m = j - ARRIVAL_WINDOW_SLOTS; m < j; m++) mx = Math.max(mx, st.slots.get(m)?.used ?? 0);
        desired = Math.ceil(mx * 1.5);
        if (desired === 0) {
          // 첫 칸을 옮기기 전에 닫힘 표시가 없으면 옛 첫 칸 앞으로 적는다(Lua의 HSETNX closed_upto와 같다)
          if (st.closed === -1) st.closed = st.first! - 1;
          j = k;
          st.first = k;
          desired = initial;
        }
      }
      // 이 호출과 이 시간 창의 남은 몫. 이 창에서 이미 뗐는데 남은 몫보다 크면 칸을 자르지 않고 멈춘다. 다음 호출이나 다음 창이 온전한 크기로 뗀다. 새 창의 첫 칸만 호출 상한까지 줄인다
      const room = Math.min(ARRIVAL_CARVE_MAX - carved.n, ARRIVAL_CARVE_WINDOW_MAX - st.cn);
      if (st.cn > 0 && desired > room) break;
      const size = Math.min(desired, room);
      const base = (this.#seq.get(eventId) ?? 0) + 1;
      st.slots.set(j, { base, size, used: 0 });
      this.#seq.set(eventId, base + size - 1);
      carved.n += size;
      st.cn += size;
      j++;
    }
    st.next = j;
  }

  async claimArrival(i: { eventId: string; reqId: string; requestId: string; ttlMs: number }): Promise<boolean> {
    const k = `${i.reqId}|${i.eventId}`;
    const v = this.#arrClaims.get(k);
    if (v === undefined) {
      this.#arrClaims.set(k, i.requestId);
      return true;
    }
    return v === i.requestId;
  }

  async rb05(i: Rb05Input): Promise<Rb05Result> {
    const held = this.#epoch.get(i.eventId);
    if (held === this.#node) return this.#pend.has(i.eventId) ? { kind: 'PENDING' } : { kind: 'DONE' };
    const now = this.clock.now();
    if (now < i.opensAtMs && !this.#seq.has(i.eventId)) {
      this.#epoch.set(i.eventId, this.#node);
      return { kind: 'DONE' };
    }
    const done = this.#doneOf(i.eventId);
    let k = i.skipBase;
    if (i.lobbyShuffle && !done.has('lobby')) k += this.#lobby.get(i.eventId)?.size ?? 0;
    if (i.openBatch && now >= (i.closeAtMs ?? 0) && !done.has(String(BATCH_NO))) k += this.#members.get(i.eventId)?.size ?? 0;
    const seq = this.#seq.get(i.eventId) ?? 0;
    const lines = this.#skipped.get(i.eventId) ?? [];
    const gen = lines.length + 1;
    this.#skipped.set(i.eventId, [...lines, `${seq + 1}:${seq + k}:${gen}`]);
    this.#seq.set(i.eventId, seq + k);
    this.#epoch.set(i.eventId, this.#node);
    this.#pend.add(i.eventId);
    return { kind: 'SKIPPED', start: seq + 1, end: seq + k, gen: gen + 1 };
  }

  async confirmRb05(i: { eventId: string }): Promise<Rb05Confirm> {
    if (this.#epoch.get(i.eventId) !== this.#node || !this.#pend.has(i.eventId)) return 'NONE';
    if (this.#confirmBlocked) return 'WAITING';
    this.#pend.delete(i.eventId);
    return 'CONFIRMED';
  }

  async number(i: NumberInput): Promise<NumberResult> {
    const { eligible, tokenHash, ...common } = i;
    return (await this.numberBatch({ ...common, items: [{ eligible, tokenHash }] }))[0]!;
  }

  async record(i: { pid: string; eventId: string; requestId: string; seq: number; gen: number; jny: string; vr?: ReasonCategory; expireAtMs: number; ticketHash?: string }): Promise<RecordResult> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#adm.has(k)) return { kind: 'ADMITTED' };
    const v = this.#recordable(k, i.requestId);
    if (v !== null && v !== `PENDING:${i.requestId}`) {
      const r = recorded(v, i.requestId);
      if (r) return { kind: 'SAME', ...r };
      const b = batched(v);
      return b?.requestId === i.requestId ? { kind: 'BATCH', tokenHash: b.tokenHash } : { kind: 'TAKEN' };
    }
    this.#dup.set(k, { v: `${i.seq}:${i.gen}:${i.requestId}:${i.jny}:${i.vr ?? ''}${i.ticketHash ? `:${i.ticketHash}` : ''}`, until: i.expireAtMs });
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
    const v = this.#recordable(k, i.requestId);
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

  async convertBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string; seq: number; gen: number; expireAtMs: number; ticketHash?: string }): Promise<({ kind: 'RECORDED' } & RecordedEntry) | { kind: 'GONE' }> {
    const k = `${i.pid}|${i.eventId}`;
    const v = this.#dupOf(k);
    if (v === null) return { kind: 'GONE' };
    const b = batched(v);
    if (!b || b.requestId !== i.requestId || b.tokenHash !== i.tokenHash) {
      const r = recorded(v, i.requestId);
      return r ? { kind: 'RECORDED', ...r } : { kind: 'GONE' };
    }
    this.#dup.set(k, { v: `${i.seq}:${i.gen}:${i.requestId}:${b.jny}:${b.vr ?? ''}${i.ticketHash ? `:${i.ticketHash}` : ''}`, until: i.expireAtMs });
    return { kind: 'RECORDED', seq: i.seq, gen: i.gen, jny: b.jny, ...(b.vr ? { vr: b.vr } : {}) };
  }

  async dropBatch(i: { pid: string; eventId: string; requestId: string; tokenHash: string }): Promise<void> {
    const k = `${i.pid}|${i.eventId}`;
    const v = this.#dupOf(k);
    const b = v === null ? null : batched(v);
    if (b && b.requestId === i.requestId && b.tokenHash === i.tokenHash) this.#dup.delete(k);
  }

  /** 이 요청의 값인가(선점 포함 여부는 고른다) */
  #own(v: string, requestId: string, pending: boolean): boolean {
    if (pending && v === `PENDING:${requestId}`) return true;
    return recorded(v, requestId) !== null || batched(v)?.requestId === requestId;
  }

  async mirror(i: { from: string; to: string; eventId: string; requestId: string }): Promise<'COPIED' | 'TAKEN' | 'ADMITTED'> {
    const from = `${i.from}|${i.eventId}`;
    const v = this.#dupOf(from);
    if (v === null || !this.#own(v, i.requestId, false)) return 'COPIED';
    const to = `${i.to}|${i.eventId}`;
    if (this.#adm.has(to)) return 'ADMITTED';
    const cur = this.#recordable(to, i.requestId);
    if (cur !== null && !this.#own(cur, i.requestId, true)) return 'TAKEN';
    this.#dup.set(to, { v, until: this.#dup.get(from)!.until });
    return 'COPIED';
  }

  async dropOwn(i: { pid: string; eventId: string; requestId: string }): Promise<void> {
    const k = `${i.pid}|${i.eventId}`;
    const v = this.#dupOf(k);
    if (v !== null && this.#own(v, i.requestId, true)) this.#dup.delete(k);
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

  async addLobbyMember(i: { eventId: string; tokenHash: string; opensAtMs: number; lobbyOpensAtMs: number; verify?: { value: string; expireAtMs: number } }): Promise<'ADDED' | 'NOT_OPEN' | 'CLOSED'> {
    const now = this.clock.now();
    if (now >= i.opensAtMs || this.#doneOf(i.eventId).has('lobby')) return 'CLOSED';
    if (now < i.lobbyOpensAtMs) return 'NOT_OPEN';
    const s = this.#lobby.get(i.eventId) ?? new Set<string>();
    s.add(i.tokenHash);
    this.#lobby.set(i.eventId, s);
    if (i.verify) {
      const m = this.#verify.get(i.eventId) ?? new Map<string, string>();
      if (!m.has(i.tokenHash)) m.set(i.tokenHash, i.verify.value);
      this.#verify.set(i.eventId, m);
    }
    return 'ADDED';
  }

  async lobbyWindow(i: { eventId: string; opensAtMs: number; lobbyOpensAtMs: number }): Promise<'OPEN' | 'NOT_OPEN' | 'CLOSED'> {
    const now = this.clock.now();
    if (now >= i.opensAtMs || this.#doneOf(i.eventId).has('lobby')) return 'CLOSED';
    return now < i.lobbyOpensAtMs ? 'NOT_OPEN' : 'OPEN';
  }

  async removeLobbyMember(i: { eventId: string; tokenHash: string; expireAtMs: number }): Promise<void> {
    // 표시가 선 뒤에는 고정한 목록을 바꾸지 않고, 주인 없는 자리로 적어 게시 때 빠진 번호가 되게 한다
    if (this.#doneOf(i.eventId).has('lobby')) {
      const m = this.#verify.get(i.eventId) ?? new Map<string, string>();
      if (!m.has(i.tokenHash)) m.set(i.tokenHash, `ORPHAN:${this.clock.now()}`);
      this.#verify.set(i.eventId, m);
      return;
    }
    this.#lobby.get(i.eventId)?.delete(i.tokenHash);
    this.#verify.get(i.eventId)?.delete(i.tokenHash);
  }

  async recordLobby(i: { pid: string; eventId: string; requestId: string; tokenHash: string; expireAtMs: number }): Promise<'RECORDED' | 'ADMITTED' | 'TAKEN'> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#adm.has(k)) return 'ADMITTED';
    const v = this.#recordable(k, i.requestId);
    if (v !== null && v !== `PENDING:${i.requestId}`) return 'TAKEN';
    this.#dup.set(k, { v: `LOBBY:${i.tokenHash}:${i.requestId}`, until: i.expireAtMs });
    return 'RECORDED';
  }

  async dropLobbyRecord(i: { pid: string; eventId: string; requestId: string; tokenHash: string }): Promise<void> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#dupOf(k) === `LOBBY:${i.tokenHash}:${i.requestId}`) this.#dup.delete(k);
  }

  async readHeld(i: { pid: string; eventId: string }): Promise<HeldRecord | null> {
    const v = this.#dupOf(`${i.pid}|${i.eventId}`);
    return v === null ? null : parseHeld(v);
  }

  async leaveNumber(i: { eventId: string; seq: number; ticketHash?: string; expireAtMs: number }): Promise<void> {
    await this.markRemoved(i);
    if (!i.ticketHash) return;
    const m = this.#verify.get(i.eventId);
    const v = m?.get(i.ticketHash);
    if (v?.startsWith('VERIFYING:') || v?.startsWith('PASSED:')) m!.delete(i.ticketHash);
    this.#soon.get(i.eventId)?.delete(i.ticketHash);
  }

  async leaveMember(i: { eventId: string; group: ShuffleGroup; tokenHash: string; closesAtMs?: number; verifyExpireAtMs: number }): Promise<'REMOVED' | 'FIXED' | 'CLOSED'> {
    const fixed = this.#doneOf(i.eventId).has(String(i.group));
    if (i.closesAtMs !== undefined && (fixed || this.clock.now() >= i.closesAtMs)) return 'CLOSED';
    const m = this.#verify.get(i.eventId) ?? new Map<string, string>();
    this.#verify.set(i.eventId, m);
    if (!fixed) {
      (i.group === 'lobby' ? this.#lobby : this.#members).get(i.eventId)?.delete(i.tokenHash);
      m.delete(i.tokenHash);
      return 'REMOVED';
    }
    const v = m.get(i.tokenHash);
    if (!v?.startsWith('ORPHAN:') && !v?.startsWith('BLOCKED:')) m.set(i.tokenHash, `ORPHAN:${this.clock.now()}`);
    this.#doneOf(i.eventId).set(`orphan:${i.group}`, '1');
    return 'FIXED';
  }

  async resultSeat(i: { group: ShuffleGroup; tokenHash: string }): Promise<{ seq: number; gen: number } | null> {
    const r = this.#results.get(i.tokenHash);
    if (!r) return null;
    const [seq, gen] = r.split(':').map(Number);
    return { seq: seq!, gen: gen! };
  }

  async swapHeld(i: { pid: string; eventId: string; from: string; to: string }): Promise<boolean> {
    const k = `${i.pid}|${i.eventId}`;
    if (this.#dupOf(k) !== i.from) return false;
    this.#dup.set(k, { v: i.to, until: this.#dup.get(k)!.until });
    return true;
  }

  closeLobbyForTest(eventId: string): void {
    this.#doneOf(eventId).set('lobby', '1:0:1');
  }
  closeListForTest(eventId: string, field: 'lobby' | '1', marker: string): void {
    this.#doneOf(eventId).set(field, marker);
  }
  setVerifyForTest(eventId: string, hash: string, value: string): void {
    const m = this.#verify.get(eventId) ?? new Map<string, string>();
    m.set(hash, value);
    this.#verify.set(eventId, m);
  }
  setResultForTest(tokenHash: string, seq: number, gen: number): void {
    this.#results.set(tokenHash, `${seq}:${gen}`);
  }
  addSoonForTest(eventId: string, hash: string, seq: number): void {
    const m = this.#soon.get(eventId) ?? new Map<string, number>();
    m.set(hash, seq);
    this.#soon.set(eventId, m);
  }
  /** 곧 입장 키 셋의 해시. 메모리에서는 한 표로 두어 셋이 같다 */
  soonForTest(eventId: string): [string[], string[], string[]] {
    const hashes = [...(this.#soon.get(eventId)?.keys() ?? [])];
    return [hashes, hashes, hashes];
  }
  lobbyMembersForTest(eventId: string): string[] {
    return [...(this.#lobby.get(eventId) ?? [])];
  }

  // 시험 도구
  admitForTest(pid: string, eventId: string, ticketHash: string): void {
    this.#adm.set(`${pid}|${eventId}`, ticketHash);
  }
  /** 주 노드가 바뀐 것을 흉내 낸다: 그 회차의 세대 키가 이미 서 있게 한 뒤(일정 사본 읽기가 쓰듯) 새 노드가 더 큰 설정 세대로 올라선다 */
  failoverForTest(eventId?: string): void {
    if (eventId !== undefined && !this.#epoch.has(eventId)) this.#epoch.set(eventId, this.#node);
    const [id, e] = this.#node.split(':');
    this.#node = `node-${Number(id!.slice(5)) + 1}:${Number(e) + 1}`;
  }
  /** 장애 전환으로 잃은 쓰기를 흉내 낸다: 카운터·건너뛴 구간·세대 키(확인 전 표시 포함, 주지 않으면 없음)를 그 값으로 되돌린다 */
  rollbackForTest(eventId: string, to: { seq: number; skipped: string[]; epoch: string; pend?: boolean }): void {
    this.#seq.set(eventId, to.seq);
    this.#skipped.set(eventId, [...to.skipped]);
    this.#epoch.set(eventId, to.epoch);
    if (to.pend) this.#pend.add(eventId);
    else this.#pend.delete(eventId);
  }
  /** 붙은 복제본이 RB-05의 쓰기를 받지 못하는 것을 흉내 낸다(확인이 WAITING) */
  blockConfirmForTest(on: boolean): void {
    this.#confirmBlocked = on;
  }
  epochOf(eventId: string): string | undefined {
    return this.#epoch.get(eventId);
  }
  skippedOf(eventId: string): string[] {
    return [...(this.#skipped.get(eventId) ?? [])];
  }
  /** 칸의 쓴 번호 수를 바로 넣는다(큰 수를 요청으로 채우지 않으려고) */
  setArrivalUsedForTest(eventId: string, slot: number, used: number): void {
    const s = this.#arrOf(eventId).slots.get(slot);
    if (s) s.used = used;
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
  /** 사람 키 값을 바꾼다(null이면 지운다, 수명이 없으면 하루) */
  setDupForTest(pid: string, eventId: string, value: string | null, expireAtMs?: number): void {
    const k = `${pid}|${eventId}`;
    if (value === null) this.#dup.delete(k);
    else this.#dup.set(k, { v: value, until: expireAtMs ?? this.clock.now() + 86_400_000 });
  }
  /** notice의 saleState를 쓴다(판매 상태 처리기가 쓴 것 흉내) */
  setSaleStateForTest(eventId: string, state: string): void {
    this.#saleState.set(eventId, state);
  }

  dupForTest(pid: string, eventId: string): { value: string | null; expireAtMs: number | null } {
    const k = `${pid}|${eventId}`;
    const value = this.#dupOf(k);
    return { value, expireAtMs: value === null ? null : (this.#dup.get(k)?.until ?? null) };
  }
}

/** 시험용 셔플 공시 기록(한 번 쓰면 안 바뀐다) */
export class MemoryShuffleCommits implements ShuffleCommitStore {
  readonly #m = new Map<string, CommitRecord>();

  /** clock: 저장소 시각을 흉내 낸다(운영은 Redis TIME) */
  constructor(private readonly clock: Pick<Clock, 'now'> = { now: () => Date.now() }) {}

  async read(eventId: string, group: ShuffleGroup): Promise<CommitRecord | null> {
    return this.#m.get(`${eventId}|${group}`) ?? null;
  }

  async write(eventId: string, group: ShuffleGroup, rec: Omit<CommitRecord, 'atMs'>, _expireAtMs?: number): Promise<CommitRecord> {
    const k = `${eventId}|${group}`;
    const hit = this.#m.get(k);
    if (hit) return hit;
    const saved = { ...rec, atMs: this.clock.now() };
    this.#m.set(k, saved);
    return saved;
  }

  /** 기록을 잃고 다시 쓰인 것을 흉내 낸다 */
  replaceForTest(eventId: string, group: ShuffleGroup, rec: CommitRecord): void {
    this.#m.set(`${eventId}|${group}`, rec);
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
