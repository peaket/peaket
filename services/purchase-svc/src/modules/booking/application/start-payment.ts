// 결제 시도 시작 쓰임새(openapi POST /v1/orders/{orderId}/payments, docs/features/payment.md §2 '결제 시도 시작의 첫 구현', docs/data.md §5 '결제 시도 시작', BUILD_ORDER PRF-191).
// 받는 층이 플랫폼 가드(신원·ticket:buy·멱등 키·구매 세션 서명·본문 형식 400, 허용 밖 칸 400)를 지난 요청을 넘긴다.
// 이 층은 어댑터를 가져오지 않는다(포트로만 쓴다, architecture §3.1). 결과는 던지지 않고 이름 붙은 값으로 돌려주고, 받는 층이 HTTP로 바꾼다.
// 결제사는 부르지 않는다. PrepareCheckout은 트랜잭션 밖에서 한 번 부른다(DB 연결을 쥔 채 gRPC를 기다리지 않는다).
import { type Clock, type Deadline, uuidv7 } from '@peaket/platform';
import { buildBehaviorSignal, DEFAULT_ORDER_NAME, PAYMENT_ATTEMPTS_MAX, pgOrderRefOf, PREPARE_CHECKOUT_DEADLINE_MS, PREPARE_CHECKOUT_MIN_REMAINING_MS, type StartPayMethod } from '../domain/payment-attempt.js';
import {
  type BehaviorSignalPublisher,
  type BehaviorSummary,
  type CheckoutOutcome,
  type OrderHoldExpiries,
  type OrderRequestOnce,
  OrderSeatStoreUnavailable,
  type OrderSessions,
  type OrderSessionView,
  type PaymentCheckouts,
  type PaymentPg,
  type PreparedCheckout,
  type SaleConfig,
  type SaleConfigs,
  type SeatSlotRead,
  type SeatSlotReads,
  type StartOrderView,
  type StartPaymentLog,
  type StartPaymentReads,
  type StartPaymentSignals,
  type StartPaymentWrites,
} from '../domain/ports.js';
import { budgetOf, seatCallOf, seatCallTooLate, transactionCallOf } from './call-budget.js';

export { START_PAYMENT_OPERATION } from '../domain/payment-attempt.js';

/** 쓰임새가 쓰는 포트와 설정 */
export interface StartPaymentDeps {
  /** 구매 세션 읽기(주문 생성과 같은 포트. markPaying은 쓰지 않는다) */
  sessions: OrderSessions;
  reads: StartPaymentReads;
  writes: StartPaymentWrites;
  slots: SeatSlotReads;
  saleConfigs: SaleConfigs;
  holdExpiries: OrderHoldExpiries;
  checkouts: PaymentCheckouts;
  behavior: BehaviorSignalPublisher;
  signals: StartPaymentSignals;
  log: StartPaymentLog;
  /** 시도 ID(UUIDv7)와 행동 신호 시각의 시계 */
  clock: Clock;
}

/** 쓰임새 입력 */
export interface StartPaymentCommand {
  /** 인증 가드가 판정한 계정(Principal.accountId) */
  readonly accountId: string;
  /** 액세스 토큰의 pid. 없으면 행동 신호를 내지 않는다(필수 칸이다) */
  readonly pid?: string;
  /** 확인을 마친 구매 세션 참조(@CurrentPurchaseSession(), = 입장 토큰 jti) */
  readonly purchaseSessionId: string;
  /** 주소의 orderId(모양은 보지 않은 글 그대로. 소문자 UUID가 아니면 없는 주문과 같다) */
  readonly orderId: string;
  /** 멱등 요청 값(@IdempotencyRequest(), operation START_PAYMENT) */
  readonly idem: OrderRequestOnce;
  /** 본문(받는 층의 경로 스키마가 모양을 이미 봤다) */
  readonly body: { readonly payMethod?: StartPayMethod; readonly behavior?: BehaviorSummary };
  /** 이 요청의 남은 시간(플랫폼 요청 맥락의 deadline). 없으면 호출마다 상한을 쓴다 */
  readonly deadline?: Deadline;
}

