// 좌석 홀드 쓰임새(docs/features/seat-hold.md §3~§5, openapi POST /v1/events/{eventId}/holds, BUILD_ORDER PRF-130 ①).
// 받는 층(HoldsController)이 신원·멱등 키 형식·구매 요청 서명·본문 모양을 확인한 뒤 부른다.
import { Inject, Injectable, Optional } from '@nestjs/common';
import { CLOCK, type Clock, type Deadline, HOT_PATH_METRICS, type HotPathMetrics, type HotPathOutcome, PLATFORM_LOGGER, type PlatformLogger, timeHotPath, timeHotPathSync, uuidv7 } from '@peaket/platform';
import {
  type HeldHold,
  type HoldResult,
  holdFingerprint,
  KEEP_AFTER_SALE_END_MS,
  KEY_PART,
  type ReplayResult,
  SEAT_CALL_CAP_MS,
  SEAT_CALL_MIN_REMAINING_MS,
  SESSION_RECORD_CAP_MS,
  type SeatRef,
  SeatStoreUnavailable,
} from '../domain/hold.js';
import { holdSeatsView } from '../domain/hold-lifecycle.js';
import { seatLuaErrorOf } from '../domain/lua-errors.js';
import {
  HOLD_ATTEMPTS,
  type HoldAttemptResult,
  type HoldAttempts,
  noSeatSignals,
  PURCHASE_SESSIONS,
  type PurchaseSessions,
  SEAT_MAP,
  SEAT_SIGNALS,
  SESSION_HOLDS,
  type SessionHolds,
  SEAT_STORE,
  type SeatCallOptions,
  type SeatMap,
  type SeatSignals,
  type SeatStore,
} from '../domain/ports.js';
import { HoldError, type HoldErrorCode, type HoldErrorDetails, storeUnavailableError } from './hold-error.js';
import { SEAT_BEHAVIOR, type SeatBehaviorReporter } from './seat-behavior.js';

/** 경로 스키마가 확인한 본문에서 쓰임새가 보는 칸(clientEphemeralPublicKey는 PRF-130 ①에서 보지 않고 버린다) */
export interface HoldBody {
  /** 직접 선택 좌석 ID(1~10개, 겹침 없음, 좌석 ID 모양은 경로 스키마가 확인했다) */
  seatIds?: readonly string[];
  /** 자동 배정 희망 조건(모양만 확인했다). PRF-130 ①은 받지 않는다 */
  auto?: object;
  /** 좌석 화면 행동 요약(모양은 경로 스키마가 확인했다. 홀드 판정에 쓰지 않는다, BUILD_ORDER BOT-055) */
  behavior?: Record<string, unknown>;
}

export interface HoldCommand {
  /** 주소의 회차 ID(경로 스키마가 KEY_PART 모양을 확인했다) */
  eventId: string;
  /** 플랫폼 인증 가드가 정한 계정(Principal.accountId). 계정은 이것으로만 정한다 */
  accountId: string;
  /** 플랫폼 구매 요청 인증 훅이 확인한 구매 세션 참조(@CurrentPurchaseSession()) */
  purchaseSessionId: string;
  /** 사람 식별값(Principal.pid). 없으면 행동 요약을 내지 않는다 */
  pid?: string;
  /** 플랫폼 멱등 모듈이 형식을 확인한 키(@IdempotencyRequest().key, 소문자 UUID v4). 플랫폼의 requestHash는 쓰지 않는다 */
  idempotencyKey: string;
  body: HoldBody;
  /**
   * 이 요청의 남은 시간(platform currentDeadline(), guidelines §5, BUILD_ORDER PRF-135). 받는 층이 넘긴다.
   * 없으면 마감을 보지 않는다(504를 내지 않고 저장소 호출에 deadlineMs를 주지 않아 플랫폼 기본 100ms다)
   */
  deadline?: Deadline;
}

