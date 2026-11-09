// 시뮬레이터 어댑터(ADR-0029 결정 1·6). PG 시뮬레이터(services/pg-simulator)를 토스페이먼츠와 같은 모양의 API로 부른다.
// 호출과 답 읽기는 토스 어댑터와 함께 쓰는 공통 코드(toss-shaped.ts)다(BUILD_ORDER PRF-184). 이 파일에는 시뮬레이터만의 능력 플래그와 결제창 값이 있다.
import type { CheckoutAttempt, CheckoutOrder, CheckoutValues, FailureCategory, PgCapabilities } from '../../domain/payment-gateway.js';
import { TossShapedGateway, type TossShapedOptions } from './toss-shaped.js';

export interface SimulatorGatewayOptions extends TossShapedOptions {
  /** sim_sk_ 시험 키. Secrets Manager의 시험 키 경로에서 받는다(docs/security/secrets-and-keys.md) */
  secretKey: string;
  /** 결제창용 공개 키 */
  clientKey: string;
  /** 시험별로 바꾸는 호출 상한(초당). 기본 300 */
  callsPerSecond?: number;
}

export class SimulatorPaymentGateway extends TossShapedGateway {
  readonly pg = 'SIMULATOR' as const;
  readonly #clientKey: string;
  readonly #callsPerSecond: number;

  constructor(o: SimulatorGatewayOptions) {
    super('pg-simulator', o);
    this.#clientKey = o.clientKey;
    this.#callsPerSecond = o.callsPerSecond ?? 300;
  }

  capabilities(): PgCapabilities {
    return {
      serverConfirm: true,
      confirmDeadlineMs: 10 * 60_000,
      partialCancel: true,
      webhookSignature: false,
      idempotencyRetentionMs: 15 * 24 * 3_600_000,
      callsPerSecond: this.#callsPerSecond,
      redirectCheckout: true,
    };
  }

  checkout(order: CheckoutOrder, attempt: CheckoutAttempt, payMethod: string): CheckoutValues {
    if (payMethod !== 'CARD') throw new RangeError(`시뮬레이터는 카드 결제만 흉내 낸다: ${payMethod}`);
    if (!(Number.isSafeInteger(order.amount) && order.amount > 0)) throw new RangeError(`결제 금액은 양의 정수(원)여야 한다: ${order.amount}`);
    return {
      simulator: {
        clientKey: this.#clientKey,
        customerKey: order.customerKey ?? 'ANONYMOUS',
        orderId: order.orderId,
        orderName: order.orderName,
        amount: order.amount,
        successUrl: attempt.successUrl,
        failUrl: attempt.failUrl,
      },
    };
  }

  /** 시뮬레이터의 거절은 시험이 고른 코드라 돈이 잡히지 않는다. 표에 없는 코드는 카드 거절로 읽는다(v0 시험이 고정한다, 토스는 UNKNOWN이다) */
  protected override failureCategoryOf(status: number, code: string): FailureCategory {
    return super.failureCategoryOf(status, code) ?? 'CARD_DECLINED';
  }
}
