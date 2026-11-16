// 회차 취소 일괄 환불의 쓰임새(BAT-425 GAT-120·GAT-130).
// 취소는 확정 뒤 대상 티켓을 기존 예매 취소 Saga(CancelTicket)로 한 장씩 환불하고,
// 연기는 환급 신청 창(REFUND_WINDOW)을 연 뒤 신청한 티켓만 환불한다.
// 자동 정지(실패율·실패 금액·연속 실패·거절률·서킷), 재시도·멱등·중단/재개·진행률, 팬 알림 Outbox를 남긴다.
import {
  EventRefundActiveConflict,
  eventRefundCancellationId,
  eventRefundPreviewOf,
  eventRefundRetryDelayMs,
  EVENT_REFUND_AUTO_STOP,
  progressOf,
  rateBp,
  type EventCancellationRequest,
  type EventRefundAttemptOutcome,
  type EventRefundItem,
  type EventRefundKind,
  type EventRefundPreview,
  type EventRefundProgress,
  type EventRefundTarget,
  type RefundPgProvider,
  type RefundPauseReason,
} from '../domain/event-refund.js';
import type {
  EventRefundApplyInput,
  EventRefundCloseWindowInput,
  EventRefundOutboxMessage,
  EventRefundPauseInput,
  EventRefundPreviewInput,
  EventRefundResumeInput,
  EventRefundServiceDeps,
  EventRefundStartInput,
} from '../domain/event-refund-ports.js';
import type { EventRefundHoldInput, EventRefundHoldState } from '../domain/event-refund-hold.js';

const UUID =/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type EventRefundErrorCode = 'INVALID' | 'NOT_FOUND' | 'CONFLICT';

export class EventRefundError extends Error {
  constructor(
    readonly code: EventRefundErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'EventRefundError';
  }
}

const pausedOf = (request: EventCancellationRequest): { pg: RefundPgProvider; reason: RefundPauseReason }[] =>
  request.progress.perPg.filter((p) => p.state === 'PAUSED' && p.pauseReason !== undefined).map((p) => ({ pg: p.pg, reason: p.pauseReason! }));

const statusAfterRun = (
  _request: EventCancellationRequest,
  progress: EventRefundProgress,
  paused: readonly { pg: RefundPgProvider }[],
  windowOpen: boolean,
): EventCancellationRequest['status'] => {
  if (paused.length > 0) return 'PAUSED';
  if (progress.total > progress.done + progress.failed + progress.notApplied) return windowOpen ? 'REFUND_WINDOW' : 'RUNNING';
  return 'COMPLETED';
};

const FAILURE_ERRORS = new Set(['REJECTED', 'TICKET_NOT_HELD', 'TRANSFER_PENDING', 'ALREADY_ENDED', 'EVENT_STARTED', 'NOT_PAYER', 'CONFLICT']);
/**
 * 결제사로 보내지 않고 끝난 즉시 실패(BAT-420 GAT-110 E1·E2): 보류 취소를 그사이 환급 실행기가 집음, 끝난 표의 취소 행이 없음, 같은 표의 다른 진행 중 취소.
 * 재시도해도 같은 답이라 바로 FAILED로 끝내 CS '일괄 환불 실패'로 넘긴다. 결제사 호출이 아니므로 자동 정지 기록에 넣지 않는다
 */
const IMMEDIATE_FAILURES = new Set(['cancellation-in-progress', 'ticket-already-ended', 'cancellation-conflict']);

/** 대상 표 한 장의 일괄 환불 항목. 보류 취소가 있으면 그 행 ID를, 아니면 요청·표로 정해진 취소 ID를 쓴다(BAT-420 GAT-110 E1) */
function itemOf(requestId: string, t: EventRefundTarget, kind: EventRefundKind, nowMs: number): EventRefundItem {
  return {
    requestId,
    orderId: t.orderId,
    ticketId: t.ticketId,
    cancellationId: t.pendingCancellationId ?? eventRefundCancellationId(requestId, t.ticketId),
    pg: t.pg,
    status: 'PENDING',
    attempts: 0,
    ...(kind === 'CANCEL' ? { appliedAtMs: nowMs } : {}),
    ...(kind === 'CANCEL' ? { nextAttemptAtMs: nowMs } : {}),
  };
}

