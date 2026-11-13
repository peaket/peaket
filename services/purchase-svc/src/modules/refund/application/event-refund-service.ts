// 회차 취소 일괄 환불의 쓰임새(BAT-425 GAT-120·GAT-130).
// 첫 몫: 취소 확정 뒤 대상 티켓을 기존 예매 취소 Saga(CancelTicket)로 한 장씩 환불하고, 진행률·부분 실패·수동 일시정지·재개를 남긴다.
// 연기(POSTPONE)·자동 정지·환급 신청 기간·알림 발송·백그라운드 실행기는 후속이다.
import {
  compensationAmount,
  eventRefundCancellationId,
  progressOf,
  type EventCancellationRequest,
  type EventRefundFault,
  type EventRefundItem,
  type EventRefundPreview,
  type EventRefundProgress,
  type EventRefundTarget,
  type RefundPgProvider,
  type RefundPauseReason,
} from '../domain/event-refund.js';
import type { EventRefundPreviewInput, EventRefundPauseInput, EventRefundResumeInput, EventRefundServiceDeps, EventRefundStartInput } from '../domain/event-refund-ports.js';

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

const statusAfterRun = (progress: EventRefundProgress, paused: readonly { pg: RefundPgProvider }[]): EventCancellationRequest['status'] => {
  if (paused.length > 0) return 'PAUSED';
  return progress.perPg.some((p) => p.unknown > 0) || progress.perPg.some((p) => p.state === 'RUNNING') ? 'RUNNING' : 'COMPLETED';
};

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
    const existing = await this.o.store.find(i.requestId);
    if (existing) {
      if (existing.eventId !== i.eventId || existing.fault !== i.fault) throw new EventRefundError('CONFLICT', '같은 요청 ID의 회차·판정이 다릅니다');
      return this.get(i.requestId);
    }

    const targets = await this.#targets(i.eventId);
    const preview = this.#previewOf(targets, i.fault);
    const nowMs = this.o.nowMs();
    const items: EventRefundItem[] = targets.map((t) => ({
      requestId: i.requestId,
      orderId: t.orderId,
      ticketId: t.ticketId,
      cancellationId: eventRefundCancellationId(i.requestId, t.ticketId),
      pg: t.pg,
      status: 'PENDING',
      attempts: 0,
    }));
    const request: EventCancellationRequest = {
      requestId: i.requestId,
      eventId: i.eventId,
      kind: 'CANCEL',
      status: 'RUNNING',
      fault: i.fault,
      ...(i.fanNoticeReason !== undefined ? { fanNoticeReason: i.fanNoticeReason } : {}),
      targetOrders: preview.targetOrders,
      refundTotal: preview.refundTotal,
      compensationTargets: preview.compensationTargets,
      compensationTotal: preview.compensationTotal,
      progress: progressOf(items),
      ruledBy: i.ruledBy,
      confirmedBy: i.confirmedBy,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    };
    const created = await this.o.store.create(request, items);
    await this.#run(created, await this.o.store.items(i.requestId), targets);
    return this.get(i.requestId);
  }

  async get(requestId: string): Promise<EventCancellationRequest> {
    if (!UUID.test(requestId)) throw new EventRefundError('INVALID', 'requestId가 UUID가 아닙니다');
    const request = await this.o.store.find(requestId);
    if (!request) throw new EventRefundError('NOT_FOUND', '회차 취소 요청을 찾을 수 없습니다');
    const items = await this.o.store.items(requestId);
    const paused = pausedOf(request);
    return { ...request, progress: progressOf(items, paused) };
  }

  async pause(i: EventRefundPauseInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.status === 'COMPLETED' || request.status === 'REJECTED') throw new EventRefundError('CONFLICT', '끝난 작업은 멈출 수 없습니다');
    const reason = i.reason.trim();
    if (reason.length === 0) throw new EventRefundError('INVALID', '멈추는 사유가 필요합니다');
    const pgs = i.pg ? [i.pg] : request.progress.perPg.map((p) => p.pg);
    const paused = [...pausedOf(request).filter((p) => !pgs.includes(p.pg)), ...pgs.map((pg) => ({ pg, reason: 'MANUAL' as const }))];
    const updated: EventCancellationRequest = { ...request, status: 'PAUSED', progress: progressOf(await this.o.store.items(i.requestId), paused), updatedAtMs: this.o.nowMs() };
    await this.o.store.update(updated);
    return this.get(i.requestId);
  }

  async resume(i: EventRefundResumeInput): Promise<EventCancellationRequest> {
    const request = await this.get(i.requestId);
    if (request.status === 'COMPLETED' || request.status === 'REJECTED') throw new EventRefundError('CONFLICT', '끝난 작업은 다시 시작할 수 없습니다');
    const paused = pausedOf(request).filter((p) => (i.pg ? p.pg !== i.pg : false));
    const items = await this.o.store.items(i.requestId);
    const running: EventCancellationRequest = { ...request, status: 'RUNNING', progress: progressOf(items, paused), updatedAtMs: this.o.nowMs() };
    await this.o.store.update(running);
    const targets = await this.#targets(request.eventId);
    await this.#run(running, items, targets);
    return this.get(i.requestId);
  }

  async #run(request: EventCancellationRequest, items: readonly EventRefundItem[], targets: readonly EventRefundTarget[]): Promise<void> {
    const paused = new Set(pausedOf(request).map((p) => p.pg));
    const byTicket = new Map(targets.map((t) => [t.ticketId, t]));
    const queue = items.filter((i) => (i.status === 'PENDING' || i.status === 'UNKNOWN') && !paused.has(i.pg));
    const worker = async (): Promise<void> => {
      for (;;) {
        const item = queue.shift();
        if (!item) return;
        const target = byTicket.get(item.ticketId);
        if (!target) {
          await this.#finishItem(item, 'FAILED', 'target-not-found', request.requestId);
          continue;
        }
        try {
          const result = await this.o.canceller.cancel(target, {
            requestId: request.requestId,
            cancellationId: item.cancellationId,
            reason: 'EVENT_CANCELLED',
            nowMs: this.o.nowMs(),
            deadlineMs: this.o.deadlineMs(),
          });
          await this.#finishItem(item, result.status === 'REFUNDED' ? 'REFUNDED' : result.status === 'REFUND_PENDING' ? 'UNKNOWN' : 'FAILED', result.error, request.requestId);
        } catch (err) {
          await this.#finishItem(item, 'UNKNOWN', err instanceof Error ? err.message : 'unknown', request.requestId);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(this.o.concurrency ?? 8, queue.length || 1)) }, worker));

    const after = await this.o.store.items(request.requestId);
    const pausedAfter = pausedOf(request);
    const progress = progressOf(after, pausedAfter);
    const updated: EventCancellationRequest = { ...request, status: statusAfterRun(progress, pausedAfter), progress, updatedAtMs: this.o.nowMs() };
    await this.o.store.update(updated);
  }

  async #finishItem(item: EventRefundItem, status: EventRefundItem['status'], error: string | undefined, requestId: string): Promise<void> {
    const next: EventRefundItem = { ...item, status, attempts: item.attempts + (status === 'REFUNDED' ? 0 : 1), ...(error !== undefined ? { lastError: error } : {}) };
    await this.o.store.updateItem(next);
    if (status === 'FAILED') {
      await this.o.notice?.open({
        requestId,
        orderId: item.orderId,
        ticketId: item.ticketId,
        cancellationId: item.cancellationId,
        attempts: next.attempts,
        lastError: error ?? 'failed',
        nowMs: this.o.nowMs(),
      });
    }
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
