// 회차 취소 일괄 환불의 메모리 저장소(단위 시험·로컬 대역).
import type { EventCancellationRequest, EventRefundAttempt, EventRefundItem, EventRefundWindowStats, RefundPgProvider } from '../domain/event-refund.js';
import type { EventRefundAttemptStore, EventRefundOutboxMessage, EventRefundStore } from '../domain/event-refund-ports.js';

export class MemoryEventRefundStore implements EventRefundStore {
  readonly requests = new Map<string, EventCancellationRequest>();
  readonly byRequest = new Map<string, Map<string, EventRefundItem>>();
  readonly outbox: EventRefundOutboxMessage[] = [];

  async find(requestId: string): Promise<EventCancellationRequest | undefined> {
    return this.requests.get(requestId);
  }

  async create(request: EventCancellationRequest, items: readonly EventRefundItem[], outbox: readonly EventRefundOutboxMessage[] = []): Promise<EventCancellationRequest> {
    const existing = this.requests.get(request.requestId);
    if (existing) return existing;
    this.requests.set(request.requestId, request);
    this.byRequest.set(request.requestId, new Map(items.map((i) => [i.ticketId, i])));
    this.outbox.push(...outbox);
    return request;
  }

  async update(request: EventCancellationRequest): Promise<void> {
    if (!this.requests.has(request.requestId)) throw new Error(`회차 취소 요청이 없다: ${request.requestId}`);
    this.requests.set(request.requestId, request);
  }

  async items(requestId: string): Promise<readonly EventRefundItem[]> {
    return [...(this.byRequest.get(requestId)?.values() ?? [])];
  }

  async updateItem(item: EventRefundItem, outbox: readonly EventRefundOutboxMessage[] = []): Promise<void> {
    const items = this.byRequest.get(item.requestId);
    if (!items?.has(item.ticketId)) throw new Error(`회차 취소 항목이 없다: ${item.requestId}/${item.ticketId}`);
    items.set(item.ticketId, item);
    this.outbox.push(...outbox);
  }

  async markApplied(requestId: string, ticketId: string, appliedAtMs: number): Promise<boolean> {
    const items = this.byRequest.get(requestId);
    const item = items?.get(ticketId);
    if (!items || !item || item.appliedAtMs !== undefined || item.status === 'NOT_APPLIED' || item.status === 'REFUNDED' || item.status === 'FAILED') return false;
    items.set(ticketId, { ...item, appliedAtMs, nextAttemptAtMs: appliedAtMs });
    return true;
  }

  async markNotApplied(requestId: string, ticketId: string): Promise<boolean> {
    const items = this.byRequest.get(requestId);
    const item = items?.get(ticketId);
    if (!items || !item || item.appliedAtMs !== undefined || item.status === 'NOT_APPLIED') return false;
    items.set(ticketId, { ...item, status: 'NOT_APPLIED', nextAttemptAtMs: undefined });
    return true;
  }

  async activeRequests(limit: number): Promise<readonly EventCancellationRequest[]> {
    return [...this.requests.values()].filter((r) => r.status === 'RUNNING' || r.status === 'REFUND_WINDOW').slice(0, limit);
  }

  async dueItems(requestId: string, nowMs: number, limit: number): Promise<readonly EventRefundItem[]> {
    return (await this.items(requestId))
      .filter((i) => (i.status === 'PENDING' || i.status === 'UNKNOWN') && i.appliedAtMs !== undefined && (i.nextAttemptAtMs === undefined || i.nextAttemptAtMs <= nowMs))
      .slice(0, limit);
  }

  async dueWindowClosures(nowMs: number, limit: number): Promise<readonly EventCancellationRequest[]> {
    return [...this.requests.values()]
      .filter((r) => r.kind === 'POSTPONE' && r.status !== 'COMPLETED' && r.status !== 'REJECTED' && r.refundWindowClosesAtMs !== undefined && r.refundWindowClosesAtMs <= nowMs)
      .slice(0, limit);
  }
}

export class MemoryEventRefundAttemptStore implements EventRefundAttemptStore {
  readonly attempts: EventRefundAttempt[] = [];

  async record(attempt: EventRefundAttempt): Promise<void> {
    this.attempts.push(attempt);
  }

  async window(pg: RefundPgProvider, sinceMs: number): Promise<EventRefundWindowStats> {
    return this.#window(this.attempts.filter((a) => a.pg === pg && a.atMs >= sinceMs));
  }

  async windowAll(sinceMs: number): Promise<EventRefundWindowStats> {
    return this.#window(this.attempts.filter((a) => a.atMs >= sinceMs));
  }

  #window(rows: readonly EventRefundAttempt[]): EventRefundWindowStats {
    return {
      calls: rows.length,
      failures: rows.filter((a) => a.outcome === 'FAILURE' || a.outcome === 'UNKNOWN').length,
      rejects: rows.filter((a) => a.outcome === 'REJECT').length,
      failedAmount: rows.filter((a) => a.outcome === 'FAILURE' || a.outcome === 'UNKNOWN').reduce((sum, a) => sum + a.amount, 0),
    };
  }

  async consecutiveFailures(pg: RefundPgProvider): Promise<number> {
    let n = 0;
    for (let i = this.attempts.length - 1; i >= 0; i--) {
      const a = this.attempts[i]!;
      if (a.pg !== pg) continue;
      if (a.outcome === 'SUCCESS') break;
      n++;
    }
    return n;
  }
}
