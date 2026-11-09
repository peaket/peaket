// 결제 접수 쓰임새(openapi POST /v1/orders/{orderId}/payment-acceptance, docs/features/payment.md §2 '결제 접수의 첫 구현', docs/data.md §5 '결제 접수', BUILD_ORDER PRF-162).
// 받는 층(inbound/orders.controller.ts)이 플랫폼 가드(신원·ticket:buy·멱등 키·구매 세션 서명·본문 형식 400, 허용 밖 칸 400)를 지난 요청을 넘긴다.
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1). 결과는 던지지 않고 이름 붙은 값으로 돌려주고, 받는 층이 HTTP로 바꾼다.
// 결제사는 부르지 않는다(외부 PG 호출은 Saga가 응답 밖에서 한다, NFR-005 p99 150ms). Saga 1단계는 PRF-165다.
import type { Clock, Deadline } from '@peaket/platform';
import {
  type AcceptLog,
  type ActiveAttemptView,
  type AttemptMismatchReason,
  type OrderAcceptReads,
  type OrderAcceptWrites,
  type OrderRequestOnce,
  OrderSeatStoreUnavailable,
  type OrderSessions,
  type OrderSessionView,
  type PaymentAcceptBody,
  type PaymentRefs,
  type SeatSlotRead,
  type SeatSlotReads,
} from '../domain/ports.js';
import { seatCallOf, seatCallTooLate, transactionCallOf } from './call-budget.js';

/** 멱등 작업 이름(order_idempotency의 operation, 범위 = 계정 × 이 작업, guidelines §4) */
export const ACCEPT_PAYMENT_OPERATION = 'ACCEPT_PAYMENT';
/** READY 결제 시도를 받는 시간 40분 [가정](결제창 인증 유효 30분 + 승인 기한 10분, data.md payment_attempt.status, ADR-0107) */
export const ATTEMPT_ACCEPT_WINDOW_MS = 40 * 60 * 1000;
/** Saga 작업 행의 첫 단계(order_saga_job.step, data.md §4 여섯 번째 마이그레이션. 값 목록 RESERVE·CONFIRM은 domain/saga.ts SAGA_STEPS, 0006 CHECK) */
export const SAGA_FIRST_STEP = 'RESERVE';

/** 쓰임새가 쓰는 포트와 설정 */
export interface AcceptPaymentDeps {
  /** 구매 세션 읽기(주문 생성과 같은 포트. markPaying은 쓰지 않는다) */
  sessions: OrderSessions;
  reads: OrderAcceptReads;
  writes: OrderAcceptWrites;
  slots: SeatSlotReads;
  log: AcceptLog;
  /** 결제 시도 40분 비교의 시계 */
  clock: Clock;
  /**
   * 이번에 접수를 커밋한 직후(ACCEPTED, 재생은 아님) 한 번 부른다: Saga 실행기의 kick(orderId)(PRF-165). 선택 의존이다(없으면 폴링이 줍는다).
   * 응답을 바꾸지 않는다: 던져도 삼키고 202 그대로
   */
  onAccepted?: (orderId: string) => void;
}

/** 쓰임새 입력 */
export interface AcceptPaymentCommand {
  /** 인증 가드가 판정한 계정(Principal.accountId) */
  readonly accountId: string;
  /** 확인을 마친 구매 세션 참조(@CurrentPurchaseSession(), = 입장 토큰 jti) */
  readonly purchaseSessionId: string;
  /** 주소의 orderId(모양은 보지 않은 글 그대로. 소문자 UUID가 아니면 없는 주문과 같다) */
  readonly orderId: string;
  /** 멱등 요청 값(@IdempotencyRequest(), operation ACCEPT_PAYMENT) */
  readonly idem: OrderRequestOnce;
  /** 본문(openapi PaymentAccept. 받는 층의 경로 스키마가 모양을 이미 봤다) */
  readonly body: PaymentAcceptBody;
  /** 이 요청의 남은 시간(플랫폼 요청 맥락의 deadline). 없으면 좌석 Redis 호출은 플랫폼 기본 마감이다 */
  readonly deadline?: Deadline;
}

