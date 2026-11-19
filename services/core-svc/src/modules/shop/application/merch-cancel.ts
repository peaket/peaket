// 굿즈·부가 상품 구매자 취소(POST /v1/shop/orders/{orderId}/cancellations, ADR-0315, POL-016 §1.4, P-T59 ④·P-T61·P-T63·P-T64·V-T35 ③).
// 차례: 멱등 다시 오기 → 주문 소유(남의 주문·없는 주문 같은 404) → 항목·자격(READY, 부가 상품은 입장 시작 전, 에스크로는 전체만) →
// 계좌 모양(400) → 결제 원장 읽기(가상계좌였는지, 실패 503) → 가상계좌인데 계좌 없음(422) → 재인증(계좌를 보낸 요청, 403·503) →
// 환급 행·항목 자리·멱등 기록을 한 트랜잭션으로(항목 상태는 아직 바꾸지 않는다) → CancelPayment(같은 취소 ID) → 결과 반영.
// 계좌는 이 요청 안에서만 쓰고 저장·로그하지 않는다. 카드 결제에 온 계좌는 결제사로 보내지 않는다.
import { uuidv7, type Clock, type IdempotencyRequest } from '@peaket/platform';
import { refundAccountShape, type RefundAccountValue } from '@peaket/validation/refund-account';
import {
  badRequest,
  dependencyUnavailable,
  entryStarted,
  GET_PAYMENT_DEADLINE_MS,
  orderNotFound,
  refundAccountRequired,
  refundRetryNextDelayMs,
  reauthRequired,
  reauthUnavailable,
  resolveCancelItems,
  type CancelStatus,
  type ShopOrderDetail,
} from '../domain/merch-order.js';
import { type CancelOutcome, type MerchPayments, ReauthUnavailable, type ShopOrderStore, type ShopReauthGate } from '../domain/merch-ports.js';
import { type ShopLogger, type ShopSignals, silentShopLogger } from './shop-signals.js';

export interface MerchCancelDeps {
  store: ShopOrderStore;
  payments: MerchPayments;
  reauth: ShopReauthGate;
  clock: Clock;
  signals?: ShopSignals;
  logger?: ShopLogger;
}

export type CancellationBody = { itemIds?: string[] | undefined; refundAccount?: RefundAccountValue | undefined };

export interface CancellationView {
  cancellationId: string;
  status: CancelStatus;
  refundAmount: number;
  refundAccountRequired?: boolean;
}

/**
 * 결제사 취소는 성공했는데 환급 결과 DB 쓰기가 실패했다(RV-07). 유스케이스는 이 오류를 던져
 * 호출 쪽이 202 REFUND_PENDING으로 답하게 한다(원인 메시지·스택은 보존).
 */
export class RefundResultWriteFailed extends Error {
  constructor(
    readonly cancellationId: string,
    readonly refundAmount: number,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : '환급 결과를 적지 못했다', { cause });
    this.name = 'RefundResultWriteFailed';
  }
}

export class MerchCancel {
  readonly #log: ShopLogger;

  constructor(private readonly d: MerchCancelDeps) {
    this.#log = d.logger ?? silentShopLogger;
  }

