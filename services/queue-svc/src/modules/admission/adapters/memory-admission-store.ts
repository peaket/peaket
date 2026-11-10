// 시험용 입장 저장소. Valkey의 Lua(admission-lua.ts)와 같은 규칙을 메모리로 둔다(같은 사례를 test/admission-cases.ts가 둘 다에 돈다).
// 서버 시각은 주입한 시계다(Lua는 Redis TIME을 쓴다). 사람 키(q:adm·q:dup)는 진입 메모리 저장소와 나누지 않는다(진입과 함께 보는 시험은 Valkey로 한다).
import type { Clock } from '@peaket/platform';
import { DEFAULT_TARGET, FIRST_USE_MS, NOT_YET_MAX_MS, NOT_YET_MIN_MS, RATE_WINDOW_SEC, SOON_RETRY_MAX_SEC, SOON_RETRY_MIN_SEC, type AdmitResult, type Claim, type LobbySeat, type Precheck, MAX_STAY_MS } from '../domain/admission.js';
import type { AdmissionStore } from '../domain/ports.js';

/** 회차 키들의 메모리 모양(시험이 직접 채운다) */
export class MemoryAdmissionDb {
  readonly dup = new Map<string, string>();
  readonly adm = new Map<string, string>();
  readonly #m = new Map<string, unknown>();

  #of<T>(kind: string, e: string, make: () => T): T {
    const key = `${kind}|${e}`;
    if (!this.#m.has(key)) this.#m.set(key, make());
    return this.#m.get(key) as T;
  }
  /** serving·admitted */
  ev = (e: string) => this.#of('ev', e, () => new Map<string, number>());
  /** serving_log: 초(문자열) → serving */
  servingLog = (e: string) => this.#of('log', e, () => new Map<string, number>());
  /** calls: 값 → 점수(마지막 번호) */
  calls = (e: string) => this.#of('calls', e, () => new Map<string, number>());
  callReq = (e: string) => this.#of('callReq', e, () => new Map<string, number>());
  removed = (e: string) => this.#of('removed', e, () => new Set<number>());
  /** q:{event:E}:verify: 대기표(로비 진입자는 참가 토큰) 해시 → VERIFYING:{ms}:{사유}·PASSED:{ms}:{사유}·BLOCKED:{ms}:{사유}·ORPHAN:{ms}. 추가 검증 저장소가 같은 db를 넘겨받아 바꾼다 */
  verify = (e: string) => this.#of('verify', e, () => new Map<string, string>());
  skipped = (e: string) => this.#of('skipped', e, () => [] as string[]);
  notice = (e: string) => this.#of('notice', e, () => new Map<string, string>());
  ctl = (e: string) => this.#of('ctl', e, () => new Map<string, string>());
  slots = (e: string) => this.#of('slots', e, () => new Map<string, number>());
  soon = (e: string) => this.#of('soon', e, () => new Map<string, number>());
  soonAt = (e: string) => this.#of('soonAt', e, () => new Map<string, number>());
  soonFirst = (e: string) => this.#of('soonFirst', e, () => new Map<string, number>());
  admits = (e: string) => this.#of('admits', e, () => new Map<string, string>());
  /** 대기표 해시 → 입장 자리 jti */
  slotOf = (e: string) => this.#of('slotOf', e, () => new Map<string, string>());
  /** 처음 요청을 센 번호 */
  req = (e: string) => this.#of('req', e, () => new Set<number>());
  /** 로비 셔플 결과 q:lobby:{토큰 해시} */
  readonly lobbyResults = new Map<string, string>();
  lobbyMembers = (e: string) => this.#of('lobbyMembers', e, () => new Set<string>());
  batchDone = (e: string) => this.#of('batchDone', e, () => new Map<string, string>());
}

/** 정렬 집합의 순서(점수, 같으면 멤버 문자열) */
const sorted = (m: Map<string, number>) => [...m.entries()].sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v.trim() === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};
/** verify 값 {상태}:{시각}[:{사유}](Lua의 '^(%u+):(%d+):?(.*)$'와 같다) */
const verifyState = (v: string | undefined): { st: string; at: number; why: string } | null => {
  const m = /^([A-Z]+):(\d+):?(.*)$/.exec(v ?? '');
  return m ? { st: m[1]!, at: Number(m[2]), why: m[3] ?? '' } : null;
};

