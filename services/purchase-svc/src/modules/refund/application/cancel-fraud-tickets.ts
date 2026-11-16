// 부정 예매 운영자 취소 쓰임새(fraud_cancellation.proto CancelFraudTickets, docs/features/transfer-refund.md §7.4 'purchase-svc·ticket-svc 쪽 세부', BUILD_ORDER GAT-080).
// 차례: 입력 검사 → 같은 승인의 기록 → (처음) 판매 설정·취소 마감 → 표 확인 → 요청 기록 → ticket-svc OperatorCancelTickets → 받은 표의 좌석 되돌리기 →
// order_cancellation(FRAUD, 공제 0원, REFUND_PENDING) → 결과 저장. 결제사는 부르지 않는다(환급 재시도 실행기가 REFUND_PENDING을 바로 집는다).
// 같은 승인으로 다시 부르면(겹친 호출 포함) 끝난 표(받음·건너뜀)는 저장한 결과를 그대로 준다. 마감 전이면 FAILED 표와 저장 결과가 아직 없는 표를 다시 한다.
// 마감 뒤에는 새 취소를 하지 않고, 티켓 단계가 끝난 뒤 실패한 표(SEAT_RETURN_FAILED·CANCELLATION_CONFLICT·ORDER_STATE)만 나머지 단계를 마친다.
// 그 밖의 FAILED는 그대로, 저장 결과가 없는 표는 FAILED·INTERNAL로 저장해 준다(BAT-415 계획 §10 ②③⑤).
// 같은 표를 겹쳐 처리해도 ticket-svc (승인, 표) 기록과 승인·표에서 정해지는 취소 ID가 취소 행·환급을 하나로 모은다.
import type { CancellationOrderView } from '../domain/cancellation.js';
import {
  type CancelFraudTicketsInput,
  FRAUD_AFTER_TICKET_FAILURES,
  type FraudCancelTarget,
  FraudCancellationError,
  type FraudFailureCode,
  type FraudTicketResult,
  fraudCancelDeadlineMs,
  fraudCancellationId,
  fraudTargetsFingerprint,
  parseCancelFraudTickets,
} from '../domain/fraud-cancellation.js';
import type { CancellationConfigs, CancellationOrders, CancellationWrites, FraudCancellationStore, OperatorTicketCancellations, OperatorTicketOutcome, OperatorTicketResult, SeatReturns } from '../domain/ports.js';
import type { BusinessCalendar } from '../domain/refund-policy.js';
import { quoteRefund } from '../domain/refund-policy.js';
import { eventStartsAtOf } from './quote-cancellation.js';

export interface CancelFraudTicketsDeps {
  readonly store: FraudCancellationStore;
  readonly tickets: OperatorTicketCancellations;
  readonly orders: CancellationOrders;
  readonly configs: CancellationConfigs;
  readonly writes: CancellationWrites;
  readonly calendar: BusinessCalendar;
  readonly seats?: SeatReturns;
}

/** order_event의 행위자(사람 행위자는 ops-svc 승인 기록에 있다) */
const FRAUD_CANCELLATION_ACTOR = 'system:fraud-cancellation';
/** 표 확인(주문 읽기)을 한 번에 몇 개까지 겹쳐 보낼지 16개 [가정](대상 500장을 차례로 읽지 않게) */
const VIEW_LOOKUP_CONCURRENCY = 16;

const SKIPPED_OF: Readonly<Record<Exclude<OperatorTicketResult, 'CANCELED'>, FraudTicketResult['outcome']>> = {
  SKIPPED_ALREADY_ENDED: 'SKIPPED_ALREADY_ENDED',
  SKIPPED_ENTRY_RECORDED: 'SKIPPED_ENTRY_STARTED',
  SKIPPED_HOLDER_CHANGED: 'SKIPPED_HOLDER_CHANGED',
};

const failed = (ticketId: string, failureCode: FraudFailureCode): FraudTicketResult => ({ ticketId, outcome: 'FAILED', failureCode });