/**
 * 거절 까닭(받는 층의 START_PAYMENT_PROBLEMS가 HTTP로 바꾼다):
 * - SESSION_ENDED 401 · IDEM_REUSED 422 · NOT_FOUND 404 · ORDER_EXPIRED 409 order-expired · ALREADY_ACCEPTED 409 payment-already-accepted
 * - ATTEMPTS_EXCEEDED 409 payment-attempts-exceeded · SALE_PAUSED 423 · SEAT_STORE_UNAVAILABLE 503
 * - PG_UNAVAILABLE 503 pg-unavailable · NEW_PAYMENT_PAUSED 503 new-payment-paused(BUILD_ORDER PRF-201) · CHECKOUT_MISCONFIGURED 503 dependency-unavailable · PAY_METHOD_INVALID 400(첫 요청만, 재생은 PG_UNAVAILABLE) · DEADLINE_EXCEEDED 504
 */
export type StartPaymentRejection =
  | 'SESSION_ENDED'
  | 'IDEM_REUSED'
  | 'NOT_FOUND'
  | 'ORDER_EXPIRED'
  | 'ALREADY_ACCEPTED'
  | 'ATTEMPTS_EXCEEDED'
  | 'SALE_PAUSED'
  | 'SEAT_STORE_UNAVAILABLE'
  | 'PG_UNAVAILABLE'
  | 'CHECKOUT_MISCONFIGURED'
  | 'PAY_METHOD_INVALID'
  | 'NEW_PAYMENT_PAUSED'
  | 'DEADLINE_EXCEEDED';

/** 201 본문의 재료 */
export interface StartedPayment extends PreparedCheckout {
  readonly attemptId: string;
  /** 홀드가 남았고 좌석 Redis를 읽었을 때만 있다 */
  readonly holdExpiresAtMs?: number;
}

/** 쓰임새 결과. replayed: 이번에 시도를 만들지 않고 처음 시도로 값을 다시 만들었다 */
export type StartPaymentResult =
  | { readonly status: 201; readonly replayed: boolean; readonly attempt: StartedPayment }
  /** holdRemainingSeconds: NEW_PAYMENT_PAUSED이고 홀드 만료를 읽었을 때만 있다(ADR-0085) */
  | { readonly status: 'REJECTED'; readonly reason: StartPaymentRejection; readonly holdRemainingSeconds?: number };

const rejected = (reason: StartPaymentRejection): StartPaymentResult => ({ status: 'REJECTED', reason });

/**
 * 결제 시도 시작. 검사 차례(payment §2 '결제 시도 시작의 첫 구현', 앞이 걸리면 뒤는 부르지 않는다):
 * 1. sessions.get: 없음·계정 다름 → SESSION_ENDED, 좌석 Redis 장애 → SEAT_STORE_UNAVAILABLE. 부르기 전 남은 시간이 5ms [가정] 미만이면 DEADLINE_EXCEEDED
 * 2. reads.findCommitted: MISMATCH → IDEM_REUSED, COMMITTED → 재생(아래 #replay)
 * 3. reads.order: 없음·계정 다름·구매 세션 다름 → NOT_FOUND(같은 답)
 * 4. 상태 표: CREATED만. EXPIRED → ORDER_EXPIRED, 그 밖 → ALREADY_ACCEPTED
 * 5. reads.attemptCount ≥ 상한 → ATTEMPTS_EXCEEDED(보안 로그 한 줄. 결제창 준비를 아낀다, 정답은 7의 트랜잭션)
 * 6. slots.read(NOT_READY → SEAT_STORE_UNAVAILABLE, PAUSED → SALE_PAUSED) → saleConfigs.get(없음 → SEAT_STORE_UNAVAILABLE) → holdExpiries.expiresAt(어떤 실패든 칸만 뺀다)
 * 7. checkouts.prepare(시도 ID = uuidv7, 데드라인 min(300ms, 남은 시간). 남은 시간이 50ms [가정] 미만이면 DEADLINE_EXCEEDED) → writes.start(한 트랜잭션)
 * 8. 첫 시도(attemptNo 1)면 커밋 뒤 행동 신호를 응답과 따로 낸다
 * writes.start가 던지는 ProblemError(409·422)·DB 오류와 slots.read의 망가진 키 Error는 그대로 던진다
 */
export class StartPayment {
  constructor(private readonly deps: StartPaymentDeps) {}

