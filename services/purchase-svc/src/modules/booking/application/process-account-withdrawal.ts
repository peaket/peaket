// 탈퇴 참여자(docs/features/payment.md §4.1 '탈퇴 참여자의 첫 구현', docs/api/proto/peaket/purchase/v1/account.proto WithdrawalParticipantService,
// ADR-0284, BUILD_ORDER PRF-169, P-T55. 미사용 티켓은 PRF-174, I-T26, BAT-013). identity-svc가 탈퇴 요청과 다시 하기 고리에서 부른다.
// 차례: 그 계정의 결제 결과 대기·입금 대기 주문을 한 문장으로 읽는다(문장 시간 한도 min(400ms [가정], 남은 시간)) → 입금 대기 주문마다 차례로
// payment-svc CancelPayment(취소 ID withdrawal-{주문 ID}, 금액 = 주문 금액, 사유 ACCOUNT_WITHDRAWAL, 범위 DEPOSIT_ONLY, 데드라인 min(남은 시간 − 100ms, 5초) [가정])를 부른다.
// 범위 DEPOSIT_ONLY라 원장이 이미 승인이면 일반 취소(전액 환불)로 가지 않고 REJECTED다(payment §6 '입금 전 취소만 부르기', BAT-010 D1·D2).
// 그다음 결제한 미사용 티켓을 표마다 기존 취소 Saga(사유 ACCOUNT_WITHDRAWAL, POL-032 공제, 표마다 고정 취소 ID)로 취소한다(한 호출 10건 [가정]).
// 남은 시간이 50ms [가정]보다 모자라거나 이번 호출에서 10건 [가정]을 이미 불렀으면 부르지 않고 남은 것으로 센다. 답이 CANCELLED면 끝난 것, 그 밖과 호출 실패는 남은 것이다.
// 남은 것이 없으면 DONE, 있으면 PENDING과 이유다. 주문 행·좌석·결제를 직접 바꾸지 않는다(주문의 T17은 결제 사건으로 지금처럼 온다).
import type { Clock } from '@peaket/platform';
import type { OrderStatus } from '../domain/order.js';
import {
  type WithdrawalDepositCancellations,
  type WithdrawalDepositCancelOutcome,
  type WithdrawalOrders,
  WithdrawalOrdersUnavailable,
  type WithdrawalParticipantLogger,
  type WithdrawalParticipantSignals,
  type WithdrawalTickets,
} from '../domain/ports.js';

/** 결제 결과를 기다리는 주문 상태(ADR-0284 결정 6). CREATED는 탈퇴 전 액세스 토큰으로 결제를 시작할 수 있어 끝날 때까지 센다 */
export const WITHDRAWAL_PAYMENT_PENDING_STATUSES: readonly OrderStatus[] = ['CREATED', 'AUTHENTICATED', 'ACCEPTED', 'RESERVED', 'UNKNOWN'];
/** 입금 대기 주문 상태(입금 전 취소 대상) */
export const WITHDRAWAL_DEPOSIT_STATUS: OrderStatus = 'AWAITING_DEPOSIT';
/** 계정 주문 찾기의 문장 시간 한도 400ms [가정](남은 시간과 짧은 쪽) */
export const WITHDRAWAL_STATEMENT_TIMEOUT_MS = 400;
/** 취소 호출 하나의 데드라인 상한 5초 [가정] */
export const WITHDRAWAL_CANCEL_DEADLINE_MS = 5_000;
/** 취소 호출의 데드라인을 남은 시간에서 뺄 여유 100ms [가정](답을 돌려줄 시간) */
export const WITHDRAWAL_CANCEL_MARGIN_MS = 100;
/** 이보다 남은 시간이 모자라면 취소를 부르지 않는다 50ms [가정](50ms면 부른다) */
export const WITHDRAWAL_CANCEL_MIN_REMAINING_MS = 50;
/** 한 호출에서 부르는 취소 상한 10건 [가정] */
export const WITHDRAWAL_CANCEL_LIMIT = 10;
/** 탈퇴 취소 ID(주문마다 하나라 다시 불러도 같은 결제사 멱등키 cancel-withdrawal-{주문 ID}다) */
export const withdrawalCancellationId = (orderId: string): string => `withdrawal-${orderId}`;

