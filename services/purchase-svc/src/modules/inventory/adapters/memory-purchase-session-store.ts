// 구매 세션 저장소와 시작 사건 기록의 메모리 구현(시험·메모리 조립용). Redis 구현(redis-purchase-sessions.ts, Lua 계약은 purchase-session-lua.ts)과 같은 사례에서 같은 결과를 낸다
// (test/purchase-session-cases.ts). 시각은 주입 Clock이다.
import type { Clock } from '@peaket/platform';
import { assertHoldRecord, assertJti, assertOpenInput, assertSeq, assertStartedEntry, type OpenSessionInput, type OpenSessionResult, SESSION_IDLE_MS, SESSION_KEY_GRACE_MS, SESSION_STARTED_GRACE_MS, type SessionStartedEntry, type StoredSession } from '../domain/purchase-session.js';
import type { PurchaseSessionStore, SeatCallOptions, SessionStartedLog } from '../domain/ports.js';

interface Marker {
  startedAtMs: number;
  /** 키가 사라지는 시각(Redis PXAT와 같다: 지금 ≥ 이 시각이면 없다) */
  untilMs: number;
}

/** 시작 사건 기록 표시(sev). 세션 상태와 같이 사라진다 */
type StartedMark = boolean;

/** PurchaseSessionStore의 메모리 구현 */
export class MemoryPurchaseSessionStore implements PurchaseSessionStore {
  readonly #markers = new Map<string, Marker>();
  readonly #sessions = new Map<string, StoredSession>();
  readonly #recorded = new Map<string, StartedMark>();
  /** 세션 상태 키가 사라지는 시각 */
  readonly #sessionUntil = new Map<string, number>();
  /** 구매 세션의 홀드 기록: jti → (holdId → 좌석 ID들). 세션 상태와 같이 사라진다 */
  readonly #holds = new Map<string, Map<string, string[]>>();
  /** 첫 홀드 표시 fh가 쓰인 세션 */
  readonly #firstHeld = new Set<string>();

  constructor(private readonly clock: Clock) {}

