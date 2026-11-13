// 결제 후 일반 취소(부분·전액) 쓰임새(GAT-080, docs/features/payment.md §4.1).
// 차례: 원장 읽기 → 일반 취소 대상 확인 → 취소 ID 표시(트랜잭션) → 결제사 부분 취소 → 원장 반영(트랜잭션).
// 잠금을 쥔 채 결제사를 부르지 않는다. 결제사가 결과를 모르면 원장을 바꾸지 않고 UNKNOWN으로 답한다(부른 쪽이 같은 취소 ID로 다시 부른다).
import type { Clock } from '@peaket/platform';
import { MIN_CALL_REMAINING_MS, PaymentInputError, PaymentNotFoundError } from '../domain/confirm-command.js';
import {
  type ConfirmedCancelAnswer,
  type ConfirmedCancelInput,
  type ConfirmedCancelResult,
  type ConfirmedCancelTarget,
  confirmedCancelIdemKey,
  isConfirmedStatus,
  parseConfirmedCancel,
  remainingCancellable,
} from '../domain/confirmed-cancel.js';
import { PaymentCancelStateError } from '../domain/deposit-cancel.js';
import type { CancelResult, PaymentGatewayPort } from '../domain/payment-gateway.js';
import type { PgCallGuard, PgCallGuards } from '../domain/pg-call-guard.js';
import type { CallBudget, PaymentConfirmedCancels, PaymentGateways } from '../domain/ports.js';

/** 결제사 취소 호출 한 번을 기다리는 시간 10초 [가정](입금 전 취소와 같다) */
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

export class CancelConfirmedPayment {
  constructor(readonly deps: CancelConfirmedPaymentDeps) {}

  /**
   * @throws PaymentInputError 입력이 틀렸다(INVALID_ARGUMENT)
   * @throws PaymentNotFoundError 결제가 없다(NOT_FOUND)
   * @throws PaymentCancelStateError 승인·부분 취소 상태가 아니다(FAILED_PRECONDITION)
   */
  async execute(input: ConfirmedCancelInput, budget?: CallBudget): Promise<ConfirmedCancelAnswer> {
    const { store, gateways, guards, clock } = this.deps;
    const parsed = parseConfirmedCancel(input);
    const target = await store.readConfirmedCancelTarget(parsed.paymentId, budget);
    if (target === undefined) throw new PaymentNotFoundError();
    const remaining = remainingCancellable(target);
    // 끝난 상태라도 같은 취소 ID의 재요청은 begin이 DONE으로 알아본다. 그 밖의 상태는 일반 취소 대상이 아니다
    if (remaining > 0 && !isConfirmedStatus(target.status)) throw new PaymentCancelStateError('승인된 결제만 취소할 수 있다');
    if (remaining <= 0 && target.status !== 'CANCELED' && target.status !== 'PARTIAL_CANCELED') throw new PaymentCancelStateError('남은 취소 가능 금액이 없다');
    const amount = parsed.amount ?? remaining;
    if (amount > remaining) throw new PaymentInputError('amount');

    const begun = await store.beginConfirmedCancel(target, parsed.cancellationId, budget);
    if (begun === 'NOT_CONFIRMED') throw new PaymentCancelStateError('승인된 결제만 취소할 수 있다');
    if (begun === 'DONE') return { result: 'CANCELLED', cancelledAmount: target.cancelledAmount };
    if (remaining <= 0) throw new PaymentCancelStateError('남은 취소 가능 금액이 없다');

    const deadlineAtMs = budget === undefined ? Number.POSITIVE_INFINITY : clock.now() + budget.remainingMs;
    const leftMs = (): number => deadlineAtMs - clock.now();
    const gateway = gateways.of(target.pg);
    const guard = gateway === undefined ? undefined : guards.of(target.pg);
    if (gateway === undefined || guard === undefined || leftMs() < MIN_CALL_REMAINING_MS || !guard.circuitClosed() || !guard.tryTakeToken()) {
      return { result: 'UNKNOWN', cancelledAmount: target.cancelledAmount };
    }
    const cancel = await this.#cancel(gateway, target, amount, remaining, parsed.reason, parsed.cancellationId, leftMs());
    if (cancel.outcome !== 'CANCELLED') return { result: OUTCOME_OF[cancel.outcome], cancelledAmount: target.cancelledAmount };
    const finished = await store.finishConfirmedCancel(target, parsed.cancellationId, amount, budget);
    return finished.status === 'APPLIED'
      ? { result: 'CANCELLED', cancelledAmount: finished.cancelledAmount }
      : { result: 'UNKNOWN', cancelledAmount: target.cancelledAmount };
  }

  async #cancel(gateway: PaymentGatewayPort, target: ConfirmedCancelTarget, amount: number, remaining: number, reason: string, cancellationId: string, leftMs: number): Promise<CancelResult> {
    try {
      return await withTimeout(
        gateway.cancel({
          paymentRef: target.paymentRef,
          amount: amount === remaining ? 'ALL' : amount,
          reason,
          idemKey: confirmedCancelIdemKey(cancellationId),
        }),
        Math.min(CONFIRMED_CANCEL_CALL_TIMEOUT_MS, leftMs),
      );
    } catch {
      return { outcome: 'UNKNOWN' };
    }
  }
}