type StopReason = { reason: RefundPauseReason; all: boolean; detail: Record<string, unknown> } | undefined;

/** 결제사 호출 결과를 자동 정지의 결과 값으로 나눈다. 업무 거절은 REJECT, 그 밖의 실패는 FAILURE, 결과 모름은 UNKNOWN */
function outcomeOf(status: 'REFUNDED' | 'REFUND_PENDING' | 'FAILED', error: string | undefined): EventRefundAttemptOutcome {
  if (status === 'REFUNDED') return 'SUCCESS';
  if (status === 'REFUND_PENDING') return 'UNKNOWN';
  return error !== undefined && FAILURE_ERRORS.has(error) ? 'REJECT' : 'FAILURE';
}

export class EventRefundService {
  constructor(private readonly o: EventRefundServiceDeps) {}

  /** 회차 취소 요청 중 보류 취소의 환급 미룸 걸기·늘리기·풀기(BAT-420 몫 D, gRPC SetEventRefundHold, 빈 뼈대). @throws EventRefundHoldError */
  async setHold(_i: EventRefundHoldInput): Promise<EventRefundHoldState> {
    throw new Error('아직 없음');
  }

  async preview(i: EventRefundPreviewInput): Promise<EventRefundPreview> {
    const targets = await this.#targets(i.eventId);
    return eventRefundPreviewOf(targets, i.fault);
  }

