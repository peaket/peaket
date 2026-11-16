// 회차 취소 요청 PostgreSQL 저장소(ops 0011·0013·0014). 칸 이름은 migrations/0011_event_cancellation_request.sql·0013과 같다.
// 요청 넣기는 한 트랜잭션에서 멱등 키 행(0014, 첫 쓰기) → 같은 회차의 진행 중 요청 확인 → 행·감사 기록 순서로 쓴다.
// 진행 중이면 트랜잭션째 되돌려 키 행도 남기지 않는다(같은 키로 뒤에 다시 보내면 다시 판정한다).
import { timingSafeEqual } from 'node:crypto';
import { IDEMPOTENCY_RECORD_TABLE, IDEMPOTENCY_RETENTION_MS, IdempotencyStore, idempotencyKeyReused, systemClock, type Clock, type Database, type DbTransaction } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { appendAuditIn, type AuditRecord } from '../../../audit/audit.js';
import {
  ACTIVE_EVENT_CANCELLATION_STATUSES,
  eventCancellationView,
  type EventCancellationDryRun,
  type EventCancellationFault,
  type EventCancellationKind,
  type EventCancellationRecord,
  type EventCancellationStatus,
  type EventCancellationVia,
  type EventCancellationView,
} from '../../domain/event-cancellation.js';
import type { EventCancellationIdempotency, EventCancellationInsert, EventCancellationStore } from '../../domain/ports.js';

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
  requested_via: string;
  promoter_id: string | null;
  fault_opinion: string | null;
  evidence_ref: string | null;
  new_starts_at: Date | string | null;
  dry_run: EventCancellationDryRun | string | null;
  rejection_reason: string | null;
}

const dryRunOf = (v: Row['dry_run']): EventCancellationDryRun | null => (v === null ? null : typeof v === 'string' ? (JSON.parse(v) as EventCancellationDryRun) : v);
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
  requestedVia: r.requested_via as EventCancellationVia,
  promoterId: r.promoter_id,
  faultOpinion: r.fault_opinion as EventCancellationFault | null,
  evidenceRef: r.evidence_ref,
  newStartsAt: r.new_starts_at === null ? null : new Date(r.new_starts_at),
  dryRun: dryRunOf(r.dry_run),
  rejectionReason: r.rejection_reason,
});
const COLUMNS = sql`request_id, event_id, kind, status, reason, requested_by, requested_at, fault, judgement_reason, fan_notice_reason, judged_by, judged_at, approved_by, approved_at, refund_job_state, version, updated_at,
  requested_via, promoter_id, fault_opinion, evidence_ref, new_starts_at, dry_run, rejection_reason`;
const ACTIVE_STATUSES: ReadonlySet<EventCancellationStatus> = new Set(ACTIVE_EVENT_CANCELLATION_STATUSES);
const ACTIVE = sql`status in ('REQUESTED','JUDGED','PENDING_APPROVAL','APPROVED','RUNNING','PAUSED','REFUND_WINDOW')`;
const jsonOf = (v: EventCancellationDryRun | null | undefined): string | null => (v ? JSON.stringify(v) : null);

/** 같은 회차에 진행 중 요청이 있어 넣지 않는다(트랜잭션을 되돌리려고 던진다) */
class ActiveRequest extends Error {
  constructor(readonly requestId: string) {
    super('event-cancellation-active');
  }
}

const pgCode = (e: unknown): string | undefined => {
  const any = e as { code?: unknown; cause?: { code?: unknown } } | undefined;
  const c = any?.code ?? any?.cause?.code;
  return typeof c === 'string' ? c : undefined;
};
const constraintOf = (e: unknown): string | undefined => {
  const any = e as { constraint?: unknown; cause?: { constraint?: unknown } } | undefined;
  const c = any?.constraint ?? any?.cause?.constraint;
  return typeof c === 'string' ? c : undefined;
};

export class DrizzleEventCancellationStore implements EventCancellationStore {
  readonly #idempotency: IdempotencyStore;
  readonly #clock: Clock;

  constructor(
    private readonly database: Database,
    clock: Clock = systemClock,
  ) {
    this.#idempotency = new IdempotencyStore({ clock });
    this.#clock = clock;
  }

