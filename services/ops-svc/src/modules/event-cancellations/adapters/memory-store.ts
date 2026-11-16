// 회차 취소 요청 메모리 저장소(단위 시험·로컬). 같은 회차의 진행 중 요청 하나(ops 0011 부분 유일 인덱스)와
// 멱등 기록(ops 0014, 계정 × 작업 × 키)을 DB 저장소와 같은 규칙으로 지킨다.
import { timingSafeEqual } from 'node:crypto';
import { idempotencyKeyReused } from '@peaket/platform';
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import { ACTIVE_EVENT_CANCELLATION_STATUSES, eventCancellationView, type EventCancellationRecord, type EventCancellationStatus, type EventCancellationView } from '../domain/event-cancellation.js';
import type { EventCancellationIdempotency, EventCancellationInsert, EventCancellationStore } from '../domain/ports.js';

const ACTIVE: ReadonlySet<EventCancellationStatus> = new Set(ACTIVE_EVENT_CANCELLATION_STATUSES);

export class MemoryEventCancellationStore implements EventCancellationStore {
  readonly rows = new Map<string, EventCancellationRecord>();
  /** 멱등 기록: `계정\n작업\n키` → 지문과 처음 응답 */
  readonly #once = new Map<string, { hash: Buffer; view: EventCancellationView }>();

  constructor(private readonly audit?: AuditChain) {}

  async insert(record: EventCancellationRecord, audit?: AuditRecord, idem?: EventCancellationIdempotency): Promise<EventCancellationInsert> {
    const scope = idem ? `${idem.accountRef}\n${idem.operation}\n${idem.key}` : undefined;
    if (idem && scope !== undefined) {
      const seen = this.#once.get(scope);
      const hash = Buffer.from(idem.requestHash);
      if (seen) {
        if (seen.hash.length !== hash.length || !timingSafeEqual(seen.hash, hash)) throw idempotencyKeyReused();
        return { status: 'REPLAYED', view: seen.view };
      }
    }
    if (ACTIVE.has(record.status)) {
      const active = await this.findActiveByEvent(record.eventId);
      if (active) return { status: 'ACTIVE', requestId: active.requestId };
    }
    this.rows.set(record.requestId, record);
    if (audit) await this.audit?.append(audit);
    if (idem && scope !== undefined) this.#once.set(scope, { hash: Buffer.from(idem.requestHash), view: eventCancellationView(record) });
    return { status: 'INSERTED' };
  }

  async find(requestId: string): Promise<EventCancellationRecord | undefined> {
    return this.rows.get(requestId);
  }

  async findActiveByEvent(eventId: string): Promise<EventCancellationRecord | undefined> {
    return [...this.rows.values()].find((r) => r.eventId === eventId && ACTIVE.has(r.status));
  }

  async save(record: EventCancellationRecord, audit?: AuditRecord): Promise<boolean> {
    const current = this.rows.get(record.requestId);
    if (!current || current.version !== record.version - 1) return false;
    this.rows.set(record.requestId, record);
    if (audit) await this.audit?.append(audit);
    return true;
  }

  async list(filter: { eventId?: string | undefined; status?: readonly EventCancellationStatus[] | undefined; limit: number }): Promise<EventCancellationRecord[]> {
    return [...this.rows.values()]
      .filter((r) => (filter.eventId === undefined || r.eventId === filter.eventId) && (filter.status === undefined || filter.status.includes(r.status)))
      .sort((a, b) => b.requestedAt.getTime() - a.requestedAt.getTime() || (a.requestId < b.requestId ? 1 : -1))
      .slice(0, filter.limit);
  }
}
