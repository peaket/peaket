// 홀드 다시 읽기·해제·연장과 주문 표시·세션 끝 해제(docs/features/seat-hold.md §5 '해제·연장·다시 읽기와 결제 정지 멈춤의 첫 구현', BUILD_ORDER HOT-070, ADR-0254).
import type { Clock, Deadline, PlatformLogger } from '@peaket/platform';
import { heldSeatIdsOf } from '../adapters/redis-order-holds.js';
import { AdmissionTokenRejected, type AdmissionKeys, verifyAdmissionToken } from '../domain/admission-token.js';
import { type HoldLifecycle, type HoldReleaseReason, type HoldTarget, holdSeatsView } from '../domain/hold-lifecycle.js';
import { KEEP_AFTER_SALE_END_MS, KEY_PART, SEAT_CALL_CAP_MS, SEAT_CALL_MIN_REMAINING_MS, SeatStoreUnavailable, type SeatRef } from '../domain/hold.js';
import type { EventSeatConfig, PurchaseSessionStore, SeatCallOptions, SeatMap, SeatSignals, SessionHoldLists } from '../domain/ports.js';
import type { SessionHoldEntry } from '../domain/purchase-session.js';
import { HoldError, storeUnavailableError } from './hold-error.js';

/** 홀드 응답 본문(openapi Hold) */
export interface HoldBody {
  holdId: string;
  seatIds: string[];
  expiresAt: string;
  extendable: boolean;
  fencingToken: number;
  seats?: { seatId: string; label: string; tierId: string; tierName?: string; price: number }[];
  totalAmount?: number;
}

export interface ManageHoldsDeps {
  lifecycle: HoldLifecycle;
  seatMap: SeatMap;
  sessions: Pick<PurchaseSessionStore, 'read'> & SessionHoldLists;
  keys: AdmissionKeys;
  issuer: string;
  clock: Clock;
  /** 푼 홀드를 주문 만료 판정에 알리는 고리(BUILD_ORDER PRF-172, onHoldsExpired와 같다). 던져도 해제는 그대로다 */
  onReleased?: (e: { readonly eventId: string; readonly holdIds: readonly string[] }) => void;
  signals?: Pick<SeatSignals, 'holdReleased' | 'holdExtended'>;
  logger?: Pick<PlatformLogger, 'warn'>;
}

export interface HoldActionCommand {
  accountId: string;
  purchaseSessionId: string;
  holdId: string;
  deadline?: Deadline;
}

export class ManageHolds {
  constructor(private readonly d: ManageHoldsDeps) {}

