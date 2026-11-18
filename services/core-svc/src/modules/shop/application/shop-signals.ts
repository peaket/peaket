// shop 굿즈 주문의 운영 지표와 로그 면(docs/observability.md 서비스 템플릿 운영 확인 표의 core-svc shop 줄, BAT-600).
// - merch_orders_total{outcome}: 주문·결제의 끝(created·sold_out·in_progress·paid·failed·expired)
// - merch_stock_expired_total: 만료 작업이 끝낸 결제 전 주문 수
// - merch_payment_pull_failures_total: 결과 당기기(BatchGetPayments)가 실패한 묶음 수
// - merch_refunds_total{outcome}: 미수령 환급 결과(cancelled·pending·rejected)
// - shop_product_attributes_invalid: 마지막 속성 검증 잡이 찾은 틀린 상품 수(게이지, ADR-0300 결정 2)
// 로그 면은 플랫폼 로거의 warn·error만 쓴다. 결제 참조·속성 값·개인 값은 싣지 않는다.
import { Counter, Gauge, type Registry } from '@peaket/platform';

export interface ShopLogger {
  info(o: object, msg: string): void;
  warn(o: object, msg: string): void;
  error(o: object, msg: string): void;
}

/** 로그를 남기지 않는 면(시험·조립 전) */
export const silentShopLogger: ShopLogger = { info: () => {}, warn: () => {}, error: () => {} };

export type MerchOrderOutcome = 'created' | 'sold_out' | 'in_progress' | 'paid' | 'failed' | 'expired';
export type MerchRefundOutcome = 'cancelled' | 'pending' | 'rejected';

export class ShopSignals {
  readonly orders = new Counter({ name: 'merch_orders_total', help: '굿즈 주문·결제의 끝(outcome별)', labelNames: ['outcome'], registers: [] });
  readonly stockExpired = new Counter({ name: 'merch_stock_expired_total', help: '재고 예약 만료 작업이 끝낸 결제 전 굿즈 주문 수', registers: [] });
  readonly pullFailures = new Counter({ name: 'merch_payment_pull_failures_total', help: '굿즈 결제 결과 당기기(BatchGetPayments)가 실패한 묶음 수', registers: [] });
  readonly refunds = new Counter({ name: 'merch_refunds_total', help: '미수령 자동 취소 환급 결과(outcome별)', labelNames: ['outcome'], registers: [] });
  readonly attributesInvalid = new Gauge({ name: 'shop_product_attributes_invalid', help: '마지막 상품 속성 검증 잡이 찾은 속성이 틀린 상품 수', registers: [] });

  order(outcome: MerchOrderOutcome, n = 1): void {
    this.orders.inc({ outcome }, n);
  }

  refund(outcome: MerchRefundOutcome): void {
    this.refunds.inc({ outcome });
  }

  /** 레지스트리에 단다(같은 레지스트리에 두 번 달지 않는다) */
  register(registry: Registry): this {
    for (const m of [this.orders, this.stockExpired, this.pullFailures, this.refunds, this.attributesInvalid]) registry.registerMetric(m);
    return this;
  }
}
