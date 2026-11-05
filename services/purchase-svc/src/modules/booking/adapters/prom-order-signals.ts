// booking 모듈 지표(docs/observability.md '주문 상태와 상태 이력이 어긋나지 않는다', BUILD_ORDER PRF-160). PromSeatSignals와 같은 꼴이다:
// 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, Gauge, type Registry } from '@peaket/platform';
import type { OrderSignals, PaymentStatusSignals } from '../domain/ports.js';
import { FALLBACK_REASONS, type FallbackReason } from '../domain/recheck.js';

/**
 * - order_history_mismatch(게이지, 이름표 없음): 마지막 매일 검사에서 어긋난 주문 수. 1 이상이면 SEV3(kind hygiene)
 * - purchase_identity_recheck_fallback_total{reason}(카운터): 주문 생성의 본인확인 재확인 대체 판정 수(PRF-161)
 * - purchase_order_paying_mark_failed_total(카운터, 이름표 없음): 커밋 뒤 Paying 표시를 다시 불러도 하지 못한 수(PRF-161 리뷰 고침 M3)
 * - purchase_payment_status_waiters(게이지, 이름표 없음): 이 파드에서 결제 결과 long polling으로 기다리는 요청 수(PRF-166)
 * - purchase_payment_status_poll_failures_total(카운터, 이름표 없음): 기다림 표의 묶음 조회가 읽기 실패한 틱 수(PRF-166 리뷰 고침 L6)
 */
export class PromOrderSignals implements OrderSignals, PaymentStatusSignals {
  readonly #mismatch = new Gauge({ name: 'order_history_mismatch', help: '마지막 매일 주문 상태·이력 검사에서 어긋난 주문 수(1 이상이면 SEV3 hygiene)', registers: [] });
  readonly #fallback = new Counter({
    name: 'purchase_identity_recheck_fallback_total',
    help: '주문 생성의 본인확인 재확인이 답하지 않아 토큰 판정으로 간 수(reason: circuit_open·deadline·unavailable·exhausted·internal, 통과·거부 모두)',
    labelNames: ['reason'] as const,
    registers: [],
  });

  readonly #payingFailed = new Counter({
    name: 'purchase_order_paying_mark_failed_total',
    help: '주문을 커밋한 뒤 구매 세션 Paying 표시를 다시 불러도 하지 못한 수(결제 중 유휴로 끝날 수 있다, POL-009)',
    registers: [],
  });

  readonly #waiters = new Gauge({
    name: 'purchase_payment_status_waiters',
    help: '이 파드에서 결제 결과 long polling(GET /v1/orders/{orderId}/payment-status)으로 기다리는 요청 수',
    registers: [],
  });

  readonly #pollFailures = new Counter({
    name: 'purchase_payment_status_poll_failures_total',
    help: '결제 결과 long polling 기다림 표의 묶음 조회가 purchase DB 읽기 실패로 아무도 깨우지 못한 틱 수',
    registers: [],
  });

  constructor() {
    // 다섯 이름표를 0으로 미리 보인다(처음 대체 판정 전에도 경보식이 값을 본다)
    for (const reason of FALLBACK_REASONS) this.#fallback.inc({ reason }, 0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#mismatch);
    registry.registerMetric(this.#fallback);
    registry.registerMetric(this.#payingFailed);
    registry.registerMetric(this.#waiters);
    registry.registerMetric(this.#pollFailures);
    return this;
  }

  /**
   * purchase_payment_status_waiters(게이지, 이름표 없음)를 count로 둔다: 이 파드에서 결제 결과 long polling으로 기다리는 요청 수(PRF-166, verification §4.1).
   * 던지지 않는다(붙이기 전에도 값을 둔다)
   */
  paymentStatusWaiters(count: number): void {
    this.#waiters.set(count);
  }

  /** purchase_payment_status_poll_failures_total(이름표 없음)을 1 올린다(묶음 조회 한 틱이 읽기 실패, 리뷰 고침 L6). 던지지 않는다 */
  paymentStatusPollFailed(): void {
    this.#pollFailures.inc();
  }

  /** purchase_order_paying_mark_failed_total(이름표 없음)을 1 올린다. 던지지 않는다(리뷰 고침 M3) */
  payingMarkFailed(): void {
    this.#payingFailed.inc();
  }

  /** order_history_mismatch를 count로 둔다. 던지지 않는다(붙이기 전에도 값을 둔다) */
  historyMismatch(count: number): void {
    this.#mismatch.set(count);
  }

  /**
   * purchase_identity_recheck_fallback_total{reason}(카운터, reason 다섯: circuit_open·deadline·unavailable·exhausted·internal)을 1 올린다(BUILD_ORDER PRF-161, ADR-0055).
   * 지표는 register가 함께 붙이고, 다섯 이름표는 0으로 미리 보인다. 던지지 않는다
   */
  identityFallback(reason: FallbackReason): void {
    // 이름표 값은 다섯 가운데 하나만 단다(모르는 값이 와도 이름표 수가 늘지 않게 internal로 접는다)
    this.#fallback.inc({ reason: FALLBACK_REASONS.includes(reason) ? reason : 'internal' });
  }
}
