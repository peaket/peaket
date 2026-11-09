// 주문 생성 쓰임새(openapi POST /v1/orders, docs/features/payment.md §2 '주문 생성의 첫 구현', docs/data.md §5 '주문 생성', BUILD_ORDER PRF-161).
// 받는 층(inbound/orders.controller.ts)이 플랫폼 가드(신원·역할 ticket:buy·멱등 키 400·구매 세션 서명 401·본문 형식 400)를 지난 요청을 넘긴다.
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1). 결과는 던지지 않고 이름 붙은 값으로 돌려주고, 받는 층이 HTTP로 바꾼다.
import { type Clock, type Deadline, uuidv7 } from '@peaket/platform';
import { buyerOf, consentVerdict, type OrderBuyerInput, type OrderConsents, priceSeats } from '../domain/order-request.js';
import {
  type BookingRestriction,
  type BookingRestrictions,
  type ContactRefs,
  type IdentityRecheck,
  type NewOrder,
  type OrderHoldMarks,
  type OrderHolds,
  type OrderLog,
  type OrderRequestOnce,
  OrderSeatStoreUnavailable,
  type OrderSessions,
  type OrderSessionView,
  type OrderSignals,
  type OrderView,
  type OrderWrites,
  type SaleConfigs,
} from '../domain/ports.js';
import { judgeRecheck, type RecheckFailure, type RecheckToken } from '../domain/recheck.js';
import { budgetOf, seatCallOf, seatCallTooLate, transactionCallOf } from './call-budget.js';

/** 멱등 작업 이름(order_idempotency의 operation, 범위 = 계정 × 이 작업, guidelines §4) */
export const CREATE_ORDER_OPERATION = 'CREATE_ORDER';
/** 본인확인 재확인 gRPC 데드라인 150ms [가정](architecture 시간 초과 표, 다시 묻기 한 번 포함) */
export const IDENTITY_RECHECK_DEADLINE_MS = 150;
/** 조사용 연락처 가명 gRPC 데드라인 50ms [가정](architecture 시간 초과 표, 다시 묻지 않는다) */
export const CONTACT_REF_DEADLINE_MS = 50;
/** 같은 홀드의 주문 ID 조회 상한 200ms [가정](ADR-0255) */
const OWN_ORDER_LOOKUP_MS = 200;

/** 쓰임새가 쓰는 포트와 설정 */
export interface CreateOrderDeps {
  sessions: OrderSessions;
  writes: OrderWrites;
  holds: OrderHolds;
  saleConfigs: SaleConfigs;
  identity: IdentityRecheck;
  contactRefs: ContactRefs;
  restrictions: BookingRestrictions;
  signals: OrderSignals;
  log: OrderLog;
  /** 판매 종료 비교와 주문 ID(UUIDv7)의 시계 */
  clock: Clock;
  /** 지금 동의 문안 판(환경 값 PEAKET_ORDER_CONSENT_VERSION, ^[0-9A-Za-z._-]{1,32}$) */
  consentVersion: string;
  /** 주문 뒤 표시와 예매 제한 해제(BUILD_ORDER HOT-070). 던지지 않는 구현을 넘긴다. 없으면 하지 않는다 */
  holdMarks?: OrderHoldMarks;
}

/** 본문(openapi CreateOrderBody. 받는 층의 경로 스키마가 모양을 이미 봤다) */
export interface CreateOrderBody {
  readonly holdId: string;
  readonly buyer: OrderBuyerInput;
  readonly consents?: OrderConsents;
}

/** 쓰임새 입력 */
export interface CreateOrderCommand {
  /** 인증 가드가 판정한 계정(Principal.accountId) */
  readonly accountId: string;
  /** 액세스 토큰의 로그인 세션 ID(Principal.sessionId, 재확인의 session_id) */
  readonly loginSessionId: string;
  /** 토큰 판정에 쓰는 값(Principal.pid·scopes) */
  readonly token: RecheckToken;
  /** 확인을 마친 구매 세션 참조(@CurrentPurchaseSession(), = 입장 토큰 jti) */
  readonly purchaseSessionId: string;
  /** 멱등 요청 값(@IdempotencyRequest(), operation CREATE_ORDER) */
  readonly idem: OrderRequestOnce;
  readonly body: CreateOrderBody;
  /** 이 요청의 남은 시간(플랫폼 요청 맥락의 deadline). 없으면 각 호출의 데드라인 상한을 그대로 쓴다 */
  readonly deadline?: Deadline;
}

