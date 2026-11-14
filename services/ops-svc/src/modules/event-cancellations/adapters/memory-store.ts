// 회차 취소 요청 메모리 저장소(단위 시험·로컬).
import type { EventCancellationRecord, EventCancellationStatus } from '../domain/event-cancellation.js';
import type { EventCancellationStore } from '../domain/ports.js';

const ACTIVE: ReadonlySet<EventCancellationStatus> = new Set(['REQUESTED', 'JUDGED', 'PENDING_APPROVAL', 'APPROVED', 'RUNNING', 'PAUSED', 'REFUND_WINDOW']);

export class MemoryEventCancellationStore implements EventCancellationStore {
  readonly rows = new Map<string, EventCancellationRecord>();

  async insert(record: EventCancellationRecord): Promise<void> {
    this.rows.set(record.requestId, record);
  }

  async find(requestId: string): Promise<EventCancellationRecord | undefined> {
    return this.rows.get(requestId);
  }

  async findActiveByEvent(eventId: string): Promise<EventCancellationRecord | undefined> {
    return [...this.rows.values()].find((r) => r.eventId === eventId && ACTIVE.has(r.status));
  }

  async save(record: EventCancellationRecord): Promise<void> {
    this.rows.set(record.requestId, record);
  }

  async list(filter: { eventId?: string | undefined; status?: readonly EventCancellationStatus[] | undefined; limit: number }): Promise<EventCancellationRecord[]> {
    return [...this.rows.values()]
      .filter((r) => (filter.eventId === undefined || r.eventId === filter.eventId) && (filter.status === undefined || filter.status.includes(r.status)))
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || (a.requestId < b.requestId ? 1 : -1))
      .slice(0, filter.limit);
  }
}
