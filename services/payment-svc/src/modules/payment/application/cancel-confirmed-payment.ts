// 결제 후 일반 취소(부분·전액) 쓰임새(GAT-080, docs/features/payment.md §4.1).
// 차례: 원장 읽기 → 취소 건 만들기·찾기(payment_cancel, 트랜잭션) → (3시간 지난 재시도는 먼저 조회) → 결제사 부분 취소(저장한 본문) → 행·원장 반영(트랜잭션).
// 잠금을 쥔 채 결제사를 부르지 않는다. 결제사가 결과를 모르면 원장을 바꾸지 않고 UNKNOWN으로 답한다(부른 쪽이 같은 취소 ID로 다시 부른다).
// 결제사에 보내는 금액·전액 여부·사유·기대 잔액은 저장소가 첫 전송 직전에 적은 취소 건(record)의 값이다. 원장(target)에서 다시 계산하지 않는다
// (같은 멱등키의 본문이 바뀌지 않게, docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액', HOT-140이 넘긴 것).
// 가상계좌 갈래(docs/features/payment.md §6 '결제 후 일반 취소의 가상계좌 갈래', BUILD_ORDER GAT-090): 가상계좌 여부는 저장소가 결제 행 잠금 안에서 본다.
// 계좌가 있으면 결제사 본문에 싣고(저장·로그 없음), 없으면 결제사 취소를 부르지 않는다. 행이 없으면 REFUND_ACCOUNT_REQUIRED, 행이 있으면 조회로 반영을 가른다
// (반영 → CANCELLED, 아님 → REFUND_ACCOUNT_REQUIRED, 가를 수 없음·조회 실패 → UNKNOWN). 결제사가 계좌를 거절하면 행 FAILED와 REFUND_ACCOUNT_REQUIRED다.
// 가상계좌가 아닌 결제에 온 계좌는 보내지 않고 버린다(지표).
import type { Clock } from '@peaket/platform';
import { MIN_CALL_REMAINING_MS, PaymentInputError, PaymentNotFoundError } from '../domain/confirm-command.js';
import {
  CONFIRMED_CANCEL_QUERY_AFTER_MS,
  type ConfirmedCancelAnswer,
  type ConfirmedCancelInput,
  type ConfirmedCancelRecord,
  type ConfirmedCancelTarget,
  parseConfirmedCancel,
} from '../domain/confirmed-cancel.js';
import { PaymentCancelStateError } from '../domain/deposit-cancel.js';
import { type CancelResult, type PaymentGatewayPort, type QueryResult, type RefundAccount, refundAccountOf } from '../domain/payment-gateway.js';
import type { PgCallGuards } from '../domain/pg-call-guard.js';
import type { CallBudget, PaymentConfirmedCancels, PaymentGateways, RefundAccountSignals } from '../domain/ports.js';

/** 결제사 취소·조회 호출 한 번을 기다리는 시간 10초 [가정](입금 전 취소와 같다) */
const CONFIRMED_CANCEL_CALL_TIMEOUT_MS = 10_000;

export interface CancelConfirmedPaymentDeps {
  store: PaymentConfirmedCancels;
  gateways: PaymentGateways;
  guards: Pick<PgCallGuards, 'of'>;
  clock: Clock;
  /** 없으면 지표를 내지 않는다(BUILD_ORDER GAT-090) */
  refundAccountSignals?: RefundAccountSignals;
}

async function withTimeout<T>(work: Promise<T>, limitMs: number): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const guard = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error('결제사 호출이 한도를 넘겼다')), limitMs);
    handle.unref();
  });
  try {
    return await Promise.race([work, guard]);
  } finally {
    clearTimeout(handle);
  }
}

const QUERY_UNKNOWN: QueryResult = Object.freeze({ kind: 'UNKNOWN' });

export class CancelConfirmedPayment {
  constructor(readonly deps: CancelConfirmedPaymentDeps) {}

