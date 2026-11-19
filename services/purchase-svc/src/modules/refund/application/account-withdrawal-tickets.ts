// 탈퇴 참여자의 결제한 미사용 티켓의 견적·취소·남은 환급(docs/features/payment.md §4.1 '미사용 티켓 견적'·'미사용 티켓 취소' '답',
// docs/features/identity.md §8 '미사용 티켓 확인과 취소', docs/planning/03 §1.5 ①, ADR-0284 결정 7, I-T26, BAT-013).
// 견적은 그 계정이 결제하고 아직 가진 표를 한 문장으로 읽고, 회차 판매 설정(공연 시작·입장 시작)으로 메모리에서 POL-032 견적을 낸다.
// 취소는 표마다 기존 예매 취소 Saga(CancelTicket, 사유 ACCOUNT_WITHDRAWAL, 표 ID에서 만든 고정 취소 ID)를 돌린다.
// 행을 만든 뒤 실패한 표는 pendingRefunds가 세므로 pendingUncanceled에 두 번 세지 않는다(취소 ID로 행을 확인한다).
import { WITHDRAWAL_STATEMENT_TIMEOUT_MS, type UnusedTicketsQuote, type WithdrawalParticipantLogger, type WithdrawalParticipantSignals, WithdrawalOrdersUnavailable, type WithdrawalTickets, type WithdrawalTicketsCancelResult } from '../../booking/index.js';
import { TRANSFER_CLOSE_BEFORE_START_MS, type WithdrawalTicket, type WithdrawalTicketStore, withdrawalTicketCancellationId } from '../domain/account-withdrawal-tickets.js';
import type { CancellationConfigs } from '../domain/ports.js';
import { type BusinessCalendar, quoteRefund } from '../domain/refund-policy.js';
import type { CancelTicket } from './cancel-ticket.js';

const EVENT_START_OFFSET_MS = 24 * 60 * 60 * 1000;

export interface AccountWithdrawalTicketsDeps {
  readonly store: WithdrawalTicketStore;
  /** 회차 판매 설정(좌석맵 판의 saleEndsAt·entryOpensAt). 읽지 못한 표가 있으면 견적·취소는 UNAVAILABLE이다 */
  readonly configs: CancellationConfigs;
  readonly calendar: BusinessCalendar;
  /** ticket-svc 주소가 없는 조립(local·ci)은 없다: 취소할 표가 있는 탈퇴는 미뤄진다 */
  readonly cancelTicket?: Pick<CancelTicket, 'execute'>;
  readonly signals?: WithdrawalParticipantSignals;
  readonly log?: WithdrawalParticipantLogger;
}

/** 회차 판매 설정(공연 시작 = 판매 종료 + 24시간, 입장 시작은 있을 때만) */
interface EventConfig {
  readonly eventStartsAtMs: number;
  readonly entryOpensAtMs?: number;
}

export class AccountWithdrawalTickets implements WithdrawalTickets {
  constructor(private readonly d: AccountWithdrawalTicketsDeps) {}

  /** 견적(읽기 전용). 판매 설정을 읽지 못한 표가 있으면 WithdrawalOrdersUnavailable이다(빠뜨린 채 낮은 금액을 보이지 않는다) */
  async quote(q: { accountId: string; nowMs: number; statementTimeoutMs: number }): Promise<UnusedTicketsQuote> {
    // ticket-svc 주소가 없는 조립(local·ci)은 견적도 내지 않는다(취소할 수 없는 표를 안내하지 않는다). 시작 로그에 경고 한 줄이 남는다
    if (!this.d.cancelTicket) throw new WithdrawalOrdersUnavailable(new Error('ticket-svc 주소가 없어 미사용 티켓 견적을 낼 수 없다'));
    const rows = await this.d.store.unusedTicketsOf(q.accountId, { statementTimeoutMs: q.statementTimeoutMs });
    const sums = { count: 0, ticketAmount: 0, deductionAmount: 0, refundAmount: 0, transferableCount: 0, deferredRefundCount: 0 };
    for (const row of rows) {
      const priced = this.#price(row, await this.#configOf(row.eventId), q.nowMs);
      if (!priced) continue;
      sums.count++;
      sums.ticketAmount += row.ticketPrice;
      sums.deductionAmount += priced.deductionAmount;
      sums.refundAmount += priced.refundAmount;
      if (priced.transferable) sums.transferableCount++;
      if (priced.deferred) sums.deferredRefundCount++;
    }
    return sums;
  }

