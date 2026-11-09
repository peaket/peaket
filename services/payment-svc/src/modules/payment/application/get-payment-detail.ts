// GetPayment 쓰임새(docs/api/proto/peaket/payment/v1/payment.proto, docs/features/payment.md §6 '`GetPayment` 서버', BUILD_ORDER HOT-151).
// 결제사를 부르지 않고 원장만 읽는다. 저장한 계좌번호는 여기서 연다. 열지 못하거나 입금 기한이 지났으면 계좌번호 칸만 비운다(원장 삭제는 입금 확정·만료 때다).
import type { Clock } from '@peaket/platform';
import { type GetPaymentKey, type PaymentDetail, type PaymentDetailRow, PaymentNotFoundError, parseGetPaymentKey } from '../domain/confirm-command.js';
import type { CallBudget, PaymentDepositLog, PaymentDepositSignals, PaymentDetailReader, PaymentGetSignals } from '../domain/ports.js';
import type { VirtualAccountCipher } from '../domain/virtual-account.js';

export interface GetPaymentDetailDeps {
  reader: PaymentDetailReader;
  signals: PaymentGetSignals;
  cipher: VirtualAccountCipher;
  depositLog: PaymentDepositLog;
  depositSignals: PaymentDepositSignals;
  /** 입금 기한이 지났는지 보는 '지금' */
  clock: Clock;
}

export class GetPaymentDetail {
  constructor(private readonly deps: GetPaymentDetailDeps) {}

  /**
   * @param paymentId·orderId proto oneof key의 두 칸(비었으면 undefined)
   * @throws PaymentInputError 입력이 틀림 · PaymentNotFoundError 원장이 없음 · PaymentDeadlineError·저장소 오류
   */
  async execute(input: { readonly paymentId?: string; readonly orderId?: string }, budget?: CallBudget): Promise<PaymentDetail> {
    const { reader, signals } = this.deps;
    let key: GetPaymentKey;
    try {
      key = parseGetPaymentKey(input.paymentId, input.orderId);
    } catch (err) {
      signals.getPayment('invalid');
      throw err;
    }
    let row: PaymentDetailRow | undefined;
    try {
      row = await reader.getDetail(key, budget);
    } catch (err) {
      signals.getPayment('error');
      throw err;
    }
    if (row === undefined) {
      signals.getPayment('not_found');
      throw new PaymentNotFoundError();
    }
    const virtualAccount = await this.#virtualAccountOf(row);
    signals.getPayment('ok');
    return {
      paymentId: row.paymentId,
      orderId: row.orderId,
      pg: row.pg,
      status: row.status,
      amount: row.amount,
      // 취소를 만드는 단계 전에는 취소한 금액이 없다(payment §6 '`GetPayment` 서버')
      cancelledAmount: 0,
      ...(row.approvedAtMs === undefined ? {} : { approvedAtMs: row.approvedAtMs }),
      ...(virtualAccount === undefined ? {} : { virtualAccount }),
    };
  }

  /** 입금 대기의 안내. 저장한 번호를 못 열거나 입금 기한이 지났으면 번호 칸만 빠지고, 저장한 칸이 하나도 없으면 안내가 없다. 던지지 않는다 */
  async #virtualAccountOf(row: PaymentDetailRow): Promise<PaymentDetail['virtualAccount']> {
    if (row.status !== 'AWAITING_DEPOSIT') return undefined;
    const pastDue = row.depositDueAtMs !== undefined && this.deps.clock.now() >= row.depositDueAtMs;
    const accountNumber = pastDue ? undefined : await this.#open(row);
    const va = {
      ...(row.virtualAccountBank === undefined ? {} : { bank: row.virtualAccountBank }),
      ...(accountNumber === undefined ? {} : { accountNumber }),
      ...(row.depositDueAtMs === undefined ? {} : { dueAtMs: row.depositDueAtMs }),
    };
    return Object.keys(va).length === 0 ? undefined : va;
  }

  async #open(row: PaymentDetailRow): Promise<string | undefined> {
    if (row.virtualAccountNoSealed === undefined) return undefined;
    const { cipher, depositLog, depositSignals } = this.deps;
    if (!cipher.ready) {
      depositSignals.fieldFailure('open', 'NO_KEY');
      depositLog.accountUnopened({ orderId: row.orderId, reason: 'NO_KEY' });
      return undefined;
    }
    try {
      return await cipher.open(row.paymentId, row.virtualAccountNoSealed);
    } catch {
      depositSignals.fieldFailure('open', 'ERROR');
      depositLog.accountUnopened({ orderId: row.orderId, reason: 'ERROR' });
      return undefined;
    }
  }
}