/** 미사용 티켓 취소 상한·여유(미사용 티켓 취소 한 번의 셈, payment §4.1 '미사용 티켓 취소') */
export const WITHDRAWAL_TICKET_CANCEL_LIMIT = 10;
export const WITHDRAWAL_TICKET_CANCEL_MIN_REMAINING_MS = 50;
export const WITHDRAWAL_TICKET_CANCEL_MARGIN_MS = 100;
export const WITHDRAWAL_TICKET_CANCEL_DEADLINE_MS = 5_000;

export type WithdrawalPendingReasonName = 'PAYMENT_PENDING_ORDER' | 'DEPOSIT_CANCEL_PENDING' | 'TICKET_REFUND_PENDING';
export interface ProcessAccountWithdrawalResult {
  state: 'DONE' | 'PENDING';
  /** PENDING일 때만 채운다. 같은 이유를 두 번 싣지 않는다 */
  reasons: WithdrawalPendingReasonName[];
  /** 결제 결과를 기다리는 주문 수 */
  paymentPendingOrders: number;
  /** 이번 호출에서 CancelPayment가 CANCELLED로 답한 입금 대기 주문 수 */
  depositOrdersCancelled: number;
  /** 취소가 남은 입금 대기 주문 수(부르지 못한 것 포함) */
  depositOrdersPending: number;
  /** 이번 호출에서 취소가 끝난(환급까지 끝났거나 이미 환급된) 미사용 티켓 수 */
  unusedTicketsCancelled: number;
  /** 취소·환급이 남은 미사용 티켓 수(취소 행이 REQUESTED·REFUND_PENDING인 표 + 이번에 취소 행을 만들지 못한 표, 같은 표를 두 번 세지 않는다) */
  unusedTicketsPending: number;
}

export interface ProcessAccountWithdrawalDeps {
  orders: WithdrawalOrders;
  deposits: WithdrawalDepositCancellations;
  clock: Clock;
  /**
   * 결제한 미사용 티켓(PRF-174). 없으면 티켓 몫을 건너뛴다(견적 0장, DONE에 영향 없음: 옛 시험·조립).
   * DB·판매 설정에 닿지 못하면 WithdrawalOrdersUnavailable을 던진다(gRPC UNAVAILABLE)
   */
  tickets?: WithdrawalTickets;
  signals?: WithdrawalParticipantSignals;
  log?: WithdrawalParticipantLogger;
}

const RESULT_OF: Readonly<Record<WithdrawalDepositCancelOutcome, 'cancelled' | 'pending' | 'unknown' | 'rejected'>> = {
  CANCELLED: 'cancelled',
  PENDING: 'pending',
  UNKNOWN: 'unknown',
  REJECTED: 'rejected',
};

export class ProcessAccountWithdrawal {
  constructor(private readonly d: ProcessAccountWithdrawalDeps) {}