/** 차례를 지키며 동시 limit개로 나눠 부른다 */
async function mapLimit<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= items.length) return;
      out[at] = await fn(items[at]!);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

export class CancelFraudTickets {
  constructor(readonly o: CancelFraudTicketsDeps) {}

  /** 결과는 요청의 대상 차례다. @throws FraudCancellationError INVALID|ALREADY_EXISTS|DEADLINE_PASSED */
  async execute(raw: CancelFraudTicketsInput): Promise<readonly FraudTicketResult[]> {
    const i = parseCancelFraudTickets(raw);
    const fingerprint = fraudTargetsFingerprint(i.fraudCaseId, i.eventId, i.targets);
    // 다시 부르기 확인은 마감 검사보다 먼저다(마감 뒤에도 저장한 결과를 준다)
    const existing = await this.o.store.find(i.approvalId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw new FraudCancellationError('ALREADY_EXISTS', '같은 승인 ID에 다른 대상이 왔다');
      return this.#continue(i, undefined);
    }
    const config = await this.o.configs.config(i.eventId);
    if (!config) throw new FraudCancellationError('INVALID', '판매 설정이 없는 회차다');
    if (i.nowMs >= fraudCancelDeadlineMs(config.saleEndsAtMs)) throw new FraudCancellationError('DEADLINE_PASSED', '취소 마감(판매 종료 2시간 전)이 지났다');
    // 표 확인은 요청 기록보다 먼저다: 없는 표·다른 회차 표가 하나라도 있으면 아무것도 쓰지 않는다
    const views = await mapLimit(i.targets, VIEW_LOOKUP_CONCURRENCY, (t) => this.o.orders.findByTicket(t.ticketId));
    const byTicket = new Map<string, CancellationOrderView>();
    for (const [n, view] of views.entries()) {
      if (!view || view.eventId !== i.eventId || view.ticketId !== i.targets[n]!.ticketId) throw new FraudCancellationError('INVALID', '없는 표이거나 다른 회차의 표다');
      byTicket.set(view.ticketId, view);
    }
    const created = await this.o.store.create({
      approvalId: i.approvalId,
      fraudCaseId: i.fraudCaseId,
      eventId: i.eventId,
      fingerprint,
      requestedBy: i.requestedBy,
      approvedBy: i.approvedBy,
      ...(i.approvedAtMs !== undefined ? { approvedAtMs: i.approvedAtMs } : {}),
      createdAtMs: i.nowMs,
    });
    // 겹친 호출이 먼저 기록했다: 같은 대상이면 다시 부르기로 잇는다
    if (created.status === 'EXISTS' && created.record.fingerprint !== fingerprint) throw new FraudCancellationError('ALREADY_EXISTS', '같은 승인 ID에 다른 대상이 왔다');
    return this.#continue(i, { saleEndsAtMs: config.saleEndsAtMs, views: byTicket });
  }

