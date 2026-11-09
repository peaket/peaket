// 구매 세션 끝내기(BUILD_ORDER PRF-138, docs/features/seat-hold.md §2 '구매 세션 종료와 정리'). 나가기(LEFT, 받는 층)와 결제 확정(COMPLETED, 결제 단계)이 부른다.
// 차례: 세션 상태 지우기(store.end) → SESSION_ENDED 더하기(SessionEndedLog, 실패해도 끝난 것은 그대로, 로그 한 줄) → 지표 → 주문 만료 고리(onEnded).
import type { Clock } from '@peaket/platform';
import type { PurchaseSessionStore, SeatSignals, SessionEndedLog } from '../domain/ports.js';
import { assertJti } from '../domain/purchase-session.js';
import type { SessionEndReason, SessionHoldEntry } from '../domain/purchase-session.js';
import type { HoldReleaseReason } from '../domain/hold-lifecycle.js';
import type { ManageHolds } from './manage-holds.js';

export interface EndSessionLogger {
  warn(obj: object, msg: string): void;
}

export interface EndPurchaseSessionDeps {
  store: Pick<PurchaseSessionStore, 'end' | 'read'>;
  ended: SessionEndedLog;
  clock: Clock;
  signals?: Pick<SeatSignals, 'sessionEnded'>;
  logger?: EndSessionLogger;
  /**
   * 세션이 끝난 뒤 부를 고리(BUILD_ORDER PRF-172 설계 2, booking OrderExpiry.onSessionEnded를 잇는다, docs/features/seat-hold.md §2). 나가기·결제 확정(execute)과 정리 반복(IDLE·MAX_STAY)이 모두 지나는 recordEnded 끝에서 부른다.
   * 던져도 세션 끝내기 결과는 그대로다(경고 한 줄). 없으면 부르지 않는다. 구매 세션 ID만 싣는다(booking은 구매 세션 ID로 주문을 찾는다)
   */
  onEnded?: (e: { readonly purchaseSessionId: string }) => void;
  /** 끝난 세션의 홀드를 푼다(LEFT·IDLE·MAX_STAY, BUILD_ORDER HOT-070). 던지지 않는 구현을 넘긴다. 없으면 홀드는 만료로 풀린다 */
  releaseHolds?: Pick<ManageHolds, 'releaseEntries'>;
}

/** 끝내기 거절: 세션이 묶인 회차가 기대한 회차와 다르다(받는 층이 403으로 바꾼다) */
export class EndSessionError extends Error {
  constructor(readonly code: 'EVENT_MISMATCH') {
    super(`구매 세션 끝내기 거절: ${code}`);
    this.name = 'EndSessionError';
  }
}

const RELEASE_REASON: Partial<Record<SessionEndReason, HoldReleaseReason>> = { LEFT: 'left', IDLE: 'idle', MAX_STAY: 'max_stay' };

export class EndPurchaseSession {
  constructor(private readonly deps: EndPurchaseSessionDeps) {}

  /**
   * 구매 세션을 끝낸다. 끝냈으면 true, 이미 없었으면 false(아무 사건도 더하지 않는다).
   * expectEventId가 있으면 세션을 읽어(store.read) 회차가 다르면 EndSessionError('EVENT_MISMATCH')로 거절하고 세션은 그대로 둔다. 세션이 없으면 false다.
   * 사건 더하기가 실패하면(좌석 Redis 일시 장애) 던지지 않고 warn 한 줄(오류 이름만)을 남긴다: 세션 상태는 이미 지워졌고 입장 자리는 최대 체류 시각에 정리된다.
   * 지표 sessionEnded(reason)은 끝낸 때마다 한 번이다.
   * @throws RangeError sessionId가 키 조각 모양이 아님
   * @throws SeatStoreUnavailable store.end(또는 read)의 좌석 Redis 일시 장애·메모리 부족
   */
  async execute(c: { sessionId: string; reason: 'LEFT' | 'COMPLETED'; expectEventId?: string }): Promise<boolean> {
    assertJti(c.sessionId);
    const { store, clock } = this.deps;
    if (c.expectEventId !== undefined) {
      const s = await store.read(c.sessionId);
      if (!s) return false;
      if (s.eventId !== c.expectEventId) throw new EndSessionError('EVENT_MISMATCH');
    }
    const ended = await store.end(c.sessionId);
    if (!ended) return false;
    await this.recordEnded({ eventId: ended.eventId, sessionId: c.sessionId, reason: c.reason, endedAtMs: clock.now(), accountId: ended.accountId, holds: ended.holds });
    return true;
  }

  /** 정리 반복이 끝낸 세션(IDLE·MAX_STAY)의 사건을 더하고 지표를 올린다. 사건 더하기 실패는 던지지 않는다 */
  async recordEnded(e: { eventId: string; sessionId: string; reason: SessionEndReason; endedAtMs: number; accountId?: string; holds?: readonly SessionHoldEntry[] }): Promise<void> {
    // 끝난 세션의 홀드를 먼저 푼다(COMPLETED는 판매로 간 좌석이라 풀지 않는다). 구현은 던지지 않고, 실패한 홀드는 만료로 풀린다
    const release = RELEASE_REASON[e.reason];
    if (release && e.holds && e.holds.length > 0 && e.accountId) await this.deps.releaseHolds?.releaseEntries({ eventId: e.eventId, accountId: e.accountId, sessionId: e.sessionId, holds: e.holds, reason: release });
    try {
      await this.deps.ended.appendEnded({ eventId: e.eventId, purchaseSessionId: e.sessionId, admissionJti: e.sessionId, reason: e.reason, endedAtMs: e.endedAtMs });
    } catch (err) {
      // 세션 상태는 이미 지워졌다. 사건이 빠지면 입장 자리는 최대 체류 시각에 정리된다(queue-admission §6)
      this.deps.logger?.warn({ errorName: err instanceof Error ? err.name : typeof err }, '구매 세션 종료 사건 더하기 실패');
    }
    this.deps.signals?.sessionEnded?.(e.reason);
    try {
      this.deps.onEnded?.({ purchaseSessionId: e.sessionId });
    } catch (err) {
      // 세션은 이미 끝났다. 주문 만료는 안전망이 받친다
      this.deps.logger?.warn({ errorName: err instanceof Error ? err.name : typeof err }, '구매 세션 종료 고리 실패');
    }
  }
}
