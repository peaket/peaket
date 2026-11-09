// 결제창의 좁은 약속(ADR-0253). 결제 화면은 이것만 안다. 결제사 SDK는 결제 시도 응답의 pg에 따라 동적 import한다(첫 화면 JS에 들지 않는다).
// 우리 코드는 결제창의 창 메시지(message)를 받지 않는다. 결과는 복귀 주소의 값을 서버가 대조해 정한다.
import type { PayMethod, PaymentAttempt } from '../model/payment-attempt';

/** failed·cancelled는 결제창을 연 뒤의 끝이라 시도 하나를 쓴다. not-opened는 창을 열지도 못했다(스크립트·값) */
export type PaymentWindowFailure = 'method-not-allowed' | 'cancelled' | 'failed' | 'not-opened';

export class PaymentWindowError extends Error {
  readonly reason: PaymentWindowFailure;

  constructor(reason: PaymentWindowFailure) {
    super(reason);
    this.name = 'PaymentWindowError';
    this.reason = reason;
  }
}

export interface PaymentWindow {
  /** 결제 수단 UI를 그린다(토스 위젯만). 그릴 것이 없으면 아무것도 하지 않는다 */
  mount(container: { methods: string; agreement: string }): Promise<void>;
  /**
   * 결제창을 연다. 정상이면 페이지가 복귀 주소로 넘어가 돌아오지 않는다.
   * @throws PaymentWindowError 고를 수 없는 수단·구매자 취소·결제창 실패·창을 열지 못함(값이 틀리거나 스크립트를 받지 못함)
   */
  pay(o: { payMethod?: PayMethod }): Promise<void>;
}

export async function loadPaymentWindow(a: PaymentAttempt): Promise<PaymentWindow> {
  if (a.pg === 'TOSS') return (await import('./toss')).tossWindow(a);
  if (a.pg === 'PORTONE') return (await import('./portone')).portoneWindow(a);
  // 데모 전용: 빌드 값이 없으면 next.config의 별칭이 이 모듈을 빈 대역(simulator-absent)으로 바꿔 진짜 코드가 묶음에 들지 않는다(FE-T21, tools/web-checks static/assets.mjs가 표식으로 막는다)
  if (process.env.NEXT_PUBLIC_PEAKET_PG_SIMULATOR === '1') return (await import('peaket-pg-simulator-window')).simulatorWindow(a);
  throw new PaymentWindowError('failed');
}