export class MemoryAdmissionStore implements AdmissionStore {
  /** 자리를 처음 잡은 시각(Lua의 slot_of '<해시>:at' 칸) */
  readonly #issuedAt = new Map<string, number>();

  setIssuedAtForTest(eventId: string, ticketHash: string, atMs: number): void {
    this.#issuedAt.set(`${eventId}|${ticketHash}`, atMs);
  }

  /** db를 넘기면 같은 회차 키를 다른 메모리 저장소(추가 검증)와 나눈다 */
  constructor(
    private readonly clock: Clock,
    readonly db: MemoryAdmissionDb = new MemoryAdmissionDb(),
  ) {}

  async precheck(i: { eventId: string; seq: number; gen: number; ticketHash: string; graceMs: number }): Promise<Precheck> {
    const e = i.eventId;
    const now = this.clock.now();
    const state = this.db.notice(e).get('saleState');
    if (state === 'SOLD_OUT') return { kind: 'SOLD_OUT' };
    if (state === 'ENDED') return { kind: 'ENDED' };
    const sold = num(this.db.notice(e).get('soldOutLastSeq'));
    if (sold !== undefined && i.seq <= sold) return { kind: 'SOLD_OUT' };
    let passedAt = -1;
    if (this.db.removed(e).has(i.seq)) {
      const v = verifyState(this.db.verify(e).get(i.ticketHash));
      if (v?.st === 'VERIFYING') return { kind: 'VERIFYING', reason: v.why };
      if (v?.st === 'BLOCKED') return { kind: 'REMOVED', removeReason: 'BLOCKED' };
      if (v?.st !== 'PASSED') return { kind: 'REMOVED' };
      passedAt = v.at;
    }
    let skipped = false;
    for (const line of this.db.skipped(e)) {
      const m = /^(\d+):(\d+):(\d+)$/.exec(line);
      if (m && i.seq >= Number(m[1]) && i.seq <= Number(m[2])) {
        if (i.gen > Number(m[3])) return { kind: 'REMOVED' };
        skipped = true;
      }
    }
    const serving = this.db.ev(e).get('serving') ?? 0;
    const log = sorted(this.db.servingLog(e));
    if (i.seq > serving) {
      const nowS = Math.floor(now / 1000);
      const tail = log.slice(-11);
      let base = [...tail].reverse().find(([s]) => Number(s) <= nowS - RATE_WINDOW_SEC);
      if (!base && tail.length > 0) base = tail[0];
      let ms = NOT_YET_MAX_MS;
      if (base && nowS > Number(base[0]) && serving > base[1]) ms = Math.ceil(((i.seq - serving) / ((serving - base[1]) / (nowS - Number(base[0])))) * 1000);
      return { kind: 'NOT_YET', serving, retryAfterMs: Math.max(NOT_YET_MIN_MS, Math.min(NOT_YET_MAX_MS, ms)) };
    }
    const first = log.find(([, v]) => v >= i.seq);
    const turnAtMs = first ? Number(first[0]) * 1000 : undefined;
    const inSoon = this.db.soon(e).has(i.ticketHash);
    // 유예는 차례와 통과 가운데 늦은 때부터 센다. 비트가 꺼진 통과자(셔플 전 통과)는 유예가 지났을 때만 통과 시각을 읽는다
    if (!inSoon && turnAtMs !== undefined && now - Math.max(turnAtMs, passedAt) > i.graceMs) {
      if (passedAt < 0) {
        const v = verifyState(this.db.verify(e).get(i.ticketHash));
        if (v?.st === 'PASSED') passedAt = v.at;
      }
      if (now - Math.max(turnAtMs, passedAt) > i.graceMs) {
        const j = this.db.slotOf(e).get(i.ticketHash);
        const sc = j === undefined ? undefined : this.db.slots(e).get(j);
        if (!(sc !== undefined && sc > now)) return { kind: 'EXPIRED', turnAtMs, ...(passedAt >= 0 ? { passedAtMs: passedAt } : {}) };
      }
    }
    return { kind: 'OK', serving, ...(turnAtMs !== undefined ? { turnAtMs } : {}), inSoon, skipped, ...(passedAt >= 0 ? { passedAtMs: passedAt } : {}) };
  }

