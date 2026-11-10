// 시험용 추가 검증 저장소. Valkey의 Lua(verification-lua.ts)와 같은 규칙을 메모리로 둔다(같은 사례를 test/verification-cases.ts가 둘 다에 돈다).
// 서버 시각은 주입한 시계다(Lua는 Redis TIME을 쓴다). 사람 키·회차 키는 진입·입장 메모리 저장소와 나누지 않는다(시험이 db를 직접 채운다).
import type { Clock } from '@peaket/platform';
import type { ResolveBegin, SettleOutcome, VerificationStore } from '../domain/ports.js';
import type { AppealDraft, AppealOutcome, ResolveResult, StoredAppeal } from '../domain/verification.js';

interface Expiring<T> {
  v: T;
  until: number;
}

/** 키들의 메모리 모양(시험이 직접 채운다). 키 이름은 '{pid}|{회차}'·'{회차}' 꼴이다 */
export class MemoryVerificationDb {
  readonly dup = new Map<string, string>();
  /** 회차 → 필드 → 값 */
  readonly verify = new Map<string, Map<string, string>>();
  readonly serving = new Map<string, number>();
  /** 회차 → serving_log(초(글자) → 그때의 serving) */
  readonly servingLog = new Map<string, Map<string, number>>();
  readonly lobbyResults = new Map<string, string>();
  readonly vsub = new Map<string, Expiring<number>>();
  /** '{pid}|{회차}' → 칸(진행 표지 pc·pv·po 포함) */
  readonly appeals = new Map<string, Expiring<Map<string, string>>>();
  readonly appealIds = new Map<string, Expiring<string>>();
  readonly appealCases = new Map<string, Expiring<string>>();

  verifyOf(eventId: string): Map<string, string> {
    let m = this.verify.get(eventId);
    if (!m) this.verify.set(eventId, (m = new Map()));
    return m;
  }
}

const who = (pid: string, e: string) => `${pid}|${e}`;
const FIELDS = ['id', 'acc', 'th', 'cat', 'txt', 'ek', 'at', 'exp', 'sent', 'cid', 'cv', 'res', 'ap'] as const;
const RESULTS: readonly ResolveResult[] = ['APPLIED', 'UNCHANGED', 'NOT_ISOLATED'];
const OUTCOMES: readonly AppealOutcome[] = ['ACCEPTED', 'REJECTED'];

function appealOf(h: Map<string, string> | undefined): StoredAppeal | null {
  const id = h?.get('id');
  if (!h || !id) return null;
  const g = (f: (typeof FIELDS)[number]) => h.get(f) ?? '';
  const result = RESULTS.find((r) => r === g('res'));
  const applied = OUTCOMES.find((o) => o === g('ap'));
  return {
    appealId: id,
    accountId: g('acc'),
    fieldHash: g('th'),
    reason: g('cat'),
    text: g('txt'),
    eventKey: g('ek'),
    receivedAtMs: Number(g('at')),
    expireAtMs: Number(g('exp')),
    sent: g('sent') === '1',
    ...(g('cid') ? { caseId: g('cid') } : {}),
    ...(g('cv') ? { caseVersion: Number(g('cv')) } : {}),
    ...(result ? { result } : {}),
    ...(applied ? { appliedOutcome: applied } : {}),
  };
}

export class MemoryVerificationStore implements VerificationStore {
  readonly db = new MemoryVerificationDb();

  constructor(private readonly clock: Clock) {}

