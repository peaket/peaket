// 결제 결과 당기기 지표(PaymentPullSignals, ADR-0140 결정 4, BUILD_ORDER PRF-171 설계 8). PromTicketIssueSignals와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
// 경보(ADR-0140 결정 4): payment_result_pulled_total이 1분 동안 0보다 크면 SEV3(사건 길이 늦다는 신호, kind cause, dependency kafka-trade 또는 outbox-relay),
// payment_result_pull_failures_total이 1분 이어지면 SEV2. 평소에는 사건이 1초 안에 오므로 당기기는 거의 돌지 않는다(돌면 그 자체가 경보 신호다).
// main.ts가 당기기 실행기를 켤 때(purchase DB가 있을 때) 서비스 레지스트리에 붙인다.
import { Counter, type Registry } from '@peaket/platform';
import { PAYMENT_PULL_TYPES } from '../domain/payment-pull.js';
import type { AppliedPaymentEventType } from '../domain/payment-result.js';
import type { PaymentPullSignals } from '../domain/ports.js';

/**
 * - payment_result_pulled_total{type}(카운터, type: APPROVED·FAILED·AWAITING_DEPOSIT·UNKNOWN·CANCELED): 당기기로 반영한 주문 수(ApplyPaymentResult가 APPLIED)
 * - payment_result_pull_failures_total(카운터, 이름표 없음): BatchGetPayments 실패 수(차단기 열림·데드라인 초과·gRPC 오류·답 모양 틀림)
 * - payment_result_pull_batches_total(카운터, 이름표 없음): BatchGetPayments를 부른 수(성패와 상관없이)
 */
export class PromPaymentPullSignals implements PaymentPullSignals {
  readonly #pulled = new Counter({
    name: 'payment_result_pulled_total',
    help: '결제 결과 당기기(BatchGetPayments)로 반영한 주문 수(type: 반영한 결제 사건 종류). 1분 동안 0보다 크면 사건 길이 늦다(SEV3, ADR-0140)',
    labelNames: ['type'] as const,
    registers: [],
  });

  readonly #failures = new Counter({
    name: 'payment_result_pull_failures_total',
    help: '결제 결과 당기기 BatchGetPayments 실패 수(차단기 열림·데드라인 초과·gRPC 오류·답 모양 틀림). 1분 이어지면 SEV2(ADR-0140)',
    registers: [],
  });

  readonly #batches = new Counter({
    name: 'payment_result_pull_batches_total',
    help: '결제 결과 당기기 BatchGetPayments를 부른 수(성패와 상관없이)',
    registers: [],
  });

  constructor() {
    // 이름표 값을 0으로 미리 보인다(처음 당기기 전에도 경보식이 값을 본다)
    for (const type of PAYMENT_PULL_TYPES) this.#pulled.inc({ type }, 0);
  }

  /** 지표 셋을 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#pulled);
    registry.registerMetric(this.#failures);
    registry.registerMetric(this.#batches);
    return this;
  }

  /** payment_result_pulled_total{type}을 1 올린다(PAYMENT_PULL_TYPES 밖의 값은 이름표 수가 늘지 않게 버린다). 던지지 않는다 */
  pulled(type: AppliedPaymentEventType): void {
    if (!PULLED_TYPES.has(type)) return;
    this.#pulled.inc({ type });
  }

  /** payment_result_pull_batches_total을 1 올린다. 던지지 않는다 */
  batch(): void {
    this.#batches.inc();
  }

  /** payment_result_pull_failures_total을 1 올린다. 던지지 않는다 */
  failure(): void {
    this.#failures.inc();
  }
}

const PULLED_TYPES: ReadonlySet<string> = new Set<string>(PAYMENT_PULL_TYPES);
