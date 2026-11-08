// 승인 명령 접수·결과 조회 지표(docs/features/payment.md §2 '승인 명령 접수의 첫 구현' 지표, docs/observability.md 같은 줄, BUILD_ORDER PRF-180).
// 다른 서비스의 Prom 신호와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, type Registry } from '@peaket/platform';
import type { BatchGetOutcome, ConfirmCommandOutcome, PaymentCommandSignals } from '../domain/ports.js';

const CONFIRM_OUTCOMES: readonly ConfirmCommandOutcome[] = ['accepted', 'replayed', 'mismatch', 'invalid', 'error'];
const BATCH_OUTCOMES: readonly BatchGetOutcome[] = ['ok', 'invalid', 'error'];

/**
 * - payment_confirm_commands_total{outcome}: outcome은 accepted·replayed·mismatch·invalid·error
 * - payment_batch_get_requests_total{outcome}: outcome은 ok·invalid·error
 */
export class PromPaymentCommandSignals implements PaymentCommandSignals {
  readonly #confirm = new Counter({
    name: 'payment_confirm_commands_total',
    help: '승인 명령 접수 결과별 수(accepted 처음 받음, replayed 같은 요청을 다시 받음, mismatch 시도·결제사·금액이 달라 거절, invalid 입력 틀림, error 저장 실패)',
    labelNames: ['outcome'] as const,
    registers: [],
  });

  readonly #batch = new Counter({
    name: 'payment_batch_get_requests_total',
    help: '결제 결과 조회 BatchGetPayments 결과별 수(ok, invalid 입력 틀림, error 읽기 실패)',
    labelNames: ['outcome'] as const,
    registers: [],
  });

  constructor() {
    // 처음 일어나기 전에도 경보식이 값을 보게 모든 이름표를 0으로 미리 보인다
    for (const outcome of CONFIRM_OUTCOMES) this.#confirm.inc({ outcome }, 0);
    for (const outcome of BATCH_OUTCOMES) this.#batch.inc({ outcome }, 0);
  }

  register(registry: Registry): void {
    registry.registerMetric(this.#confirm);
    registry.registerMetric(this.#batch);
  }

  confirmCommand(outcome: ConfirmCommandOutcome): void {
    this.#confirm.inc({ outcome });
  }

  batchGet(outcome: BatchGetOutcome): void {
    this.#batch.inc({ outcome });
  }
}
