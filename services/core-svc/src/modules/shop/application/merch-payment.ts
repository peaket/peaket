// 굿즈 결제 시도 시작(POST /v1/shop/orders/{orderId}/payments)과 결제 접수(POST …/payment-acceptance)(ADR-0300 결정 5, ADR-0299 결정 3).
// - 시작: 주문이 CREATED이고 예약이 끝나지 않았고 접수 전이며 시도가 3회 [가정] 미만일 때만. 택배(결제대금예치 상점)는 503 pg-unavailable(BAT-605가 연다).
//   PrepareCheckout(ORDER_KIND_MERCH)을 부른 뒤 주문 행을 잠그고 다시 보고 시도를 넣는다(이전 READY는 SUPERSEDED). 예약 시각을 늘리지 않는다.
// - 접수: 한 트랜잭션(주문 잠금·조건부 재고 차감·시도 ACCEPTED·예약 연장·승인 명령 작업)을 커밋한 뒤 EXTEND와 ConfirmPayment(200ms)를 부르고 202.
//   ConfirmPayment가 받아지지 않으면 작업이 다시 보낸다(merch-payment-results.ts). 만료면 409 order-expired이고 결제사를 부르지 않는다.
// - 같은 키 다시 오기(ADR-0337 결정 6, ADR-0352): 저장한 결과가 경로 주문·세션 계정의 것인지 본 뒤에만 돌려준다. 시작의 결과 참조는 시도 ID 하나이고,
//   재생은 PrepareCheckout을 같은 시도 ID·고정 결제사로 다시 불러 지금 설정의 결제창 값을 만든다. 재생이 만든 결제사·금액·주문이 어긋나면 503이다.
//   접수는 참조가 accepted·sold-out이고 경로 주문이 세션 계정의 것일 때다. 맞지 않으면 쓰기·결제사 호출 없이 남의 주문과 같은 404이고 보안 이벤트 로그 한 줄이다.
import { uuidv7, type Clock, type IdempotencyRequest } from '@peaket/platform';
import {
  type AcceptBody,
  attemptStartBlocker,
  badRequest,
  CONFIRM_DEADLINE_MS,
  confirmRetryDelayMs,
  dependencyUnavailable,
  escrowLinesOf,
  merchSoldOut,
  type MerchAttempt,
  orderNotFound,
  payMethodBlockedByStore,
  payMethodsForStore,
  paymentRefOf,
  pgUnavailable,
  PULL_PENDING_MS,
  ShopProblem,
  type ShopOrderDetail,
} from '../domain/merch-order.js';
import { type CheckoutAnswer, CheckoutFailed, type CheckoutValues, type MerchPayments, type MerchStock, type ShopOrderStore } from '../domain/merch-ports.js';
import { replayMismatch, type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

export interface MerchPaymentDeps {
  store: ShopOrderStore;
  stock: MerchStock;
  payments: MerchPayments;
  clock: Clock;
  signals?: ShopSignals;
  logger?: ShopLogger;
}

export interface PaymentAttemptView {
  attemptId: string;
  pg: 'TOSS' | 'PORTONE' | 'SIMULATOR';
  switched: boolean;
  holdExpiresAt: string;
  allowedPayMethods: string[];
  checkout: CheckoutValues;
  /** 입금 기한(가상계좌를 낼 수 있을 때만) */
  depositDueAt?: string;
}

export class MerchPayment {
  readonly #log: ShopLogger;

  constructor(private readonly d: MerchPaymentDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  async start(accountId: string, orderId: string, body: { payMethod?: string | undefined }, once: IdempotencyRequest): Promise<PaymentAttemptView> {
    const replay = await this.d.store.replayOf(once);
    if (replay !== undefined) return this.#startReplay(accountId, orderId, replay, once.operation);
    const detail = await this.d.store.findOrder(orderId.toLowerCase());
    if (!detail || detail.order.accountId !== accountId) throw orderNotFound();
    const nowMs = this.d.clock.now();
    const blocked = attemptStartBlocker(detail, nowMs);
    if (blocked) throw blocked;
    // 에스크로 상점은 간편결제·휴대폰을 낼 수 없다(코어가 결제사를 부르기 전에 400, P-T59 ③)
    if (payMethodBlockedByStore(detail.order.pgStore, body.payMethod)) throw badRequest('checkout_invalid');
    const attemptId = uuidv7(this.d.clock);
    const names = detail.items.map((i) => i.productName);
    const orderName = names.length > 1 ? `${names[0]} 외 ${names.length - 1}건` : (names[0] ?? '굿즈 주문');
    let answer;
    try {
      answer = await this.d.payments.prepareCheckout({
        orderId: detail.order.orderId,
        attemptId,
        eventId: detail.order.eventId,
        amount: detail.order.amount,
        orderName,
        payMethod: body.payMethod,
        pgStore: detail.order.pgStore,
        ...(detail.order.pgStore === 'ESCROW' ? { escrowProducts: escrowLinesOf(detail.items) } : {}),
        // 굿즈는 가상계좌(입금 대기 O2~O4)를 받는다(ADR-0314)
        virtualAccountAllowed: true,
      });
    } catch (e) {
      if (!(e instanceof CheckoutFailed)) throw e;
      if (e.reason === 'unavailable') throw pgUnavailable();
      if (e.reason === 'invalid') throw badRequest('checkout_invalid');
      if (e.reason === 'paused') throw new ShopProblem('new-payment-paused', 503, '새 결제를 잠시 멈췄습니다', 5);
      this.#log.error({ kind: 'merch-checkout-failed', severity: 'SEV2', orderId: detail.order.orderId }, '굿즈 결제창 준비가 설정 오류로 끝났다');
      throw dependencyUnavailable();
    }
    const view = this.#viewOf(detail, attemptId, answer);
    this.d.signals?.escrowPayment(detail.order.pgStore === 'ESCROW' ? 'prepared' : 'standard');
    // 결과 참조는 저장소가 시도 ID로 쓴다. 결제창 값은 DB에 두지 않는다(ADR-0352)
    const saved = await this.d.store.saveAttempt(once, { orderId: detail.order.orderId, accountId, attemptId, pg: answer.pg, payMethod: body.payMethod ?? null, nowMs: this.d.clock.now() });
    return saved.kind === 'replay' ? this.#startReplay(accountId, orderId, saved.resultRef, once.operation) : view;
  }

  /** 새 시도·재생의 201 재료. 재생은 지금 주문의 재고 예약 만료와 지금 설정의 결제창 값을 싣는다 */
  #viewOf(detail: ShopOrderDetail, attemptId: string, answer: CheckoutAnswer): PaymentAttemptView {
    const allowed = new Set(payMethodsForStore(detail.order.pgStore));
    return {
      attemptId,
      pg: answer.pg,
      switched: answer.switched,
      holdExpiresAt: detail.order.stockReservedUntil.toISOString(),
      allowedPayMethods: answer.allowedPayMethods.filter((m) => allowed.has(m)),
      checkout: answer.checkout,
      ...(answer.depositDueAtMs === undefined ? {} : { depositDueAt: new Date(answer.depositDueAtMs).toISOString() }),
    };
  }

  /**
   * 시작의 같은 키 다시 오기(ADR-0352). 결과 참조에서 시도 ID만 읽고(옛 JSON 참조는 그 안의 ID만), 경로 주문·세션 계정의 시도인지 본 뒤
   * PrepareCheckout을 같은 시도 ID·고정 결제사로 다시 불러 결제창 값을 지금 설정으로 만든다. 대조는 처음 응답 뒤에도 바뀌지 않는 사실만 본다.
   * 맞지 않으면 쓰기·PrepareCheckout 없이 남의 주문과 같은 404이고 보안 이벤트 로그 한 줄이다.
   */
  async #startReplay(accountId: string, orderId: string, ref: string, operation: string): Promise<PaymentAttemptView> {
    const path = orderId.toLowerCase();
    const attemptId = attemptIdOf(ref);
    if (attemptId !== undefined) {
      const detail = await this.d.store.findOrder(path);
      if (detail && detail.order.accountId === accountId) {
        const attempt = await this.d.store.paymentAttempt(attemptId);
        if (attempt && attempt.orderId === detail.order.orderId) {
          const answer = await this.#prepareReplay(detail, attempt);
          this.#checkReplay(detail, attempt, answer);
          return this.#viewOf(detail, attempt.attemptId, answer);
        }
      }
    }
    throw replayMismatch(this.#log, operation, path);
  }

  /**
   * 재생의 결제창 준비. 처음 201을 준 요청이라 준비 실패는 400이 아니라 5xx이고, 같은 키로 다시 보낼 수 있다(ADR-0352 결정 5).
   * 다른 결제사·다른 상점으로 넘어가지 않는다(pinnedPg).
   */
  async #prepareReplay(detail: ShopOrderDetail, attempt: MerchAttempt): Promise<CheckoutAnswer> {
    const names = detail.items.map((i) => i.productName);
    const orderName = names.length > 1 ? `${names[0]} 외 ${names.length - 1}건` : (names[0] ?? '굿즈 주문');
    try {
      return await this.d.payments.prepareCheckout({
        orderId: detail.order.orderId,
        attemptId: attempt.attemptId,
        eventId: detail.order.eventId,
        amount: detail.order.amount,
        orderName,
        payMethod: attempt.payMethod ?? undefined,
        pgStore: detail.order.pgStore,
        ...(detail.order.pgStore === 'ESCROW' ? { escrowProducts: escrowLinesOf(detail.items) } : {}),
        virtualAccountAllowed: true,
        pinnedPg: attempt.pg,
      });
    } catch (e) {
      if (!(e instanceof CheckoutFailed)) throw e;
      switch (e.reason) {
        case 'unavailable':
        case 'invalid':
          throw pgUnavailable();
        case 'paused':
          throw new ShopProblem('new-payment-paused', 503, '새 결제를 잠시 멈췄습니다', 5);
        default:
          throw dependencyUnavailable();
      }
    }
  }

  /** 재생이 만든 결제사·금액·주문 ID가 시도·주문과 어긋나면 결제창 값을 돌려주지 않는다(다른 상점·다른 금액 차단, ADR-0352 결정 4) */
  #checkReplay(detail: ShopOrderDetail, attempt: MerchAttempt, answer: CheckoutAnswer): void {
    const field =
      answer.pg !== attempt.pg
        ? 'pg'
        : checkoutAmountOf(answer.checkout, answer.pg) !== detail.order.amount
          ? 'amount'
          : checkoutOrderIdOf(answer.checkout, answer.pg) !== detail.order.orderId
            ? 'orderId'
            : undefined;
    if (field === undefined) return;
    this.#log.error({ kind: 'merch-checkout-replay-mismatch', severity: 'SEV2', orderId: detail.order.orderId, field }, '결제창 재생 값이 시도·주문과 어긋난다');
    throw dependencyUnavailable();
  }

  async accept(accountId: string, orderId: string, body: AcceptBody, once: IdempotencyRequest): Promise<void> {
    const replay = await this.d.store.replayOf(once);
    if (replay !== undefined) return this.#acceptReplay(accountId, orderId, replay, once.operation);
    const ref = paymentRefOf(body);
    if (!ref) throw badRequest('payment_ref_invalid');
    const nowMs = this.d.clock.now();
    const out = await this.d.store.acceptPayment(once, { orderId: orderId.toLowerCase(), accountId, nowMs, body, ref });
    if (out.kind === 'replay') return this.#acceptReplay(accountId, orderId, out.resultRef, once.operation);
    if (out.kind === 'sold-out') {
      // 주문 FAILED는 커밋했다. Redis 예약을 풀어 카운터를 돌린다(실패하면 만료 작업이 FAILED 주문의 원소로 돌린다)
      for (const l of out.limited) {
        try {
          await this.d.stock.release(l.productId, orderId.toLowerCase(), true, accountId);
        } catch {
          this.#log.warn({ kind: 'merch-stock-release-failed', orderId }, '품절로 끝낸 주문의 예약을 풀지 못했다(만료 작업이 돌린다)');
        }
      }
      this.d.signals?.order('sold_out');
      throw merchSoldOut();
    }
    for (const l of out.limited) {
      try {
        await this.d.stock.extend(l.productId, out.job.orderId, out.reservedUntil.getTime(), accountId);
      } catch {
        // 연장하지 못해도 만료 작업은 접수한 주문을 끝내지 않고 점수만 미룬다(ADR-0300 결정 7)
        this.#log.warn({ kind: 'merch-stock-extend-failed', orderId: out.job.orderId }, '결제 접수 뒤 예약을 늘리지 못했다');
      }
    }
    const outcome = await this.d.payments.confirm(out.job, CONFIRM_DEADLINE_MS);
    const now = this.d.clock.now();
    if (outcome.status === 'ACCEPTED') await this.d.store.markConfirmSent(out.job.orderId, now + PULL_PENDING_MS);
    else await this.d.store.rescheduleJob(out.job.orderId, now + confirmRetryDelayMs(1), { tries: 1 });
  }

  /** 접수의 같은 키 다시 오기. 참조는 두 값(accepted·sold-out)뿐이고 경로 주문이 세션 계정의 것이어야 한다. sold-out만 409다 */
  async #acceptReplay(accountId: string, orderId: string, ref: string, operation: string): Promise<void> {
    const path = orderId.toLowerCase();
    if (ref === 'accepted' || ref === 'sold-out') {
      const detail = await this.d.store.findOrder(path);
      if (detail && detail.order.accountId === accountId) {
        if (ref === 'sold-out') throw merchSoldOut();
        return;
      }
    }
    throw replayMismatch(this.#log, operation, path);
  }
}

