// 회차 취소 일괄 환불의 쓰임새(BAT-425 GAT-120·GAT-130).
// 취소는 확정 뒤 대상 티켓을 기존 예매 취소 Saga(CancelTicket)로 한 장씩 환불하고,
// 연기는 환급 신청 창(REFUND_WINDOW)을 연 뒤 신청한 티켓만 환불한다.
// 자동 정지(실패율·실패 금액·연속 실패·거절률·서킷), 재시도·멱등·중단/재개·진행률, 팬 알림 Outbox를 남긴다.
import {
  compensationAmount,
  eventRefundCancellationId,
  eventRefundRetryDelayMs,
  EVENT_REFUND_AUTO_STOP,
  progressOf,
  rateBp,
  type EventCancellationRequest,
  type EventRefundAttemptOutcome,
  type EventRefundFault,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

type StopReason = { reason: RefundPauseReason; all: boolean; detail: Record<string, unknown> } | undefined;

/** 결제사 호출 결과를 자동 정지의 결과 값으로 나눈다. 업무 거절은 REJECT, 그 밖의 실패는 FAILURE, 결과 모름은 UNKNOWN */
function outcomeOf(status: 'REFUNDED' | 'REFUND_PENDING' | 'FAILED', error: string | undefined): EventRefundAttemptOutcome {
  if (status === 'REFUNDED') return 'SUCCESS';
  if (status === 'REFUND_PENDING') return 'UNKNOWN';
  return error !== undefined && FAILURE_ERRORS.has(error) ? 'REJECT' : 'FAILURE';
}

export class EventRefundService {
  constructor(private readonly o: EventRefundServiceDeps) {}

  async preview(i: EventRefundPreviewInput): Promise<EventRefundPreview> {
    const targets = await this.#targets(i.eventId);
    return this.#previewOf(targets, i.fault);
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
    const targets = await this.#targets(i.eventId);
    const preview = this.#previewOf(targets, i.fault);
    const items: EventRefundItem[] = targets.map((t) => ({
      requestId: i.requestId,
      orderId: t.orderId,
      ticketId: t.ticketId,
      cancellationId: eventRefundCancellationId(i.requestId, t.ticketId),
      pg: t.pg,
      status: 'PENDING',
      attempts: 0,
      ...(kind === 'CANCEL' ? { appliedAtMs: nowMs } : {}),
      ...(kind === 'CANCEL' ? { nextAttemptAtMs: nowMs } : {}),
    }));
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
    const created = await this.o.store.create(request, items, confirmed);
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

  /** 백그라운드 실행기 한 바퀴: 닫을 창을 닫고, 실행 중 요청의 due 항목을 조금씩 처리한다 */
  async runDue(): Promise<{ closedWindows: number; processed: number }> {
    const nowMs = this.o.nowMs();
    let closedWindows = 0;
    for (const request of await this.o.store.dueWindowClosures(nowMs, 20)) {
      await this.#closeWindowNow(request, 'system:event-refund-window');
      closedWindows++;
    }
    let processed = 0;
    for (const request of await this.o.store.activeRequests(20)) {
      if (request.status === 'PAUSED' || request.status === 'COMPLETED' || request.status === 'REJECTED') continue;
      const items = await this.o.store.dueItems(request.requestId, nowMs, this.o.batchSize ?? 200);
      if (items.length === 0) continue;
      const targets = await this.#targets(request.eventId);
      await this.#run(request, targets, items.length);
      processed += items.length;
    }
    return { closedWindows, processed };
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
    const queue = all
      .filter((i) => (i.status === 'PENDING' || i.status === 'UNKNOWN') && i.appliedAtMs !== undefined && (i.nextAttemptAtMs === undefined || i.nextAttemptAtMs <= nowMs) && !paused.has(i.pg))
      .slice(0, Math.max(0, limit));
    const newlyPaused: { pg: RefundPgProvider; reason: RefundPauseReason; detail: Record<string, unknown> }[] = [];
    // 자동 정지 판정은 결제사 몫마다 5건에 한 번 다시 본다(건마다 DB를 묻지 않으면서 기준을 넘긴 뒤 새 호출을 4건 이내로 막는다).
    const stopChecks = new Map<RefundPgProvider, StopReason>();
    const seen = new Map<RefundPgProvider, number>();
    const worker = async (): Promise<void> => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        if (paused.has(item.pg)) continue;
        const n = (seen.get(item.pg) ?? 0) + 1;
        seen.set(item.pg, n);
        if (!stopChecks.has(item.pg) || n % 5 === 0) stopChecks.set(item.pg, await this.#stopReason(item.pg, nowMs));
        const stop = stopChecks.get(item.pg);
        if (stop) {
          const pgs = stop.all ? request.progress.perPg.map((p) => p.pg) : [item.pg];
          for (const pg of pgs) {
            if (!paused.has(pg)) {
              paused.set(pg, stop.reason);
              newlyPaused.push({ pg, reason: stop.reason, detail: stop.detail });
            }
          }
          continue;
        }
        const target = byTicket.get(item.ticketId);
        if (!target) {
          await this.#finishItem(request, item, 'FAILED', 'target-not-found', undefined, undefined);
          continue;
        }
        try {
          const result = await this.o.canceller.cancel(target, {
            requestId: request.requestId,
            cancellationId: item.cancellationId,
            reason: request.kind === 'POSTPONE' ? 'EVENT_POSTPONED' : 'EVENT_CANCELLED',
            nowMs: this.o.nowMs(),
            deadlineMs: this.o.deadlineMs(),
          });
          const outcome = outcomeOf(result.status, result.error);
          await this.#recordAttempt(request, item, target, outcome);
          if (result.status === 'REFUNDED') {
            await this.#finishItem(request, item, 'REFUNDED', undefined, target, undefined);
          } else if (result.status === 'REFUND_PENDING') {
            await this.#retryOrFail(request, item, 'UNKNOWN', result.error ?? 'refund-pending', target);
          } else if (result.error !== undefined && FAILURE_ERRORS.has(result.error)) {
            await this.#finishItem(request, item, 'FAILED', result.error, target, undefined);
          } else {
            await this.#retryOrFail(request, item, 'FAILED', result.error ?? 'failed', target);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : 'unknown';
          await this.#recordAttempt(request, item, target, 'UNKNOWN');
          await this.#retryOrFail(request, item, 'UNKNOWN', message, target);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.o.concurrency ?? 8, queue.length || 1)) }, worker));

    const after = await this.o.store.items(request.requestId);
    const pausedAfter = [...paused.entries()].map(([pg, reason]) => ({ pg, reason }));
    const progress = progressOf(after, pausedAfter, this.#windowOpen(request));
    const updated: EventCancellationRequest = { ...request, status: statusAfterRun(request, progress, pausedAfter, this.#windowOpen(request)), progress, updatedAtMs: this.o.nowMs() };
    await this.o.store.update(updated);
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

  async #retryOrFail(request: EventCancellationRequest, item: EventRefundItem, status: 'UNKNOWN' | 'FAILED', error: string, target: EventRefundTarget | undefined): Promise<void> {
    const attempts = item.attempts + 1;
    if (attempts >= EVENT_REFUND_AUTO_STOP.maxAttempts) {
      await this.#finishItem(request, item, 'FAILED', error, target, attempts);
      return;
    }
    const nextAttemptAtMs = this.o.nowMs() + eventRefundRetryDelayMs(attempts);
    await this.o.store.updateItem({ ...item, status, attempts, lastError: error, nextAttemptAtMs });
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

  #previewOf(targets: readonly EventRefundTarget[], fault: EventRefundFault): EventRefundPreview {
    const byPg = new Map<RefundPgProvider, number>();
    let refundTotal = 0;
    let compensationTargets = 0;
    let compensationTotal = 0;
    for (const t of targets) {
      refundTotal += t.ticketPrice;
      const compensation = compensationAmount(t.ticketPrice, fault);
      if (compensation > 0) compensationTargets++;
      compensationTotal += compensation;
      byPg.set(t.pg, (byPg.get(t.pg) ?? 0) + 1);
    }
    return {
      targetOrders: targets.length,
      refundTotal,
      compensationTargets,
      compensationTotal,
      perPg: [...byPg.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([pg, orders]) => ({ pg, orders, estimatedSeconds: Math.ceil(orders / 300) })),
    };
  }
}
