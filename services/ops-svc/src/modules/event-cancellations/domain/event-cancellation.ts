// 회차 취소 요청·판정·2인 확정(BAT-425 GAT-130 잔여, FR-055, POL-038, ADR-0046, openapi EventCancellationRequest).
// commander가 요청하고, commander가 귀책을 판정한 뒤 판정자가 아닌 operator·commander가 확정한다.
export type EventCancellationKind = 'CANCEL' | 'POSTPONE';
export type EventCancellationStatus = 'REQUESTED' | 'JUDGED' | 'PENDING_APPROVAL' | 'APPROVED' | 'RUNNING' | 'PAUSED' | 'REFUND_WINDOW' | 'COMPLETED' | 'REJECTED';
export type EventCancellationFault = 'ORGANIZER' | 'FORCE_MAJEURE' | 'CONTENT_CHANGE';
export type EventCancellationPg = 'TOSS' | 'PORTONE' | 'SIMULATOR';

export class EventCancellationProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'EventCancellationProblem';
  }
}

export interface EventCancellationRecord {
  requestId: string;
  eventId: string;
  kind: EventCancellationKind;
  status: EventCancellationStatus;
  reason: string;
  requestedBy: string;
  requestedAt: Date;
  fault: EventCancellationFault | null;
  judgementReason: string | null;
  fanNoticeReason: string | null;
  judgedBy: string | null;
  judgedAt: Date | null;
  approvedBy: string | null;
  approvedAt: Date | null;
  refundJobState: string | null;
  version: number;
  updatedAt: Date;
}

export interface EventCancellationView {
  requestId: string;
  eventId: string;
  kind: EventCancellationKind;
  status: EventCancellationStatus;
  reason: string;
  fault?: EventCancellationFault;
  fanNoticeReason?: string;
  requestedAt: string;
  judgedBy?: string;
  progress?: { state: string };
}

export const eventCancellationView = (r: EventCancellationRecord): EventCancellationView => ({
  requestId: r.requestId,
  eventId: r.eventId,
  kind: r.kind,
  status: r.status,
  reason: r.reason,
  ...(r.fault !== null ? { fault: r.fault } : {}),
  ...(r.fanNoticeReason !== null ? { fanNoticeReason: r.fanNoticeReason } : {}),
  requestedAt: r.requestedAt.toISOString(),
  ...(r.judgedBy !== null ? { judgedBy: r.judgedBy } : {}),
  ...(r.refundJobState !== null ? { progress: { state: r.refundJobState } } : {}),
});
