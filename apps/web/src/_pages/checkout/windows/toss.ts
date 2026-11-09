// 토스페이먼츠 주문서형 결제창(docs/frontend.md §5.3, ADR-0253). 결제 화면에서만 동적 import된다.
import { loadTossPayments } from '@tosspayments/tosspayments-sdk';
import { type PaymentAttempt, type TossCheckout, tossMethodAllowed } from '../model/payment-attempt';
import { PaymentWindowError, type PaymentWindow } from './index';

export interface TossSdk {
  widgets(p: { customerKey: string }): {
    setAmount(a: { currency: 'KRW'; value: number }): Promise<void>;
    renderPaymentMethods(p: { selector: string; variantKey: string }): Promise<{ getSelectedPaymentMethod(): Promise<{ method: string }> }>;
    renderAgreement(p: { selector: string; variantKey: string }): Promise<unknown>;
    requestPayment(p: { orderId: string; orderName: string; successUrl: string; failUrl: string; customerName?: string }): Promise<unknown>;
  };
}

/** 시험에서 SDK를 바꿔 끼운다 */
export function tossWindow(a: PaymentAttempt, load: (clientKey: string) => Promise<TossSdk> = (k) => loadTossPayments(k) as unknown as Promise<TossSdk>): PaymentWindow {
  const c = a.checkout as TossCheckout;
  let widgets: ReturnType<TossSdk['widgets']> | undefined;
  let methods: { getSelectedPaymentMethod(): Promise<{ method: string }> } | undefined;
  return {
    async mount(container) {
      try {
        const sdk = await load(c.clientKey);
        widgets = sdk.widgets({ customerKey: c.customerKey });
        await widgets.setAmount({ currency: 'KRW', value: c.amount });
        [methods] = await Promise.all([widgets.renderPaymentMethods({ selector: container.methods, variantKey: 'DEFAULT' }), widgets.renderAgreement({ selector: container.agreement, variantKey: 'AGREEMENT' })]);
      } catch {
        throw new PaymentWindowError('failed');
      }
    },
    async pay({ buyerName }) {
      if (!widgets || !methods) throw new PaymentWindowError('failed');
      let picked: { method: string };
      try {
        picked = await methods.getSelectedPaymentMethod();
      } catch {
        throw new PaymentWindowError('failed');
      }
      // 서버가 막은 수단(가상계좌 등)을 위젯에서 골랐으면 결제를 시작하지 않는다(BUILD_ORDER PRF-190)
      if (!tossMethodAllowed(picked.method, a.allowedPayMethods)) throw new PaymentWindowError('method-not-allowed');
      try {
        await widgets.requestPayment({ orderId: c.orderId, orderName: c.orderName, successUrl: c.successUrl, failUrl: c.failUrl, ...(buyerName ? { customerName: buyerName } : {}) });
      } catch (e) {
        throw new PaymentWindowError((e as { code?: string }).code === 'USER_CANCEL' ? 'cancelled' : 'failed');
      }
    },
  };
}