  async claim(i: { pid: string; eventId: string; ticketHash: string; nonce: string; expireAtMs: number }): Promise<Claim> {
    const key = `${i.pid}|${i.eventId}`;
    const v = this.db.adm.get(key);
    if (v === undefined) {
      this.db.adm.set(key, `${i.ticketHash}:${i.nonce}`);
      return { kind: 'NEW' };
    }
    if (/^([0-9a-f]+)/.exec(v)?.[1] === i.ticketHash) return { kind: 'SAME' };
    return { kind: 'DUP' };
  }

  async admit(i: Parameters<AdmissionStore['admit']>[0]): Promise<AdmitResult> {
    const e = i.eventId;
    const now = this.clock.now();
    const serving = this.db.ev(e).get('serving') ?? 0;
    if (i.seq > serving) return { kind: 'NOT_YET' };
    if (this.db.removed(e).has(i.seq)) {
      const st = verifyState(this.db.verify(e).get(i.ticketHash))?.st;
      if (st === 'BLOCKED') return { kind: 'REMOVED', removeReason: 'BLOCKED' };
      if (st !== 'PASSED') return { kind: 'REMOVED' };
    }
    const slots = this.db.slots(e);
    const prev = this.db.slotOf(e).get(i.ticketHash);
    if (prev !== undefined) {
      const sc = slots.get(prev);
      if (sc !== undefined && sc > now) {
        slots.set(prev, Math.max(sc, now + FIRST_USE_MS));
        const issuedAtMs = this.#issuedAt.get(`${e}|${i.ticketHash}`);
        if (issuedAtMs !== undefined && now >= issuedAtMs + MAX_STAY_MS) return { kind: 'EXPIRED' };
        return { kind: 'ADMITTED', jti: prev, again: true, firstSlot: false, serving, ...(issuedAtMs !== undefined ? { issuedAtMs } : {}) };
      }
    }
    const inSoon = this.db.soon(e).has(i.ticketHash);
    let arrivalDelayMs: number | undefined;
    if (!i.skipped && !this.db.req(e).has(i.seq)) {
      this.db.req(e).add(i.seq);
      const call = i.turnAtMs === undefined ? undefined : sorted(this.db.calls(e)).find(([, last]) => last >= i.seq);
      const at = call ? Number(/^(\d+):/.exec(call[0])?.[1]) : Number.NaN;
      if (call && i.turnAtMs !== undefined && Number.isFinite(at) && Math.floor(at / 1000) === Math.floor(i.turnAtMs / 1000)) {
        this.db.callReq(e).set(call[0], (this.db.callReq(e).get(call[0]) ?? 0) + 1);
        arrivalDelayMs = now - at;
      }
    }
    const target = num(this.db.ctl(e).get('targetNow')) ?? DEFAULT_TARGET;
    const free = target - [...slots.values()].filter((at) => at > now).length;
    const ahead = [...this.db.soon(e).values()].filter((s) => s < i.seq).length;
    const sec = Math.floor(now / 1000);
    const delay = arrivalDelayMs !== undefined ? { arrivalDelayMs } : {};
    if (free > ahead) {
      slots.set(i.freshJti, now + FIRST_USE_MS);
      this.db.slotOf(e).set(i.ticketHash, i.freshJti);
      this.#issuedAt.set(`${e}|${i.ticketHash}`, now);
      this.db.ev(e).set('admitted', (this.db.ev(e).get('admitted') ?? 0) + 1);
      const f = String(sec % 16);
      const cur = /^(\d+):(\d+)$/.exec(this.db.admits(e).get(f) ?? '');
      this.db.admits(e).set(f, `${sec}:${cur && Number(cur[1]) === sec ? Number(cur[2]) + 1 : 1}`);
      let soonWaitMs: number | undefined;
      if (inSoon) {
        const fs = this.db.soonFirst(e).get(i.ticketHash);
        if (fs !== undefined) soonWaitMs = now - fs;
        this.db.soon(e).delete(i.ticketHash);
        this.db.soonAt(e).delete(i.ticketHash);
        this.db.soonFirst(e).delete(i.ticketHash);
      }
      return { kind: 'ADMITTED', jti: i.freshJti, again: false, firstSlot: prev === undefined, serving, issuedAtMs: now, ...delay, ...(soonWaitMs !== undefined ? { soonWaitMs } : {}) };
    }
    this.db.soon(e).set(i.ticketHash, i.seq);
    this.db.soonAt(e).set(i.ticketHash, now);
    if (!this.db.soonFirst(e).has(i.ticketHash)) this.db.soonFirst(e).set(i.ticketHash, now);
    let sum = 0;
    for (const v of this.db.admits(e).values()) {
      const m = /^(\d+):(\d+)$/.exec(v);
      if (m && Number(m[1]) <= sec && sec - Number(m[1]) < RATE_WINDOW_SEC) sum += Number(m[2]);
    }
    let retry = SOON_RETRY_MAX_SEC;
    if (sum > 0) retry = Math.ceil((ahead + 1 - free) / (sum / RATE_WINDOW_SEC));
    return { kind: 'SOON', retryAfterSeconds: Math.max(SOON_RETRY_MIN_SEC, Math.min(SOON_RETRY_MAX_SEC, retry)), ...delay };
  }