  async start(i: EventRefundStartInput): Promise<EventCancellationRequest> {
    if (!UUID.test(i.requestId)) throw new EventRefundError('INVALID', 'requestId가 UUID가 아닙니다');
    if (!UUID.test(i.eventId)) throw new EventRefundError('INVALID', 'eventId가 UUID가 아닙니다');
    if (i.ruledBy.length === 0 || i.confirmedBy.length === 0) throw new EventRefundError('INVALID', '판정자와 확정자가 필요합니다');
    if (i.ruledBy === i.confirmedBy) throw new EventRefundError('CONFLICT', '판정자와 확정자는 달라야 합니다');
    const kind: EventRefundKind = i.kind ?? 'CANCEL';
    const existing = await this.o.store.find(i.requestId);
    if (existing) {
      if (existing.eventId !== i.eventId || existing.fault !== i.fault || existing.kind !== kind) throw new EventRefundError('CONFLICT', '같은 요청 ID의 회차·판정·종류가 다릅니다');
      return this.get(i.requestId);
    }
    const nowMs = this.o.nowMs();
    const window = this.#windowOf(kind, i, nowMs);
    const listed = await this.#targets(i.eventId);
    // 연기(POSTPONE) 신청 환급은 예매 취소 Saga로 하므로 보류 취소(REQUESTED) 표를 넣지 않는다(그 표는 마감 뒤 환급으로 끝난다, GAT-110 E5)
    const targets = kind === 'POSTPONE' ? listed.filter((t) => t.pendingCancellationId === undefined) : listed;
    const preview = eventRefundPreviewOf(targets, i.fault);
    const items: EventRefundItem[] = targets.map((t) => itemOf(i.requestId, t, kind, nowMs));
    const progress = progressOf(items, [], kind === 'POSTPONE');
    const request: EventCancellationRequest = {
      requestId: i.requestId,
      eventId: i.eventId,
      kind,
      status: kind === 'POSTPONE' ? 'REFUND_WINDOW' : 'RUNNING',
      fault: i.fault,
      ...(i.fanNoticeReason !== undefined ? { fanNoticeReason: i.fanNoticeReason } : {}),
      ...(window ? { postponedToMs: window.postponedToMs, refundWindowClosesAtMs: window.refundWindowClosesAtMs } : {}),
      targetOrders: preview.targetOrders,
      refundTotal: preview.refundTotal,
      compensationTargets: preview.compensationTargets,
      compensationTotal: preview.compensationTotal,
      progress,
      ruledBy: i.ruledBy,
      confirmedBy: i.confirmedBy,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const confirmed = this.o.fanNotifier?.confirmed(request, targets, nowMs) ?? [];
    let created: EventCancellationRequest;
    try {
      created = await this.o.store.create(request, items, confirmed);
    } catch (err) {
      // 같은 회차의 진행 중 요청(0016 active key)과 부딪히면 500이 아니라 409다
      if (err instanceof EventRefundActiveConflict) throw new EventRefundError('CONFLICT', `같은 회차에 진행 중인 회차 취소 요청이 있습니다: ${err.requestId}`);
      throw err;
    }
    if (kind === 'CANCEL') await this.#run(created, targets, this.o.firstBatch ?? 200);
    return this.get(i.requestId);
  }

  async get(requestId: string): Promise<EventCancellationRequest> {
    if (!UUID.test(requestId)) throw new EventRefundError('INVALID', 'requestId가 UUID가 아닙니다');
    const request = await this.o.store.find(requestId);
    if (!request) throw new EventRefundError('NOT_FOUND', '회차 취소 요청을 찾을 수 없습니다');
    const items = await this.o.store.items(requestId);
    const paused = pausedOf(request);
    return { ...request, progress: progressOf(items, paused, this.#windowOpen(request)) };
  }

  async pause(i: EventRefundPauseInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.status === 'COMPLETED' || request.status === 'REJECTED') throw new EventRefundError('CONFLICT', '끝난 작업은 멈출 수 없습니다');
    const reason = i.reason.trim();
    if (reason.length === 0) throw new EventRefundError('INVALID', '멈추는 사유가 필요합니다');
    const pgs = i.pg ? [i.pg] : request.progress.perPg.map((p) => p.pg);
    const paused = [...pausedOf(request).filter((p) => !pgs.includes(p.pg)), ...pgs.map((pg) => ({ pg, reason: 'MANUAL' as const }))];
    const items = await this.o.store.items(i.requestId);
    const updated: EventCancellationRequest = { ...request, status: 'PAUSED', progress: progressOf(items, paused, false), updatedAtMs: this.o.nowMs() };
    await this.o.store.update(updated);
    return this.get(i.requestId);
  }

  async resume(i: EventRefundResumeInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.status === 'COMPLETED' || request.status === 'REJECTED') throw new EventRefundError('CONFLICT', '끝난 작업은 다시 시작할 수 없습니다');
    const paused = pausedOf(request).filter((p) => (i.pg ? p.pg !== i.pg : false));
    const items = await this.o.store.items(i.requestId);
    // 수동 재개는 기다리던 재시도를 지금 다시 본다(결과 모름을 결제사 조회로 먼저 끝내는 규칙).
    const nowMs = this.o.nowMs();
    for (const item of items) {
      if ((item.status === 'UNKNOWN' || item.status === 'PENDING') && item.appliedAtMs !== undefined && (!i.pg || item.pg === i.pg) && (item.nextAttemptAtMs ?? 0) > nowMs) {
        await this.o.store.updateItem({ ...item, nextAttemptAtMs: nowMs });
      }
    }
    const windowOpen = this.#windowOpen(request);
    const running: EventCancellationRequest = { ...request, status: windowOpen ? 'REFUND_WINDOW' : 'RUNNING', progress: progressOf(items, paused, windowOpen), updatedAtMs: this.o.nowMs() };
    await this.o.store.update(running);
    const targets = await this.#targets(request.eventId);
    await this.#run(running, targets, this.o.firstBatch ?? 200);
    return this.get(i.requestId);
  }

  /** 연기(POSTPONE)에서 팬이 환급을 신청한다. 같은 요청·티켓은 한 번만 신청된다 */
  async apply(i: EventRefundApplyInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.kind !== 'POSTPONE') throw new EventRefundError('CONFLICT', '연기 요청만 환급을 신청할 수 있습니다');
    if (!this.#windowOpen(request)) throw new EventRefundError('CONFLICT', '환급 신청 창이 닫혔습니다');
    if (!UUID.test(i.ticketId)) throw new EventRefundError('INVALID', 'ticketId가 UUID가 아닙니다');
    const item = (await this.o.store.items(i.requestId)).find((x) => x.ticketId === i.ticketId);
    if (!item) throw new EventRefundError('NOT_FOUND', '그 요청의 대상 티켓이 아닙니다');
    if (item.appliedAtMs === undefined) {
      const nowMs = i.appliedAtMs ?? this.o.nowMs();
      const accepted = await this.o.store.markApplied(i.requestId, i.ticketId, nowMs);
      if (!accepted) {
        const again = (await this.o.store.items(i.requestId)).find((x) => x.ticketId === i.ticketId);
        if (again?.appliedAtMs === undefined) throw new EventRefundError('CONFLICT', '환급 신청 창이 닫혔습니다');
      }
    }
    const targets = await this.#targets(request.eventId);
    await this.#run(await this.get(i.requestId), targets, this.o.firstBatch ?? 200);
    return this.get(i.requestId);
  }

  /** 신청 창을 지금 닫는다. 신청하지 않은 티켓은 NOT_APPLIED로 끝나고 환급하지 않는다 */
  async closeWindow(i: EventRefundCloseWindowInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.kind !== 'POSTPONE') throw new EventRefundError('CONFLICT', '연기 요청만 신청 창을 닫을 수 있습니다');
    if (!this.#windowOpen(request)) return this.get(i.requestId);
    const reason = i.reason.trim();
    if (reason.length === 0) throw new EventRefundError('INVALID', '창을 닫는 사유가 필요합니다');
    await this.#closeWindowNow(request, i.closedBy);
    const targets = await this.#targets(request.eventId);
    await this.#run(await this.get(i.requestId), targets, this.o.firstBatch ?? 200);
    return this.get(i.requestId);
  }

  /**
   * 백그라운드 실행기 한 바퀴: 닫을 창을 닫고, 실행 중 요청의 due 항목을 조금씩 처리한다.
   * 회차 취소(CANCEL)는 실행 중·멈춤 요청마다 대상을 다시 골라 항목이 없는 표를 더하고(확정 뒤 결제가 끝난 주문, ADR-0280 결정 4),
   * 실행 중이면 할 항목이 없어도 완료 여부를 다시 본다(끝나지 않은 주문이 남으면 RUNNING, 결정 5). 멈춘 요청은 더하기만 하고 부르지 않는다
   */
  async runDue(): Promise<{ closedWindows: number; processed: number }> {
    const nowMs = this.o.nowMs();
    let closedWindows = 0;
    for (const request of await this.o.store.dueWindowClosures(nowMs, 20)) {
      await this.#closeWindowNow(request, 'system:event-refund-window');
      closedWindows++;
    }
    let processed = 0;
    for (const request of await this.o.store.activeRequests(20)) {
      if (request.status === 'COMPLETED' || request.status === 'REJECTED') continue;
      const sweeping = request.kind === 'CANCEL' && this.o.items !== undefined && this.o.openOrders !== undefined;
      let targets: readonly EventRefundTarget[] | undefined;
      if (sweeping && (request.status === 'RUNNING' || request.status === 'PAUSED')) {
        targets = await this.#targets(request.eventId);
        await this.#sweep(request, targets);
      }
      if (request.status === 'PAUSED') continue;
      const items = await this.o.store.dueItems(request.requestId, nowMs, this.o.batchSize ?? 200);
      if (items.length === 0 && !sweeping) continue;
      targets ??= await this.#targets(request.eventId);
      await this.#run(request, targets, items.length);
      processed += items.length;
    }
    return { closedWindows, processed };
  }

  /** 대상을 다시 골라 그 요청에 항목이 없는 표를 PENDING으로 더하고, 새 주문마다 확정 알림을 한 번 남긴다(같은 트랜잭션) */
  async #sweep(request: EventCancellationRequest, targets: readonly EventRefundTarget[]): Promise<void> {
    const existing = await this.o.store.items(request.requestId);
    const tickets = new Set(existing.map((i) => i.ticketId));
    const fresh = targets.filter((t) => !tickets.has(t.ticketId));
    if (fresh.length === 0 || !this.o.items) return;
    const nowMs = this.o.nowMs();
    const knownOrders = new Set(existing.map((i) => i.orderId));
    const newOrderTargets = fresh.filter((t) => !knownOrders.has(t.orderId));
    const outbox = newOrderTargets.length > 0 ? (this.o.fanNotifier?.confirmed(request, newOrderTargets, nowMs) ?? []) : [];
    await this.o.items.addItems(
      request.requestId,
      fresh.map((t) => itemOf(request.requestId, t, 'CANCEL', nowMs)),
      outbox,
    );
  }