  async execute(c: StartPaymentCommand): Promise<StartPaymentResult> {
    const d = this.deps;

    // 1. 구매 세션
    if (seatCallTooLate(c.deadline)) return rejected('DEADLINE_EXCEEDED');
    let session: OrderSessionView | undefined;
    try {
      session = await d.sessions.get(c.purchaseSessionId);
    } catch (e) {
      if (e instanceof OrderSeatStoreUnavailable) return rejected('SEAT_STORE_UNAVAILABLE');
      throw e;
    }
    if (!session || session.accountId !== c.accountId) return rejected('SESSION_ENDED');

    // 2. 커밋된 멱등 기록(같은 키·같은 지문이면 처음 시도로 값만 다시 만든다. 주문 상태·횟수·판매 정지를 다시 보지 않는다, guidelines §4)
    const committed = await d.reads.findCommitted(c.idem);
    if (committed.status === 'MISMATCH') return rejected('IDEM_REUSED');
    if (committed.status === 'COMMITTED') return this.#replay(c, committed.attemptId);

    // 3. 주문(없음·남의 계정·다른 구매 세션은 같은 404. 상태 표보다 먼저라 남의 주문 상태가 새지 않는다)
    const order = await d.reads.order(c.orderId);
    if (!order || order.accountId !== c.accountId || order.purchaseSessionId !== c.purchaseSessionId) return rejected('NOT_FOUND');

    // 4. 상태 표(T2는 CREATED에서만 간다. AUTHENTICATED는 접수 트랜잭션 안에서만 있다)
    if (order.status === 'EXPIRED') return rejected('ORDER_EXPIRED');
    if (order.status !== 'CREATED') return rejected('ALREADY_ACCEPTED');

    // 5. 횟수 미리 보기(넘었으면 결제창 준비를 부르지 않는다. 정답은 주문 행을 잡은 뒤의 트랜잭션이다)
    if ((await d.reads.attemptCount(order.orderId)) >= PAYMENT_ATTEMPTS_MAX) return this.#exceeded(c, order.orderId);

    // 6. 판매 정지·좌석 저장소, 회차 판, 홀드 만료
    const blocked = await this.#slotBlock(order.eventId, c.deadline);
    if (blocked !== undefined) return rejected(blocked);
    const sale = await d.saleConfigs.get(order.eventId);
    if (!sale) return rejected('SEAT_STORE_UNAVAILABLE');
    const holdExpiresAtMs = await this.#holdExpiry(order, c.deadline);

    // 7. 결제창 준비(트랜잭션 밖) → 한 트랜잭션
    if (this.#prepareTooLate(c.deadline)) return this.#tooLate();
    const attemptId = uuidv7(d.clock);
    const prepared = await d.checkouts.prepare(this.#query(c, order, sale, attemptId));
    if (prepared.status !== 'OK') return this.#prepareFailed(prepared, holdExpiresAtMs);

    const outcome = await d.writes.start(
      c.idem,
      { orderId: order.orderId, attemptId, pg: prepared.pg, pgOrderRef: pgOrderRefOf(prepared.checkout), actor: `account:${c.accountId}` },
      transactionCallOf(c.deadline),
    );
    switch (outcome.status) {
      case 'STARTED':
        d.signals.paymentAttempt(prepared.pg, 'started');
        // 8. 첫 시도의 행동 요약만 낸다(재시도·재생은 버린다, payment §2 '결제 화면 행동 요약')
        if (outcome.attemptNo === 1) this.#emitBehavior(c, session, order);
        return { status: 201, replayed: false, attempt: attemptOf(attemptId, prepared, holdExpiresAtMs) };
      case 'REPLAYED':
        // 겹친 같은 키가 먼저 커밋했다: 방금 만든 값은 버리고 처음 시도의 결제사로 다시 만든다
        return this.#replay(c, outcome.attemptId);
      case 'ATTEMPTS_EXCEEDED':
        return this.#exceeded(c, order.orderId);
      case 'ACTIVE_CONFLICT':
        return rejected('ALREADY_ACCEPTED');
      default:
        return rejected(outcome.current === 'EXPIRED' ? 'ORDER_EXPIRED' : 'ALREADY_ACCEPTED');
    }
  }

  /**
   * 멱등 재생: 시도의 결제사로 고정해(pinnedPg) 결제창 값만 다시 만든다. 쓰지 않고 주문 상태·횟수·판매 정지를 보지 않는다.
   * 주문의 구매 세션은 본다(다르면 NOT_FOUND, 리뷰 고침 L5: 멱등 범위는 계정 × 작업이라 다른 구매 세션의 같은 키가 닿을 수 있다).
   * 처음 201을 준 요청이라 수단 거절도 400이 아니라 다시 보낼 수 있는 503이다(guidelines §4, 리뷰 고침 M4).
   * @throws Error 멱등 기록의 결과 참조가 가리키는 시도·주문이 없음(멱등 기록과 시도가 어긋났다)
   */
  async #replay(c: StartPaymentCommand, attemptId: string): Promise<StartPaymentResult> {
    const d = this.deps;
    const attempt = await d.reads.attempt(attemptId);
    if (!attempt) throw new Error('멱등 기록의 결과 참조가 가리키는 결제 시도가 없다(멱등 기록과 시도가 어긋났다)');
    const order = await d.reads.order(attempt.orderId);
    if (!order) throw new Error('멱등 기록의 결과 참조가 가리키는 주문이 없다(멱등 기록과 시도가 어긋났다)');
    if (order.purchaseSessionId !== c.purchaseSessionId) return rejected('NOT_FOUND');
    const sale = await d.saleConfigs.get(order.eventId);
    if (!sale) return rejected('SEAT_STORE_UNAVAILABLE');
    const holdExpiresAtMs = await this.#holdExpiry(order, c.deadline);
    if (this.#prepareTooLate(c.deadline)) return this.#tooLate();
    const prepared = await d.checkouts.prepare(this.#query(c, order, sale, attempt.attemptId, attempt.pg));
    if (prepared.status !== 'OK') {
      const failed = this.#prepareFailed(prepared, holdExpiresAtMs);
      return prepared.status === 'PAY_METHOD_INVALID' ? rejected('PG_UNAVAILABLE') : failed;
    }
    d.signals.paymentAttempt(prepared.pg, 'replayed');
    return { status: 201, replayed: true, attempt: attemptOf(attempt.attemptId, prepared, holdExpiresAtMs) };
  }

  /** 회차 슬롯이 막는가(판매 정지·세대 키 없음·장애). 지나가면 undefined. 망가진 세대 키(Error)는 그대로 던진다 */
  async #slotBlock(eventId: string, deadline: Deadline | undefined): Promise<StartPaymentRejection | undefined> {
    if (seatCallTooLate(deadline)) return 'DEADLINE_EXCEEDED';
    let slot: SeatSlotRead;
    try {
      slot = await this.deps.slots.read(eventId, seatCallOf(deadline));
    } catch (e) {
      if (e instanceof OrderSeatStoreUnavailable) return 'SEAT_STORE_UNAVAILABLE';
      throw e;
    }
    if (slot.status === 'NOT_READY') return 'SEAT_STORE_UNAVAILABLE';
    return slot.status === 'PAUSED' ? 'SALE_PAUSED' : undefined;
  }

  /** 응답의 holdExpiresAt 재료. 선택 칸이라 읽지 못하면 언제나 undefined다(응답을 막지 않는다). 좌석 Redis 장애·시간 모자람 밖의 오류(망가진 키)는 SEV2 설정 로그 한 줄을 남긴다(리뷰 고침 L7) */
  async #holdExpiry(order: StartOrderView, deadline: Deadline | undefined): Promise<number | undefined> {
    if (seatCallTooLate(deadline)) return undefined;
    try {
      return await this.deps.holdExpiries.expiresAt({ eventId: order.eventId, holdId: order.holdId, seatIds: order.seatIds }, seatCallOf(deadline));
    } catch (e) {
      if (!(e instanceof OrderSeatStoreUnavailable)) this.deps.log.holdExpiryUnreadable({ eventId: order.eventId });
      return undefined;
    }
  }

  #prepareTooLate(deadline: Deadline | undefined): boolean {
    return deadline !== undefined && deadline.remainingMs() < PREPARE_CHECKOUT_MIN_REMAINING_MS;
  }