/** 201 응답 본문(openapi Hold) */
export interface HoldResponse {
  holdId: string;
  /** 잡은 좌석 ID(오름차순) */
  seatIds: string[];
  /** 만료 시각, ISO 8601 UTC('Z', 밀리초 셋째 자리까지) */
  expiresAt: string;
  /** 1회 연장을 아직 쓰지 않았다(새 홀드와 멱등 재생 모두 true) */
  extendable: boolean;
  /** 펜싱 토큰(양의 안전한 정수, 지금 시각으로 16자리. openapi Hold.fencingToken integer) */
  fencingToken: number;
  /** 좌석 표시 값과 정가 합(가격이 없는 등급이 있으면 뺀다, BUILD_ORDER HOT-070) */
  seats?: { seatId: string; label: string; tierId: string; tierName?: string; price: number }[];
  totalAmount?: number;
}

@Injectable()
export class HoldSeats {
  constructor(
    @Inject(SEAT_STORE) private readonly store: SeatStore,
    @Inject(SEAT_MAP) private readonly seatMap: SeatMap,
    @Inject(PURCHASE_SESSIONS) private readonly sessions: PurchaseSessions,
    @Inject(HOLD_ATTEMPTS) private readonly attempts: HoldAttempts,
    @Inject(CLOCK) private readonly clock: Clock,
    /** 좌석 Lua 지표(BUILD_ORDER PRF-135). 주입하지 않으면 버린다(noSeatSignals) */
    @Optional() @Inject(SEAT_SIGNALS) private readonly signals: SeatSignals = noSeatSignals,
    /** 새 홀드를 구매 세션 상태에 기록하고 첫 홀드 표시를 얻는다(BUILD_ORDER PRF-137). 주입하지 않으면 기록하지 않고 firstHeldInSession도 비운다 */
    @Optional() @Inject(SESSION_HOLDS) private readonly holds?: SessionHolds,
    /** 서비스 로거(구매 세션 홀드 기록 실패 경고, 선택) */
    @Optional() @Inject(PLATFORM_LOGGER) private readonly logger?: PlatformLogger,
    /** 좌석 화면 행동 요약(BUILD_ORDER BOT-055). 주입하지 않으면 내지 않는다 */
    @Optional() @Inject(SEAT_BEHAVIOR) private readonly seatBehavior?: SeatBehaviorReporter,
    /** 핫패스 구간 진단(BAT-027). 주입하지 않으면 계측하지 않는다 */
    @Optional() @Inject(HOT_PATH_METRICS) private readonly hotPath?: HotPathMetrics,
  ) {}