const ATTEMPT_REF = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * 결과 참조에서 시도 ID를 읽는다. 새 참조는 UUID 하나이고, 옛 참조(배포 전)는 처음 응답 JSON이다.
 * 옛 JSON에서는 `attemptId` 하나만 쓰고 결제창 값·결제사·금액은 버린다(ADR-0352 결정 6).
 */
function attemptIdOf(ref: string): string | undefined {
  if (ATTEMPT_REF.test(ref)) return ref;
  let v: unknown;
  try {
    v = JSON.parse(ref);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const id = (v as { attemptId?: unknown }).attemptId;
  return typeof id === 'string' && ATTEMPT_REF.test(id) ? id : undefined;
}

/** 결제창 금액: 포트원은 totalAmount, 토스·시뮬레이터는 amount(openapi PaymentAttempt.checkout). 숫자가 아니면 undefined */
function checkoutAmountOf(c: CheckoutValues, pg: MerchAttempt['pg']): number | undefined {
  const amount = pg === 'PORTONE' ? (c as { totalAmount?: unknown }).totalAmount : (c as { amount?: unknown }).amount;
  return typeof amount === 'number' ? amount : undefined;
}

/** 결제창의 주문 ID: 토스는 orderId, 포트원은 paymentId의 `pay-{orderId}`와 customData.orderId다. 다르면 undefined(어긋남) */
function checkoutOrderIdOf(c: CheckoutValues, pg: MerchAttempt['pg']): string | undefined {
  if (pg !== 'PORTONE') {
    const id = (c as { orderId?: unknown }).orderId;
    return typeof id === 'string' ? id : undefined;
  }
  const paymentId = (c as { paymentId?: unknown }).paymentId;
  const custom = (c as { customData?: { orderId?: unknown } }).customData?.orderId;
  const fromPayment = typeof paymentId === 'string' && paymentId.startsWith('pay-') ? paymentId.slice(4) : undefined;
  const fromCustom = typeof custom === 'string' ? custom : undefined;
  if (fromCustom !== undefined && fromPayment !== undefined && fromCustom !== fromPayment) return undefined;
  return fromCustom ?? fromPayment;
}