  #tooLate(): StartPaymentResult {
    this.deps.signals.paymentAttempt('none', 'deadline');
    return rejected('DEADLINE_EXCEEDED');
  }

  #query(c: StartPaymentCommand, order: StartOrderView, sale: SaleConfig, attemptId: string, pinnedPg?: PaymentPg) {
    return {
      orderId: order.orderId,
      attemptId,
      eventId: order.eventId,
      amount: order.amount,
      orderName: sale.orderName ?? DEFAULT_ORDER_NAME,
      ...(c.body.payMethod !== undefined ? { payMethod: c.body.payMethod } : {}),
      ...(sale.virtualAccountAllowed !== undefined ? { virtualAccountAllowed: sale.virtualAccountAllowed } : {}),
      ...(sale.entryOpensAtMs !== undefined ? { entryOpensAtMs: sale.entryOpensAtMs } : {}),
      ...(pinnedPg !== undefined ? { pinnedPg } : {}),
      deadlineMs: budgetOf(c.deadline, PREPARE_CHECKOUT_DEADLINE_MS),
    };
  }

  #exceeded(c: StartPaymentCommand, orderId: string): StartPaymentResult {
    this.deps.log.attemptsExceeded({ accountId: c.accountId, orderId });
    this.deps.signals.paymentAttempt('none', 'exceeded');
    return rejected('ATTEMPTS_EXCEEDED');
  }

  /** 결제창 준비 실패 → 거절(시도를 만들지 않는다, ASVS 16.5.3). 새 결제 일시 정지는 홀드 만료를 읽었을 때만 남은 초를 싣는다(ADR-0085, 실제로 멈추는 일은 HOT-070) */
  #prepareFailed(prepared: Exclude<CheckoutOutcome, { status: 'OK' }>, holdExpiresAtMs: number | undefined): StartPaymentResult {
    const { signals, log, clock } = this.deps;
    switch (prepared.status) {
      case 'PG_UNAVAILABLE':
        signals.paymentAttempt('none', prepared.reason === 'deadline' ? 'deadline' : 'pg_unavailable');
        return rejected('PG_UNAVAILABLE');
      case 'PAY_METHOD_INVALID':
        signals.paymentAttempt('none', 'pay_method_invalid');
        return rejected('PAY_METHOD_INVALID');
      case 'NEW_PAYMENT_PAUSED':
        signals.paymentAttempt('none', 'new_payment_paused');
        return { status: 'REJECTED', reason: 'NEW_PAYMENT_PAUSED', ...(holdExpiresAtMs === undefined ? {} : { holdRemainingSeconds: Math.max(0, Math.ceil((holdExpiresAtMs - clock.now()) / 1000)) }) };
      default:
        signals.paymentAttempt('none', 'misconfigured');
        log.checkoutMisconfigured({ reason: prepared.reason });
        return rejected('CHECKOUT_MISCONFIGURED');
    }
  }

  /** 첫 시도의 행동 요약을 응답을 기다리지 않고 낸다. 어떤 실패든 응답을 막지 않고 telemetry_dropped_total만 올린다 */
  #emitBehavior(c: StartPaymentCommand, session: OrderSessionView, order: StartOrderView): void {
    const { behavior, signals, clock } = this.deps;
    const features = c.body.behavior;
    if (features === undefined || c.pid === undefined) return;
    const pid = c.pid;
    void Promise.resolve()
      .then(() => behavior.publish(buildBehaviorSignal({ orderId: order.orderId, eventId: order.eventId, pid, journeyId: session.journeyId, features, occurredAtMs: clock.now() })))
      .catch(() => signals.telemetryDropped('behavior_signal'));
  }
}

/** 준비 값과 시도 ID·홀드 만료 → 201 재료 */
function attemptOf(attemptId: string, p: Extract<CheckoutOutcome, { status: 'OK' }>, holdExpiresAtMs: number | undefined): StartedPayment {
  return {
    attemptId,
    pg: p.pg,
    switched: p.switched,
    ...(holdExpiresAtMs !== undefined ? { holdExpiresAtMs } : {}),
    allowedPayMethods: p.allowedPayMethods,
    ...(p.depositDueAtMs !== undefined ? { depositDueAtMs: p.depositDueAtMs } : {}),
    checkout: p.checkout,
  };
}