  /** 좌석 Redis 일시 장애(SeatStoreUnavailable)로 503을 낼 때: 미룸 지표 seat_hold_deferred_total{reason="store_unavailable"}을 올리고 503 오류를 돌려준다(PRF-143) */
  #deferred(err: SeatStoreUnavailable): HoldError {
    this.signals.holdDeferred?.('store_unavailable');
    return storeUnavailableError(err);
  }

  /** 새 홀드를 구매 세션 상태에 기록하고 이번이 첫 홀드인지 돌려준다. 보조 기록이라 어떤 오류도 홀드를 막지 않는다(세션이 없거나 실패하면 undefined, 실패는 로그 한 줄) */
  async #recordHold(sessionId: string, holdId: string, seatIds: readonly string[], deadline?: Deadline): Promise<boolean | undefined> {
    if (!this.holds) return undefined;
    // 홀드는 이미 확정됐으니 보조 기록이 응답을 붙들지 않게 짧은 상한으로 부르고, 남은 시간이 모자라면 부르지 않는다(PRF-137 리뷰)
    if (deadline && deadline.remainingMs() < SEAT_CALL_MIN_REMAINING_MS) return undefined;
    const deadlineMs = Math.max(1, Math.floor(deadline ? deadline.budgetFor(SESSION_RECORD_CAP_MS) : SESSION_RECORD_CAP_MS));
    try {
      return (await timeHotPath(this.hotPath, 'hold.session_record', () => this.holds!.recordHold(sessionId, holdId, seatIds, { deadlineMs }))) ?? undefined;
    } catch (err) {
      this.logger?.warn({ errorName: err instanceof Error ? err.name : typeof err }, '구매 세션의 홀드 기록 실패');
      return undefined;
    }
  }

  /**
   * 좌석 홀드 요청 하나를 계측하고 #execute로 넘긴다(BAT-027, HOT-462).
   * 전체 시간(hold.total)과 최종 결과(hold.outcomes)만 여기서 남기고, 구간 시간은 #execute 안에서 남긴다.
   */
  async execute(c: HoldCommand): Promise<HoldResponse> {
    const done = this.hotPath?.start('hold.total');
    try {
      const response = await this.#execute(c);
      this.hotPath?.outcome('ok');
      return response;
    } catch (err) {
      this.hotPath?.outcome(holdOutcomeOf(err));
      throw err;
    } finally {
      done?.();
    }
  }

  /**
   * 좌석을 잡고 201 본문을 돌려준다. 아니면 HoldError(application/hold-error.ts의 코드)를 던진다. 차례(앞이 걸리면 뒤는 하지 않는다):
   *
   * 1. 구매 세션: accountId가 KEY_PART 모양이 아니거나(Redis 키에 들어간다), sessions.get(purchaseSessionId)가 없거나, 그 계정이 accountId와 다르면
   *    SESSION_NOT_FOUND(401).
   *    세션의 회차가 eventId와 다르면 EVENT_MISMATCH(403). sessions.get이 SeatStoreUnavailable이면 STORE_UNAVAILABLE(503, 시도 기록 없음).
   * 2. 본문: auto가 있으면 AUTO_NOT_SUPPORTED(400, seatIds가 함께 있어도). seatIds가 없거나 비었으면 SEATS_REQUIRED(400).
   * 3. 회차 설정: seatMap.config(eventId)가 없으면 NOT_READY(503).
   * 4. 판매 종료: clock.now() ≥ saleEndsAtMs면 SALE_ENDED(410).
   * 5. 좌석 확인: seatIds를 seatMap.resolve로 바꾼다. undefined가 하나라도 있거나 같은 좌석 ID가 두 번 있으면 INVALID_SEAT(422).
   *    여기까지 걸리면 store.hold를 부르지 않는다(S-T30: Lua 호출 0, 좌석·보유 수·Stream 변화 0).
   *
   *    재생이 앱 쪽 거절보다 먼저다(추천 적용 2026-11-04, guidelines §4): 3(설정 없음 503)·4(판매 종료 410)·5(좌석맵에 없는 좌석 422)로 거절하려 할 때
   *    먼저 store.replay({ eventId, accountId, idempotencyKey, fingerprint: holdFingerprint(본문 seatIds) })를 한 번 부른다.
   *    같은 지문이면 처음 201을 그대로 돌려준다(seatIds는 정렬한 요청 좌석, 시도 기록 없음). 다른 지문이면 IDEM_REUSED(422, 시도 기록 ERROR).
   *    기록이 없으면(null) 원래 거절이다. replay가 SeatStoreUnavailable이면 STORE_UNAVAILABLE(503, ERROR).
   *    1의 401·403과 2의 400은 멱등 범위 밖이라 replay보다 앞이고, 거절하지 않는 정상 경로는 replay를 부르지 않는다(멱등은 홀드 Lua 안에서 본다).
   * 6. 저장소: 좌석을 좌석 ID 오름차순으로 정렬하고, holdId = uuidv7(clock), fingerprint = holdFingerprint(seatIds), limit = perAccountLimit,
   *    keepUntilMs = saleEndsAtMs + KEEP_AFTER_SALE_END_MS로 store.hold를 한 번 부른다(다시 시도하지 않는다).
   *    SeatStoreUnavailable이면 STORE_UNAVAILABLE(503, cause = 그 오류). 그 밖의 오류는 그대로 던진다.
   * 7. 결과: OK·IDEM_REPLAY → 201 본문(holdId·fencingToken·expiresAt은 저장소가 준 값, seatIds는 정렬한 요청 좌석, extendable true).
   *    NOT_READY → NOT_READY, IDEM_REUSED → IDEM_REUSED, PAUSED → PAUSED, CONFLICT → CONFLICT,
   *    REHOLD_WAIT → REHOLD_WAIT(details.recentlyReleasedSeats = 결과의 seatIds, reholdAvailableAtMs = availableAtMs), QUOTA_EXCEEDED → QUOTA_EXCEEDED.
   *
   * 시도 기록(attempts.record, S-T35·ADR-0171, seat-hold.md §3 '시도 하나의 내용'): 1의 구매 세션 확인을 지난 요청마다 정확히 한 번, 결과를 정한 뒤 남긴다.
   * 남기지 않는 것은 1의 401, 2의 400, 멱등 재생(IDEM_REPLAY, 처음 시도가 이미 남겼다)뿐이다.
   * result는 OK → HELD(heldAtMs = 결과의 heldAtMs), CONFLICT → CONFLICT, REHOLD_WAIT → RECENTLY_RELEASED, QUOTA_EXCEEDED → LIMIT이고,
   * 그 밖의 거절(EVENT_MISMATCH 403, NOT_READY·STORE_UNAVAILABLE 503, SALE_ENDED 410, INVALID_SEAT·IDEM_REUSED 422, PAUSED 423)은 ERROR(heldAtMs 없음)다.
   * 칸: eventId = 주소의 회차, accountId·purchaseSessionId, journeyId = 구매 세션의 것, mode PICK, seatIds = 본문 seatIds를 보낸 차례 그대로(없으면 빈 목록),
   * tierId·sectionId = 본문 첫 좌석을 seatMap.resolve로 찾았으면 그 좌석의 것(5 전에 거절했거나 첫 좌석이 판에 없으면 없음),
   * occurredAtMs = 결과를 정한 때의 clock.now(), latencyMs = execute 시작부터 그때까지의 clock.monotonicMs() 차이.
   *
   * 명세에서 모호했던 셋(추천 적용 2026-11-04):
   * - 회차가 달라 403이면 본문이 auto여도 ERROR 하나를 남긴다(구매 세션 확인을 지났고, 403이 본문 검사 400보다 먼저다).
   * - 저장소가 일시 장애가 아닌 오류(스크립트 오류 같은 버그)를 던지면 ERROR 하나를 남기고 그 오류를 바꾸지 않고 던진다.
   * - HoldAttempt의 firstHeldInSession(BUILD_ORDER PRF-137): 새로 잡은 홀드(OK)마다 holds(SessionHolds)가 있으면 recordHold(구매 세션 ID, holdId, 정렬된 좌석 ID들)를 한 번 부르고
   *   결과(첫 홀드면 true, 아니면 false)를 HELD 시도 기록에 싣는다. 세션이 없어 null이거나, 던지거나(일시 장애든 버그든 로거 warn 한 줄), holds가 없으면 칸을 비운다.
   *   멱등 재생(IDEM_REPLAY)과 거절은 기록하지 않는다. 기록 실패는 홀드를 막지 않는다(보조 기록이라서). Kafka·Avro 보내기는 BAS-030이다.
   *
   * 요청 마감(BUILD_ORDER PRF-135, guidelines §5). c.deadline이 있을 때만 본다:
   * - 좌석 Redis를 부르기 바로 전(5의 store.replay와 6의 store.hold 각각)에 c.deadline.remainingMs() < SEAT_CALL_MIN_REMAINING_MS(5)이면 부르지 않고
   *   DEADLINE_EXCEEDED(504 deadline-exceeded, 시도 기록 ERROR). 그 요청에서 저장소 호출 수는 0이다(그 앞의 replay는 이미 불렀을 수 있다).
   * - 부를 때 둘째 인자로 { deadlineMs: max(1, floor(c.deadline.budgetFor(SEAT_CALL_CAP_MS))) }(= min(남은 시간, 100)을 내림한 정수, 1 이상)를 준다.
   *   c.deadline이 없으면 둘째 인자를 주지 않는다(undefined).
   * - 호출 도중 마감을 넘기면 저장소가 SeatStoreUnavailable을 던지므로 지금처럼 STORE_UNAVAILABLE(503)이다.
   * - 1·2(세션·본문)와 3·4(좌석맵 판·시계)는 좌석 Redis를 부르지 않으므로 마감을 보지 않는다.
   *
   * 메모리 부족(PRF-135): 저장소의 SeatStoreUnavailable은 까닭과 관계없이 STORE_UNAVAILABLE(503 seat-store-unavailable + Retry-After)이고
   * details.storeReason = 그 까닭(storeUnavailableError, cause = 그 오류). store.hold의 reason 'oom'이면 signals.luaError('hold', 'OOM')을 한 번 부른다.
   * reason 'unavailable'은 지표를 올리지 않는다.
   *
   * 좌석 Lua 지표(PRF-135, seat_lua_errors_total): store.hold의 결과가 NOT_READY면 signals.luaError('hold', 'NOT_READY'),
   * store.hold가 일시 장애가 아닌 오류를 던지면 signals.luaError('hold', seatLuaErrorOf(err).code)를 한 번 부르고 그 오류를 그대로 던진다(바꾸지 않는다.
   * 계정 ID가 든 키 이름을 지우는 것은 받는 층이다, HoldsController). 업무 거절(경합·한도·정지·멱등 키 재사용)과 성공은 올리지 않는다.
   * replay의 오류는 Lua 오류가 아니라 세지 않는다.
   *
   * 미룸 지표(BUILD_ORDER PRF-143, seat_hold_deferred_total{reason}): store.hold의 결과가 NOT_READY(세대 키 없음)면 signals.holdDeferred('not_ready'),
   * 구매 세션 읽기·replay·hold가 SeatStoreUnavailable이라 503(STORE_UNAVAILABLE)이면 signals.holdDeferred('store_unavailable')를 한 번 부른다.
   * 좌석맵 판이 없어 내는 3의 503(NOT_READY)은 세지 않는다(좌석 저장소가 아니라 판 문제다).
   */
  async #execute(c: HoldCommand): Promise<HoldResponse> {
    const started = this.clock.monotonicMs();

    // 1 구매 세션(계정 ID는 Redis 키에 들어가므로 모양부터 본다)
    if (!KEY_PART.test(c.accountId)) throw new HoldError('SESSION_NOT_FOUND', '계정 ID 모양이 키 조각이 아니다');
    let session;
    try {
      session = await timeHotPath(this.hotPath, 'hold.session', () => this.sessions.get(c.purchaseSessionId));
    } catch (err) {
      // 구매 세션 저장소(좌석 Redis)의 일시 장애·메모리 부족도 503이다. 아직 시도 기록을 남기기 전이다(PRF-136 리뷰)
      if (err instanceof SeatStoreUnavailable) throw this.#deferred(err);
      throw err;
    }
    if (!session || session.accountId !== c.accountId) throw new HoldError('SESSION_NOT_FOUND', '구매 세션이 없거나 이 계정의 것이 아니다');

    // 여기부터 결과마다 시도 하나를 남긴다(멱등 재생과 2의 400은 빼고)
    const requested = [...(c.body.seatIds ?? [])];
    let first: SeatRef | undefined;
    const record = (result: HoldAttemptResult, heldAtMs?: number, firstHeldInSession?: boolean): void => {
      timeHotPathSync(this.hotPath, 'hold.attempts', () =>
        this.attempts.record({
          eventId: c.eventId,
          accountId: c.accountId,
          purchaseSessionId: c.purchaseSessionId,
          journeyId: session.journeyId,
          mode: 'PICK',
          seatIds: requested,
          ...(first ? { tierId: first.tierId, sectionId: first.sectionId } : {}),
          result,
          ...(heldAtMs !== undefined ? { heldAtMs } : {}),
          ...(firstHeldInSession !== undefined ? { firstHeldInSession } : {}),
          occurredAtMs: this.clock.now(),
          latencyMs: Math.max(0, this.clock.monotonicMs() - started),
        }),
      );
    };
    /** ERROR를 남기고 던질 오류를 돌려준다 */
    const refuse = (code: HoldErrorCode, message: string, details?: HoldErrorDetails): HoldError => {
      record('ERROR');
      return new HoldError(code, message, details);
    };

    if (session.eventId !== c.eventId) throw refuse('EVENT_MISMATCH', '구매 세션의 회차와 주소의 회차가 다르다');

    // 2 본문(기록 없음)
    if (c.body.auto !== undefined) throw new HoldError('AUTO_NOT_SUPPORTED', '자동 배정은 아직 받지 않는다(wbs 2.5.4)');
    if (requested.length === 0) throw new HoldError('SEATS_REQUIRED', '본문에 seatIds가 없다');

    // 좌석 화면 행동 요약: 홀드 결과와 상관없이 세션마다 처음 것 하나만 낸다(기다리지 않는다, 판정에 쓰지 않는다)
    if (c.body.behavior !== undefined && c.pid !== undefined) this.seatBehavior?.report({ purchaseSessionId: c.purchaseSessionId, pid: c.pid, eventId: c.eventId, journeyId: session.journeyId, behavior: c.body.behavior });

    /** 좌석 Redis를 부르기 바로 전의 마감 확인: 모자라면 504(시도 기록 ERROR), 있으면 그 호출의 선택값(마감이 없으면 undefined) */
    const callOptions = (): SeatCallOptions | undefined => {
      const d = c.deadline;
      if (!d) return undefined;
      if (d.remainingMs() < SEAT_CALL_MIN_REMAINING_MS) throw refuse('DEADLINE_EXCEEDED', '남은 시간이 모자라 좌석 Redis를 부르지 않았다');
      return { deadlineMs: Math.max(1, Math.floor(d.budgetFor(SEAT_CALL_CAP_MS))) };
    };

    /**
     * 앱 쪽 거절(3·4·5) 직전의 멱등 재생 읽기: 같은 지문이면 처음 201을 그대로 돌려주고(기록 없음), 다른 지문이면 422 IDEM_REUSED(ERROR),
     * 기록이 없으면 undefined를 돌려줘 부른 쪽이 원래 거절을 던진다
     */
    const replayOrRefuse = async (): Promise<HoldResponse | undefined> => {
      const opt = callOptions();
      let r: ReplayResult;
      try {
        r = await timeHotPath(this.hotPath, 'hold.replay', () =>
          this.store.replay({ eventId: c.eventId, accountId: c.accountId, idempotencyKey: c.idempotencyKey, fingerprint: holdFingerprint(requested) }, opt),
        );
      } catch (err) {
        record('ERROR');
        if (err instanceof SeatStoreUnavailable) throw this.#deferred(err);
        throw err;
      }
      if (r === null) return undefined;
      if (r.kind === 'IDEM_REUSED') throw refuse('IDEM_REUSED', '같은 멱등 키에 다른 좌석 선택이다');
      return responseOf(r, sortedIds(requested));
    };

    // 3 회차 설정, 4 판매 종료(주입 시계)
    const config = await timeHotPath(this.hotPath, 'hold.seat_config', () => this.seatMap.config(c.eventId));
    if (!config) {
      const replayed = await replayOrRefuse();
      if (replayed) return replayed;
      throw refuse('NOT_READY', '그 회차의 좌석맵 판이 없다');
    }
    if (this.clock.now() >= config.saleEndsAtMs) {
      const replayed = await replayOrRefuse();
      if (replayed) return replayed;
      throw refuse('SALE_ENDED', '판매 종료 뒤의 새 홀드다');
    }

    // 5 좌석 확인(Lua 전에. 없는 좌석·다른 회차·판매 제외석·겹침)
    const refs = await timeHotPath(this.hotPath, 'hold.seat_resolve', () => this.seatMap.resolve(c.eventId, requested));
    first = refs[0];
    const seats = refs.filter((r): r is SeatRef => r !== undefined);
    if (seats.length !== requested.length || new Set(requested).size !== requested.length) {
      const replayed = await replayOrRefuse();
      if (replayed) return replayed;
      throw refuse('INVALID_SEAT', '고를 수 없는 좌석이 있다');
    }

    // 6 저장소(한 번만)
    seats.sort((a, b) => byCodeUnit(a.seatId, b.seatId));
    const seatIds = seats.map((s) => s.seatId);
    const opt = callOptions();
    let r: HoldResult;
    try {
      r = await timeHotPath(this.hotPath, 'hold.lua', () =>
        this.store.hold(
          {
            eventId: c.eventId,
            accountId: c.accountId,
            purchaseSessionId: c.purchaseSessionId,
            holdId: uuidv7(this.clock),
            idempotencyKey: c.idempotencyKey,
            fingerprint: holdFingerprint(seatIds),
            seats,
            limit: config.perAccountLimit,
            keepUntilMs: config.saleEndsAtMs + KEEP_AFTER_SALE_END_MS,
          },
          opt,
        ),
      );
    } catch (err) {
      record('ERROR');
      if (err instanceof SeatStoreUnavailable) {
        if (err.reason === 'oom') this.signals.luaError('hold', 'OOM');
        throw this.#deferred(err);
      }
      this.signals.luaError('hold', seatLuaErrorOf(err)?.code ?? 'OTHER');
      throw err;
    }

    // 7 결과
    switch (r.kind) {
      case 'OK':
      case 'IDEM_REPLAY':
        if (r.kind === 'OK') record('HELD', r.heldAtMs, await this.#recordHold(c.purchaseSessionId, r.holdId, seatIds, c.deadline));
        return responseOf(r, seatIds, holdSeatsView(seats, config));
      case 'NOT_READY':
        this.signals.luaError('hold', 'NOT_READY');
        // 세대 키가 없어 503으로 미룬다(다시 만들기 RB-06 전·도중, PRF-143). 좌석맵 판이 없어 내는 3의 503은 세지 않는다
        this.signals.holdDeferred?.('not_ready');
        throw refuse('NOT_READY', '세대 키가 없다(좌석 저장소가 준비되지 않음)');
      case 'IDEM_REUSED':
        throw refuse('IDEM_REUSED', '같은 멱등 키에 다른 좌석 선택이다');
      case 'PAUSED':
        throw refuse('PAUSED', '판매 정지 중이다');
      case 'CONFLICT':
        record('CONFLICT');
        throw new HoldError('CONFLICT', `다른 사람이 잡은 좌석이 있다: ${r.seatId}`);
      case 'REHOLD_WAIT':
        record('RECENTLY_RELEASED');
        throw new HoldError('REHOLD_WAIT', '방금 놓은 좌석이 있다', { recentlyReleasedSeats: [...r.seatIds], reholdAvailableAtMs: r.availableAtMs });
      case 'QUOTA_EXCEEDED':
        record('LIMIT');
        throw new HoldError('QUOTA_EXCEEDED', '1인 한도를 넘는다');
    }
  }
}

