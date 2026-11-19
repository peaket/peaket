// 결제 후 일반 취소(부분·전액) 쓰임새(GAT-080, docs/features/payment.md §4.1).
// 차례: 원장 읽기 → (새 계좌 시도면 앞 진행 중 행을 조회로 닫기) → 취소 건 만들기·찾기(payment_cancel, 트랜잭션) → (3시간 지난 재시도는 먼저 조회) → 결제사 부분 취소(저장한 본문) → 행·원장 반영(트랜잭션).
// 잠금을 쥔 채 결제사를 부르지 않는다. 결제사가 결과를 모르면 원장을 바꾸지 않고 UNKNOWN으로 답한다(부른 쪽이 같은 취소 ID로 다시 부른다).
// 결제사에 보내는 금액·전액 여부·사유·기대 잔액은 저장소가 첫 전송 직전에 적은 취소 건(record)의 값이다. 원장(target)에서 다시 계산하지 않는다
// (같은 멱등키의 본문이 바뀌지 않게, docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액', HOT-140이 넘긴 것).
// 가상계좌 갈래(docs/features/payment.md §6 '결제 후 일반 취소의 가상계좌 갈래', BUILD_ORDER GAT-090): 가상계좌 여부는 저장소가 결제 행 잠금 안에서 본다.
// 계좌가 있으면 결제사 본문에 싣고(저장·로그 없음), 없으면 결제사 취소를 부르지 않는다. 행이 없으면 REFUND_ACCOUNT_REQUIRED, 행이 있으면 조회로 반영을 가른다
// (반영 → CANCELLED, 아님 → REFUND_ACCOUNT_REQUIRED, 가를 수 없음·조회 실패 → UNKNOWN). 결제사가 계좌를 거절하면 행 FAILED와 REFUND_ACCOUNT_REQUIRED다.
// 가상계좌가 아닌 결제에 온 계좌는 보내지 않고 버린다(지표).
// 리뷰 반영(BAT-420-rest RV-02·RV-03·RV-04, payment §6 '구현에서 정한 것' ②④⑥): 포트원 결제의 대응표 밖 은행 코드는 행을 만들기 전에 계좌 없음과 같다.
// 가상계좌 결제에서 그 취소 ID의 행이 이미 있으면 계좌가 있어도(다른 계좌여도) 다시 보내지 않고 조회 대조로만 끝을 본다(같은 멱등키에는 첫 본문만).
// 계좌 거절로 끝낸 행은 fail_reason REFUND_ACCOUNT_INVALID를 남기고, 같은 취소 ID의 다시 부름은 결제사 0·REFUND_ACCOUNT_REQUIRED다(같은 취소 ID = 같은 답).
// 이중 환불 가드(BAT-425, ADR-0316, P-T76): 가상계좌 결제에 계좌를 실은 새 취소 시도(새 취소 ID 또는 같은 취소 ID의 새 시도 번호)는 결제사를 부르기 전에
// 그 결제의 앞 진행 중 행을 한 번 조회해, 반영됐으면 새 전송 0·CANCELLED, 아니면 그 행을 FAILED(SUPERSEDED)로 닫고 새 시도를 보낸다.
// CANCEL_PENDING·진행 중 행 둘 이상·조회 실패는 새 전송 0·UNKNOWN이다(잔액으로 어느 행의 반영인지 가를 수 없다).
import type { Clock } from '@peaket/platform';
import { MIN_CALL_REMAINING_MS, PaymentInputError, PaymentNotFoundError } from '../domain/confirm-command.js';
import {
  CONFIRMED_CANCEL_QUERY_AFTER_MS,
  type ConfirmedCancelAnswer,
  type ConfirmedCancelInProgress,
  type ConfirmedCancelInput,
  type ConfirmedCancelRecord,
  type ConfirmedCancelTarget,
  confirmedCancelIdemKey,
  parseConfirmedCancel,
} from '../domain/confirmed-cancel.js';
import { PaymentCancelStateError } from '../domain/deposit-cancel.js';
import { type CancelResult, type PaymentGatewayPort, portoneBankOf, type QueryResult, type RefundAccount, refundAccountOf } from '../domain/payment-gateway.js';
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

/** 앞 진행 중 행 정리 결과. PROCEED만 새 시도를 보낸다 */
type PriorAttemptOutcome = { readonly action: 'PROCEED' } | { readonly action: 'RETURN'; readonly answer: ConfirmedCancelAnswer };