  /** 처음 호출(first)과 다시 부르기의 공통 몸. 할 표를 골라 처리하고, 바뀐 결과만 저장한 뒤 저장된 것과 합쳐 요청 차례로 준다 */
  async #continue(i: CancelFraudTicketsInput, first: { readonly saleEndsAtMs: number; readonly views: ReadonlyMap<string, CancellationOrderView> } | undefined): Promise<readonly FraudTicketResult[]> {
    const stored = new Map((await this.o.store.results(i.approvalId)).map((r) => [r.ticketId, r]));
    const saleEndsAtMs = first?.saleEndsAtMs ?? (await this.o.configs.config(i.eventId))?.saleEndsAtMs;
    // 판매 설정을 읽지 못한 다시 부르기는 마감 뒤로 본다(새 취소를 하지 않는 쪽)
    const afterDeadline = saleEndsAtMs === undefined || i.nowMs >= fraudCancelDeadlineMs(saleEndsAtMs);
    const fresh = new Map<string, FraudTicketResult>();
    const afterTicketFailure = (ticketId: string): FraudFailureCode | undefined => {
      const r = stored.get(ticketId);
      return r?.outcome === 'FAILED' && r.failureCode !== undefined && FRAUD_AFTER_TICKET_FAILURES.has(r.failureCode) ? r.failureCode : undefined;
    };
    let todo: FraudCancelTarget[];
    if (!afterDeadline) {
      todo = i.targets.filter((t) => {
        const r = stored.get(t.ticketId);
        return r === undefined || r.outcome === 'FAILED';
      });
    } else {
      todo = i.targets.filter((t) => afterTicketFailure(t.ticketId) !== undefined);
      // 티켓 단계가 됐는지 모르는 표는 마감 뒤에 다시 하지 않는다. 결과가 없는 표는 INTERNAL로 남긴다
      for (const t of i.targets) if (!stored.has(t.ticketId)) fresh.set(t.ticketId, failed(t.ticketId, 'INTERNAL'));
    }

    if (todo.length > 0) {
      const views = new Map(first?.views ?? []);
      const missing = todo.filter((t) => !views.has(t.ticketId));
      const found = await mapLimit(missing, VIEW_LOOKUP_CONCURRENCY, (t) => this.o.orders.findByTicket(t.ticketId));
      for (const view of found) if (view && view.eventId === i.eventId) views.set(view.ticketId, view);
      const sendable = todo.filter((t) => {
        if (views.has(t.ticketId)) return true;
        fresh.set(t.ticketId, failed(t.ticketId, 'INTERNAL'));
        return false;
      });
      if (sendable.length > 0) {
        let outcomes: readonly OperatorTicketOutcome[] | undefined;
        try {
          outcomes = await this.o.tickets.operatorCancel({ approvalId: i.approvalId, fraudCaseId: i.fraudCaseId, eventId: i.eventId, targets: sendable, deadlineMs: i.deadlineMs });
        } catch {
          // 티켓 단계가 끝난 뒤의 실패였던 표는 그 까닭을 지킨다(마감 뒤에도 나머지를 마칠 수 있게)
          for (const t of sendable) fresh.set(t.ticketId, failed(t.ticketId, afterTicketFailure(t.ticketId) ?? 'TICKET_UNAVAILABLE'));
        }
        if (outcomes) {
          const byTicket = new Map(outcomes.map((x) => [x.ticketId, x]));
          for (const t of sendable) {
            const outcome = byTicket.get(t.ticketId);
            fresh.set(t.ticketId, outcome ? await this.#afterTicket(i, outcome, views.get(t.ticketId)!) : failed(t.ticketId, 'INTERNAL'));
          }
        }
      }
    }

    // FAILED끼리는 티켓 단계 뒤 까닭을 티켓 단계가 됐는지 모르는 까닭(TICKET_UNAVAILABLE·INTERNAL)으로 바꾸지 않는다(다시 보기 R2, 저장소 문장도 같은 조건)
    for (const [ticketId, r] of fresh) {
      const kept = afterTicketFailure(ticketId);
      if (kept !== undefined && r.outcome === 'FAILED' && (r.failureCode === 'TICKET_UNAVAILABLE' || r.failureCode === 'INTERNAL')) fresh.set(ticketId, stored.get(ticketId)!);
    }
    if (fresh.size === 0) return i.targets.map((t) => stored.get(t.ticketId) ?? failed(t.ticketId, 'INTERNAL'));
    // 저장소는 행이 없거나 FAILED일 때만 쓴다(겹친 호출의 늦은 실패가 먼저 끝난 결과를 덮지 못한다). 답은 저장한 뒤 다시 읽은 결과다(리뷰 B5)
    await this.o.store.saveResults(
      i.approvalId,
      i.targets.filter((t) => fresh.has(t.ticketId)).map((t) => ({ ...fresh.get(t.ticketId)!, expectedHolderAccountId: t.expectedHolderAccountId })),
      i.nowMs,
    );
    const saved = new Map((await this.o.store.results(i.approvalId)).map((r) => [r.ticketId, r]));
    return i.targets.map((t) => saved.get(t.ticketId) ?? fresh.get(t.ticketId) ?? stored.get(t.ticketId) ?? failed(t.ticketId, 'INTERNAL'));
  }