  /**
   * @throws PaymentInputError 입력이 틀렸다·요청액이 남은 금액과 진행 중 합을 넘는다·같은 취소 ID에 다른 금액(INVALID_ARGUMENT)
   * @throws PaymentNotFoundError 결제가 없다(NOT_FOUND)
   * @throws PaymentCancelStateError 승인·부분 취소 상태가 아니다·남은 금액이 없다(FAILED_PRECONDITION)
   */
  async execute(input: ConfirmedCancelInput, budget?: CallBudget): Promise<ConfirmedCancelAnswer> {
    const { store, gateways, guards, clock } = this.deps;
    const parsed = parseConfirmedCancel(input);
    // 모양이 틀린 계좌는 없는 것과 같다(docs/features/payment.md §6 '구현에서 정한 것' ②). 값은 이 호출 안에서만 쓴다
    const account = refundAccountOf(input.refundAccount);
    const target = await store.readConfirmedCancelTarget(parsed.paymentId, budget);
    if (target === undefined) throw new PaymentNotFoundError();

    const begun = await store.beginConfirmedCancel(
      target,
      { cancellationId: parsed.cancellationId, ...(parsed.amount === undefined ? {} : { amount: parsed.amount }), reason: parsed.reason, ...(account === undefined ? {} : { hasRefundAccount: true }) },
      budget,
    );
    switch (begun.status) {
      case 'ACCOUNT_REQUIRED':
        // 가상계좌인데 계좌가 없고 행도 없다: 결제사 0·행 0(V4)
        return { result: 'REFUND_ACCOUNT_REQUIRED', cancelledAmount: target.cancelledAmount };
      case 'NOT_CONFIRMED':
        throw new PaymentCancelStateError('승인된 결제만 취소할 수 있다');
      case 'NO_BALANCE':
        throw new PaymentCancelStateError('남은 취소 가능 금액이 없다');
      case 'OVER_REMAINING':
      case 'AMOUNT_MISMATCH':
        throw new PaymentInputError('amount');
      case 'DONE':
        return { result: 'CANCELLED', cancelledAmount: begun.cancelledAmount };
      case 'REJECTED':
        // 거절로 끝난 건의 재요청: 결제사를 부르지 않고 거절을 다시 준다(리뷰 B3. 다시 환급하려면 새 취소 ID로 한다)
        return { result: 'REJECTED', cancelledAmount: target.cancelledAmount };
      case 'BUSY':
        // 같은 결제의 다른 취소가 10분 안에 진행 중이다: 보내지 않고 결과 모름(부른 쪽이 다시 시도한다)
        return unknownOf(target);
      case 'BEGUN':
        break;
    }
    const { record, replay } = begun;
    const virtualAccount = begun.virtualAccount === true;
    if (!virtualAccount && input.refundAccount !== undefined) this.deps.refundAccountSignals?.refundAccountIgnored(target.pg);
    const refundAccount = virtualAccount ? account : undefined;

    const deadlineAtMs = budget === undefined ? Number.POSITIVE_INFINITY : clock.now() + budget.remainingMs;
    const leftMs = (): number => deadlineAtMs - clock.now();
    const gateway = gateways.of(target.pg);
    const guard = gateway === undefined ? undefined : guards.of(target.pg);
    if (gateway === undefined || guard === undefined || leftMs() < MIN_CALL_REMAINING_MS || !guard.circuitClosed() || !guard.tryTakeToken()) return unknownOf(target);

    // 가상계좌인데 계좌 없는 재시도(앞서 계좌를 실어 보낸 행이 진행 중): 같은 멱등키로 계좌 없는 본문을 보내지 않고 조회로만 끝을 본다(V5)
    if (virtualAccount && refundAccount === undefined) {
      const query = await this.#query(gateway, target, leftMs());
      if (query.kind !== 'FOUND') return unknownOf(target);
      const settled = await store.settleConfirmedCancelByQuery(target, parsed.cancellationId, query.balanceAmount, budget);
      if (settled.status === 'APPLIED') return { result: 'CANCELLED', cancelledAmount: settled.cancelledAmount };
      if (settled.status === 'RESEND') return { result: 'REFUND_ACCOUNT_REQUIRED', cancelledAmount: target.cancelledAmount };
      return unknownOf(target);
    }

    // 만든 지 3시간 이상(정각 포함) 지난 취소 건의 재시도는 결제사 멱등키 보관이 끝났을 수 있어 먼저 조회한다(P-T21)
    if (replay && clock.now() - record.createdAtMs >= CONFIRMED_CANCEL_QUERY_AFTER_MS) {
      const query = await this.#query(gateway, target, leftMs());
      if (query.kind !== 'FOUND') return unknownOf(target);
      // 가르기는 결제 행 잠금 안의 저장소가 한다: 지금 원장 잔액 = 기대 잔액이고 다른 진행 중 행이 없을 때만(리뷰 B1)
      const settled = await store.settleConfirmedCancelByQuery(target, parsed.cancellationId, query.balanceAmount, budget);
      if (settled.status === 'APPLIED') return { result: 'CANCELLED', cancelledAmount: settled.cancelledAmount };
      if (settled.status === 'UNDECIDABLE') return unknownOf(target);
      // RESEND(기대 잔액 그대로): 아직 반영되지 않았다. 같은 본문으로 다시 보낸다
      if (leftMs() < MIN_CALL_REMAINING_MS || !guard.tryTakeToken()) return unknownOf(target);
    }

    const cancel = await this.#cancel(gateway, target, record, leftMs(), refundAccount);
    switch (cancel.outcome) {
      case 'CANCELLED':
        return this.#finish(target, parsed.cancellationId, budget);
      case 'REJECTED':
        await store.markConfirmedCancel(target, parsed.cancellationId, 'FAILED', budget);
        // 결제사가 계좌를 거절했으면 행을 FAILED로 끝내고 계좌 대기로 답한다(V6)
        return { result: refundAccount !== undefined && cancel.reason === 'REFUND_ACCOUNT_INVALID' ? 'REFUND_ACCOUNT_REQUIRED' : 'REJECTED', cancelledAmount: target.cancelledAmount };
      case 'CANCEL_PENDING':
        await store.markConfirmedCancel(target, parsed.cancellationId, 'CANCEL_PENDING', budget);
        return { result: 'CANCEL_PENDING', cancelledAmount: target.cancelledAmount };
      case 'UNKNOWN':
        return unknownOf(target);
    }
  }