export class CancelConfirmedPayment {
  constructor(readonly deps: CancelConfirmedPaymentDeps) {}

  /**
   * @throws PaymentInputError 입력이 틀렸다·요청액이 남은 금액과 진행 중 합을 넘는다·같은 취소 ID에 다른 금액·계좌 없는 새 시도(INVALID_ARGUMENT)
   * @throws PaymentNotFoundError 결제가 없다(NOT_FOUND)
   * @throws PaymentCancelStateError 승인·부분 취소 상태가 아니다·남은 금액이 없다(FAILED_PRECONDITION)
   */
  async execute(input: ConfirmedCancelInput, budget?: CallBudget): Promise<ConfirmedCancelAnswer> {
    const { store, gateways, guards, clock } = this.deps;
    const parsed = parseConfirmedCancel(input);
    const attempt = parsed.refundAttempt ?? 0;
    // 모양이 틀린 계좌는 없는 것과 같다(docs/features/payment.md §6 '구현에서 정한 것' ②). 값은 이 호출 안에서만 쓴다
    let account = refundAccountOf(input.refundAccount);
    const target = await store.readConfirmedCancelTarget(parsed.paymentId, budget);
    if (target === undefined) throw new PaymentNotFoundError();
    // 포트원 대응표 밖 은행 코드는 모양이 틀린 계좌와 같다(행을 만들기 전, 같은 취소 ID를 맞는 계좌로 다시 쓸 수 있다, RV-04)
    if (account !== undefined && target.pg === 'PORTONE' && portoneBankOf(account.bankCode) === undefined) account = undefined;

    const newIdemKey = confirmedCancelIdemKey(parsed.cancellationId, attempt);
    // 같은 시도의 행이 있는지 먼저 본다. 계좌를 실은 시도가 결과 모름(CANCEL_PENDING·UNKNOWN)으로 남은 뒤의 재시도는
    // 계좌를 저장하지 않으므로 계좌 없이 온다. 그때는 거절하지 않고 같은 시도의 멱등키로 조회·정산한다(RV-01, ADR-0316 결정 4, B9)
    const needsOwnLookup = target.virtualAccount === true || attempt > 0;
    const own = needsOwnLookup ? await store.findCancelStatus?.(target.paymentId, newIdemKey, budget) : undefined;
    // 계좌 없이 온 새 시도(그 시도의 행도 없다)만 계좌가 필요하다. 계좌를 다시 받는 시도이므로 거절한다(ADR-0316)
    if (attempt > 0 && account === undefined && own === undefined) throw new PaymentInputError('refund_account');

    // 새 계좌 시도 전 앞 진행 중 행 정리(B1~B5, P-T76 ①③④). 가상계좌가 아니거나 계좌가 없거나 이미 있는 행의 재시도면 지금 그대로다
    if (target.virtualAccount === true && account !== undefined && own === undefined) {
      const prior = await this.#priorAttempts(target, newIdemKey, budget);
      if (prior !== undefined) {
        const outcome = await this.#settlePrior(
          target,
          prior,
          { cancellationId: parsed.cancellationId, attempt, ...(parsed.amount === undefined ? {} : { amount: parsed.amount }), reason: parsed.reason },
          budget,
        );
        if (outcome.action === 'RETURN') return outcome.answer;
      }
    }