/**
 * 거절 까닭(받는 층의 ORDER_PROBLEMS가 HTTP로 바꾼다):
 * - SESSION_NOT_FOUND: 구매 세션이 없거나 끝남 → 401 purchase-session-ended
 * - IDEM_REUSED: 같은 멱등 키에 다른 지문(커밋된 기록) → 422 idempotency-key-reused
 * - HOLD_NOT_FOUND: 홀드 확인 NOT_FOUND(판매 종료 전) → 404 not-found
 * - SALE_ENDED: 판매 종료 뒤인데 판매 종료 전에 잡은 홀드가 아님(NOT_FOUND 포함) → 410 sale-ended
 * - SEAT_STORE_UNAVAILABLE: 좌석 Redis 장애·준비 안 됨·좌석맵 판 없음 → 503 seat-store-unavailable(Retry-After 2초)
 * - CONSENT_REQUIRED·CONSENT_VERSION_OUTDATED → 422
 * - BUYER_INVALID: 예매자 성명·번호가 없거나 1~100자가 아니거나 번호를 E.164로 맞출 수 없음 → 400(about:blank)
 * - IDENTITY_DENIED: 재확인 거부(토큰 판정 거부 포함) → 403 identity-verification-required
 * - IDENTITY_MISCONFIGURED: 재확인 PERMISSION_DENIED·INVALID_ARGUMENT·정본 목록 밖(unexpected) → 503 dependency-unavailable(SEV2)
 * - BOOKING_RESTRICTED: 예매 제한 ACTIVE이고 끝 시각 전 → 403 booking-restricted
 * - PRICE_MISSING: 가격이 없는 등급, 또는 등급 가격 합이 int4를 넘음(리뷰 고침 L5) → 500(설정 오류)
 * - HOLD_ALREADY_ORDERED: 같은 홀드로 만든 주문이 있음(다른 멱등 키) → 409 hold-already-ordered
 * - DEADLINE_EXCEEDED: 좌석 Redis(구매 세션·홀드 확인·예매 제한)를 부르기 전 남은 시간이 5ms [가정] 미만 → 504 deadline-exceeded(부르지 않는다, 리뷰 고침 L4)
 */
export type CreateOrderRejection =
  | 'SESSION_NOT_FOUND'
  | 'IDEM_REUSED'
  | 'HOLD_NOT_FOUND'
  | 'SALE_ENDED'
  | 'SEAT_STORE_UNAVAILABLE'
  | 'CONSENT_REQUIRED'
  | 'CONSENT_VERSION_OUTDATED'
  | 'BUYER_INVALID'
  | 'IDENTITY_DENIED'
  | 'IDENTITY_MISCONFIGURED'
  | 'BOOKING_RESTRICTED'
  | 'PRICE_MISSING'
  | 'HOLD_ALREADY_ORDERED'
  | 'DEADLINE_EXCEEDED';

/** 쓰임새 결과 */
export type CreateOrderResult =
  /** 201 Order. replayed: 이번에 만들지 않고 처음 결과를 다시 돌려줬다(커밋된 기록 읽기 또는 트랜잭션 안의 재생) */
  | { readonly status: 201; readonly order: OrderView; readonly replayed: boolean }
  | { readonly status: 'REJECTED'; readonly reason: CreateOrderRejection; readonly orderId?: string };

