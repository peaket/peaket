// 관리 계정 로그인의 출발지가 든 값과 없는 계정의 가짜 상태(메모리 구현, 시험·로컬, BUILD_ORDER BOT-111).
// Redis 구현(redis-login-counters.ts)과 같은 규칙이다: 묶음 실패 수와 묶음 잠금, 1시간 창의 계정의 출발지 수·출발지의 계정 수, 5분 전체 실패 수, 경보 끝 시각.
import { type AccountLoginState, FRESH_LOGIN_STATE } from '../domain/login-rules.js';
import { type LoginCounters, type LoginCountersPeek, LoginCountersUnavailable, type LoginFailureLimits, type LoginFailureRecorded } from '../domain/ports.js';

const MINUTE = 60_000;

export class MemoryLoginCounters implements LoginCounters {
  /** 시험용: 켜면 모든 호출이 LoginCountersUnavailable */
  down = false;
  readonly #pairs = new Map<string, { n: number; until: number | null }>();
  readonly #accountSources = new Map<string, Map<string, number>>();
  readonly #sourceAccounts = new Map<string, Map<string, number>>();
  readonly #alerts = new Map<string, number>();
  readonly #globalMinutes = new Map<number, number>();
  readonly #ghosts = new Map<string, AccountLoginState>();
  readonly #leases = new Map<string, { token: string; until: number }>();
  #seq = 0;

  #check(): void {
    if (this.down) throw new LoginCountersUnavailable('memory');
  }

  async peek(i: { subject: string; pair: string; ipHash: string; now: number }): Promise<LoginCountersPeek> {
    this.#check();
    const p = this.#pairs.get(`${i.subject}|${i.pair}`);
    const live = (k: string) => (this.#alerts.get(k) ?? 0) > i.now;
    return {
      pairFailures: p ? p.n : 0,
      pairLockedUntil: p && p.until !== null && p.until > i.now ? p.until : null,
      accountAlert: live(`a:${i.subject}`),
      sourceAlert: live(`s:${i.ipHash}`),
      globalAlert: live('g'),
    };
  }

  /** 1시간 창의 서로 다른 값 수(지난 것은 뺀다) */
  #distinct(m: Map<string, Map<string, number>>, key: string, member: string, now: number, windowMs: number): number {
    const set = m.get(key) ?? new Map<string, number>();
    for (const [k, t] of set) if (t <= now - windowMs) set.delete(k);
    set.set(member, now);
    m.set(key, set);
    return set.size;
  }

  /** 경보가 꺼져 있으면 켜고 true(이미 켜져 있으면 false: 한 번만 알린다) */
  #raise(key: string, now: number, ms: number): boolean {
    if ((this.#alerts.get(key) ?? 0) > now) return false;
    this.#alerts.set(key, now + ms);
    return true;
  }

  async recordFailure(i: { subject: string; pair: string; ipHash: string; emailHash: string; now: number; accountLockedUntil: number | null; pairLockMs: number; limits: LoginFailureLimits }): Promise<LoginFailureRecorded> {
    this.#check();
    const L = i.limits;
    // 묶음: 잠금이 끝났으면 0부터. 계정이 이번에 잠겼으면 같은 끝 시각, 묶음만 기준에 닿으면 pairLockMs
    const key = `${i.subject}|${i.pair}`;
    let p = this.#pairs.get(key) ?? { n: 0, until: null };
    if (p.until !== null && p.until <= i.now) p = { n: 0, until: null };
    const n = p.n + 1;
    let until: number | null = null;
    let left = n;
    if (i.accountLockedUntil !== null) until = i.accountLockedUntil;
    else if (n >= L.pairLockAfter) until = i.now + i.pairLockMs;
    if (until !== null) left = 0;
    this.#pairs.set(key, { n: left, until });
    const ips = this.#distinct(this.#accountSources, i.subject, i.ipHash, i.now, L.windowMs);
    const emails = this.#distinct(this.#sourceAccounts, i.ipHash, i.emailHash, i.now, L.windowMs);
    const minute = Math.floor(i.now / MINUTE);
    this.#globalMinutes.set(minute, (this.#globalMinutes.get(minute) ?? 0) + 1);
    let global = 0;
    for (let m = minute - Math.ceil(L.globalWindowMs / MINUTE) + 1; m <= minute; m++) global += this.#globalMinutes.get(m) ?? 0;
    return {
      pairFailures: left,
      pairLockedUntil: until,
      newAccountAlert: ips >= L.multiSourceIps && this.#raise(`a:${i.subject}`, i.now, L.accountAlertMs),
      newSourceAlert: emails >= L.sourceAccounts && this.#raise(`s:${i.ipHash}`, i.now, L.sourceAlertMs),
      newGlobalAlert: global >= L.globalFailures && this.#raise('g', i.now, L.globalAlertMs),
    };
  }

  async acquire(subject: string, now: number, ttlMs: number): Promise<string | null> {
    this.#check();
    const l = this.#leases.get(subject);
    if (l && l.until > now) return null;
    const token = `t${++this.#seq}`;
    this.#leases.set(subject, { token, until: now + ttlMs });
    return token;
  }

  async release(subject: string, token: string): Promise<void> {
    if (this.#leases.get(subject)?.token === token) this.#leases.delete(subject);
  }

  async clearPair(subject: string, pair: string): Promise<void> {
    this.#check();
    this.#pairs.delete(`${subject}|${pair}`);
  }

  async ghostState(ghostKey: string, _now?: number): Promise<AccountLoginState> {
    this.#check();
    return structuredClone(this.#ghosts.get(ghostKey) ?? FRESH_LOGIN_STATE);
  }

  async setGhostState(ghostKey: string, state: AccountLoginState, _now?: number): Promise<void> {
    this.#check();
    this.#ghosts.set(ghostKey, structuredClone(state));
  }
}
