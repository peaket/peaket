// 회차 취소 일괄 환불의 메모리 저장소(단위 시험·로컬 대역).
import type { EventCancellationRequest, EventRefundItem } from '../domain/event-refund.js';
import type { EventRefundStore } from '../domain/event-refund-ports.js';

export class MemoryEventRefundStore implements EventRefundStore {
  readonly requests = new Map<string, EventCancellationRequest>();
  readonly byRequest = new Map<string, Map<string, EventRefundItem>>();

  async find(requestId: string): Promise<EventCancellationRequest | undefined> {
    return this.requests.get(requestId);
  }

  async create(request: EventCancellationRequest, items: readonly EventRefundItem[]): Promise<EventCancellationRequest> {
    const existing = this.requests.get(request.requestId);
    if (existing) return existing;
    this.requests.set(request.requestId, request);
    this.byRequest.set(request.requestId, new Map(items.map((i) => [i.ticketId, i])));
    return request;
  }

  async update(request: EventCancellationRequest): Promise<void> {
    if (!this.requests.has(request.requestId)) throw new Error(`회차 취소 요청이 없다: ${request.requestId}`);
    this.requests.set(request.requestId, request);
  }

  async items(requestId: string): Promise<readonly EventRefundItem[]> {
    return [...(this.byRequest.get(requestId)?.values() ?? [])];
  }

  async updateItem(item: EventRefundItem): Promise<void> {
    const items = this.byRequest.get(item.requestId);
    if (!items?.has(item.ticketId)) throw new Error(`회차 취소 항목이 없다: ${item.requestId}/${item.ticketId}`);
    items.set(item.ticketId, item);
  }
}
