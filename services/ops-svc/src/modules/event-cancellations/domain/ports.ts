// 회차 취소 요청 저장·purchase-svc 일괄 환불 시작 포트.
import type { AuditRecord } from '../../audit/audit.js';
import type { EventCancellationFault, EventCancellationKind, EventCancellationPg, EventCancellationRecord, EventCancellationStatus } from './event-cancellation.js';

export interface EventCancellationStore {
  /** 상태 행과 감사 기록을 같은 트랜잭션에 쓴다(감사 기록이 있으면) */
  insert(record: EventCancellationRecord, audit?: AuditRecord): Promise<void>;
  find(requestId: string): Promise<EventCancellationRecord | undefined>;
  findActiveByEvent(eventId: string): Promise<EventCancellationRecord | undefined>;
  /** version 조건부 갱신과 감사 기록을 같은 트랜잭션에 쓴다. 다른 요청이 먼저 갱신했으면 false */
  save(record: EventCancellationRecord, audit?: AuditRecord): Promise<boolean>;
  list(filter: { eventId?: string | undefined; status?: readonly EventCancellationStatus[] | undefined; limit: number }): Promise<EventCancellationRecord[]>;
}

export interface EventRefundStartInput {
  readonly eventId: string;
  readonly requestId: string;
  readonly fault: EventCancellationFault;
  readonly ruledBy: string;
  readonly confirmedBy: string;
  readonly kind?: EventCancellationKind;
  readonly fanNoticeReason?: string;
}

export interface EventRefundJobView {
  readonly jobId: string;
  readonly state: string;
}

/** purchase-svc EventRefundService의 필요한 몫. 없으면 확정·정지·재개가 503이다. */
export interface EventRefundStarter {
  start(input: EventRefundStartInput): Promise<EventRefundJobView>;
  pause(input: { requestId: string; pg?: EventCancellationPg; reason: string }): Promise<EventRefundJobView>;
  resume(input: { requestId: string; pg?: EventCancellationPg; reason?: string }): Promise<EventRefundJobView>;
}

export const EVENT_CANCELLATION_STORE = Symbol.for('peaket.ops.event-cancellation-store');
export const EVENT_REFUND_STARTER = Symbol.for('peaket.ops.event-refund-starter');