/**
 * 주문 생성. 검사 차례(payment §2, 앞이 걸리면 뒤는 부르지 않는다):
 * 1. sessions.get(purchaseSessionId): 없음 → SESSION_NOT_FOUND
 * 2. writes.findCommitted(idem): COMMITTED → 201 그대로(replayed true, 홀드·동의 등을 보지 않는다), MISMATCH → IDEM_REUSED
 * 3. saleConfigs.get(세션의 회차): 없음 → SEAT_STORE_UNAVAILABLE.
 *    holds.check({ 세션의 회차, 구매 세션, 계정, body.holdId }): STORE_UNAVAILABLE → SEAT_STORE_UNAVAILABLE.
 *    clock.now() ≥ saleEndsAtMs이면 OK이고 heldAtMs < saleEndsAtMs인 홀드만 받고 그 밖(NOT_FOUND 포함)은 모두 SALE_ENDED, 판매 종료 전이면 NOT_FOUND → HOLD_NOT_FOUND
 * 4. consentVerdict(body.consents, deps.consentVersion) → CONSENT_REQUIRED·CONSENT_VERSION_OUTDATED
 * 5. buyerOf(body.buyer) → BUYER_INVALID
 * 6. identity.check({ 계정, 로그인 세션, deadlineMs = min(150, 남은 시간) }) → judgeRecheck(답, token):
 *    PASS_FALLBACK·DENY(fallbackReason 있음)이면 signals.identityFallback?.(까닭)과 log.identityFallback(계정·까닭·통과 여부·멱등 키) 한 번씩.
 *    DENY → IDENTITY_DENIED, MISCONFIGURED → log.configError 뒤 IDENTITY_MISCONFIGURED
 * 7. restrictions.read(계정): ACTIVE이고 untilMs가 없거나 clock.now() < untilMs → BOOKING_RESTRICTED(같은 처리의 홀드 해제는 HOT-070이 붙인다)
 * 8. priceSeats(홀드 좌석, tierPrices): PRICE_MISSING·AMOUNT_OUT_OF_RANGE → log.configError(tier_price_missing·amount_out_of_range) 뒤 PRICE_MISSING
 * 9. contactRefs.compute(phoneE164, min(50, 남은 시간)): undefined면 contactRef 없이 refMissing 참.
 *    6의 재확인이 circuit_open·deadline·unavailable로 답하지 않았으면 부르지 않고 refMissing 참(리뷰 고침 M4)
 * 10. writes.create(idem, NewOrder): id = uuidv7(clock), holdId = body.holdId, purchaseSessionId, seatAssignment 'PICK', actor account:<계정>,
 *     buyerName·buyerPhone(E.164), consentVersion, created = { purchaseSessionId, journeyId(세션), contactRef?, refMissing }.
 *     HOLD_ALREADY_ORDERED → 그 거절, CREATED·REPLAYED → 11로
 * 11. sessions.markPaying(purchaseSessionId): 실패(false·던짐)해도 응답을 바꾸지 않는다(주문은 커밋됐다). 2의 COMMITTED 재생도 같이 부른다.
 *     실패면 남은 시간이 있을 때 한 번 더, 그래도 실패면 signals.payingMarkFailed?.()와 log.payingMarkFailed(구매 세션 ID·주문 ID)(리뷰 고침 M3)
 * 12. 201 { order, replayed }
 * 좌석 Redis 포트가 OrderSeatStoreUnavailable을 던지면(1·7) SEAT_STORE_UNAVAILABLE. writes.create가 던지는 ProblemError(409·422)·DB 오류는 그대로 던진다.
 * 1·3·7의 좌석 Redis 호출 바로 전 남은 시간이 5ms [가정] 미만이면 부르지 않고 DEADLINE_EXCEEDED(504). 10의 트랜잭션에는 남은 시간이 DB 문장 상한(1초 [가정])보다
 * 짧을 때 그것을 문장 시간 초과로 넘긴다(리뷰 고침 L4). 11의 Paying 표시는 주문을 커밋한 뒤라 이 기준으로 막지 않는다
 */
export class CreateOrder {
  constructor(private readonly deps: CreateOrderDeps) {}