/**
 * 거절 까닭(받는 층의 ACCEPT_PROBLEMS가 HTTP로 바꾼다):
 * - SESSION_ENDED: 구매 세션이 없거나 끝남(세션 계정이 요청 계정과 다름 포함) → 401 purchase-session-ended
 * - IDEM_REUSED: 같은 멱등 키에 다른 지문(커밋된 기록) → 422 idempotency-key-reused
 * - NOT_FOUND: 주문이 없거나, 계정·구매 세션이 다름(가리지 않는다) → 404 not-found
 * - ORDER_EXPIRED: 주문이 EXPIRED(트랜잭션의 T3가 0행이고 지금 상태가 EXPIRED인 것 포함) → 409 order-expired
 * - ALREADY_ACCEPTED: 주문이 CREATED·EXPIRED가 아님(AUTHENTICATED부터), 또는 트랜잭션에서 주문이 그사이 먼저 접수됨(T3 0행) → 409 payment-already-accepted
 * - ATTEMPT_MISMATCH: 활성 시도가 없음·READY가 아님·40분 넘음, pg가 다름, 포트원 paymentId가 pg_order_ref와 다름, 트랜잭션에서 시도가 그사이 대체·만료됨
 *   → 409 payment-attempt-mismatch(보안 로그)
 * - AMOUNT_MISMATCH: 토스·시뮬레이터 본문 amount가 주문 금액과 다름 → 400(about:blank, P-T7. 보안 로그 amount_mismatch, ASVS 16.3.3)
 * - SALE_PAUSED: 회차 슬롯 읽기 PAUSED → 423 sale-paused
 * - SEAT_STORE_UNAVAILABLE: 구매 세션·회차 슬롯 읽기의 좌석 Redis 장애, 세대 키 없음(NOT_READY) → 503 seat-store-unavailable(Retry-After 2초)
 * - DEADLINE_EXCEEDED: 좌석 Redis(구매 세션·회차 슬롯)를 부르기 전 남은 시간이 5ms [가정] 미만 → 504 deadline-exceeded(부르지 않는다, 리뷰 고침 L4)
 */
export type AcceptPaymentRejection =
  | 'SESSION_ENDED'
  | 'IDEM_REUSED'
  | 'NOT_FOUND'
  | 'ORDER_EXPIRED'
  | 'ALREADY_ACCEPTED'
  | 'ATTEMPT_MISMATCH'
  | 'AMOUNT_MISMATCH'
  | 'SALE_PAUSED'
  | 'SEAT_STORE_UNAVAILABLE'
  | 'DEADLINE_EXCEEDED';

/** 쓰임새 결과 */
export type AcceptPaymentResult =
  /** 202(본문 없음). replayed: 이번에 접수하지 않고 처음 결과를 다시 돌려줬다(커밋된 기록 읽기 또는 트랜잭션 안의 재생) */
  | { readonly status: 202; readonly replayed: boolean }
  | { readonly status: 'REJECTED'; readonly reason: AcceptPaymentRejection };

/**
 * 결제 접수. 검사 차례(payment §2 '결제 접수의 첫 구현', 앞이 걸리면 뒤는 부르지 않는다):
 * 1. sessions.get(purchaseSessionId): 없음·계정 다름 → SESSION_ENDED. OrderSeatStoreUnavailable → SEAT_STORE_UNAVAILABLE
 * 2. reads.findCommitted(idem): COMMITTED → 202 그대로(replayed true, 주문·시도·슬롯을 보지 않는다), MISMATCH → IDEM_REUSED
 * 3. reads.order(orderId): 없음, accountId ≠ 요청 계정, purchaseSessionId ≠ 요청 구매 세션 → NOT_FOUND(같은 답)
 * 4. 상태 표: CREATED만 받는다. EXPIRED → ORDER_EXPIRED, 그 밖 → ALREADY_ACCEPTED
 * 5. reads.activeAttempt(orderId)로 대조(실패면 log.attemptMismatch(계정·주문·까닭) 한 번 뒤 ATTEMPT_MISMATCH):
 *    없음·READY 아님 → no_attempt, clock.now() − createdAtMs ≥ 40분 → attempt_expired, body.pg ≠ 시도 pg → pg_mismatch,
 *    포트원이면 body.paymentId ≠ pgOrderRef(없음 포함) → payment_id_mismatch.
 *    토스·시뮬레이터면 body.amount ≠ 주문 금액 → log.attemptMismatch(까닭 amount_mismatch, 금액은 싣지 않는다) 한 번 뒤 AMOUNT_MISMATCH(400).
 *    금액 변조도 보안 사건이라 같은 줄을 남긴다(payment §2 '활성 결제 시도 대조', ASVS 16.3.3, 2026-11-05 정본 바로잡음)
 * 6. slots.read(주문의 회차, 좌석 호출 마감 = min(100ms, 남은 시간), 남은 시간이 없으면 넘기지 않는다): NOT_READY → SEAT_STORE_UNAVAILABLE, PAUSED → SALE_PAUSED,
 *    OrderSeatStoreUnavailable → SEAT_STORE_UNAVAILABLE
 * 7. writes.accept(idem, { orderId, attemptId, eventId, refs(결제사별: 토스·시뮬레이터 paymentKey, 포트원 txId·paymentToken), seatGen = 6의 gen, actor account:<계정> }):
 *    ACCEPTED → 202(replayed false), REPLAYED → 202(replayed true),
 *    STALE ORDER_STATE → current가 EXPIRED면 ORDER_EXPIRED, 아니면 ALREADY_ACCEPTED(다른 탭이 먼저 접수),
 *    STALE ATTEMPT_GONE(주문 행을 잡은 뒤 시도가 대체·만료됨) → log.attemptMismatch(current EXPIRED면 attempt_expired, 그 밖은 no_attempt) 뒤 ATTEMPT_MISMATCH(리뷰 고침 M2).
 *    트랜잭션에는 남은 시간이 DB 문장 상한(1초 [가정])보다 짧을 때 그것을 문장 시간 초과로 넘긴다
 * 1·6의 좌석 Redis 호출 바로 전 남은 시간이 5ms [가정] 미만이면 부르지 않고 DEADLINE_EXCEEDED(504, 리뷰 고침 L4).
 * writes.accept가 던지는 ProblemError(409·422)·DB 오류와 slots.read의 망가진 키 Error는 그대로 던진다
 */
