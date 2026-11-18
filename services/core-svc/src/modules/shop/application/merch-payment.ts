// 굿즈 결제 시도 시작(POST /v1/shop/orders/{orderId}/payments)과 결제 접수(POST …/payment-acceptance)(ADR-0300 결정 5, ADR-0299 결정 3).
// - 시작: 주문이 CREATED이고 예약이 끝나지 않았고 접수 전이며 시도가 3회 [가정] 미만일 때만. 택배(결제대금예치 상점)는 503 pg-unavailable(BAT-605가 연다).
//   PrepareCheckout(ORDER_KIND_MERCH)을 부른 뒤 주문 행을 잠그고 다시 보고 시도를 넣는다(이전 READY는 SUPERSEDED). 예약 시각을 늘리지 않는다.
// - 접수: 한 트랜잭션(주문 잠금·조건부 재고 차감·시도 ACCEPTED·예약 연장·승인 명령 작업)을 커밋한 뒤 EXTEND와 ConfirmPayment(200ms)를 부르고 202.
//   ConfirmPayment가 받아지지 않으면 작업이 다시 보낸다(merch-payment-results.ts). 만료면 409 order-expired이고 결제사를 부르지 않는다.
import { uuidv7, type Clock, type IdempotencyRequest } from '@peaket/platform';
import {
  type AcceptBody,
  attemptStartBlocker,
  badRequest,
  CONFIRM_DEADLINE_MS,
  confirmRetryDelayMs,
  dependencyUnavailable,
  merchSoldOut,
  orderNotFound,
  paymentRefOf,
  pgUnavailable,
  PULL_PENDING_MS,
  ShopProblem,
} from '../domain/merch-order.js';
import { CheckoutFailed, type CheckoutValues, type MerchPayments, type MerchStock, type ShopOrderStore } from '../domain/merch-ports.js';
import { type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

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
}

/** 굿즈 결제 시도 응답에 내는 결제수단(가상계좌는 뺀다, ADR-0299 결정 3) */
const PAY_METHODS = new Set(['CARD', 'EASY_PAY', 'TRANSFER', 'MOBILE']);

export class MerchPayment {
  readonly #log: ShopLogger;

  constructor(private readonly d: MerchPaymentDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  async start(accountId: string, orderId: string, body: { payMethod?: string | undefined }, once: IdempotencyRequest): Promise<PaymentAttemptView> {
    const replay = await this.d.store.replayOf(once);
    if (replay !== undefined) return JSON.parse(replay) as PaymentAttemptView;
    const detail = await this.d.store.findOrder(orderId.toLowerCase());
    if (!detail || detail.order.accountId !== accountId) throw orderNotFound();
    const nowMs = this.d.clock.now();
    const blocked = attemptStartBlocker(detail, nowMs);
    if (blocked) throw blocked;
    // 택배 주문의 결제대금예치 상점 결제창 값은 BAT-605(LCH-030)가 더한다(ADR-0299 결정 3)
    if (detail.order.fulfillment === 'DELIVERY') throw pgUnavailable();
    if (body.payMethod === 'VIRTUAL_ACCOUNT') throw badRequest('virtual_account_not_allowed');
    const attemptId = uuidv7(this.d.clock);
    const names = detail.items.map((i) => i.productName);
    const orderName = names.length > 1 ? `${names[0]} 외 ${names.length - 1}건` : (names[0] ?? '굿즈 주문');
    let answer;
    try {
      answer = await this.d.payments.prepareCheckout({ orderId: detail.order.orderId, attemptId, eventId: detail.order.eventId, amount: detail.order.amount, orderName, payMethod: body.payMethod });
    } catch (e) {
      if (!(e instanceof CheckoutFailed)) throw e;
      if (e.reason === 'unavailable') throw pgUnavailable();
      if (e.reason === 'invalid') throw badRequest('checkout_invalid');
      if (e.reason === 'paused') throw new ShopProblem('new-payment-paused', 503, '새 결제를 잠시 멈췄습니다', 5);
      this.#log.error({ kind: 'merch-checkout-failed', severity: 'SEV2', orderId: detail.order.orderId }, '굿즈 결제창 준비가 설정 오류로 끝났다');
      throw dependencyUnavailable();
    }
    const view: PaymentAttemptView = {
      attemptId,
      pg: answer.pg,
      switched: answer.switched,
      holdExpiresAt: detail.order.stockReservedUntil.toISOString(),
      allowedPayMethods: answer.allowedPayMethods.filter((m) => PAY_METHODS.has(m)),
      checkout: answer.checkout,
    };
    const saved = await this.d.store.saveAttempt(once, { orderId: detail.order.orderId, accountId, attemptId, pg: answer.pg, payMethod: body.payMethod ?? null, nowMs: this.d.clock.now(), responseJson: JSON.stringify(view) });
    return saved.kind === 'replay' ? (JSON.parse(saved.resultRef) as PaymentAttemptView) : view;
  }

  async accept(accountId: string, orderId: string, body: AcceptBody, once: IdempotencyRequest): Promise<void> {
    const replay = await this.d.store.replayOf(once);
    if (replay !== undefined) return this.#replay(replay);
    const ref = paymentRefOf(body);
    if (!ref) throw badRequest('payment_ref_invalid');
    const nowMs = this.d.clock.now();
    const out = await this.d.store.acceptPayment(once, { orderId: orderId.toLowerCase(), accountId, nowMs, body, ref });
    if (out.kind === 'replay') return this.#replay(out.resultRef);
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

  #replay(ref: string): void {
    if (ref === 'sold-out') throw merchSoldOut();
  }
}
