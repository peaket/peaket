// 회차 취소 일괄 환불의 메모리 저장소(단위 시험·로컬 대역).
import { EventRefundActiveConflict, type EventCancellationRequest, type EventRefundAttempt, type EventRefundItem, type EventRefundWindowStats, type RefundPgProvider } from '../domain/event-refund.js';
import type { EventRefundAttemptStore, EventRefundItemAdder, EventRefundOutboxMessage, EventRefundStore } from '../domain/event-refund-ports.js';

export class MemoryEventRefundStore implements EventRefundStore, EventRefundItemAdder {
  readonly requests = new Map<string, EventCancellationRequest>();
  readonly byRequest = new Map<string, Map<string, EventRefundItem>>();
  readonly outbox: EventRefundOutboxMessage[] = [];
  /** 항목 FAILED 때 그 취소 행에 남긴 실패 표시(취소 ID → 마지막 오류, 웨이브 끝 리뷰 K1·C1) */
  readonly cancellationFailures = new Map<string, string>();
  /** 공제 차액 대상 표시(취소 ID → 요청 ID, 웨이브 끝 리뷰 C2·S1). 처음 표시한 요청을 둔다 */
  readonly deductionGaps = new Map<string, string>();
  /** 일괄 환불 실패 건을 열 대상으로 표시한 항목(`요청 ID/표 ID`, 다시 보기 2 N2 failure_case_at). FAILED 쓰기와 함께 남긴다 */
  readonly failureCases = new Set<string>();

  async find(requestId: string): Promise<EventCancellationRequest | undefined> {
    return this.requests.get(requestId);
  }

  async create(
    request: EventCancellationRequest,
    items: readonly EventRefundItem[],
    outbox: readonly EventRefundOutboxMessage[] = [],
    extra: { readonly deductionGaps?: readonly string[] } = {},
  ): Promise<EventCancellationRequest> {
    const existing = this.requests.get(request.requestId);
    if (existing) return existing;
    const active = [...this.requests.values()].find(
      (r) => r.eventId === request.eventId && ['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW'].includes(r.status),
    );
    if (active) throw new EventRefundActiveConflict(active.requestId, active.eventId);
    this.requests.set(request.requestId, request);
    this.byRequest.set(request.requestId, new Map(items.map((i) => [i.ticketId, i])));
    this.outbox.push(...outbox);
    for (const id of extra.deductionGaps ?? []) if (!this.deductionGaps.has(id)) this.deductionGaps.set(id, request.requestId);
    return request;
  }

  async update(request: EventCancellationRequest): Promise<void> {
    if (!this.requests.has(request.requestId)) throw new Error(`회차 취소 요청이 없다: ${request.requestId}`);
    this.requests.set(request.requestId, request);
  }

  async updateActive(request: EventCancellationRequest): Promise<boolean> {
    const current = this.requests.get(request.requestId);
    if (!current || (current.status !== 'RUNNING' && current.status !== 'REFUND_WINDOW')) return false;
    this.requests.set(request.requestId, request);
    return true;
  }

  /** W9-fix1 N8 잠근 진행률 쓰기(빈 뼈대: 시험 담당, 구현 전. 동작은 구현 담당이 채운다) */
  async updateLocked(_requestId: string, _next: (current: EventCancellationRequest) => EventCancellationRequest | undefined): Promise<EventCancellationRequest | undefined> {
    throw new Error('아직 없음: MemoryEventRefundStore.updateLocked');
  }

  async items(requestId: string): Promise<readonly EventRefundItem[]> {
    return [...(this.byRequest.get(requestId)?.values() ?? [])];
  }

  /** 확정 뒤 끝난 주문의 표 더하기(BAT-420 GAT-110 H). 없는 (요청, 표)만 더하고, 더한 것이 있을 때만 Outbox를 남긴다 */
  async addItems(requestId: string, items: readonly EventRefundItem[], outbox: readonly EventRefundOutboxMessage[] = []): Promise<readonly EventRefundItem[]> {
    const existing = this.byRequest.get(requestId);
    if (!existing) throw new Error(`회차 취소 요청이 없다: ${requestId}`);
    const cancellationIds = new Set([...existing.values()].map((i) => i.cancellationId));
    const added = items.filter((i) => !existing.has(i.ticketId) && !cancellationIds.has(i.cancellationId));
    for (const i of added) existing.set(i.ticketId, i);
    if (added.length > 0) this.outbox.push(...outbox);
    return added;
  }

  /**
   * 끝나지 않은(PENDING·UNKNOWN) 항목만 쓴다(웨이브 끝 리뷰 K2: 끝난 상태를 덮지 않는다). 썼을 때만 Outbox와
   * 취소 행 실패 표시(K1·C1, cancellationFailures)·차액 대상 표시(C2·S1, deductionGaps)·일괄 환불 실패 건 표시(다시 보기 2 N2, failureCases)를 남긴다. 쓰지 않았으면 false
   */
  async updateItem(
    item: EventRefundItem,
    outbox: readonly EventRefundOutboxMessage[] = [],
    extra: {
      readonly cancellationFailure?: { readonly lastError: string };
      readonly deductionGap?: { readonly cancellationId: string; readonly requestId: string };
      readonly failureCase?: true;
    } = {},
  ): Promise<boolean> {
    const items = this.byRequest.get(item.requestId);
    const current = items?.get(item.ticketId);
    if (!items || !current) throw new Error(`회차 취소 항목이 없다: ${item.requestId}/${item.ticketId}`);
    if (current.status !== 'PENDING' && current.status !== 'UNKNOWN') return false;
    items.set(item.ticketId, item);
    this.outbox.push(...outbox);
    if (extra.cancellationFailure && !this.cancellationFailures.has(item.cancellationId)) this.cancellationFailures.set(item.cancellationId, extra.cancellationFailure.lastError);
    if (extra.deductionGap && !this.deductionGaps.has(extra.deductionGap.cancellationId)) this.deductionGaps.set(extra.deductionGap.cancellationId, extra.deductionGap.requestId);
    if (extra.failureCase === true && item.status === 'FAILED') this.failureCases.add(`${item.requestId}/${item.ticketId}`);
    return true;
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
    return [...this.requests.values()].filter((r) => r.status === 'RUNNING' || r.status === 'PAUSED' || r.status === 'REFUND_WINDOW').slice(0, limit);
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
