// 탈퇴 참여자 지표(WithdrawalParticipantSignals, docs/features/payment.md §4.1 '탈퇴 참여자의 첫 구현' '지표·로그', BUILD_ORDER PRF-169). PromTicketVoidSignals와 같은 꼴이다.
import { Counter, type Registry } from '@peaket/platform';
import type { WithdrawalParticipantSignals } from '../domain/ports.js';

const STATES = ['done', 'pending', 'error'] as const;
const RESULTS = ['cancelled', 'pending', 'unknown', 'rejected', 'skipped'] as const;

/** purchase_withdrawal_participant_total{state}, purchase_withdrawal_deposit_cancel_total{result}. 값을 0으로 미리 보인다 */
export class PromWithdrawalParticipantSignals implements WithdrawalParticipantSignals {
  readonly #participant = new Counter({ name: 'purchase_withdrawal_participant_total', help: '탈퇴 참여자 호출 결과(state: done·pending·error)', labelNames: ['state'] as const, registers: [] });
  readonly #deposit = new Counter({
    name: 'purchase_withdrawal_deposit_cancel_total',
    help: '탈퇴 참여자의 입금 대기 주문 취소 결과(result: cancelled·pending·unknown·rejected·skipped)',
    labelNames: ['result'] as const,
    registers: [],
  });

  constructor() {
    for (const state of STATES) this.#participant.inc({ state }, 0);
    for (const result of RESULTS) this.#deposit.inc({ result }, 0);
  }

  /** 지표를 registry에 붙이고 자신을 돌려준다 */
  register(registry: Registry): this {
    registry.registerMetric(this.#participant);
    registry.registerMetric(this.#deposit);
    return this;
  }

  participant(state: (typeof STATES)[number]): void {
    this.#participant.inc({ state });
  }

  depositCancel(result: (typeof RESULTS)[number]): void {
    this.#deposit.inc({ result });
  }
}