  async settle(i: { pid: string; eventId: string; ticketHash: string; outcome: 'ADMITTED' | 'RELEASE'; nonce: string; expireAtMs: number }): Promise<void> {
    const key = `${i.pid}|${i.eventId}`;
    const v = this.db.adm.get(key);
    const mine = `${i.ticketHash}:${i.nonce}`;
    if (i.outcome === 'ADMITTED') {
      if (v === undefined || /^([0-9a-f]+)/.exec(v)?.[1] === i.ticketHash) this.db.adm.set(key, mine);
      this.db.dup.delete(key);
      return;
    }
    if (v === mine) this.db.adm.delete(key);
  }

  async lobbySeat(i: { eventId: string; tokenHash: string; nowMs: number }): Promise<LobbySeat> {
    const v = this.db.lobbyResults.get(i.tokenHash);
    const m = v === undefined ? null : /^(\d+):(\d+)$/.exec(v);
    if (m) return { kind: 'SEAT', seq: Number(m[1]), gen: Number(m[2]) };
    if (!this.db.batchDone(i.eventId).has('pub:lobby')) return { kind: 'PENDING' };
    if (!this.db.lobbyMembers(i.eventId).has(i.tokenHash)) return { kind: 'GONE' };
    if (!this.db.batchDone(i.eventId).has('repair:lobby')) this.db.batchDone(i.eventId).set('repair:lobby', String(i.nowMs));
    return { kind: 'REPAIRING' };
  }

  async expire(i: { pid: string; eventId: string; seq: number; gen: number; dupPrefix?: string }): Promise<{ admittedBefore: boolean }> {
    const key = `${i.pid}|${i.eventId}`;
    if (this.db.dup.get(key)?.startsWith(i.dupPrefix ?? `${i.seq}:${i.gen}:`)) this.db.dup.delete(key);
    return { admittedBefore: this.db.adm.has(key) };
  }

  async markRemoved(i: { eventId: string; seq: number; ticketHash: string }): Promise<{ verifyCleared: boolean }> {
    this.db.removed(i.eventId).add(i.seq);
    const v = this.db.verify(i.eventId).get(i.ticketHash);
    if (!(v?.startsWith('PASSED:') || v?.startsWith('VERIFYING:'))) return { verifyCleared: false };
    this.db.verify(i.eventId).delete(i.ticketHash);
    return { verifyCleared: true };
  }

  async sessionStarted(i: { eventId: string; jti: string; maxStayUntilMs: number }): Promise<boolean> {
    const slots = this.db.slots(i.eventId);
    const cur = slots.get(i.jti);
    if (cur === undefined || cur >= i.maxStayUntilMs) return false;
    slots.set(i.jti, i.maxStayUntilMs);
    return true;
  }

  async sessionEnded(i: { eventId: string; jti: string }): Promise<boolean> {
    return this.db.slots(i.eventId).delete(i.jti);
  }
}