    const begun = await store.beginConfirmedCancel(
      target,
      {
        cancellationId: parsed.cancellationId,
        ...(parsed.amount === undefined ? {} : { amount: parsed.amount }),
        reason: parsed.reason,
        ...(account === undefined ? {} : { hasRefundAccount: true }),
        ...(attempt === 0 ? {} : { attempt }),
      },
      budget,
    );
    switch (begun.status) {
      case 'ACCOUNT_REQUIRED':
        // 가상계좌인데 계좌가 없고 행도 없다: 결제사 0·행 0(V4). 계좌 거절로 끝낸 행의 다시 부름도 같은 답이다(RV-03)
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

    // 가상계좌의 다시 부름(앞서 계좌를 실어 보낸 행이 진행 중): 계좌가 있어도 같은 멱등키로 다른 본문을 보내지 않고 조회로만 끝을 본다(V5, RV-02 ⑥)
    if (virtualAccount && (replay || refundAccount === undefined)) {
      const query = await this.#query(gateway, target, leftMs());
      if (query.kind !== 'FOUND') return unknownOf(target);
      const settled = await store.settleConfirmedCancelByQuery(target, parsed.cancellationId, query.balanceAmount, budget, record.attempt ?? 0);
      if (settled.status === 'APPLIED') return { result: 'CANCELLED', cancelledAmount: settled.cancelledAmount };
      if (settled.status === 'RESEND') return { result: 'REFUND_ACCOUNT_REQUIRED', cancelledAmount: target.cancelledAmount };
      return unknownOf(target);
    }

    // 만든 지 3시간 이상(정각 포함) 지난 취소 건의 재시도는 결제사 멱등키 보관이 끝났을 수 있어 먼저 조회한다(P-T21)
    if (replay && clock.now() - record.createdAtMs >= CONFIRMED_CANCEL_QUERY_AFTER_MS) {
      const query = await this.#query(gateway, target, leftMs());
      if (query.kind !== 'FOUND') return unknownOf(target);
      // 가르기는 결제 행 잠금 안의 저장소가 한다: 지금 원장 잔액 = 기대 잔액이고 다른 진행 중 행이 없을 때만(리뷰 B1)
      const settled = await store.settleConfirmedCancelByQuery(target, parsed.cancellationId, query.balanceAmount, budget, record.attempt ?? 0);
      if (settled.status === 'APPLIED') return { result: 'CANCELLED', cancelledAmount: settled.cancelledAmount };
      if (settled.status === 'UNDECIDABLE') return unknownOf(target);
      // RESEND(기대 잔액 그대로): 아직 반영되지 않았다. 같은 본문으로 다시 보낸다
      if (leftMs() < MIN_CALL_REMAINING_MS || !guard.tryTakeToken()) return unknownOf(target);
    }

    const cancel = await this.#cancel(gateway, target, record, leftMs(), refundAccount);
    switch (cancel.outcome) {
      case 'CANCELLED':
        return this.#finish(target, parsed.cancellationId, record.attempt ?? 0, budget);
      case 'REJECTED':
      {
        // 결제사가 계좌를 거절했으면 행을 FAILED(fail_reason REFUND_ACCOUNT_INVALID)로 끝내고 계좌 대기로 답한다(V6, RV-03)
        const accountInvalid = refundAccount !== undefined && cancel.reason === 'REFUND_ACCOUNT_INVALID';
        await store.markConfirmedCancel(target, parsed.cancellationId, 'FAILED', budget, accountInvalid ? 'REFUND_ACCOUNT_INVALID' : undefined, record.attempt ?? 0);
        return { result: accountInvalid ? 'REFUND_ACCOUNT_REQUIRED' : 'REJECTED', cancelledAmount: target.cancelledAmount };
      }
      case 'CANCEL_PENDING':
        await store.markConfirmedCancel(target, parsed.cancellationId, 'CANCEL_PENDING', budget, undefined, record.attempt ?? 0);
        return { result: 'CANCEL_PENDING', cancelledAmount: target.cancelledAmount };
      case 'UNKNOWN':
        return unknownOf(target);
    }
  }