  async open(i: OpenSessionInput): Promise<OpenSessionResult> {
    assertOpenInput(i);
    const now = this.clock.now();
    this.#expire(i.jti, now);
    if (now >= i.expiresAtMs) return { kind: 'TOKEN_EXPIRED' };
    const marker = this.#markers.get(i.jti);
    if (marker) {
      const s = this.#sessions.get(i.jti);
      if (!s) return { kind: 'ENDED' };
      if (s.accountId === i.accountId && s.loginSessionId === i.loginSessionId && s.eventId === i.eventId && (i.clientKey === undefined || s.clientKey === i.clientKey)) {
        // 다시 받은 토큰의 더 늦은 exp와 관계없이 세션은 처음 최대 체류에 끝난다
        if (now >= s.maxStayUntilMs) return { kind: 'TOKEN_EXPIRED' };
        // 다시 받은 토큰(더 늦은 exp)이면 표지 수명만 늘린다(줄이지 않는다)
        if (i.expiresAtMs > s.maxStayUntilMs) marker.untilMs = Math.max(marker.untilMs, i.reissueUntilMs + SESSION_KEY_GRACE_MS);
        return { kind: 'REPLAY', startedAtMs: s.startedAtMs, maxStayUntilMs: s.maxStayUntilMs, needsStarted: this.#recorded.get(i.jti) !== true && now - s.startedAtMs >= SESSION_STARTED_GRACE_MS };
      }
      return { kind: 'MISMATCH' };
    }
    if (now > i.firstUseDeadlineMs) return { kind: 'FIRST_USE_EXPIRED' };
    if (i.clientKey === undefined) return { kind: 'KEY_REQUIRED' };
    const clientKey = i.clientKey;
    this.#markers.set(i.jti, { startedAtMs: now, untilMs: Math.max(i.reissueUntilMs, i.expiresAtMs) + SESSION_KEY_GRACE_MS });
    this.#sessionUntil.set(i.jti, i.expiresAtMs + SESSION_KEY_GRACE_MS);
    this.#sessions.set(i.jti, {
      sessionId: i.jti,
      accountId: i.accountId,
      loginSessionId: i.loginSessionId,
      eventId: i.eventId,
      journeyId: i.journeyId,
      clientKey,
      lastSeq: 0,
      startedAtMs: now,
      idleUntilMs: now + SESSION_IDLE_MS,
      maxStayUntilMs: i.expiresAtMs,
      ...(i.priorityGrantId !== undefined ? { priorityGrantId: i.priorityGrantId } : {}),
    });
    return { kind: 'CREATED', startedAtMs: now };
  }

  async read(jti: string): Promise<StoredSession | undefined> {
    assertJti(jti);
    this.#expire(jti, this.clock.now());
    const s = this.#sessions.get(jti);
    return s ? { ...s } : undefined;
  }

  async advance(jti: string, seq: number): Promise<boolean> {
    assertJti(jti);
    assertSeq(seq);
    const now = this.clock.now();
    this.#expire(jti, now);
    const s = this.#sessions.get(jti);
    if (!s) return false;
    if (now >= s.maxStayUntilMs || !(seq > s.lastSeq)) return false;
    s.lastSeq = seq;
    s.idleUntilMs = now + SESSION_IDLE_MS;
    return true;
  }

  async markStarted(jti: string): Promise<boolean> {
    assertJti(jti);
    this.#expire(jti, this.clock.now());
    if (!this.#sessions.has(jti)) return false;
    this.#recorded.set(jti, true);
    return true;
  }

  /** 지금 시각에 사라졌어야 할 키를 지운다(Redis 키 수명과 같은 순간: 지금 ≥ 사라지는 시각) */
  #expire(jti: string, now: number): void {
    const su = this.#sessionUntil.get(jti);
    if (su !== undefined && now >= su) {
      this.#sessions.delete(jti);
      this.#recorded.delete(jti);
      this.#sessionUntil.delete(jti);
      this.#holds.delete(jti);
      this.#firstHeld.delete(jti);
    }
    const m = this.#markers.get(jti);
    if (m && now >= m.untilMs) this.#markers.delete(jti);
  }

  async recordHold(jti: string, holdId: string, seatIds: readonly string[], _o?: SeatCallOptions): Promise<boolean | null> {
    assertHoldRecord(jti, holdId, seatIds);
    this.#expire(jti, this.clock.now());
    if (!this.#sessions.has(jti)) return null;
    let m = this.#holds.get(jti);
    if (!m) {
      m = new Map();
      this.#holds.set(jti, m);
    }
    m.set(holdId, [...seatIds]);
    if (this.#firstHeld.has(jti)) return false;
    this.#firstHeld.add(jti);
    return true;
  }

  /** 시험용: 구매 세션의 홀드 기록(holdId → 좌석 ID들, 기록한 차례 그대로). 세션이 없거나 기록이 없으면 undefined */
  holdsOf(jti: string): ReadonlyMap<string, readonly string[]> | undefined {
    this.#expire(jti, this.clock.now());
    const m = this.#holds.get(jti);
    return this.#sessions.has(jti) && m ? new Map([...m].map(([k, v]) => [k, [...v]])) : undefined;
  }

  /** 시험용: 세션 상태만 지운다(세션이 끝난 것. 재사용 차단 표지는 남아 같은 입장 토큰으로 다시 열 수 없다). 없으면 아무 일도 없다 */
  endSession(jti: string): void {
    this.#sessions.delete(jti);
    this.#recorded.delete(jti);
    this.#holds.delete(jti);
    this.#firstHeld.delete(jti);
  }
}

/** SessionStartedLog의 메모리 구현: 더한 항목을 순서대로 모은다. failWith를 두면 그 오류로 실패한다(시험) */
export class RecordingSessionStartedLog implements SessionStartedLog {
  readonly entries: SessionStartedEntry[] = [];
  failWith: unknown;

  async appendStarted(e: SessionStartedEntry): Promise<void> {
    assertStartedEntry(e);
    if (this.failWith !== undefined) throw this.failWith;
    this.entries.push({ ...e });
  }
}