  /** ticket-svc 답 하나의 나머지 단계: 건너뜀은 그대로, 취소한 표는 좌석 되돌리기 → 공제 없는 취소 행(REFUND_PENDING) */
  async #afterTicket(i: CancelFraudTicketsInput, outcome: OperatorTicketOutcome, view: CancellationOrderView): Promise<FraudTicketResult> {
    const withdrawn = outcome.withdrawnTransferOfferId ? { withdrawnTransferOfferId: outcome.withdrawnTransferOfferId } : {};
    if (outcome.result !== 'CANCELED') return { ticketId: view.ticketId, outcome: SKIPPED_OF[outcome.result], ...withdrawn };
    if (this.o.seats) {
      try {
        await this.o.seats.returnSold({ eventId: view.eventId, orderId: view.orderId, seatId: view.seatId, accountId: view.payerAccountId, saleEndsAtMs: view.saleEndsAtMs });
      } catch {
        return { ...failed(view.ticketId, 'SEAT_RETURN_FAILED'), ...withdrawn };
      }
    }
    const quote = this.#quote(view, i.nowMs);
    if (!quote) return { ...failed(view.ticketId, 'INTERNAL'), ...withdrawn };
    const cancellationId = fraudCancellationId(i.approvalId, view.ticketId);
    let write: Awaited<ReturnType<CancellationWrites['create']>>;
    try {
      write = await this.o.writes.create({
        cancellationId,
        orderId: view.orderId,
        ticketId: view.ticketId,
        reason: 'FRAUD',
        daysBefore: quote.daysBefore,
        within24h: quote.within24h,
        deductionBp: quote.deductionBp,
        deductionAmount: quote.deductionAmount,
        refundAmount: quote.refundAmount,
        status: 'REFUND_PENDING',
        nowMs: i.nowMs,
        actor: FRAUD_CANCELLATION_ACTOR,
        fraudCaseId: i.fraudCaseId,
        approvalId: i.approvalId,
      });
    } catch {
      // 주문 상태 전이 실패(T22~T25) 등
      return { ...failed(view.ticketId, 'ORDER_STATE'), ...withdrawn };
    }
    if (write.status === 'CONFLICT') return { ...failed(view.ticketId, 'CANCELLATION_CONFLICT'), ...withdrawn };
    const refundAmount = write.status === 'REPLAYED' ? write.refundAmount : quote.refundAmount;
    return { ticketId: view.ticketId, outcome: 'ACCEPTED', cancellationId, refundAmount, ...withdrawn };
  }

  /** 공제 없는 견적(FRAUD). 공연이 시작된 뒤의 마무리(마감 뒤 다시 부르기)도 권면 금액 그대로다 */
  #quote(view: CancellationOrderView, nowMs: number): { daysBefore: number; within24h: boolean; deductionBp: number; deductionAmount: number; refundAmount: number } | undefined {
    const q = quoteRefund({
      ticketPrice: view.ticketPrice,
      eventStartsAtMs: eventStartsAtOf(view.saleEndsAtMs),
      bookedAtMs: view.bookedAtMs,
      nowMs,
      calendar: this.o.calendar,
      zeroDeduction: true,
      zeroDeductionBasis: '부정 예매 운영자 취소(공제 없음, POL-046)',
    });
    if (q.status === 'OK') return q.quote;
    if (q.status === 'EVENT_STARTED') return { daysBefore: 0, within24h: false, deductionBp: 0, deductionAmount: 0, refundAmount: view.ticketPrice };
    return undefined;
  }
}
