// 입금 전 취소 쓰임새(gRPC CancelPayment, docs/features/payment.md §6 '입금 전 취소와 입금 오류 되돌림의 첫 구현', BUILD_ORDER HOT-152, ADR-0062).
// 입금 대기 결제만 받는다. 차례: 표시(트랜잭션) → 결제사 취소 → 단독 조회 → 답 반영(트랜잭션). 잠금을 쥔 채 결제사를 부르지 않는다.
// 호출의 남은 시간을 지킨다: 결제사 호출은 min(10초 [가정], 남은 시간)에서 끊고, 남은 시간이 50ms [가정]보다 모자라면 다음 일을 시작하지 않고 UNKNOWN이다(부른 쪽이 같은 취소 ID로 다시 보낸다, BUILD_ORDER HOT-152 코드 리뷰).
import type { Clock } from '@peaket/platform';
import { MIN_CALL_REMAINING_MS, PaymentInputError, PaymentNotFoundError } from '../domain/confirm-command.js';
import { type DepositCancelAnswer, type DepositCancelInput, type DepositCancelOutcome, type DepositCancelResult, DEPOSIT_CANCEL_CALL_TIMEOUT_MS, decideDepositCancel, depositCancelIdemKey, depositCancelStaleResult, parseDepositCancel, PaymentCancelStateError } from '../domain/deposit-cancel.js';
import type { CancelResult, PaymentGatewayPort, QueryResult } from '../domain/payment-gateway.js';
import type { PgCallGuard, PgCallGuards } from '../domain/pg-call-guard.js';
import { isQueryOutage } from '../domain/pg-circuit.js';
import type { CallBudget, PaymentDepositCancels, PaymentDepositSignals, PaymentGateways } from '../domain/ports.js';

export interface CancelDepositPaymentDeps {
  store: PaymentDepositCancels;
  gateways: PaymentGateways;
  guards: Pick<PgCallGuards, 'of'>;
  signals: Pick<PaymentDepositSignals, 'cancel'>;
  clock: Clock;
}

const QUERY_UNKNOWN: QueryResult = Object.freeze({ kind: 'UNKNOWN' });
const OUTCOME_OF: Readonly<Record<DepositCancelResult, DepositCancelOutcome>> = { CANCELLED: 'cancelled', CANCEL_PENDING: 'pending', REJECTED: 'rejected', UNKNOWN: 'unknown' };

/** 어댑터가 시간 한도를 지키지 않아도 요청이 끝나게 감싼다. 늦게 끝난 호출의 결과는 버린다 */
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

export class CancelDepositPayment {
  constructor(readonly deps: CancelDepositPaymentDeps) {}