  #live<T>(m: Map<string, Expiring<T>>, key: string): T | undefined {
    const x = m.get(key);
    if (!x) return undefined;
    if (this.clock.now() >= x.until) {
      m.delete(key);
      return undefined;
    }
    return x.v;
  }

  async readDup(pid: string, eventId: string): Promise<string | null> {
    return this.db.dup.get(who(pid, eventId)) ?? null;
  }

  async readVerify(eventId: string, fieldHash: string): Promise<string | null> {
    return this.db.verify.get(eventId)?.get(fieldHash) ?? null;
  }

  async lobbySeq(tokenHash: string): Promise<number | null> {
    const m = /^(\d+):(\d+)$/.exec(this.db.lobbyResults.get(tokenHash) ?? '');
    return m ? Number(m[1]) : null;
  }

  async turnOf(eventId: string, seq: number): Promise<{ serving: number; turnAtMs?: number }> {
    const serving = this.db.serving.get(eventId) ?? 0;
    if (seq > serving) return { serving };
    // ZRANGE serving_log seq +inf BYSCORE LIMIT 0 1: 점수(serving)가 번호 이상인 첫 칸(같은 점수면 멤버 글자 차례)
    const first = [...(this.db.servingLog.get(eventId) ?? new Map<string, number>()).entries()]
      .filter(([, v]) => v >= seq)
      .sort((a, b) => a[1] - b[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))[0];
    return { serving, ...(first ? { turnAtMs: Number(first[0]) * 1000 } : {}) };
  }

  async countSubmit(pid: string, eventId: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const key = who(pid, eventId);
    const now = this.clock.now();
    // 살아 있는 키(되돌려 0이 된 키 포함)는 첫 제출에 정한 마감을 그대로 쓴다(Lua와 같다)
    const x = this.#live(this.db.vsub, key) === undefined ? undefined : this.db.vsub.get(key);
    const next = x ? { v: x.v + 1, until: x.until } : { v: 1, until: now + windowMs };
    this.db.vsub.set(key, next);
    return { count: next.v, ttlMs: next.until - now };
  }

  async uncountSubmit(pid: string, eventId: string): Promise<void> {
    const key = who(pid, eventId);
    const x = this.#live(this.db.vsub, key) === undefined ? undefined : this.db.vsub.get(key);
    if (x && x.v > 0) this.db.vsub.set(key, { v: x.v - 1, until: x.until });
  }

  async settleVerify(eventId: string, fieldHash: string, target: 'PASSED' | 'BLOCKED'): Promise<SettleOutcome> {
    const serving = this.db.serving.get(eventId) ?? 0;
    const v = this.db.verify.get(eventId)?.get(fieldHash);
    if (v === undefined) return { kind: 'GONE', serving };
    const m = /^([A-Z]+):\d+:?(.*)$/.exec(v);
    if (m?.[1] === 'VERIFYING') {
      const nv = `${target}:${this.clock.now()}:${m[2] ?? ''}`;
      this.db.verifyOf(eventId).set(fieldHash, nv);
      return { kind: 'APPLIED', value: nv, serving };
    }
    return { kind: 'CURRENT', value: v, serving };
  }

  async openAppeal(pid: string, eventId: string, d: AppealDraft): Promise<{ created: boolean; appeal: StoredAppeal }> {
    const key = who(pid, eventId);
    let h = this.#live(this.db.appeals, key);
    // 다른 대기 참여의 지난 이의는 새 대기 참여의 이의로 바꾼다
    if (h && h.get('th') !== d.fieldHash) {
      this.db.appeals.delete(key);
      h = undefined;
    }
    let created = false;
    if (!h?.has('id')) {
      h = new Map([
        ['id', d.appealId],
        ['acc', d.accountId],
        ['th', d.fieldHash],
        ['cat', d.reason],
        ['txt', d.text],
        ['ek', d.eventKey],
        ['at', String(d.receivedAtMs)],
        ['exp', String(d.expireAtMs)],
      ]);
      this.db.appeals.set(key, { v: h, until: d.expireAtMs });
      created = true;
    }
    return { created, appeal: appealOf(h)! };
  }

  async readAppeal(pid: string, eventId: string): Promise<StoredAppeal | null> {
    return appealOf(this.#live(this.db.appeals, who(pid, eventId)));
  }

  async indexAppeal(appealId: string, eventId: string, pid: string, expireAtMs: number): Promise<void> {
    this.db.appealIds.set(appealId, { v: `${eventId}:${pid}`, until: expireAtMs });
  }

  async findAppeal(appealId: string): Promise<{ eventId: string; pid: string } | null> {
    const m = /^([A-Za-z0-9_-]{1,64}):([A-Za-z0-9_-]{1,64})$/.exec(this.#live(this.db.appealIds, appealId) ?? '');
    return m ? { eventId: m[1]!, pid: m[2]! } : null;
  }

  async markSent(pid: string, eventId: string, appealId: string): Promise<boolean> {
    const h = this.#live(this.db.appeals, who(pid, eventId));
    if (!h || h.get('id') !== appealId || h.has('sent')) return false;
    h.set('sent', '1');
    return true;
  }

  async claimCase(caseId: string, appealId: string, expireAtMs: number): Promise<string> {
    const v = this.#live(this.db.appealCases, caseId);
    if (v !== undefined) return v;
    this.db.appealCases.set(caseId, { v: appealId, until: expireAtMs });
    return appealId;
  }

  async beginResolve(pid: string, eventId: string, appealId: string, r: { caseId: string; version: number; outcome: string }): Promise<ResolveBegin> {
    const h = this.#live(this.db.appeals, who(pid, eventId));
    if (!h || h.get('id') !== appealId) return { kind: 'NOT_FOUND' };
    const cid = h.get('cid');
    if (cid !== undefined && cid !== r.caseId) return { kind: 'OTHER_CASE' };
    if (r.version <= Number(h.get('cv') ?? '0')) return { kind: 'UNCHANGED' };
    const retry = h.get('pc') === r.caseId && h.get('pv') === String(r.version) && h.get('po') === r.outcome;
    h.set('pc', r.caseId).set('pv', String(r.version)).set('po', r.outcome);
    return { kind: 'PROCEED', retry };
  }

  async commitResolve(pid: string, eventId: string, appealId: string, r: { caseId: string; version: number; outcome: string; result: ResolveResult }): Promise<void> {
    const h = this.#live(this.db.appeals, who(pid, eventId));
    if (!h || h.get('id') !== appealId || r.version <= Number(h.get('cv') ?? '0')) return;
    h.set('cid', r.caseId).set('cv', String(r.version)).set('res', r.result);
    if (r.result === 'APPLIED') h.set('ap', r.outcome);
    h.delete('pc');
    h.delete('pv');
    h.delete('po');
  }
}
