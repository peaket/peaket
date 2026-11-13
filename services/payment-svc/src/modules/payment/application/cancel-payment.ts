// CancelPayment의 갈래 고르기(GAT-080): 입금 대기 결제는 입금 전 취소, 승인·부분 취소 결제는 결제 후 일반 취소.
// 원장 상태를 한 번 읽어 어느 쓰임새로 보낼지 정한다. 결제사는 각 쓰임새가 부른다.
import type { PaymentLedgerStatus } from '../domain/confirm-command.js';
import { PaymentNotFoundError } from '../domain/confirm-command.js';
import { type DepositCancelInput, parseDepositCancel } from '../domain/deposit-cancel.js';
import type { CallBudget } from '../domain/ports.js';
import type { CancelConfirmedPayment } from './cancel-confirmed-payment.js';
import type { CancelDepositPayment } from './cancel-deposit-payment.js';

export interface CancelPaymentStatusReader {
  readCancelStatus(paymentId: string, budget?: CallBudget): Promise<PaymentLedgerStatus | undefined>;
}

/** 두 갈래의 공통 답. 입금 전 취소는 취소액이 늘 0이고(칸 없음), 일반 취소는 누적 취소액을 싣는다 */
export interface CancelAnswer {
  readonly result: 'CANCELLED' | 'CANCEL_PENDING' | 'REJECTED' | 'UNKNOWN';
  readonly cancelledAmount?: number;
}

export class CancelPayment {
  constructor(
    private readonly deposit: Pick<CancelDepositPayment, 'execute'>,
    private readonly confirmed: Pick<CancelConfirmedPayment, 'execute'>,
    private readonly status: CancelPaymentStatusReader,
  ) {}

  async execute(input: DepositCancelInput, budget?: CallBudget): Promise<CancelAnswer> {
    const parsed = parseDepositCancel(input);
    const current = await this.status.readCancelStatus(parsed.paymentId, budget);
    if (current === undefined) throw new PaymentNotFoundError();
    return current === 'AWAITING_DEPOSIT' ? this.deposit.execute(parsed, budget) : this.confirmed.execute(parsed, budget);
  }
}