  #call(deadline: Deadline | undefined): SeatCallOptions | undefined {
    if (!deadline) return undefined;
    if (deadline.remainingMs() < SEAT_CALL_MIN_REMAINING_MS) throw new HoldError('DEADLINE_EXCEEDED', '남은 시간이 모자라 좌석 Redis를 부르지 않았다');
    return { deadlineMs: Math.max(1, Math.floor(deadline.budgetFor(SEAT_CALL_CAP_MS))) };
  }

  /** 좌석 Redis 호출 하나: 일시 장애는 503 오류로 바꾼다 */
  async #guarded<T>(p: Promise<T>): Promise<T> {
    try {
      return await p;
    } catch (err) {
      if (err instanceof SeatStoreUnavailable) throw storeUnavailableError(err);
      throw err;
    }
  }

  /** 구매 세션의 홀드 목록에서 찾아 좌석맵 판으로 바꾼다(남의 것·없는 것은 같은 404) */
  async #target(c: HoldActionCommand): Promise<{ target: HoldTarget; config: EventSeatConfig; seatIds: string[] }> {
    if (!KEY_PART.test(c.accountId) || !KEY_PART.test(c.holdId)) throw new HoldError('HOLD_NOT_FOUND', '모양이 키 조각이 아니다');
    const session = await this.#guarded(this.d.sessions.read(c.purchaseSessionId));
    if (!session || session.accountId !== c.accountId) throw new HoldError('SESSION_NOT_FOUND', '구매 세션이 없거나 이 계정의 것이 아니다');
    const listed = await this.#guarded(this.d.sessions.heldSeats(c.purchaseSessionId, c.holdId, this.#call(c.deadline)));
    if (listed === null) throw new HoldError('HOLD_NOT_FOUND', '구매 세션의 홀드 목록에 없다');
    const seatIds = heldSeatIdsOf(listed);
    const config = await this.d.seatMap.config(session.eventId);
    if (!config) throw new HoldError('NOT_READY', '그 회차의 좌석맵 판이 없다');
    const refs = await this.d.seatMap.resolve(session.eventId, seatIds);
    if (refs.some((r) => r === undefined)) throw new HoldError('HOLD_NOT_FOUND', '좌석맵 판에 없는 좌석이다');
    return { target: { eventId: session.eventId, holdId: c.holdId, accountId: c.accountId, purchaseSessionId: c.purchaseSessionId, seats: refs as SeatRef[] }, config, seatIds };
  }

  #body(t: HoldTarget, seatIds: string[], config: EventSeatConfig, expiresAtMs: number, extendable: boolean, fencingToken: number): HoldBody {
    const view = holdSeatsView(t.seats, config);
    return { holdId: t.holdId, seatIds, expiresAt: new Date(expiresAtMs).toISOString(), extendable, fencingToken, ...(view ?? {}) };
  }

  /**
   * GET /v1/holds/{holdId}. 입장 토큰으로 구매 세션을 찾는다(서명 없음, 일련번호·무활동 시간을 바꾸지 않는다).
   * @throws HoldError ADMISSION_INVALID·SESSION_NOT_FOUND·HOLD_NOT_FOUND·NOT_READY·STORE_UNAVAILABLE·DEADLINE_EXCEEDED
   */
  async read(c: { token: unknown; accountId: string; holdId: string; deadline?: Deadline }): Promise<HoldBody> {
    let jti: string;
    try {
      const claims = verifyAdmissionToken(c.token, { keys: this.d.keys, issuer: this.d.issuer, nowMs: this.d.clock.now() });
      if (claims.accountId !== c.accountId) throw new HoldError('ADMISSION_INVALID', '입장 토큰의 계정이 요청과 다르다');
      jti = claims.jti;
    } catch (err) {
      if (err instanceof AdmissionTokenRejected) throw new HoldError('ADMISSION_INVALID', '입장 토큰이 맞지 않다');
      throw err;
    }
    const { target, config, seatIds } = await this.#target({ accountId: c.accountId, purchaseSessionId: jti, holdId: c.holdId, ...(c.deadline ? { deadline: c.deadline } : {}) });
    const r = await this.#guarded(this.d.lifecycle.read(target, this.#call(c.deadline)));
    if (r.kind === 'NOT_READY') throw new HoldError('NOT_READY', '세대 키가 없다');
    if (r.kind === 'NOT_FOUND') throw new HoldError('HOLD_NOT_FOUND', '홀드가 끝났거나 이 세션의 것이 아니다');
    return this.#body(target, seatIds, config, r.expiresAtMs, !r.extended, r.fencingToken);
  }

  /** DELETE /v1/holds/{holdId}(서명). 끝나면 돌아오고, 거절은 HoldError다 */
  async release(c: HoldActionCommand): Promise<void> {
    const { target, config } = await this.#target(c);
    const keepUntil = config.saleEndsAtMs + KEEP_AFTER_SALE_END_MS;
    const r = await this.#guarded(this.d.lifecycle.release(target, keepUntil, this.#call(c.deadline)));
    switch (r.kind) {
      case 'NOT_READY':
        throw new HoldError('NOT_READY', '세대 키가 없다');
      case 'NOT_FOUND':
        throw new HoldError('HOLD_NOT_FOUND', '풀 좌석이 없다');
      case 'PINNED':
        throw new HoldError('HOLD_IN_PAYMENT', '결제 접수 뒤 묶인 홀드다');
      case 'OK':
        this.d.signals?.holdReleased?.('user', r.released);
        this.#afterReleased(target.eventId, c.purchaseSessionId, [c.holdId]);
    }
  }

  /** POST /v1/holds/{holdId}/extension(서명) */
  async extend(c: HoldActionCommand): Promise<HoldBody> {
    const { target, config, seatIds } = await this.#target(c);
    const r = await this.#guarded(this.d.lifecycle.extend(target, this.#call(c.deadline)));
    switch (r.kind) {
      case 'NOT_READY':
        throw new HoldError('NOT_READY', '세대 키가 없다');
      case 'NOT_FOUND':
        throw new HoldError('HOLD_NOT_FOUND', '홀드가 끝났거나 이 세션의 것이 아니다');
      case 'PINNED':
        throw new HoldError('HOLD_IN_PAYMENT', '결제 접수 뒤 묶인 홀드다');
      case 'ALREADY':
        throw new HoldError('HOLD_ALREADY_EXTENDED', '이미 연장했다');
      case 'OK':
        this.d.signals?.holdExtended?.();
        return this.#body(target, seatIds, config, r.expiresAtMs, false, r.fencingToken);
    }
  }

  #afterReleased(eventId: string, sessionId: string, holdIds: readonly string[]): void {
    for (const holdId of holdIds) void this.d.sessions.forgetHold(sessionId, holdId).catch(() => undefined);
    try {
      this.d.onReleased?.({ eventId, holdIds });
    } catch (err) {
      this.d.logger?.warn({ errorName: err instanceof Error ? err.name : typeof err }, '홀드 해제 고리 실패(안전망이 받친다)');
    }
  }

  /** 끝난 세션(LEFT·IDLE·MAX_STAY)이나 예매 제한 세션의 홀드를 푼다. 던지지 않는다(실패한 홀드는 만료로 풀린다) */
  async releaseEntries(e: { eventId: string; accountId: string; sessionId: string; holds: readonly SessionHoldEntry[]; reason: HoldReleaseReason }): Promise<void> {
    const released: string[] = [];
    for (const h of e.holds) {
      try {
        const config = await this.d.seatMap.config(e.eventId);
        if (!config) continue;
        const refs = await this.d.seatMap.resolve(e.eventId, h.seatIds);
        if (refs.some((r) => r === undefined)) continue;
        const t: HoldTarget = { eventId: e.eventId, holdId: h.holdId, accountId: e.accountId, purchaseSessionId: e.sessionId, seats: refs as SeatRef[] };
        const r = await this.d.lifecycle.release(t, config.saleEndsAtMs + KEEP_AFTER_SALE_END_MS);
        if (r.kind === 'OK') {
          released.push(h.holdId);
          this.d.signals?.holdReleased?.(e.reason, r.released);
        }
      } catch (err) {
        this.d.logger?.warn({ eventId: e.eventId, errorName: err instanceof Error ? err.name : typeof err }, '세션 홀드 해제 실패(만료로 풀린다)');
      }
    }
    if (released.length > 0) this.#afterReleased(e.eventId, e.sessionId, released);
  }

  /** 주문 생성 403 booking-restricted의 같은 처리: 그 세션의 홀드를 모두 푼다(POL, payment §2 '예매 제한 확인'). 던지지 않는다 */
  async releaseSession(e: { eventId: string; accountId: string; sessionId: string }): Promise<void> {
    try {
      const holds = await this.d.sessions.sessionHolds(e.sessionId);
      await this.releaseEntries({ ...e, holds, reason: 'restricted' });
    } catch (err) {
      this.d.logger?.warn({ eventId: e.eventId, errorName: err instanceof Error ? err.name : typeof err }, '예매 제한 홀드 해제 실패(만료로 풀린다)');
    }
  }

  /** 주문 커밋 뒤 표시. 표시가 실패해도 주문은 그대로다(그 홀드가 멈추지 않을 뿐이다). 실패면 false */
  async markOrdered(e: { eventId: string; accountId: string; sessionId: string; holdId: string; seatIds: readonly string[]; deadline?: Deadline }): Promise<boolean> {
    try {
      const session = await this.d.sessions.read(e.sessionId);
      const config = await this.d.seatMap.config(e.eventId);
      if (!session || !config) return false;
      const refs = await this.d.seatMap.resolve(e.eventId, e.seatIds);
      if (refs.some((r) => r === undefined)) return false;
      const t: HoldTarget = { eventId: e.eventId, holdId: e.holdId, accountId: e.accountId, purchaseSessionId: e.sessionId, seats: refs as SeatRef[] };
      return (await this.d.lifecycle.markOrdered(t, session.maxStayUntilMs, config.saleEndsAtMs + KEEP_AFTER_SALE_END_MS, this.#call(e.deadline))).kind === 'OK';
    } catch (err) {
      this.d.logger?.warn({ eventId: e.eventId, errorName: err instanceof Error ? err.name : typeof err }, '주문 표시 실패');
      return false;
    }
  }
}