export class AcceptPayment {
  constructor(private readonly deps: AcceptPaymentDeps) {}

  async execute(c: AcceptPaymentCommand): Promise<AcceptPaymentResult> {
    const d = this.deps;

    // 1. 구매 세션(없거나 끝났으면 401). 세션의 계정이 요청 계정과 다르면 없는 것과 같게 본다(플랫폼 가드가 이미 막지만 한 번 더 본다)
    //    좌석 Redis를 부르기 전 남은 시간이 5ms [가정] 미만이면 부르지 않는다(504, 리뷰 고침 L4. 6도 같다)
    if (seatCallTooLate(c.deadline)) return rejected('DEADLINE_EXCEEDED');
    let session: OrderSessionView | undefined;
    try {
      session = await d.sessions.get(c.purchaseSessionId);
    } catch (e) {
      if (e instanceof OrderSeatStoreUnavailable) return rejected('SEAT_STORE_UNAVAILABLE');
      throw e;
    }
    if (!session || session.accountId !== c.accountId) return rejected('SESSION_ENDED');

    // 2. 커밋된 멱등 기록(같은 키·같은 지문이면 처음 202 그대로. 주문·시도·슬롯을 다시 보지 않는다)
    const committed = await d.reads.findCommitted(c.idem);
    if (committed.status === 'COMMITTED') return REPLAYED;
    if (committed.status === 'MISMATCH') return rejected('IDEM_REUSED');

    // 3. 주문(없음·남의 계정·다른 구매 세션은 같은 404. 상태 표보다 먼저라 남의 주문 상태가 새지 않는다)
    const order = await d.reads.order(c.orderId);
    if (!order || order.accountId !== c.accountId || order.purchaseSessionId !== c.purchaseSessionId) return rejected('NOT_FOUND');

    // 4. 상태 표(CREATED만 받는다. 인증 T3와 접수 T4를 한 트랜잭션에 함께 쓴다)
    if (order.status === 'EXPIRED') return rejected('ORDER_EXPIRED');
    if (order.status !== 'CREATED') return rejected('ALREADY_ACCEPTED');

    // 5. 활성 결제 시도 대조(시도 없음 → 40분 → 결제사 → paymentId·금액). 맞지 않으면 보안 로그 한 줄(계정·주문·까닭)
    const attempt = await d.reads.activeAttempt(order.orderId);
    const mismatch = attemptMismatchOf(attempt, c.body, order.amount, d.clock.now());
    if (mismatch !== undefined) {
      d.log.attemptMismatch({ accountId: c.accountId, orderId: order.orderId, reason: mismatch });
      return rejected(mismatch === 'amount_mismatch' ? 'AMOUNT_MISMATCH' : 'ATTEMPT_MISMATCH');
    }
    // attemptMismatchOf가 undefined면 READY 시도가 있다
    const ready = attempt!;

    // 6. 회차 슬롯 읽기(세대 키 gen·판매 정지 사본). 망가진 세대 키(Error)는 그대로 던진다
    let slot: SeatSlotRead;
    if (seatCallTooLate(c.deadline)) return rejected('DEADLINE_EXCEEDED');
    try {
      slot = await d.slots.read(order.eventId, seatCallOf(c.deadline));
    } catch (e) {
      if (e instanceof OrderSeatStoreUnavailable) return rejected('SEAT_STORE_UNAVAILABLE');
      throw e;
    }
    if (slot.status === 'NOT_READY') return rejected('SEAT_STORE_UNAVAILABLE');
    if (slot.status === 'PAUSED') return rejected('SALE_PAUSED');

    // 7. 한 트랜잭션(남은 시간이 DB 문장 상한보다 짧으면 문장 시간 초과로 넘긴다). ProblemError(409·422)·DB 오류는 그대로 던진다
    const outcome = await d.writes.accept(
      c.idem,
      {
        orderId: order.orderId,
        attemptId: ready.attemptId,
        eventId: order.eventId,
        refs: refsOf(c.body),
        seatGen: slot.gen,
        actor: `account:${c.accountId}`,
      },
      transactionCallOf(c.deadline),
    );
    switch (outcome.status) {
      case 'ACCEPTED':
        // 커밋 직후 Saga를 한 번 깨운다(PRF-165). 실패해도 202는 그대로다(폴링이 1초 [가정] 안에 줍는다)
        try {
          d.onAccepted?.(order.orderId);
        } catch {
          // 삼킨다(깨우기는 응답과 무관하다)
        }
        return ACCEPTED;
      case 'REPLAYED':
        return REPLAYED;
      default:
        if (outcome.reason === 'ATTEMPT_GONE') {
          // 주문 행을 잡은 뒤 시도가 READY가 아니었다(그사이 대체·만료): 시도 대조 실패와 같은 답과 보안 로그(리뷰 고침 M2)
          d.log.attemptMismatch({ accountId: c.accountId, orderId: order.orderId, reason: outcome.current === 'EXPIRED' ? 'attempt_expired' : 'no_attempt' });
          return rejected('ATTEMPT_MISMATCH');
        }
        // 다른 탭·기기가 먼저 접수한 주문은 409 payment-already-accepted, 그사이 만료된 주문은 409 order-expired
        return rejected(outcome.current === 'EXPIRED' ? 'ORDER_EXPIRED' : 'ALREADY_ACCEPTED');
    }
  }
}

