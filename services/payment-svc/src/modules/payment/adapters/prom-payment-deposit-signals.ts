// 입금 대기 쓰기와 GetPayment 지표(docs/observability.md 같은 줄, BUILD_ORDER HOT-151). PromPaymentWebhookSignals와 같은 꼴이다: 지표는 registers: []로 만들고 register(registry)로 서비스 레지스트리에 붙인다.
import { Counter, type Registry } from '@peaket/platform';
import type { GetPaymentOutcome, PaymentDepositSignals, PaymentGetSignals } from '../domain/ports.js';
import type { VirtualAccountFieldReason } from '../domain/virtual-account.js';
import { DEPOSIT_CANCEL_OUTCOMES, type DepositCancelOutcome } from '../domain/deposit-cancel.js';

const OPS = ['seal', 'open'] as const;
const REASONS: readonly VirtualAccountFieldReason[] = ['NO_KEY', 'ERROR'];
const GET_OUTCOMES: readonly GetPaymentOutcome[] = ['ok', 'not_found', 'invalid', 'error'];

/**
 * - payment_virtual_account_field_failures_total{op, reason}: 계좌번호를 암호화·복호하지 못한 수. 값은 싣지 않는다
 * - payment_get_requests_total{outcome}: GetPayment 결과별 수
 * 이름표를 모두 0으로 미리 보인다
 */
export class PromPaymentDepositSignals implements PaymentDepositSignals, PaymentGetSignals {
  readonly #field = new Counter({ name: 'payment_virtual_account_field_failures_total', help: '가상계좌 번호를 암호화·복호하지 못한 수(연산·까닭)', labelNames: ['op', 'reason'] as const, registers: [] });
  readonly #get = new Counter({ name: 'payment_get_requests_total', help: 'GetPayment 결과별 수', labelNames: ['outcome'] as const, registers: [] });

  readonly #cancel = new Counter({ name: 'payment_deposit_cancel_total', help: '입금 전 취소 결과별 수', labelNames: ['outcome'] as const, registers: [] });

  readonly #dueCapped = new Counter({ name: 'payment_deposit_due_capped_total', help: '결제사가 준 입금 기한이 입장 시작 24시간 전을 넘어 잘라 저장한 수', registers: [] });

  constructor() {
    for (const outcome of DEPOSIT_CANCEL_OUTCOMES) this.#cancel.inc({ outcome }, 0);
    for (const op of OPS) for (const reason of REASONS) this.#field.inc({ op, reason }, 0);
    for (const outcome of GET_OUTCOMES) this.#get.inc({ outcome }, 0);
    this.#dueCapped.inc(0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#field);
    registry.registerMetric(this.#get);
    registry.registerMetric(this.#cancel);
    registry.registerMetric(this.#dueCapped);
    return this;
  }

  dueCapped(): void {
    this.#dueCapped.inc();
  }

  fieldFailure(op: 'seal' | 'open', reason: VirtualAccountFieldReason): void {
    this.#field.inc({ op, reason });
  }

  cancel(outcome: DepositCancelOutcome): void {
    this.#cancel.inc({ outcome });
  }

  getPayment(outcome: GetPaymentOutcome): void {
    this.#get.inc({ outcome });
  }
}