  /**
   * @throws PaymentInputError 입력이 틀렸다(INVALID_ARGUMENT)
   * @throws PaymentNotFoundError 결제가 없다(NOT_FOUND)
   * @throws PaymentCancelStateError 입금 대기가 아니다(FAILED_PRECONDITION)
   */
  async execute(input: DepositCancelInput, budget?: CallBudget): Promise<DepositCancelAnswer> {
    const { store, gateways, guards, clock } = this.deps;
    const deadlineAtMs = budget === undefined ? Number.POSITIVE_INFINITY : clock.now() + budget.remainingMs;
    /** 지금 남은 시간(ms). 예산 없는 호출은 무한이다 */
    const leftMs = (): number => deadlineAtMs - clock.now();
    /** 저장소에 넘길 지금 남은 시간. 예산 없는 호출은 undefined다 */
    const left = (): CallBudget | undefined => (budget === undefined ? undefined : { remainingMs: leftMs() });
    let parsed: DepositCancelInput;
    try {
      parsed = parseDepositCancel(input);
    } catch (err) {
      this.#outcome('invalid');
      throw err;
    }
    const target = await store.readCancelTarget(parsed.paymentId, left());
    if (target === undefined) throw new PaymentNotFoundError();
    // 입금 전이라 일부 취소가 없다: 금액을 주면 전액이어야 한다
    if (parsed.amount !== undefined && parsed.amount !== target.amount) {
      this.#outcome('invalid');
      throw new PaymentInputError('amount');
    }
    const begun = await store.beginDepositCancel(target, parsed.cancellationId, left());
    if (begun === 'NOT_WAITING') {
      this.#outcome('not_waiting');
      throw new PaymentCancelStateError();
    }
    if (begun === 'DONE') {
      this.#outcome('replayed');
      return { result: 'CANCELLED' };
    }
    const gateway = gateways.of(target.pg);
    const guard = gateway === undefined ? undefined : guards.of(target.pg);
    // 토큰이 없으면 상한 없이 부르지 않는다. 표시는 남아 있고 부른 쪽이 같은 취소 ID로 다시 보낸다
    // 서킷이 닫혀 있지 않으면 부르지 않고 결과 모름으로 답한다(표시는 남고 부른 쪽이 같은 취소 ID로 다시 보낸다. 시험 호출은 취소가 아니라 단독 조회다, BUILD_ORDER PRF-200)
    if (gateway === undefined || guard === undefined || leftMs() < MIN_CALL_REMAINING_MS || !guard.circuitClosed() || !guard.tryTakeToken()) return this.#answer('UNKNOWN');
    const cancel = await this.#cancel(gateway, target.paymentRef, parsed, leftMs());
    if (leftMs() < MIN_CALL_REMAINING_MS) return this.#answer('UNKNOWN');
    const query = guard.admitsQuery() && guard.tryTakeToken() ? await this.#query(gateway, guard, target.paymentRef, target.txId, leftMs) : QUERY_UNKNOWN;
    const decision = decideDepositCancel(cancel, query, target);
    if (decision.kind === 'ANSWER') return this.#answer(decision.result);
    if (leftMs() < MIN_CALL_REMAINING_MS) return this.#answer('UNKNOWN');
    if ((await store.finishDepositCancel(target, left())) === 'APPLIED') return this.#answer('CANCELLED');
    // 조회와 답 반영 사이에 원장이 먼저 끝났다(기한 경과·입금 확인): 지금 상태로 답한다
    if (leftMs() < MIN_CALL_REMAINING_MS) return this.#answer('UNKNOWN');
    return this.#answer(depositCancelStaleResult(await store.readCancelStatus(target.paymentId, left())));
  }

  /** 결제사 취소 한 번(닫힌 서킷에서만 오고 서킷 판정에 세지 않는다). 던지거나 한도를 넘으면 결과 모름이다 */
  async #cancel(gateway: PaymentGatewayPort, paymentRef: string, input: DepositCancelInput, leftMs: number): Promise<CancelResult> {
    try {
      return await withTimeout(gateway.cancel({ paymentRef, amount: 'ALL', reason: input.reason, idemKey: depositCancelIdemKey(input.cancellationId) }), Math.min(DEPOSIT_CANCEL_CALL_TIMEOUT_MS, leftMs));
    } catch {
      return { outcome: 'UNKNOWN' };
    }
  }

  /**
   * 단독 조회 한 번(서킷 안에서). 던지거나 한도를 넘거나 서킷이 끊으면 결과 모름이다.
   * 부른 쪽의 남은 시간이 다해 끊긴 호출은 결제사 장애가 아니므로 서킷 실패로 세지 않는다(반 열림의 시험 호출이 된 때 다시 열지 않게, 코드 리뷰)
   */
  async #query(gateway: PaymentGatewayPort, guard: PgCallGuard, paymentRef: string, txId: string | undefined, leftMs: () => number): Promise<QueryResult> {
    const limitMs = Math.min(DEPOSIT_CANCEL_CALL_TIMEOUT_MS, leftMs());
    const outOfTime = (): boolean => leftMs() < MIN_CALL_REMAINING_MS;
    try {
      return await guard.run(
        () =>
          withTimeout(gateway.query(paymentRef, { timeoutMs: limitMs, ...(txId === undefined ? {} : { expectedTxId: txId }) }), limitMs).catch((err: unknown) => {
            if (outOfTime()) return QUERY_UNKNOWN;
            throw err;
          }),
        (answer) => isQueryOutage(answer) && !outOfTime(),
        'query',
      );
    } catch {
      return QUERY_UNKNOWN;
    }
  }

  #answer(result: DepositCancelResult): DepositCancelAnswer {
    this.#outcome(OUTCOME_OF[result]);
    return { result };
  }

  /** 지표는 던지지 않기로 했지만, 던져도 취소를 막지 않는다 */
  #outcome(outcome: DepositCancelOutcome): void {
    try {
      this.deps.signals.cancel?.(outcome);
    } catch {
      // 삼킨다
    }
  }
}
