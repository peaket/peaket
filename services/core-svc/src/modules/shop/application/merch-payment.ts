// 굿즈 결제 시도 시작(POST /v1/shop/orders/{orderId}/payments)과 결제 접수(POST …/payment-acceptance)(ADR-0300 결정 5, ADR-0299 결정 3).
// - 시작: 주문이 CREATED이고 예약이 끝나지 않았고 접수 전이며 시도가 3회 [가정] 미만일 때만. 택배(결제대금예치 상점)는 503 pg-unavailable(BAT-605가 연다).
//   PrepareCheckout(ORDER_KIND_MERCH)을 부른 뒤 주문 행을 잠그고 다시 보고 시도를 넣는다(이전 READY는 SUPERSEDED). 예약 시각을 늘리지 않는다.
// - 접수: 한 트랜잭션(주문 잠금·조건부 재고 차감·시도 ACCEPTED·예약 연장·승인 명령 작업)을 커밋한 뒤 EXTEND와 ConfirmPayment(200ms)를 부르고 202.
//   ConfirmPayment가 받아지지 않으면 작업이 다시 보낸다(merch-payment-results.ts). 만료면 409 order-expired이고 결제사를 부르지 않는다.
// - 같은 키 다시 오기(ADR-0337 결정 6): 저장한 결과가 경로 주문·세션 계정의 것인지 본 뒤에만 돌려준다. 시작은 시도 ID가 경로 주문의 시도이고
//   결제사가 그 시도의 결제사이며 결제창 금액이 주문 금액일 때, 접수는 참조가 accepted·sold-out이고 경로 주문이 세션 계정의 것일 때다.
//   맞지 않으면 쓰기·결제사 호출 없이 남의 주문과 같은 404이고 보안 이벤트 로그 한 줄이다.
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
  orderNotFound,
  payMethodBlockedByStore,
  payMethodsForStore,
  paymentRefOf,
  pgUnavailable,
  PULL_PENDING_MS,
  ShopProblem,
} from '../domain/merch-order.js';
import { CheckoutFailed, type CheckoutValues, type MerchPayments, type MerchStock, type ShopOrderStore } from '../domain/merch-ports.js';
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
    const allowed = new Set(payMethodsForStore(detail.order.pgStore));
    const view: PaymentAttemptView = {
      attemptId,
      pg: answer.pg,
      switched: answer.switched,
      holdExpiresAt: detail.order.stockReservedUntil.toISOString(),
      allowedPayMethods: answer.allowedPayMethods.filter((m) => allowed.has(m)),
      checkout: answer.checkout,
      ...(answer.depositDueAtMs === undefined ? {} : { depositDueAt: new Date(answer.depositDueAtMs).toISOString() }),
    };
    this.d.signals?.escrowPayment(detail.order.pgStore === 'ESCROW' ? 'prepared' : 'standard');
    const saved = await this.d.store.saveAttempt(once, { orderId: detail.order.orderId, accountId, attemptId, pg: answer.pg, payMethod: body.payMethod ?? null, nowMs: this.d.clock.now(), responseJson: JSON.stringify(view) });
    return saved.kind === 'replay' ? this.#startReplay(accountId, orderId, saved.resultRef, once.operation) : view;
  }

  /**
   * 시작의 같은 키 다시 오기. 대조는 처음 응답 뒤에도 바뀌지 않는 사실만 본다(소유 계정, 시도가 속한 주문, 시도의 결제사, 주문 금액).
   * 그래서 그 뒤 시도가 대체·만료되었어도 처음 응답을 그대로 돌려준다(guidelines §4 '돌려주는 응답')
   */
  async #startReplay(accountId: string, orderId: string, ref: string, operation: string): Promise<PaymentAttemptView> {
    const path = orderId.toLowerCase();
    const view = attemptViewOf(ref);
    if (view !== undefined) {
      const detail = await this.d.store.findOrder(path);
      const attempt = detail && detail.order.accountId === accountId ? await this.d.store.paymentAttempt(view.attemptId) : undefined;
      if (detail && attempt && attempt.orderId === detail.order.orderId && attempt.pg === view.pg && checkoutAmountOf(view) === detail.order.amount) return view;
    }
    throw replayMismatch(this.#log, operation, path);
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

/** 저장한 결제 시도 응답(JSON)을 읽는다. 읽지 못하거나 대조할 칸이 없으면 undefined */
function attemptViewOf(ref: string): PaymentAttemptView | undefined {
  let v: unknown;
  try {
    v = JSON.parse(ref);
  } catch {
    return undefined;
  }
  if (typeof v !== 'object' || v === null) return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.attemptId !== 'string' || typeof o.pg !== 'string' || typeof o.checkout !== 'object' || o.checkout === null) return undefined;
  return v as PaymentAttemptView;
}

/** 결제창 금액: 포트원은 totalAmount, 토스·시뮬레이터는 amount(openapi PaymentAttempt.checkout). 숫자가 아니면 undefined */
function checkoutAmountOf(v: PaymentAttemptView): number | undefined {
  const c = v.checkout as Record<string, unknown>;
  const amount = v.pg === 'PORTONE' ? c.totalAmount : c.amount;
  return typeof amount === 'number' ? amount : undefined;
}