  /**
   * 미사용 티켓 취소. limit건까지만 부르고 남은 시간이 50ms [가정]보다 모자라면 부르지 않고 남은 것으로 센다.
   * ticket-svc 주소가 없으면(cancelTicket 없음) 취소할 표가 있을 때만 WithdrawalOrdersUnavailable이다(표가 없으면 DONE에 영향이 없다)
   */
  async cancel(q: { accountId: string; nowMs: number; deadlineAtMs: number; limit: number; minRemainingMs: number; marginMs: number; cancelDeadlineCapMs: number }): Promise<WithdrawalTicketsCancelResult> {
    const left = q.deadlineAtMs - q.nowMs;
    if (!(left >= 1)) throw new WithdrawalOrdersUnavailable(new Error('미사용 티켓을 읽을 남은 시간이 없다'));
    const rows = await this.d.store.unusedTicketsOf(q.accountId, { statementTimeoutMs: Math.max(1, Math.floor(Math.min(WITHDRAWAL_STATEMENT_TIMEOUT_MS, left))) });
    if (rows.length === 0) return { cancelled: 0, pendingUncanceled: 0, skipped: 0 };
    const cancelTicket = this.d.cancelTicket;
    if (!cancelTicket) {
      // ticket-svc 주소가 없는 조립(local·ci): 취소할 표가 있으면 지금은 할 수 없다(identity는 202로 미룬다)
      this.d.signals?.ticketCancel?.('error');
      this.d.log?.warn({ count: rows.length }, 'withdrawal-ticket-cancel-error');
      throw new WithdrawalOrdersUnavailable(new Error('ticket-svc 주소가 없어 미사용 티켓을 취소하지 못한다'));
    }
    let cancelled = 0;
    let pendingUncanceled = 0;
    let skipped = 0;
    let calls = 0;
    for (const row of rows) {
      const priced = this.#price(row, await this.#configOf(row.eventId), q.nowMs);
      // 공연이 시작됐거나 이미 끝난 표는 그대로 둔다(취소 기록이 생기지 않는다)
      if (!priced) {
        skipped++;
        this.d.signals?.ticketCancel?.('skipped');
        this.d.log?.warn({ ticketId: row.ticketId }, 'withdrawal-ticket-cancel-skipped');
        continue;
      }
      // 상한을 넘었거나 남은 시간이 50ms보다 모자라면 부르지 않고 남은 것으로 센다(다음 호출이 같은 취소 ID로 다시 보낸다)
      if (calls >= q.limit || left < q.minRemainingMs) {
        pendingUncanceled++;
        this.d.signals?.ticketCancel?.('skipped');
        continue;
      }
      calls++;
      const cancellationId = withdrawalTicketCancellationId(row.ticketId);
      const deadlineMs = Math.max(1, Math.floor(Math.min(left - q.marginMs, q.cancelDeadlineCapMs)));
      let result: Awaited<ReturnType<typeof cancelTicket.execute>>;
      try {
        result = await cancelTicket.execute({ accountId: q.accountId, ticketId: row.ticketId, cancellationId, reason: 'ACCOUNT_WITHDRAWAL', nowMs: q.nowMs, deadlineMs });
      } catch (err) {
        // 행을 쓴 뒤 실패했으면 pendingRefunds가 센다(두 번 세지 않는다). 행이 없으면 이번에 만들지 못한 표다
        const state = await this.d.store.cancellationStatus(cancellationId);
        if (state === undefined) {
          pendingUncanceled++;
          this.d.signals?.ticketCancel?.('error');
          this.d.log?.warn({ ticketId: row.ticketId, err }, 'withdrawal-ticket-cancel-error');
        }
        continue;
      }
      switch (result.status) {
        case 'ACCEPTED':
        case 'REPLAYED':
          // 입장 시작 뒤(REQUESTED)는 환급이 남은 것이라 pendingRefunds가 센다. 환급까지 끝난 표만 이번에 끝난 것으로 센다
          if (result.refundAfterEntryClose) {
            this.d.signals?.ticketCancel?.('refund_pending');
          } else {
            cancelled++;
            this.d.signals?.ticketCancel?.('cancelled');
          }
          break;
        case 'REFUND_PENDING':
          // 결제사 결과 모름·재시도 대기·업무 거절: 행이 있으므로 pendingRefunds가 센다(재시도는 환급 고리 몫)
          this.d.signals?.ticketCancel?.('refund_pending');
          this.d.log?.warn({ ticketId: row.ticketId }, 'withdrawal-ticket-cancel-refund_pending');
          break;
        case 'CONFLICT':
        case 'TRANSFER_PENDING':
        case 'NOT_FOUND':
        case 'NOT_PAYER':
          // 취소 행을 만들지 못했다(양도 요청 중·다른 취소가 먼저 잡음). 다음 호출이 다시 본다
          pendingUncanceled++;
          this.d.signals?.ticketCancel?.('refund_pending');
          this.d.log?.warn({ ticketId: row.ticketId }, `withdrawal-ticket-cancel-${result.status.toLowerCase()}`);
          break;
        default:
          // NOT_PAYER_HOLDER(양도 등으로 남이 가짐)·EVENT_STARTED·ALREADY_ENDED·EVENT_CANCELLED: 그 표는 그대로 둔다
          skipped++;
          this.d.signals?.ticketCancel?.('skipped');
          this.d.log?.warn({ ticketId: row.ticketId }, 'withdrawal-ticket-cancel-skipped');
      }
    }
    return { cancelled, pendingUncanceled, skipped };
  }