  /** @throws ShopProblem 400 invalid-body · 403 reauth-required · 404 not-found · 409 · 422 refund-account-required · 503 */
  async run(accountId: string, sessionId: string, orderId: string, body: CancellationBody, once: IdempotencyRequest, reauthToken?: string): Promise<CancellationView> {
    const replay = await this.d.store.replayOf(once);
    if (replay !== undefined) return this.#replay(replay);
    const detail = await this.d.store.findOrder(orderId.toLowerCase());
    if (!detail || detail.order.accountId !== accountId) throw orderNotFound();
    const nowMs = this.d.clock.now();
    // 계좌 모양은 재인증·결제사 호출 앞에서 본다(틀리면 400 invalid-body, P-T63 ③)
    const shape = body.refundAccount === undefined ? undefined : refundAccountShape(body.refundAccount);
    if (shape !== undefined && !shape.ok) throw badRequest('invalid-body');
    const account = shape?.value;
    const entryOpensAtMs = await this.#entryOf(detail);
    // WALLET인데 연결 회차 입장 시각을 읽지 못하면(eventId 없음·event 행 없음) 닫힌 쪽으로 답한다(RV-04)
    if (detail.order.fulfillment === 'WALLET' && entryOpensAtMs === undefined) throw entryStarted();
    const selection = resolveCancelItems(detail, body.itemIds, entryOpensAtMs, nowMs);
    // 결제 수단(가상계좌였는지)을 읽는다. 읽지 못하면 아무것도 쓰지 않고 503이다
    let payment;
    try {
      const getPayment = this.d.payments.getPayment;
      if (getPayment === undefined) throw new Error('결제 원장 읽기 포트가 없다');
      payment = await getPayment.call(this.d.payments, detail.order.orderId, GET_PAYMENT_DEADLINE_MS);
    } catch {
      this.d.signals?.cancellation('invalid');
      throw dependencyUnavailable();
    }
    if (payment === undefined) throw dependencyUnavailable();
    if (payment.virtualAccountPaid === true && account === undefined) {
      this.d.signals?.cancellation('invalid');
      throw refundAccountRequired();
    }
    // 카드 결제에 온 계좌는 버린다(지표 1). 결제사로 보내지 않는다
    if (account !== undefined && payment.virtualAccountPaid !== true) this.d.signals?.refundAccountIgnored.inc();
    // 계좌를 보낸 요청은 재인증 필수(op = SHOP_CANCEL_REFUND_ACCOUNT, act = FAN_HIGH_RISK, ADR-0293)
    if (account !== undefined) {
      let passed: boolean;
      try {
        passed = await this.d.reauth.verify(reauthToken, { accountId, sessionId, act: 'FAN_HIGH_RISK', op: 'SHOP_CANCEL_REFUND_ACCOUNT' });
      } catch (e) {
        if (e instanceof ReauthUnavailable) {
          this.d.signals?.reauth('unavailable', 'store');
          throw reauthUnavailable();
        }
        throw e;
      }
      if (!passed) {
        this.d.signals?.reauth('rejected', 'token');
        throw reauthRequired();
      }
      this.d.signals?.reauth('accepted', 'ok');
    }
    const refundId = uuidv7(this.d.clock);
    const created = await this.d.store.createCancellation(once, {
      refundId,
      orderId: detail.order.orderId,
      accountId,
      itemIds: selection.items.map((i) => i.itemId),
      nowMs,
      ...(entryOpensAtMs === undefined ? {} : { entryOpensAtMs }),
    });
    if (created.kind === 'replay') return this.#replay(created.resultRef);
    const amount = created.refund.amount;
    // 카드 결제에 온 계좌는 결제사로 보내지 않는다(P-T63 ④)
    const sendAccount = payment.virtualAccountPaid === true ? account : undefined;
    const paymentId = detail.order.paymentId ?? created.refund.paymentId;
    if (paymentId === null) throw dependencyUnavailable();
    const outcome = await this.d.payments.cancel({
      paymentId,
      cancellationId: refundId,
      amount,
      reason: 'USER_CANCEL',
      ...(sendAccount === undefined ? {} : { refundAccount: sendAccount }),
    });
    const settledAt = this.d.clock.now();
    if (outcome === 'CANCELLED') {
      await this.#record(refundId, amount, outcome, settledAt, { attempts: 0 });
      this.d.signals?.cancellation('refunded');
      return { cancellationId: refundId, status: 'REFUNDED', refundAmount: amount };
    }
    if (outcome === 'REFUND_ACCOUNT_REQUIRED' || outcome === 'REJECTED') {
      await this.#record(refundId, amount, outcome, settledAt, {
        attempts: 0,
        failReason: outcome === 'REFUND_ACCOUNT_REQUIRED' ? 'REFUND_ACCOUNT_REQUIRED' : 'PG_REJECTED',
        ...(outcome === 'REFUND_ACCOUNT_REQUIRED' ? { accountRequiredAtMs: settledAt } : {}),
      });
      this.d.signals?.cancellation('rejected');
      // 결제사가 계좌를 거절했다. 입력 칸을 다시 받는다(openapi 422)
      throw refundAccountRequired();
    }
    // CANCEL_PENDING·UNKNOWN: 취소 효력은 즉시, 환급은 다시 부른다
    await this.#record(refundId, amount, outcome, settledAt, { attempts: 0, nextAtMs: settledAt + (refundRetryNextDelayMs(0) ?? 0) });
    this.d.signals?.cancellation('pending');
    return { cancellationId: refundId, status: 'REFUND_PENDING', refundAmount: amount };
  }

  /**
   * 환급 결과 반영. DB 쓰기가 실패하면 RefundResultWriteFailed를 던져 받는 층이 202 REFUND_PENDING으로 답한다
   * (결제사 취소는 이미 나갔고, 재시도가 같은 취소 ID로 끝낸다, RV-07)
   */
  async #record(
    refundId: string,
    amount: number,
    outcome: CancelOutcome,
    nowMs: number,
    o: { attempts?: number; nextAtMs?: number | null; failReason?: string; accountRequiredAtMs?: number },
  ): Promise<void> {
    try {
      await this.d.store.refundResult(refundId, outcome, nowMs, o);
    } catch (e) {
      this.d.signals?.userRefund('error');
      this.#log.error({ kind: 'merch-cancel-refund-write-failed', cancellationId: refundId, err: e instanceof Error ? e.name : 'unknown' }, '결제사 취소는 나갔는데 환급 결과를 적지 못했다(재시도가 같은 취소 ID로 끝낸다)');
      throw new RefundResultWriteFailed(refundId, amount, e);
    }
  }

  async #entryOf(detail: ShopOrderDetail): Promise<number | undefined> {
    if (detail.order.eventId === null || !detail.items.some((i) => i.fulfillment === 'WALLET')) return undefined;
    const at = await this.d.store.eventEntryOpensAt(detail.order.eventId);
    return at?.getTime();
  }

  /** 같은 키 다시 오기. 환급 행의 지금 상태로 같은 답을 만든다(거절은 같은 4xx, 이미 환급이면 REFUNDED) */
  async #replay(ref: string): Promise<CancellationView> {
    if (!ref.startsWith('cancel:')) throw badRequest('invalid-body');
    const row = await this.d.store.cancelView(ref.slice('cancel:'.length));
    if (row === undefined) throw dependencyUnavailable();
    if (row.state === 'REJECTED') {
      this.d.signals?.cancellation('rejected');
      throw refundAccountRequired();
    }
    return {
      cancellationId: row.cancellationId,
      status: row.state === 'CANCELLED' ? 'REFUNDED' : 'REFUND_PENDING',
      refundAmount: row.refundAmount,
      ...(row.refundAccountRequired ? { refundAccountRequired: true } : {}),
    };
  }
}
