// shop 굿즈 주문의 운영 지표와 로그 면(docs/observability.md 서비스 템플릿 운영 확인 표의 core-svc shop 줄, BAT-600·BAT-605).
// - merch_orders_total{outcome}: 주문·결제의 끝(created·sold_out·in_progress·paid·failed·expired)
// - merch_stock_expired_total: 만료 작업이 끝낸 결제 전 주문 수
// - merch_payment_pull_failures_total: 결과 당기기(BatchGetPayments)가 실패한 묶음 수
// - merch_refunds_total{outcome}: 미수령 환급 결과(cancelled·pending·rejected)
// - shop_escrow_payments_total{result}: 에스크로 상점 결제창(prepared·standard)
// - shop_deposit_total{result}: 입금 대기·확인·만료(waiting·approved·expired)
// - shop_cancellations_total{result}: 구매자 취소(refunded·pending·rejected·invalid)
// - shop_returns_total{result}: 반품 요청(requested·rejected)
// - shop_refund_total{result}: 구매자 취소 환급 다시 부르기(cancelled·pending·rejected·error)
// - shop_refund_account_total{result}: 굿즈 지연 환급 계좌 다시 받기(accepted·refunded·pending·rejected·invalid)
// - shop_reauth_total{result,reason}: 재인증(accepted·rejected·unavailable)
// - shop_product_attributes_invalid: 마지막 속성 검증 잡이 찾은 틀린 상품 수(게이지, ADR-0300 결정 2)
// 로그 면은 플랫폼 로거의 warn·error만 쓴다. 결제 참조·계좌·개인 값은 싣지 않는다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import { orderNotFound, type ShopProblem } from '../domain/merch-order.js';

export interface ShopLogger {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  error(o: object, msg: string): void;
}

/** 로그를 남기지 않는 면(시험·조립 전) */
export const silentShopLogger: ShopLogger = { info: () => {}, warn: () => {}, error: () => {} };

/**
 * 멱등 재생의 결과 참조가 지금 요청의 계정·경로 주문에 속하지 않는다(ADR-0337 결정 6). 보안 이벤트로 오류 로그 한 줄을 남기고(authz-matrix §2의 7)
 * 남의 주문과 같은 404 not-found를 돌려준다(받는 쪽이 던진다). 로그에는 작업과 경로의 주문 ID만 싣고 계정 ID·결과 참조 원문은 싣지 않는다.
 * 경로에 주문이 없는 작업(주문 만들기·부가 상품 주문)은 orderId를 비운다(참조한 주문 ID도 싣지 않는다)
 */
export function replayMismatch(log: ShopLogger, operation: string, orderId?: string): ShopProblem {
  log.error({ kind: 'idempotency-replay-mismatch', severity: 'SEV2', operation, ...(orderId === undefined ? {} : { orderId }) }, '멱등 재생의 결과 참조가 이 요청의 계정·주문과 맞지 않아 처음 응답 대신 404로 답했다');
  return orderNotFound();
}

export type MerchOrderOutcome = 'created' | 'sold_out' | 'in_progress' | 'paid' | 'failed' | 'expired';
export type MerchRefundOutcome = 'cancelled' | 'pending' | 'rejected';

export class ShopSignals {
  readonly orders = new Counter({ name: 'merch_orders_total', help: '굿즈 주문·결제의 끝(outcome별)', labelNames: ['outcome'], registers: [] });
  readonly stockExpired = new Counter({ name: 'merch_stock_expired_total', help: '재고 예약 만료 작업이 끝낸 결제 전 굿즈 주문 수', registers: [] });
  readonly pullFailures = new Counter({ name: 'merch_payment_pull_failures_total', help: '굿즈 결제 결과 당기기(BatchGetPayments)가 실패한 묶음 수', registers: [] });
  readonly refunds = new Counter({ name: 'merch_refunds_total', help: '미수령 자동 취소 환급 결과(outcome별)', labelNames: ['outcome'], registers: [] });
  readonly escrowPayments = new Counter({ name: 'shop_escrow_payments_total', help: '굿즈 결제창 준비 결과(에스크로 prepared·standard)', labelNames: ['result'], registers: [] });
  readonly deposits = new Counter({ name: 'shop_deposit_total', help: '굿즈 가상계좌 입금 대기·확인·만료', labelNames: ['result'], registers: [] });
  readonly cancellations = new Counter({ name: 'shop_cancellations_total', help: '굿즈 구매자 취소 결과', labelNames: ['result'], registers: [] });
  readonly returns = new Counter({ name: 'shop_returns_total', help: '굿즈 반품 요청 결과', labelNames: ['result'], registers: [] });
  readonly userRefunds = new Counter({ name: 'shop_refund_total', help: '굿즈 구매자 취소 환급 다시 부르기 결과', labelNames: ['result'], registers: [] });
  readonly refundAccounts = new Counter({ name: 'shop_refund_account_total', help: '굿즈 지연 환급 계좌 다시 받기 결과', labelNames: ['result'], registers: [] });
  readonly refundAccountIgnored = new Counter({ name: 'shop_refund_account_ignored_total', help: '카드 결제 취소에 실려 와 결제사로 보내지 않은 환불 계좌 수', registers: [] });
  readonly reauths = new Counter({ name: 'shop_reauth_total', help: '굿즈 취소 재인증 결과', labelNames: ['result', 'reason'], registers: [] });
  readonly attributesInvalid = new Gauge({ name: 'shop_product_attributes_invalid', help: '마지막 상품 속성 검증 잡이 찾은 속성이 틀린 상품 수', registers: [] });

  order(outcome: MerchOrderOutcome, n = 1): void {
    this.orders.inc({ outcome }, n);
  }

  refund(outcome: MerchRefundOutcome): void {
    this.refunds.inc({ outcome });
  }

  escrowPayment(result: 'prepared' | 'standard'): void {
    this.escrowPayments.inc({ result });
  }

  deposit(result: 'waiting' | 'approved' | 'expired'): void {
    this.deposits.inc({ result });
  }

  cancellation(result: 'refunded' | 'pending' | 'rejected' | 'invalid'): void {
    this.cancellations.inc({ result });
  }

  ret(result: 'requested' | 'rejected'): void {
    this.returns.inc({ result });
  }

  userRefund(result: 'cancelled' | 'pending' | 'rejected' | 'error'): void {
    this.userRefunds.inc({ result });
  }

  refundAccount(result: 'accepted' | 'refunded' | 'pending' | 'rejected' | 'invalid'): void {
    this.refundAccounts.inc({ result });
  }

  reauth(result: 'accepted' | 'rejected' | 'unavailable', reason: 'ok' | 'token' | 'store' | 'keys'): void {
    this.reauths.inc({ result, reason });
  }

  /** 레지스트리에 단다(같은 레지스트리에 두 번 달지 않는다) */
  register(registry: Registry): this {
    for (const m of [
      this.orders,
      this.stockExpired,
      this.pullFailures,
      this.refunds,
      this.escrowPayments,
      this.deposits,
      this.cancellations,
      this.returns,
      this.userRefunds,
      this.refundAccounts,
      this.refundAccountIgnored,
      this.reauths,
      this.attributesInvalid,
    ])
      registry.registerMetric(m);
    return this;
  }
}
