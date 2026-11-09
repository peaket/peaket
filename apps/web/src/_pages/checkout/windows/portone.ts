// 포트원 V2 결제창(docs/frontend.md §5.3, ADR-0253). 결제 화면에서만 동적 import된다. 결과는 forceRedirect로 페이지 이동으로만 받는다.
import * as PortOne from '@portone/browser-sdk/v2';
import type { PaymentAttempt, PortoneCheckout } from '../model/payment-attempt';
import { PaymentWindowError, type PaymentWindow } from './index';

export type PortoneRequest = (p: Record<string, unknown>) => Promise<{ code?: string } | undefined>;

/** 시험에서 SDK를 바꿔 끼운다 */
export function portoneWindow(a: PaymentAttempt, request: PortoneRequest = PortOne.requestPayment as unknown as PortoneRequest): PaymentWindow {
  const c = a.checkout as PortoneCheckout;
  return {
    async mount() {},
    async pay({ payMethod }) {
      let r: { code?: string } | undefined;
      try {
        r = await request({
          storeId: c.storeId,
          channelKey: c.channelKey,
          paymentId: c.paymentId,
          orderName: c.orderName,
          totalAmount: c.totalAmount,
          currency: c.currency,
          payMethod: payMethod ?? a.allowedPayMethods?.[0] ?? 'CARD',
          redirectUrl: c.redirectUrl,
          forceRedirect: true,
          ...(c.customer ? { customer: c.customer } : {}),
          ...(c.customData ? { customData: c.customData } : {}),
        });
      } catch {
        throw new PaymentWindowError('not-opened');
      }
      // 리디렉션이 일어나면 돌아오지 않는다. 돌아왔다면 실패 답이다. 취소로 확인된 코드만 취소이고 모르는 코드는 실패로 본다
      if (r?.code) throw new PaymentWindowError(r.code === 'PAY_PROCESS_CANCELED' || r.code === 'PAY_PROCESS_ABORTED' ? 'cancelled' : 'failed');
    },
  };
}
