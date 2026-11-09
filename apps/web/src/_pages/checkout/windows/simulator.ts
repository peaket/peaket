// 데모 SIMULATOR 결제창(운영 묶음에 들지 않는다, FE-T21, ADR-0253). 시뮬레이터 비밀 키는 브라우저에 없고 데모 전용 서버 경로가 인증을 대신 부른다.
import type { PaymentAttempt, TossCheckout } from '../model/payment-attempt';
import { PaymentWindowError, type PaymentWindow } from './index';

const ROUTE = '/demo/pg-simulator/authenticate';

export function simulatorWindow(a: PaymentAttempt, nav: (url: string) => void = (u) => window.location.assign(u), f: typeof fetch = fetch): PaymentWindow {
  const c = a.checkout as TossCheckout;
  return {
    async mount() {},
    async pay() {
      let paymentKey: unknown;
      try {
        const r = await f(ROUTE, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ orderId: c.orderId, amount: c.amount, orderName: c.orderName }) });
        if (!r.ok) throw new Error(String(r.status));
        paymentKey = ((await r.json()) as { paymentKey?: unknown }).paymentKey;
      } catch {
        throw new PaymentWindowError('not-opened');
      }
      if (typeof paymentKey !== 'string' || paymentKey === '') throw new PaymentWindowError('not-opened');
      const back = new URL(c.successUrl);
      back.searchParams.set('paymentKey', paymentKey);
      back.searchParams.set('amount', String(c.amount));
      back.searchParams.set('orderId', c.orderId);
      nav(back.toString());
    },
  };
}