  async #finish(target: ConfirmedCancelTarget, cancellationId: string, budget: CallBudget | undefined): Promise<ConfirmedCancelAnswer> {
    const finished = await this.deps.store.finishConfirmedCancel(target, cancellationId, budget);
    return finished.status === 'APPLIED' ? { result: 'CANCELLED', cancelledAmount: finished.cancelledAmount } : unknownOf(target);
  }

  /** 저장한 본문 그대로 결제사 취소 한 번. 던지거나 한도를 넘으면 결과 모름이다 */
  async #cancel(gateway: PaymentGatewayPort, target: ConfirmedCancelTarget, record: ConfirmedCancelRecord, leftMs: number, refundAccount: RefundAccount | undefined): Promise<CancelResult> {
    try {
      return await withTimeout(
        gateway.cancel({
          paymentRef: target.paymentRef,
          amount: record.fullCancel ? 'ALL' : record.amount,
          reason: record.reason,
          idemKey: record.idemKey,
          expectedBalance: record.expectedBalance,
          ...(refundAccount === undefined ? {} : { refundAccount }),
        }),
        Math.min(CONFIRMED_CANCEL_CALL_TIMEOUT_MS, leftMs),
      );
    } catch {
      return { outcome: 'UNKNOWN' };
    }
  }

  /** 단독 조회 한 번(원장의 결제 시도 ID로 대조). 던지거나 한도를 넘으면 결과 모름이다 */
  async #query(gateway: PaymentGatewayPort, target: ConfirmedCancelTarget, leftMs: number): Promise<QueryResult> {
    const limitMs = Math.min(CONFIRMED_CANCEL_CALL_TIMEOUT_MS, leftMs);
    try {
      return await withTimeout(gateway.query(target.paymentRef, { timeoutMs: limitMs, ...(target.txId === undefined ? {} : { expectedTxId: target.txId }) }), limitMs);
    } catch {
      return QUERY_UNKNOWN;
    }
  }
}

/** 원장을 바꾸지 않은 결과 모름(지금 누적액) */
function unknownOf(target: ConfirmedCancelTarget): ConfirmedCancelAnswer {
  return { result: 'UNKNOWN', cancelledAmount: target.cancelledAmount };
}
