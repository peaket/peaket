// 회차 취소 요청 PostgreSQL 저장소(ops 0011). 칸 이름은 migrations/0011_event_cancellation_request.sql과 같다.
import type { Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import type { EventCancellationFault, EventCancellationKind, EventCancellationRecord, EventCancellationStatus } from '../../domain/event-cancellation.js';
import type { EventCancellationStore } from '../../domain/ports.js';

interface Row {
  request_id: string;
  event_id: string;
  kind: string;
  status: string;
  reason: string;
  requested_by: string;
  requested_at: Date | string;
  fault: string | null;
  judgement_reason: string | null;
  fan_notice_reason: string | null;
  judged_by: string | null;
  judged_at: Date | string | null;
  approved_by: string | null;
  approved_at: Date | string | null;
  refund_job_state: string | null;
  version: number | string;
  updated_at: Date | string;
}

const ms = (v: Date | string): number => new Date(v).getTime();
const recordOf = (r: Row): EventCancellationRecord => ({
  requestId: r.request_id,
  eventId: r.event_id,
  kind: r.kind as EventCancellationKind,
  status: r.status as EventCancellationStatus,
  reason: r.reason,
  requestedBy: r.requested_by,
  requestedAt: new Date(r.requested_at),
  fault: r.fault as EventCancellationFault | null,
  judgementReason: r.judgement_reason,
  fanNoticeReason: r.fan_notice_reason,
  judgedBy: r.judged_by,
  judgedAt: r.judged_at === null ? null : new Date(r.judged_at),
  approvedBy: r.approved_by,
  approvedAt: r.approved_at === null ? null : new Date(r.approved_at),
  refundJobState: r.refund_job_state,
  version: Number(r.version),
  updatedAt: new Date(r.updated_at),
});
const COLUMNS = sql`request_id, event_id, kind, status, reason, requested_by, requested_at, fault, judgement_reason, fan_notice_reason, judged_by, judged_at, approved_by, approved_at, refund_job_state, version, updated_at`;
const ACTIVE = sql`status in ('REQUESTED','JUDGED','PENDING_APPROVAL','APPROVED','RUNNING','PAUSED','REFUND_WINDOW')`;

export class DrizzleEventCancellationStore implements EventCancellationStore {
  constructor(private readonly database: Database) {}

  async insert(r: EventCancellationRecord): Promise<void> {
    await this.database.db.execute(sql`
      insert into event_cancellation_request (${COLUMNS})
      values (${r.requestId}::uuid, ${r.eventId}::uuid, ${r.kind}, ${r.status}, ${r.reason}, ${r.requestedBy}, ${r.requestedAt}::timestamptz,
              ${r.fault}, ${r.judgementReason}, ${r.fanNoticeReason}, ${r.judgedBy}, ${r.judgedAt}::timestamptz, ${r.approvedBy}, ${r.approvedAt}::timestamptz,
              ${r.refundJobState}, ${r.version}::bigint, ${r.updatedAt}::timestamptz)`);
  }

  async find(requestId: string): Promise<EventCancellationRecord | undefined> {
    const r = await this.database.db.execute(sql`select ${COLUMNS} from event_cancellation_request where request_id = ${requestId}::uuid`);
    const row = r.rows[0] as unknown as Row | undefined;
    return row ? recordOf(row) : undefined;
  }

  async findActiveByEvent(eventId: string): Promise<EventCancellationRecord | undefined> {
    const r = await this.database.db.execute(sql`select ${COLUMNS} from event_cancellation_request where event_id = ${eventId}::uuid and ${ACTIVE} order by requested_at desc limit 1`);
    const row = r.rows[0] as unknown as Row | undefined;
    return row ? recordOf(row) : undefined;
  }

  async save(rec: EventCancellationRecord): Promise<void> {
    await this.database.db.execute(sql`
      update event_cancellation_request set status = ${rec.status}, fault = ${rec.fault}, judgement_reason = ${rec.judgementReason},
        fan_notice_reason = ${rec.fanNoticeReason}, judged_by = ${rec.judgedBy}, judged_at = ${rec.judgedAt}::timestamptz,
        approved_by = ${rec.approvedBy}, approved_at = ${rec.approvedAt}::timestamptz, refund_job_state = ${rec.refundJobState},
        version = ${rec.version}::bigint, updated_at = ${rec.updatedAt}::timestamptz
      where request_id = ${rec.requestId}::uuid`);
  }

  async list(filter: { eventId?: string | undefined; status?: readonly EventCancellationStatus[] | undefined; limit: number }): Promise<EventCancellationRecord[]> {
    const statuses = filter.status && filter.status.length > 0 ? sql`and status in (${sql.join(filter.status.map((s) => sql`${s}`), sql`, `)})` : sql``;
    const event = filter.eventId === undefined ? sql`` : sql`and event_id = ${filter.eventId}::uuid`;
    const r = await this.database.db.execute(sql`select ${COLUMNS} from event_cancellation_request where true ${event} ${statuses} order by requested_at desc, request_id desc limit ${filter.limit}`);
    return (r.rows as unknown as Row[]).map(recordOf);
  }
}

export const __test = { ms };