  /** 같은 멱등 키의 커밋된 처음 응답(보관 기간 안). 넣기의 멱등 규칙(platform IdempotencyStore)과 같은 표·범위·지문 비교다 */
  async replayOf(idem: EventCancellationIdempotency): Promise<EventCancellationView | undefined> {
    const since = new Date(this.#clock.now() - IDEMPOTENCY_RETENTION_MS);
    const r = await this.database.db.execute(sql`
      select request_hash, result_ref from ${sql.identifier(IDEMPOTENCY_RECORD_TABLE)}
       where account_ref = ${idem.accountRef} and operation = ${idem.operation} and idempotency_key = ${idem.key} and created_at > ${since}`);
    const row = r.rows[0] as { request_hash: Buffer; result_ref: string | null } | undefined;
    if (!row || row.result_ref === null) return undefined;
    const stored = Buffer.from(row.request_hash);
    const hash = Buffer.from(idem.requestHash);
    if (stored.length !== hash.length || !timingSafeEqual(stored, hash)) throw idempotencyKeyReused();
    return JSON.parse(row.result_ref) as EventCancellationView;
  }

  async insert(r: EventCancellationRecord, audit?: AuditRecord, idem?: EventCancellationIdempotency): Promise<EventCancellationInsert> {
    try {
      return await this.database.transaction(async (tx): Promise<EventCancellationInsert> => {
        if (!idem) {
          await this.#insertIn(tx, r, audit);
          return { status: 'INSERTED' };
        }
        let inserted = false;
        const view = await this.#idempotency.run<EventCancellationView>(tx, idem, {
          execute: async () => {
            await this.#insertIn(tx, r, audit);
            inserted = true;
            const first = eventCancellationView(r);
            return { resultRef: JSON.stringify(first), value: first };
          },
          replay: async (ref) => JSON.parse(ref) as EventCancellationView,
        });
        return inserted ? { status: 'INSERTED' } : { status: 'REPLAYED', view };
      });
    } catch (err) {
      if (err instanceof ActiveRequest) return { status: 'ACTIVE', requestId: err.requestId };
      // 확인과 넣기 사이에 다른 요청이 먼저 커밋했다(부분 유일 인덱스가 막음): 그 요청을 진행 중으로 알린다
      if (pgCode(err) === '23505' && constraintOf(err) === 'event_cancellation_request_active_key') {
        const active = await this.findActiveByEvent(r.eventId);
        if (active) return { status: 'ACTIVE', requestId: active.requestId };
      }
      throw err;
    }
  }

  async #insertIn(tx: DbTransaction, r: EventCancellationRecord, audit?: AuditRecord): Promise<void> {
    if (ACTIVE_STATUSES.has(r.status)) {
      const active = await tx.execute(sql`select request_id from event_cancellation_request where event_id = ${r.eventId}::uuid and ${ACTIVE} limit 1`);
      const existing = (active.rows[0] as { request_id: string } | undefined)?.request_id;
      if (existing !== undefined) throw new ActiveRequest(existing);
    }
    await tx.execute(sql`
      insert into event_cancellation_request (${COLUMNS})
      values (${r.requestId}::uuid, ${r.eventId}::uuid, ${r.kind}, ${r.status}, ${r.reason}, ${r.requestedBy}, ${r.requestedAt}::timestamptz,
              ${r.fault}, ${r.judgementReason}, ${r.fanNoticeReason}, ${r.judgedBy}, ${r.judgedAt}::timestamptz, ${r.approvedBy}, ${r.approvedAt}::timestamptz,
              ${r.refundJobState}, ${r.version}::bigint, ${r.updatedAt}::timestamptz,
              ${r.requestedVia ?? 'COMMANDER'}, ${r.promoterId ?? null}::uuid, ${r.faultOpinion ?? null}, ${r.evidenceRef ?? null}, ${r.newStartsAt ?? null}::timestamptz,
              ${jsonOf(r.dryRun)}::jsonb, ${r.rejectionReason ?? null})`);
    if (audit) await appendAuditIn(tx, audit);
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

  async save(rec: EventCancellationRecord, audit?: AuditRecord): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const updated = await tx.execute(sql`
        update event_cancellation_request set status = ${rec.status}, fault = ${rec.fault}, judgement_reason = ${rec.judgementReason},
          fan_notice_reason = ${rec.fanNoticeReason}, judged_by = ${rec.judgedBy}, judged_at = ${rec.judgedAt}::timestamptz,
          approved_by = ${rec.approvedBy}, approved_at = ${rec.approvedAt}::timestamptz, refund_job_state = ${rec.refundJobState},
          dry_run = ${jsonOf(rec.dryRun)}::jsonb, rejection_reason = ${rec.rejectionReason ?? null},
          version = ${rec.version}::bigint, updated_at = ${rec.updatedAt}::timestamptz
        where request_id = ${rec.requestId}::uuid and version = ${rec.version - 1}::bigint
        returning request_id`);
      if (updated.rows.length === 0) return false;
      if (audit) await appendAuditIn(tx, audit);
      return true;
    });
  }

  async list(filter: { eventId?: string | undefined; status?: readonly EventCancellationStatus[] | undefined; limit: number }): Promise<EventCancellationRecord[]> {
    const statuses = filter.status && filter.status.length > 0 ? sql`and status in (${sql.join(filter.status.map((s) => sql`${s}`), sql`, `)})` : sql``;
    const event = filter.eventId === undefined ? sql`` : sql`and event_id = ${filter.eventId}::uuid`;
    const r = await this.database.db.execute(sql`select ${COLUMNS} from event_cancellation_request where true ${event} ${statuses} order by requested_at desc, request_id desc limit ${filter.limit}`);
    return (r.rows as unknown as Row[]).map(recordOf);
  }
}