/** 좌석 ID 문자 코드 순(Array.prototype.sort 기본과 같다) */
const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const sortedIds = (ids: readonly string[]): string[] => [...ids].sort(byCodeUnit);

/** 201 본문(처음 응답이든 재생이든 저장소가 준 holdId·토큰·만료 시각) */
function responseOf(h: HeldHold, seatIds: string[], view?: ReturnType<typeof holdSeatsView>): HoldResponse {
  return { holdId: h.holdId, seatIds, expiresAt: new Date(h.expiresAtMs).toISOString(), extendable: true, fencingToken: h.fencingToken, ...(view ?? {}) };
}

/** HoldError를 핫패스 결과 이름으로 바꾼다(고정 목록, 카디널리티 낮춤). 모르는 오류는 error다 */
function holdOutcomeOf(err: unknown): HotPathOutcome {
  if (!(err instanceof HoldError)) return 'error';
  switch (err.code) {
    case 'CONFLICT':
      return 'conflict';
    case 'QUOTA_EXCEEDED':
      return 'quota_exceeded';
    case 'REHOLD_WAIT':
      return 'rehold_wait';
    case 'PAUSED':
      return 'paused';
    case 'NOT_READY':
      return 'not_ready';
    case 'IDEM_REUSED':
      return 'idem_reused';
    case 'INVALID_SEAT':
      return 'invalid_seat';
    case 'SALE_ENDED':
      return 'sale_ended';
    case 'SESSION_NOT_FOUND':
      return 'session_not_found';
    case 'EVENT_MISMATCH':
      return 'event_mismatch';
    case 'DEADLINE_EXCEEDED':
      return 'deadline_exceeded';
    case 'STORE_UNAVAILABLE':
      return 'store_unavailable';
    case 'AUTO_NOT_SUPPORTED':
    case 'SEATS_REQUIRED':
      return 'invalid_request';
    default:
      return 'error';
  }
}