  async #closeWindowNow(request: EventCancellationRequest, closedBy: string): Promise<void> {
    const nowMs = this.o.nowMs();
    const items = await this.o.store.items(request.requestId);
    for (const item of items) {
      // 신청과 창 닫기가 겹치면 행 잠금이 먼저 온 쪽만 남긴다. 신청이 이겼으면 applied_at이 있어 여기서 지우지 않는다.
      if (item.appliedAtMs === undefined) await this.o.store.markNotApplied(request.requestId, item.ticketId);
    }
    const paused = pausedOf(request);
    const after = await this.o.store.items(request.requestId);
    const progress = progressOf(after, paused, false);
    const updated: EventCancellationRequest = { ...request, status: statusAfterRun(request, progress, paused, false), progress, updatedAtMs: nowMs };
    await this.o.store.update(updated);
    await this.o.alert?.raise({
      requestId: request.requestId,
      eventId: request.eventId,
      severity: 'SEV3',
      reason: 'REFUND_WINDOW_CLOSED',
      detail: { closedBy, notApplied: progress.notApplied, total: progress.total },
      nowMs,
    });
  }

  async #run(request: EventCancellationRequest, targets: readonly EventRefundTarget[], limit: number): Promise<void> {
    const paused = new Map(pausedOf(request).map((p) => [p.pg, p.reason]));
    const byTicket = new Map(targets.map((t) => [t.ticketId, t]));
    const nowMs = this.o.nowMs();
    const all = await this.o.store.items(request.requestId);
    // 같은 주문의 앞 표가 재시도를 기다리면(결과 모름, 다음 시도 시각 전) 그 주문의 나머지 표는 이번 실행에 넣지 않는다(리뷰 B4).
    // 넣지 않은 표는 부르지도 시도로 기록하지도 않아 자동 정지의 실패율·연속 실패·실패 금액에 들지 않는다
    const waitingOrders = new Set(all.filter((i) => i.status === 'UNKNOWN' && i.nextAttemptAtMs !== undefined && i.nextAttemptAtMs > nowMs).map((i) => i.orderId));
    const queue = all
      .filter(
        (i) =>
          (i.status === 'PENDING' || i.status === 'UNKNOWN') &&
          i.appliedAtMs !== undefined &&
          (i.nextAttemptAtMs === undefined || i.nextAttemptAtMs <= nowMs) &&
          !paused.has(i.pg) &&
          !waitingOrders.has(i.orderId),
      )
      .slice(0, Math.max(0, limit));
    // 같은 주문의 표는 한 작업자가 큐 차례대로 처리한다. payment-svc가 같은 결제의 일반 취소를 한 번에 하나씩 보내므로(10분 안의 진행 중 건이 있으면 결과 모름),
    // 같은 주문의 표를 동시에 보내면 결과 모름이 자동 정지 실패율에 섞인다(docs/data.md §5 '같은 주문의 표 둘을 동시에 취소', BUILD_ORDER GAT-080).
    // 묶음 안에서는 재시도할 결과 모름을 처음 보내는 표보다 먼저 한다(앞 건이 끝나야 뒤 건을 보낼 수 있다)
    const groups = new Map<string, EventRefundItem[]>();
    for (const item of queue) {
      const group = groups.get(item.orderId);
      if (group) group.push(item);
      else groups.set(item.orderId, [item]);
    }
    const orderQueue = [...groups.values()].map((g) => [...g.filter((i) => i.status === 'UNKNOWN'), ...g.filter((i) => i.status !== 'UNKNOWN')]);
    const newlyPaused: { pg: RefundPgProvider; reason: RefundPauseReason; detail: Record<string, unknown> }[] = [];
    /** 항목 하나를 처리하고, 그 항목이 끝났는지(환급·실패) 돌려준다. 멈춤·자동 정지로 보내지 않았거나 재시도를 기다리면 false다 */
    const processItem = async (item: EventRefundItem): Promise<boolean> => {
      // 실행 중에 사람이 멈췄을 수 있다. 항목마다 저장된 상태를 다시 보고 새 호출을 보내지 않는다
      const current = await this.o.store.find(request.requestId);
      if (current) {
        for (const p of pausedOf(current)) paused.set(p.pg, p.reason);
        if (current.status === 'PAUSED' && !paused.has(item.pg)) paused.set(item.pg, 'MANUAL');
      }
      if (paused.has(item.pg)) return false;
      // 기준을 넘긴 뒤 새 호출을 한 건도 더 보내지 않게 항목마다 판정한다
      const stop = await this.#stopReason(item.pg, nowMs);
      if (stop) {
        const pgs = stop.all ? request.progress.perPg.map((p) => p.pg) : [item.pg];
        for (const pg of pgs) {
          if (!paused.has(pg)) {
            paused.set(pg, stop.reason);
            newlyPaused.push({ pg, reason: stop.reason, detail: stop.detail });
          }
        }
        return false;
      }
      const target = byTicket.get(item.ticketId);
      if (!target) {
        await this.#finishItem(request, item, 'FAILED', 'target-not-found', undefined, undefined);
        return true;
      }
      try {
        const result = await this.o.canceller.cancel(target, {
          requestId: request.requestId,
          eventId: request.eventId,
          cancellationId: item.cancellationId,
          reason: request.kind === 'POSTPONE' ? 'EVENT_POSTPONED' : 'EVENT_CANCELLED',
          nowMs: this.o.nowMs(),
          deadlineMs: this.o.deadlineMs(),
        });
        // 결제사로 보내지 않은 실패(티켓 단계)는 결제사 호출로 세지 않고 재시도한다(GAT-110 E7)
        if (result.status === 'NOT_SENT') return (await this.#retryOrFail(request, item, 'UNKNOWN', result.error, target)) !== 'UNKNOWN';
        // 결제사로 보내기 전에 끝난 즉시 실패는 기록하지 않고 바로 FAILED다(GAT-110 E1·E2)
        if (result.status === 'FAILED' && result.error !== undefined && IMMEDIATE_FAILURES.has(result.error)) {
          await this.#finishItem(request, item, 'FAILED', result.error, target, undefined);
          return true;
        }
        const outcome = outcomeOf(result.status, result.error);
        await this.#recordAttempt(request, item, target, outcome);
        if (result.status === 'REFUNDED') {
          await this.#finishItem(request, item, 'REFUNDED', undefined, target, undefined);
          return true;
        }
        if (result.status === 'REFUND_PENDING') return (await this.#retryOrFail(request, item, 'UNKNOWN', result.error ?? 'refund-pending', target)) !== 'UNKNOWN';
        if (result.error !== undefined && FAILURE_ERRORS.has(result.error)) {
          await this.#finishItem(request, item, 'FAILED', result.error, target, undefined);
          return true;
        }
        return (await this.#retryOrFail(request, item, 'FAILED', result.error ?? 'failed', target)) !== 'UNKNOWN';
      } catch (err) {
        const message = err instanceof Error ? err.message : 'unknown';
        await this.#recordAttempt(request, item, target, 'UNKNOWN');
        return (await this.#retryOrFail(request, item, 'UNKNOWN', message, target)) !== 'UNKNOWN';
      }
    };
    const worker = async (): Promise<void> => {
      for (;;) {
        const group = orderQueue.shift();
        if (!group) return;
        // 앞 항목이 끝나지 않으면(결과 모름·멈춤) 그 묶음의 나머지는 이번 실행에서 부르지 않는다(리뷰 B4)
        for (const item of group) if (!(await processItem(item))) break;
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.o.concurrency ?? 8, orderQueue.length || 1)) }, worker));

    const after = await this.o.store.items(request.requestId);
    const pausedAfter = [...paused.entries()].map(([pg, reason]) => ({ pg, reason }));
    const progress = progressOf(after, pausedAfter, this.#windowOpen(request));
    let status = statusAfterRun(request, progress, pausedAfter, this.#windowOpen(request));
    // 회차 취소는 그 회차에 끝나지 않은 주문이 있으면 항목이 다 끝나도 COMPLETED로 가지 않는다(늦게 끝난 주문을 쓸어 담는다, ADR-0280 결정 5)
    if (status === 'COMPLETED' && request.kind === 'CANCEL' && this.o.openOrders && (await this.o.openOrders.count(request.eventId)) > 0) status = 'RUNNING';
    const updated: EventCancellationRequest = { ...request, status, progress, updatedAtMs: this.o.nowMs() };
    // 그 사이 사람이 멈췄으면 PAUSED를 RUNNING 진행률로 덮지 않는다
    await this.o.store.updateActive(updated);
    for (const p of newlyPaused) {
      await this.o.alert?.raise({
        requestId: request.requestId,
        eventId: request.eventId,
        pg: p.pg,
        severity: 'SEV2',
        reason: p.reason,
        detail: p.detail,
        nowMs: this.o.nowMs(),
      });
    }
  }

  async #recordAttempt(request: EventCancellationRequest, item: EventRefundItem, target: EventRefundTarget, outcome: EventRefundAttemptOutcome): Promise<void> {
    await this.o.attempts?.record({ requestId: request.requestId, ticketId: item.ticketId, pg: item.pg, amount: target.ticketPrice, outcome, atMs: this.o.nowMs() });
  }

  /** 재시도를 적거나(시도 상한이면 실패로 끝낸다) 그 뒤의 항목 상태를 돌려준다. UNKNOWN만 다음 실행에서 다시 집는다 */
  async #retryOrFail(request: EventCancellationRequest, item: EventRefundItem, status: 'UNKNOWN' | 'FAILED', error: string, target: EventRefundTarget | undefined): Promise<'UNKNOWN' | 'FAILED'> {
    const attempts = item.attempts + 1;
    if (attempts >= EVENT_REFUND_AUTO_STOP.maxAttempts) {
      await this.#finishItem(request, item, 'FAILED', error, target, attempts);
      return 'FAILED';
    }
    const nextAttemptAtMs = this.o.nowMs() + eventRefundRetryDelayMs(attempts);
    await this.o.store.updateItem({ ...item, status, attempts, lastError: error, nextAttemptAtMs });
    return status;
  }

  async #finishItem(
    request: EventCancellationRequest,
    item: EventRefundItem,
    status: EventRefundItem['status'],
    error: string | undefined,
    target: EventRefundTarget | undefined,
    attempts?: number,
  ): Promise<void> {
    const next: EventRefundItem = {
      ...item,
      status,
      attempts: attempts ?? item.attempts + (status === 'REFUNDED' ? 0 : 1),
      ...(error !== undefined ? { lastError: error } : {}),
      nextAttemptAtMs: undefined,
    };
    const outbox: EventRefundOutboxMessage[] =
      status === 'REFUNDED' && this.o.fanNotifier
        ? [this.o.fanNotifier.refunded(request, next, target, this.o.nowMs())]
        : status === 'FAILED' && this.o.fanNotifier
          ? [this.o.fanNotifier.failed(request, next, target, this.o.nowMs())]
          : [];
    await this.o.store.updateItem(next, outbox);
    if (status === 'FAILED') {
      await this.o.notice?.open({
        requestId: request.requestId,
        orderId: item.orderId,
        ticketId: item.ticketId,
        cancellationId: item.cancellationId,
        attempts: next.attempts,
        lastError: error ?? 'failed',
        nowMs: this.o.nowMs(),
      });
    }
  }

  async #stopReason(pg: RefundPgProvider, nowMs: number): Promise<StopReason> {
    if (this.o.circuitOpen?.(pg)) return { reason: 'AUTO_CIRCUIT_OPEN', all: false, detail: { pg } };
    if (!this.o.attempts) return undefined;
    const consecutive = await this.o.attempts.consecutiveFailures(pg);
    if (consecutive >= EVENT_REFUND_AUTO_STOP.consecutiveFailures) {
      return { reason: 'AUTO_CONSECUTIVE_FAILURES', all: false, detail: { pg, consecutiveFailures: consecutive } };
    }
    const window = await this.o.attempts.window(pg, nowMs - EVENT_REFUND_AUTO_STOP.windowMs);
    if (window.calls >= EVENT_REFUND_AUTO_STOP.minCalls && rateBp(window.failures, window.calls) >= EVENT_REFUND_AUTO_STOP.failureRateBp) {
      return { reason: 'AUTO_FAILURE_RATE', all: false, detail: { pg, ...window, failureRateBp: rateBp(window.failures, window.calls) } };
    }
    if (window.failedAmount >= EVENT_REFUND_AUTO_STOP.failedAmount) {
      return { reason: 'AUTO_FAILED_AMOUNT', all: false, detail: { pg, ...window, failedAmountThreshold: EVENT_REFUND_AUTO_STOP.failedAmount } };
    }
    const all = await this.o.attempts.windowAll(nowMs - EVENT_REFUND_AUTO_STOP.windowMs);
    if (all.calls >= EVENT_REFUND_AUTO_STOP.minCalls && rateBp(all.rejects, all.calls) >= EVENT_REFUND_AUTO_STOP.rejectRateBp) {
      return { reason: 'AUTO_REJECT_RATE', all: true, detail: { pg, ...all, rejectRateBp: rateBp(all.rejects, all.calls) } };
    }
    return undefined;
  }

  #windowOpen(request: EventCancellationRequest): boolean {
    if (request.kind !== 'POSTPONE') return false;
    if (request.status === 'COMPLETED' || request.status === 'REJECTED') return false;
    return request.refundWindowClosesAtMs !== undefined && this.o.nowMs() < request.refundWindowClosesAtMs;
  }

  #windowOf(kind: EventRefundKind, i: EventRefundStartInput, nowMs: number): { postponedToMs: number; refundWindowClosesAtMs: number } | undefined {
    if (kind !== 'POSTPONE') return undefined;
    if (i.postponedToMs === undefined) throw new EventRefundError('INVALID', '연기는 바뀐 공연 시작 시각(postponedToMs)이 필요합니다');
    const closes = i.refundWindowClosesAtMs ?? i.postponedToMs;
    if (!Number.isSafeInteger(i.postponedToMs) || i.postponedToMs <= nowMs) throw new EventRefundError('INVALID', '바뀐 공연 시작 시각은 지금보다 뒤여야 합니다');
    if (!Number.isSafeInteger(closes) || closes <= nowMs || closes > i.postponedToMs) throw new EventRefundError('INVALID', '환급 신청 창의 닫힘은 지금과 바뀐 공연 시작 사이여야 합니다');
    return { postponedToMs: i.postponedToMs, refundWindowClosesAtMs: closes };
  }

  async #targets(eventId: string): Promise<readonly EventRefundTarget[]> {
    if (!UUID.test(eventId)) throw new EventRefundError('INVALID', 'eventId가 UUID가 아닙니다');
    return this.o.targets.list(eventId);
  }
}