  async execute(c: CreateOrderCommand): Promise<CreateOrderResult> {
    const d = this.deps;

    // 1. 구매 세션(없거나 끝났으면 401). 세션의 계정이 요청 계정과 다르면 없는 것과 같게 본다(플랫폼 가드가 이미 막지만 한 번 더 본다)
    //    좌석 Redis를 부르기 전 남은 시간이 5ms [가정] 미만이면 부르지 않는다(504, 리뷰 고침 L4. 3·7도 같다)
    if (seatCallTooLate(c.deadline)) return rejected('DEADLINE_EXCEEDED');
    let session: OrderSessionView | undefined;
    try {
      session = await d.sessions.get(c.purchaseSessionId);
    } catch (e) {
      if (e instanceof OrderSeatStoreUnavailable) return rejected('SEAT_STORE_UNAVAILABLE');
      throw e;
    }
    if (!session || session.accountId !== c.accountId) return rejected('SESSION_NOT_FOUND');

    // 2. 커밋된 멱등 기록(같은 키·같은 지문이면 처음 201 그대로, 홀드·동의 등을 다시 보지 않는다)
    const committed = await d.writes.findCommitted(c.idem);
    if (committed.status === 'COMMITTED') {
      await this.#markPaying(c.purchaseSessionId, committed.order.orderId, c.deadline);
      return { status: 201, order: committed.order, replayed: true };
    }
    if (committed.status === 'MISMATCH') return rejected('IDEM_REUSED');

    // 3. 판매 설정과 홀드 확인. 판매 종료 뒤에는 판매 종료 전에 잡은 홀드만 받고 그 밖은 모두 410(있는지 새지 않게 같은 답)
    const sale = await d.saleConfigs.get(session.eventId);
    if (!sale) return rejected('SEAT_STORE_UNAVAILABLE');
    if (seatCallTooLate(c.deadline)) return rejected('DEADLINE_EXCEEDED');
    const hold = await d.holds.check(
      { eventId: session.eventId, purchaseSessionId: c.purchaseSessionId, accountId: c.accountId, holdId: c.body.holdId },
      seatCallOf(c.deadline),
    );
    if (hold.status === 'STORE_UNAVAILABLE') return rejected('SEAT_STORE_UNAVAILABLE');
    if (d.clock.now() >= sale.saleEndsAtMs && (hold.status !== 'OK' || hold.heldAtMs >= sale.saleEndsAtMs)) return rejected('SALE_ENDED');
    if (hold.status !== 'OK') return rejected('HOLD_NOT_FOUND');

    // 4. 동의(422), 5. 예매자(400)
    const consent = consentVerdict(c.body.consents, d.consentVersion);
    if (consent !== 'OK') return rejected(consent);
    const buyer = buyerOf(c.body.buyer);
    if (!buyer) return rejected('BUYER_INVALID');

    // 6. 본인확인 재확인. 답이 없어 토큰 판정으로 갔으면(통과든 거부든) 지표·보안 로그를 한 번씩 남긴다(ADR-0055)
    const answer = await d.identity.check({ accountId: c.accountId, sessionId: c.loginSessionId, deadlineMs: budgetOf(c.deadline, IDENTITY_RECHECK_DEADLINE_MS) });
    const verdict = judgeRecheck(answer, c.token);
    const fallbackReason = verdict.kind === 'PASS_FALLBACK' ? verdict.reason : verdict.kind === 'DENY' ? verdict.fallbackReason : undefined;
    if (fallbackReason !== undefined) {
      d.signals.identityFallback?.(fallbackReason);
      d.log.identityFallback({ accountId: c.accountId, reason: fallbackReason, passed: verdict.kind === 'PASS_FALLBACK', idempotencyKey: c.idem.key });
    }
    if (verdict.kind === 'DENY') return rejected('IDENTITY_DENIED');
    if (verdict.kind === 'MISCONFIGURED') {
      d.log.configError({ what: 'identity_misconfigured', reason: verdict.reason });
      return rejected('IDENTITY_MISCONFIGURED');
    }

    // 7. 예매 제한 사본(ACTIVE이고 끝 시각 전이면 403). 망가진 사본(Error)은 제한 없음으로 숨기지 않고 그대로 던진다
    let restriction: BookingRestriction | undefined;
    if (seatCallTooLate(c.deadline)) return rejected('DEADLINE_EXCEEDED');
    try {
      restriction = await d.restrictions.read(c.accountId);
    } catch (e) {
      if (e instanceof OrderSeatStoreUnavailable) return rejected('SEAT_STORE_UNAVAILABLE');
      throw e;
    }
    if (restriction?.st === 'ACTIVE' && (restriction.untilMs === undefined || d.clock.now() < restriction.untilMs)) {
      // 같은 처리에서 그 구매 세션의 홀드를 푼다(payment §2 '예매 제한 확인', P-T49 ①). 던지지 않고, 실패한 홀드는 만료로 풀린다
      await d.holdMarks?.releaseSession({ eventId: session.eventId, accountId: c.accountId, sessionId: c.purchaseSessionId });
      return rejected('BOOKING_RESTRICTED');
    }

    // 8. 금액(홀드 좌석의 등급 가격 합. 클라이언트 값은 쓰지 않는다)
    const pricing = priceSeats(hold.seats, sale.tierPrices);
    if (pricing.status === 'PRICE_MISSING') {
      d.log.configError({ what: 'tier_price_missing', eventId: session.eventId, tierId: pricing.tierId });
      return rejected('PRICE_MISSING');
    }
    if (pricing.status === 'AMOUNT_OUT_OF_RANGE') {
      // 합이 주문 금액 칸을 넘는 가격 표도 같은 설정 오류 길이다(저장소의 RangeError 500 전에 로그를 남긴다)
      d.log.configError({ what: 'amount_out_of_range', eventId: session.eventId });
      return rejected('PRICE_MISSING');
    }

    // 9. 조사용 연락처 가명(E.164 번호로 한 번. 받지 못하면 비우고 refMissing 참).
    //    같은 identity-svc의 재확인이 방금 답하지 않았으면(차단기 열림·데드라인·연결 불가) 부르지 않는다(기다림만 늘고 받을 가능성이 낮다)
    const identityDown = answer.status === 'FAILED' && SKIP_CONTACT_REF_AFTER.has(answer.reason);
    const contactRef = identityDown ? undefined : await this.#contactRefOf(buyer.phoneE164, budgetOf(c.deadline, CONTACT_REF_DEADLINE_MS));

    // 10. 한 트랜잭션(멱등 기록 잡기 → 주문 만들기). ProblemError(409·422)·DB 오류는 그대로 던진다
    const order: NewOrder = {
      id: uuidv7(d.clock),
      accountId: c.accountId,
      eventId: session.eventId,
      amount: pricing.amount,
      buyerName: buyer.name,
      buyerPhone: buyer.phoneE164,
      idempotencyKey: c.idem.key,
      // 동의 판정을 지났으니 본문 판 = 지금 판이다
      consentVersion: d.consentVersion,
      seatAssignment: 'PICK',
      items: pricing.items,
      actor: `account:${c.accountId}`,
      created: {
        purchaseSessionId: c.purchaseSessionId,
        journeyId: session.journeyId,
        ...(contactRef !== undefined ? { contactRef } : {}),
        refMissing: contactRef === undefined,
      },
      holdId: c.body.holdId,
      purchaseSessionId: c.purchaseSessionId,
    };
    // 남은 시간이 DB 문장 상한보다 짧으면 트랜잭션의 문장 시간 초과로 넘긴다(리뷰 고침 L4)
    const outcome = await d.writes.create(c.idem, order, transactionCallOf(c.deadline));
    if (outcome.status === 'HOLD_ALREADY_ORDERED') {
      // 같은 계정·같은 구매 세션의 주문이면 그 ID를 함께 준다(응답을 잃은 화면이 이어 간다, ADR-0255)
      // 조회는 시간 제한 안에서 한 번이다. 실패하면 칸 없이 답한다(409는 그대로, L11)
      const orderId = await Promise.race([
        (d.writes.findOwnOrderId?.({ holdId: c.body.holdId, accountId: c.accountId, purchaseSessionId: c.purchaseSessionId }) ?? Promise.resolve(undefined)).catch(() => undefined),
        new Promise<undefined>((resolve) => {
          const t = setTimeout(() => resolve(undefined), OWN_ORDER_LOOKUP_MS);
          (t as { unref?: () => void }).unref?.();
        }),
      ]);
      return { status: 'REJECTED', reason: 'HOLD_ALREADY_ORDERED', ...(orderId ? { orderId } : {}) };
    }

    // 주문 뒤 표시(결제 정지 때 멈출 대상, seat-hold §5 '주문 표시'). 실패해도 201은 그대로다
    if (outcome.status === 'CREATED' && d.holdMarks) {
      const mark = () => d.holdMarks!.markOrdered({ eventId: session.eventId, accountId: c.accountId, sessionId: c.purchaseSessionId, holdId: c.body.holdId, seatIds: hold.seats.map((s) => s.seatId), ...(c.deadline ? { deadline: c.deadline } : {}) });
      // 일시 실패면 한 번 더 한다. 그래도 실패하면 결제 시도 시작이 다시 표시한다(L4)
      if (!(await mark()) && !(await mark())) d.signals.holdMarkFailed?.();
    }

    // 11. 커밋 뒤 Paying 표시(실패해도 응답을 바꾸지 않는다), 12. 201
    await this.#markPaying(c.purchaseSessionId, outcome.order.orderId, c.deadline);
    return { status: 201, order: outcome.order, replayed: outcome.status === 'REPLAYED' };
  }