  /** 진행 중 행을 읽는다. 저장소가 옛 모양(메서드 없음)이면 undefined(지금 그대로)다 */
  async #priorAttempts(target: ConfirmedCancelTarget, excludeIdemKey: string, budget: CallBudget | undefined): Promise<readonly ConfirmedCancelInProgress[] | undefined> {
    if (this.deps.store.listInProgressCancels === undefined) return undefined;
    return this.deps.store.listInProgressCancels(target.paymentId, excludeIdemKey, budget);
  }

  /**
   * 앞 진행 중 행을 조회로 닫거나, 닫을 수 없으면 결과 모름으로 답한다(ADR-0316 B1~B5).
   * CANCEL_PENDING은 결제사가 비동기로 받아들인 것이라 닫지 않는다. 진행 중 행이 둘 이상이면 잔액으로 가를 수 없다.
   * REQUESTED 하나는 결제사에 한 번 조회해, 반영이면 그 행을 CANCELED로 끝내고 새 전송 0, 아니면 FAILED(SUPERSEDED)로 닫고 진행한다.
   */
  async #settlePrior(
    target: ConfirmedCancelTarget,
    prior: readonly ConfirmedCancelInProgress[],
    q: { readonly cancellationId: string; readonly attempt: number; readonly amount?: number; readonly reason: string },
    budget: CallBudget | undefined,
  ): Promise<PriorAttemptOutcome> {
    const { store, gateways, guards, clock } = this.deps;
    if (prior.length === 0) return { action: 'PROCEED' };
    if (prior.length > 1) {
      this.deps.refundAccountSignals?.cancelSuperseded?.('undecidable');
      return { action: 'RETURN', answer: unknownOf(target) };
    }
    const row = prior[0]!;
    const gateway = gateways.of(target.pg);
    const guard = gateway === undefined ? undefined : guards.of(target.pg);
    const deadlineAtMs = budget === undefined ? Number.POSITIVE_INFINITY : clock.now() + budget.remainingMs;
    const leftMs = (): number => deadlineAtMs - clock.now();
    if (row.status === 'CANCEL_PENDING') {
      this.deps.refundAccountSignals?.cancelSuperseded?.('undecidable');
      return { action: 'RETURN', answer: unknownOf(target) };
    }
    // 새 시도의 금액이 앞 행과 다르면 앞 행의 반영이 이 시도를 덮는다고 말할 수 없다(앞 행을 건드리지 않고 결과 모름).
    // 금액을 비운 전액 취소도 앞 행이 남은 전부를 덮었을 때만 같은 답을 줄 수 있다
    if ((q.amount !== undefined && q.amount !== row.amount) || (q.amount === undefined && row.amount !== row.expectedBalance)) {
      this.deps.refundAccountSignals?.cancelSuperseded?.('undecidable');
      return { action: 'RETURN', answer: unknownOf(target) };
    }
    if (gateway === undefined || guard === undefined || !guard.circuitClosed() || !guard.tryTakeToken()) {
      this.deps.refundAccountSignals?.cancelSuperseded?.('undecidable');
      return { action: 'RETURN', answer: unknownOf(target) };
    }
    // 조회 한 번. 실패·시간 초과는 반영 아님으로 읽지 않는다(새 전송 0, 결과 모름)
    const query = await this.#query(gateway, target, leftMs());
    if (query.kind !== 'FOUND') {
      this.deps.refundAccountSignals?.cancelSuperseded?.('undecidable');
      return { action: 'RETURN', answer: unknownOf(target) };
    }
    const settled = await store.settlePriorConfirmedCancel?.(target, row.idemKey, query.balanceAmount, budget);
    if (settled === undefined) {
      this.deps.refundAccountSignals?.cancelSuperseded?.('undecidable');
      return { action: 'RETURN', answer: unknownOf(target) };
    }
    if (settled.status === 'APPLIED') {
      if (store.satisfyWithPriorCancel !== undefined) {
        const marked = await store.satisfyWithPriorCancel(target, q, row, budget);
        if (marked === undefined) {
          this.deps.refundAccountSignals?.cancelSuperseded?.('undecidable');
          return { action: 'RETURN', answer: unknownOf(target) };
        }
        this.deps.refundAccountSignals?.cancelSuperseded?.('applied');
        return { action: 'RETURN', answer: { result: 'CANCELLED', cancelledAmount: marked.cancelledAmount } };
      }
      this.deps.refundAccountSignals?.cancelSuperseded?.('applied');
      return { action: 'RETURN', answer: { result: 'CANCELLED', cancelledAmount: settled.cancelledAmount } };
    }
    if (settled.status === 'UNDECIDABLE') {
      this.deps.refundAccountSignals?.cancelSuperseded?.('undecidable');
      return { action: 'RETURN', answer: unknownOf(target) };
    }
    // 반영 아님: 그 행을 조건부로 닫는다(REQUESTED만). 0행이면 그사이 누가 닫았으므로 새 전송을 보내지 않는다
    if (store.closeSupersededCancel === undefined || !(await store.closeSupersededCancel(target.paymentId, row.idemKey, budget))) {
      this.deps.refundAccountSignals?.cancelSuperseded?.('undecidable');
      return { action: 'RETURN', answer: unknownOf(target) };
    }
    this.deps.refundAccountSignals?.cancelSuperseded?.('not_applied');
    // 잠금을 쥔 채 결제사를 부르지 않는다: 다음 begin이 잔액을 다시 계산하고 새 본문을 저장한다
    return { action: 'PROCEED' };
  }

  async #finish(target: ConfirmedCancelTarget, cancellationId: string, attempt: number, budget: CallBudget | undefined): Promise<ConfirmedCancelAnswer> {
    const finished = await this.deps.store.finishConfirmedCancel(target, cancellationId, budget, attempt);
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