const ACCEPTED: AcceptPaymentResult = { status: 202, replayed: false };
const REPLAYED: AcceptPaymentResult = { status: 202, replayed: true };
const rejected = (reason: AcceptPaymentRejection): AcceptPaymentResult => ({ status: 'REJECTED', reason });

/**
 * 활성 결제 시도 대조(payment §2 '활성 결제 시도 대조'). 맞으면 undefined, 아니면 보안 로그 까닭.
 * 차례: 없음·READY 아님(no_attempt) → 만든 지 40분 이상(attempt_expired) → 본문 pg가 시도와 다름(pg_mismatch)
 * → 포트원 paymentId가 pg_order_ref와 다름(없음 포함, 글자 그대로 견준다, payment_id_mismatch) → 토스·시뮬레이터 amount가 주문 금액과 다름(amount_mismatch)
 */
function attemptMismatchOf(attempt: ActiveAttemptView | undefined, body: PaymentAcceptBody, orderAmount: number, nowMs: number): AttemptMismatchReason | undefined {
  if (!attempt || attempt.status !== 'READY') return 'no_attempt';
  if (nowMs - attempt.createdAtMs >= ATTEMPT_ACCEPT_WINDOW_MS) return 'attempt_expired';
  if (body.pg !== attempt.pg) return 'pg_mismatch';
  if (body.pg === 'PORTONE') return attempt.pgOrderRef !== undefined && body.paymentId === attempt.pgOrderRef ? undefined : 'payment_id_mismatch';
  return body.amount === orderAmount ? undefined : 'amount_mismatch';
}

/** 본문 → 결제 시도에 저장할 결제 참조(토스·시뮬레이터 paymentKey, 포트원 txId·paymentToken. paymentId·amount는 싣지 않는다) */
function refsOf(body: PaymentAcceptBody): PaymentRefs {
  return body.pg === 'PORTONE' ? { pg: 'PORTONE', txId: body.txId, paymentToken: body.paymentToken } : { pg: body.pg, paymentKey: body.paymentKey };
}