  /**
   * 구매 세션 Paying 표시. 주문은 이미 커밋됐으므로 응답을 바꾸지 않는다. 실패(false·던짐)면 요청의 남은 시간이 있을 때 한 번 더 부르고,
   * 그래도 실패면 경고 한 줄(구매 세션 ID·주문 ID)과 지표 하나를 남긴다(세션 정리 반복이 결제 중 유휴로 끝낼 수 있어 알린다, POL-009)
   */
  async #markPaying(sessionId: string, orderId: string, deadline: Deadline | undefined): Promise<void> {
    if (await this.#markPayingOnce(sessionId, deadline)) return;
    if ((deadline === undefined || deadline.remainingMs() > 0) && (await this.#markPayingOnce(sessionId, deadline))) return;
    this.deps.signals.payingMarkFailed?.();
    this.deps.log.payingMarkFailed({ purchaseSessionId: sessionId, orderId });
  }

  /** Paying 표시 한 번(마감은 부를 때의 남은 시간으로). 됐으면 true, false·던짐이면 false */
  async #markPayingOnce(sessionId: string, deadline: Deadline | undefined): Promise<boolean> {
    try {
      return (await this.deps.sessions.markPaying(sessionId, seatCallOf(deadline))) === true;
    } catch {
      return false;
    }
  }

  /** 가명 계산. 포트는 던지지 않지만 혹시 던져도 주문을 막지 않는다(빈 글도 받지 못한 것으로 본다) */
  async #contactRefOf(phoneE164: string, deadlineMs: number): Promise<string | undefined> {
    try {
      const ref = await this.deps.contactRefs.compute(phoneE164, deadlineMs);
      return typeof ref === 'string' && ref.length > 0 ? ref : undefined;
    } catch {
      return undefined;
    }
  }
}

const rejected = (reason: CreateOrderRejection): CreateOrderResult => ({ status: 'REJECTED', reason });

/** 재확인이 이 까닭으로 답하지 않았으면 가명 호출을 건너뛴다(같은 identity-svc가 지금 답하지 않는다, 리뷰 고침 M4 2026-11-05) */
const SKIP_CONTACT_REF_AFTER: ReadonlySet<RecheckFailure> = new Set<RecheckFailure>(['circuit_open', 'deadline', 'unavailable']);

