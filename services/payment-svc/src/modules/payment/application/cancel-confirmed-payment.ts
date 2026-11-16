// 결제 후 일반 취소(부분·전액) 쓰임새(GAT-080, docs/features/payment.md §4.1).
// 차례: 원장 읽기 → 취소 건 만들기·찾기(payment_cancel, 트랜잭션) → (3시간 지난 재시도는 먼저 조회) → 결제사 부분 취소(저장한 본문) → 행·원장 반영(트랜잭션).
// 잠금을 쥔 채 결제사를 부르지 않는다. 결제사가 결과를 모르면 원장을 바꾸지 않고 UNKNOWN으로 답한다(부른 쪽이 같은 취소 ID로 다시 부른다).
// 결제사에 보내는 금액·전액 여부·사유·기대 잔액은 저장소가 첫 전송 직전에 적은 취소 건(record)의 값이다. 원장(target)에서 다시 계산하지 않는다
// (같은 멱등키의 본문이 바뀌지 않게, docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액', HOT-140이 넘긴 것).
import type { Clock } from '@peaket/platform';
import { MIN_CALL_REMAINING_MS, PaymentInputError, PaymentNotFoundError } from '../domain/confirm-command.js';
import {
  CONFIRMED_CANCEL_QUERY_AFTER_MS,
  type ConfirmedCancelAnswer,
  type ConfirmedCancelInput,
  type ConfirmedCancelRecord,
  type ConfirmedCancelResult,
  type ConfirmedCancelTarget,
  parseConfirmedCancel,
  settleByBalance,
} from '../domain/confirmed-cancel.js';
import { PaymentCancelStateError } from '../domain/deposit-cancel.js';
import type { CancelResult, PaymentGatewayPort, QueryResult } from '../domain/payment-gateway.js';
import type { PgCallGuards } from '../domain/pg-call-guard.js';
import type { CallBudget, PaymentConfirmedCancels, PaymentGateways } from '../domain/ports.js';

/** 결제사 취소·조회 호출 한 번을 기다리는 시간 10초 [가정](입금 전 취소와 같다) */
const CONFIRMED_CANCEL_CALL_TIMEOUT_MS = 10_000;

export interface CancelConfirmedPaymentDeps {
  store: PaymentConfirmedCancels;
  gateways: PaymentGateways;
  guards: Pick<PgCallGuards, 'of'>;
  clock: Clock;
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

const OUTCOME_OF: Readonly<Record<CancelResult['outcome'], ConfirmedCancelResult>> = {
  CANCELLED: 'CANCELLED',
  CANCEL_PENDING: 'CANCEL_PENDING',
  REJECTED: 'REJECTED',
  UNKNOWN: 'UNKNOWN',
};

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
    const target = await store.readConfirmedCancelTarget(parsed.paymentId, budget);
    if (target === undefined) throw new PaymentNotFoundError();

    const begun = await store.beginConfirmedCancel(
      target,
      { cancellationId: parsed.cancellationId, ...(parsed.amount === undefined ? {} : { amount: parsed.amount }), reason: parsed.reason },
      budget,
    );
    switch (begun.status) {
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
        // 리뷰 B3 빈 뼈대(BAT-415 리뷰 반영): 거절로 끝난 건의 재요청. 구현 담당이 채운다
        throw new Error('아직 없음');
      case 'BUSY':
        // 같은 결제의 다른 취소가 10분 안에 진행 중이다: 보내지 않고 결과 모름(부른 쪽이 다시 시도한다)
        return unknownOf(target);
      case 'BEGUN':
        break;
    }
    const { record, replay } = begun;

    const deadlineAtMs = budget === undefined ? Number.POSITIVE_INFINITY : clock.now() + budget.remainingMs;
    const leftMs = (): number => deadlineAtMs - clock.now();
    const gateway = gateways.of(target.pg);
    const guard = gateway === undefined ? undefined : guards.of(target.pg);
    if (gateway === undefined || guard === undefined || leftMs() < MIN_CALL_REMAINING_MS || !guard.circuitClosed() || !guard.tryTakeToken()) return unknownOf(target);

    // 만든 지 3시간 이상(정각 포함) 지난 취소 건의 재시도는 결제사 멱등키 보관이 끝났을 수 있어 먼저 조회한다(P-T21)
    if (replay && clock.now() - record.createdAtMs >= CONFIRMED_CANCEL_QUERY_AFTER_MS) {
      const query = await this.#query(gateway, target, leftMs());
      if (query.kind !== 'FOUND') return unknownOf(target);
      const settled = settleByBalance(record, query.balanceAmount);
      if (settled === 'APPLIED') return this.#finish(target, parsed.cancellationId, budget);
      if (settled === 'UNKNOWN') return unknownOf(target);
      // 기대 잔액 그대로: 아직 반영되지 않았다. 같은 본문으로 다시 보낸다
      if (leftMs() < MIN_CALL_REMAINING_MS || !guard.tryTakeToken()) return unknownOf(target);
    }

    const cancel = await this.#cancel(gateway, target, record, leftMs());
    switch (cancel.outcome) {
      case 'CANCELLED':
        return this.#finish(target, parsed.cancellationId, budget);
      case 'CANCEL_PENDING':
      case 'REJECTED':
        await store.markConfirmedCancel(target, parsed.cancellationId, cancel.outcome === 'REJECTED' ? 'FAILED' : 'CANCEL_PENDING', budget);
        return { result: OUTCOME_OF[cancel.outcome], cancelledAmount: target.cancelledAmount };
      case 'UNKNOWN':
        return unknownOf(target);
    }
  }

  async #finish(target: ConfirmedCancelTarget, cancellationId: string, budget: CallBudget | undefined): Promise<ConfirmedCancelAnswer> {
    const finished = await this.deps.store.finishConfirmedCancel(target, cancellationId, budget);
    return finished.status === 'APPLIED' ? { result: 'CANCELLED', cancelledAmount: finished.cancelledAmount } : unknownOf(target);
  }

  /** 저장한 본문 그대로 결제사 취소 한 번. 던지거나 한도를 넘으면 결과 모름이다 */
  async #cancel(gateway: PaymentGatewayPort, target: ConfirmedCancelTarget, record: ConfirmedCancelRecord, leftMs: number): Promise<CancelResult> {
    try {
      return await withTimeout(
        gateway.cancel({
          paymentRef: target.paymentRef,
          amount: record.fullCancel ? 'ALL' : record.amount,
          reason: record.reason,
          idemKey: record.idemKey,
          expectedBalance: record.expectedBalance,
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