  /** 그 계정 주문의 order_cancellation 가운데 사유 ACCOUNT_WITHDRAWAL이고 상태가 REQUESTED·REFUND_PENDING인 표 수 */
  async pendingRefunds(q: { accountId: string; statementTimeoutMs: number }): Promise<number> {
    return this.d.store.pendingRefunds(q.accountId, { statementTimeoutMs: q.statementTimeoutMs });
  }

  /** 회차 판매 설정. 읽지 못하면 견적·취소 모두 UNAVAILABLE이다 */
  async #configOf(eventId: string): Promise<EventConfig> {
    const config = await this.d.configs.config(eventId);
    if (!config) throw new WithdrawalOrdersUnavailable(new Error(`회차 ${eventId}의 판매 설정을 읽지 못했다`));
    return { eventStartsAtMs: config.saleEndsAtMs + EVENT_START_OFFSET_MS, ...(config.entryOpensAtMs !== undefined ? { entryOpensAtMs: config.entryOpensAtMs } : {}) };
  }

  /** 표 하나의 POL-032 견적과 양도 가능·마감 뒤 환급 여부. 공연이 시작됐으면 undefined(견적에서 빼고, 취소는 건너뛴다) */
  #price(row: WithdrawalTicket, config: EventConfig, nowMs: number): { deductionAmount: number; refundAmount: number; transferable: boolean; deferred: boolean } | undefined {
    const r = quoteRefund({
      ticketPrice: row.ticketPrice,
      eventStartsAtMs: config.eventStartsAtMs,
      bookedAtMs: row.bookedAtMs,
      nowMs,
      calendar: this.d.calendar,
      ...(config.entryOpensAtMs !== undefined ? { entryOpensAtMs: config.entryOpensAtMs } : {}),
    });
    if (r.status === 'EVENT_STARTED') return undefined;
    if (r.status !== 'OK') throw new Error('표 금액이 0 이상의 정수가 아니다');
    const transferDeadline = config.entryOpensAtMs !== undefined ? Math.min(config.eventStartsAtMs - TRANSFER_CLOSE_BEFORE_START_MS, config.entryOpensAtMs) : config.eventStartsAtMs - TRANSFER_CLOSE_BEFORE_START_MS;
    return { deductionAmount: r.quote.deductionAmount, refundAmount: r.quote.refundAmount, transferable: nowMs < transferDeadline, deferred: config.entryOpensAtMs !== undefined && nowMs >= config.entryOpensAtMs };
  }
}