  /**
   * deadlineAtMs: 이 호출의 마감 시각(ms, 받는 층이 gRPC 데드라인으로 준다. 없으면 Infinity).
   * @throws WithdrawalOrdersUnavailable purchase DB에 닿지 못했거나 문장 시간 한도를 넘었다(남은 시간이 1ms도 없을 때도). 그 밖의 SQL 오류는 그대로 던진다
   */
  async run(i: { accountId: string; deadlineAtMs: number }): Promise<ProcessAccountWithdrawalResult> {
    const remaining = (): number => i.deadlineAtMs - this.d.clock.now();
    let orders: Awaited<ReturnType<WithdrawalOrders['openOrdersOf']>>;
    try {
      const left = remaining();
      if (!(left >= 1)) throw new WithdrawalOrdersUnavailable(new Error('남은 시간이 없다'));
      orders = await this.d.orders.openOrdersOf(i.accountId, { statementTimeoutMs: Math.max(1, Math.floor(Math.min(WITHDRAWAL_STATEMENT_TIMEOUT_MS, left))) });
    } catch (e) {
      this.d.signals?.participant('error');
      throw e;
    }
    const paymentPendingOrders = orders.filter((o) => WITHDRAWAL_PAYMENT_PENDING_STATUSES.includes(o.status)).length;
    let depositOrdersCancelled = 0;
    let depositOrdersPending = 0;
    let calls = 0;
    for (const o of orders) {
      if (o.status !== WITHDRAWAL_DEPOSIT_STATUS) continue;
      const left = remaining();
      // 상한을 넘었거나 남은 시간이 50ms보다 모자라면 부르지 않고 남은 것으로 센다(다음 호출이 같은 취소 ID로 다시 보낸다)
      if (calls >= WITHDRAWAL_CANCEL_LIMIT || left < WITHDRAWAL_CANCEL_MIN_REMAINING_MS) {
        depositOrdersPending++;
        this.d.signals?.depositCancel('skipped');
        continue;
      }
      calls++;
      const deadlineMs = Math.max(1, Math.floor(Math.min(left - WITHDRAWAL_CANCEL_MARGIN_MS, WITHDRAWAL_CANCEL_DEADLINE_MS)));
      let outcome: WithdrawalDepositCancelOutcome;
      try {
        outcome = await this.d.deposits.cancel({ cancellationId: withdrawalCancellationId(o.orderId), orderId: o.orderId, amount: o.amount, reason: 'ACCOUNT_WITHDRAWAL', deadlineMs, scope: 'DEPOSIT_ONLY' });
      } catch {
        outcome = 'UNKNOWN';
      }
      const result = RESULT_OF[outcome] ?? 'unknown';
      this.d.signals?.depositCancel(result);
      if (result === 'cancelled') {
        depositOrdersCancelled++;
        continue;
      }
      depositOrdersPending++;
      // 입금이 먼저 확정됐다(주문은 T16으로 간다). 주문 ID만 싣는다
      if (result === 'rejected') this.d.log?.warn({ orderId: o.orderId }, 'withdrawal-deposit-cancel-rejected');
    }
    // 결제한 미사용 티켓(payment §4.1 '미사용 티켓 취소', I-T26 ②③): 입금 대기 취소 뒤에 표마다 기존 취소 Saga를 돈다.
    // 포트가 없는 조립(옛 시험)은 티켓 몫을 건너뛴다(견적 0장, DONE에 영향 없음)
    let unusedTicketsCancelled = 0;
    let unusedTicketsPending = 0;
    if (this.d.tickets) {
      const tickets = this.d.tickets;
      try {
        // 취소 뒤 남은 취소 행(REQUESTED·REFUND_PENDING)을 읽는 문장 시간 한도도 남은 시간과 짧은 쪽이다
        const ticketCancel = await tickets.cancel({
          accountId: i.accountId,
          nowMs: this.d.clock.now(),
          deadlineAtMs: i.deadlineAtMs,
          limit: WITHDRAWAL_TICKET_CANCEL_LIMIT,
          minRemainingMs: WITHDRAWAL_TICKET_CANCEL_MIN_REMAINING_MS,
          marginMs: WITHDRAWAL_TICKET_CANCEL_MARGIN_MS,
          cancelDeadlineCapMs: WITHDRAWAL_TICKET_CANCEL_DEADLINE_MS,
        });
        unusedTicketsCancelled = ticketCancel.cancelled;
        const left = remaining();
        // 남은 환급을 읽지 못하면 DONE으로 접지 않는다(UNAVAILABLE, 고리가 다시 본다)
        const pending = await tickets.pendingRefunds({ accountId: i.accountId, statementTimeoutMs: Math.max(1, Math.floor(Math.min(WITHDRAWAL_STATEMENT_TIMEOUT_MS, left))) });
        // 이번에 취소 행을 만들지 못한 표와 이미 행이 있는 대기 표를 겹치지 않게 더한다(같은 표를 두 번 세지 않는다)
        unusedTicketsPending = pending + ticketCancel.pendingUncanceled;
      } catch (e) {
        this.d.signals?.participant('error');
        throw e instanceof WithdrawalOrdersUnavailable ? e : new WithdrawalOrdersUnavailable(e);
      }
    }
    const reasons: WithdrawalPendingReasonName[] = [];
    if (paymentPendingOrders > 0) reasons.push('PAYMENT_PENDING_ORDER');
    if (depositOrdersPending > 0) reasons.push('DEPOSIT_CANCEL_PENDING');
    if (unusedTicketsPending > 0) reasons.push('TICKET_REFUND_PENDING');
    const state = reasons.length === 0 ? 'DONE' : 'PENDING';
    this.d.signals?.participant(state === 'DONE' ? 'done' : 'pending');
    return { state, reasons, paymentPendingOrders, depositOrdersCancelled, depositOrdersPending, unusedTicketsCancelled, unusedTicketsPending };
  }
}
