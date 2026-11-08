// 결제사 어댑터 등록부(BUILD_ORDER PRF-181). 이 단계는 시뮬레이터 하나다(토스 PRF-184, 포트원 HOT-140이 더한다).
import type { PaymentGatewayPort, PgName } from '../../domain/payment-gateway.js';
import type { PaymentGateways } from '../../domain/ports.js';

/** 어댑터 목록에서 pg로 찾는다. 같은 pg가 둘이면 만들 때 던진다 */
export class StaticPaymentGateways implements PaymentGateways {
  readonly #byPg = new Map<PgName, PaymentGatewayPort>();

  constructor(gateways: readonly PaymentGatewayPort[]) {
    for (const gateway of gateways) {
      if (this.#byPg.has(gateway.pg)) throw new Error(`같은 결제사 어댑터가 둘이다: ${gateway.pg}`);
      this.#byPg.set(gateway.pg, gateway);
    }
  }

  of(pg: PgName): PaymentGatewayPort | undefined {
    return this.#byPg.get(pg);
  }
}
