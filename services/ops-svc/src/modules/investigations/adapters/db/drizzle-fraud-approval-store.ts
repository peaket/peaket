// F-04-13 FRAUD_ACTION 승인 저장소 Drizzle 판(ops DB, 마이그레이션 0037).
// 승인 요청·사건 상태·ACTION_REQUESTED 기록·감사 기록·멱등 기록을 한 트랜잭션에 쓴다.
import { sql } from 'drizzle-orm';
import { IdempotencyStore, systemClock, type Database, type DbTransaction } from '@peaket/platform';
import { appendAuditIn } from '../../../audit/index.js';
import type { CaseAuditRecord, FraudApprovalRecord, FraudApprovalStore, IdempotentWrite } from '../../domain/ports.js';
import type { FraudCaseEventRecord } from '../../domain/investigation.js';

const ms = (v: Date | string | null | undefined): number | null => (v === null || v === undefined ? null : v instanceof Date ? v.getTime() : Date.parse(v));

const recordOf = (r: any, scope: any, approvals: readonly string[], approvedAtMs: number | null): FraudApprovalRecord => ({
  approvalId: r.id,
  caseId: r.target_ref,
  eventId: scope.eventId ?? '',
  action: r.fraud_action,
  accountIds: scope.accountIds,
  targets: scope.targets,
  restrictionEndsAtMs: scope.restrictionEndsAtMs,
  reason: r.reason_text,
  requestedBy: r.requested_by,
  requesterRole: r.requester_role,
  dueAtMs: ms(r.due_at) ?? 0,
  status: r.status,
  requestedAtMs: ms(r.created_at) ?? 0,
  approverId: r.approver_id ?? null,
  approvedAtMs,
  closeReason: r.close_reason ?? null,
  approvals,
});

export class DrizzleFraudApprovalStore implements FraudApprovalStore {
  readonly updatesCase = true;
  readonly #idem = new IdempotencyStore({ clock: systemClock });

  constructor(private readonly database: Database) {}

  async request(
    i: FraudApprovalRecord,
    o: {
      idem?: IdempotentWrite;
      result?: unknown;
      audit?: CaseAuditRecord;
      events: readonly FraudCaseEventRecord[];
      caseStatus?: string;
    },
  ): Promise<void> {
    const requestedAtMs = i.requestedAtMs ?? i.nowMs ?? Date.now();
    const write = async (tx: DbTransaction): Promise<void> => {
      await tx.execute(sql`
        insert into approval_request (id, kind, target_ref, fraud_action, reason_code, reason_text, requested_by, requester_role, required_approvals, status, due_at, created_at, updated_at, version)
        values (${i.approvalId}::uuid, 'FRAUD_ACTION', ${i.caseId}, ${i.action}, 'FRAUD_ACTION', ${i.reason}, ${i.requestedBy}::uuid, ${i.requesterRole ?? ''}, 2, 'PENDING_APPROVAL', ${new Date(i.dueAtMs)}, ${new Date(requestedAtMs)}, ${new Date(requestedAtMs)}, 1)
      `);
      await tx.execute(sql`
        update fraud_case set status = ${o.caseStatus ?? 'DECISION_PENDING'}, approval_id = ${i.approvalId}::uuid, version = version + 1
        where id = ${i.caseId}::uuid
      `);
      for (const e of o.events) {
        await tx.execute(sql`
          insert into fraud_case_event (case_id, seq, kind, actor_id, note, detail, occurred_at)
          values (${i.caseId}::uuid, ${e.seq}, ${e.kind}, ${e.actorId === null ? null : sql`${e.actorId}::uuid`}, ${e.note}, ${JSON.stringify({
            ...(e.detail ?? {}),
            approvalId: i.approvalId,
            eventId: i.eventId,
            action: i.action,
            accountIds: [...i.accountIds],
            targets: i.targets,
            restrictionEndsAtMs: i.restrictionEndsAtMs,
          })}::jsonb, ${new Date(e.occurredAtMs)})
        `);
      }
      if (o.audit) await appendAuditIn(tx, o.audit);
    };
    if (!o.idem) {
      await this.database.transaction(write);
      return;
    }
    const resultRef = JSON.stringify(o.result ?? { approvalId: i.approvalId });
    await this.database.transaction((tx) =>
      this.#idem.run<void>(tx, o.idem!, {
        execute: async () => {
          await write(tx);
          return { resultRef, value: undefined };
        },
        replay: async () => undefined,
      }),
    );
  }

  async get(approvalId: string): Promise<FraudApprovalRecord | null> {
    const rows = await this.database.pool.query('select * from approval_request where id = $1 and kind = $2', [approvalId, 'FRAUD_ACTION']);
    const r = rows.rows[0];
    if (!r) return null;
    const scopeRows = await this.database.pool.query(
      "select detail from fraud_case_event where case_id = $1 and kind = 'ACTION_REQUESTED' and detail->>'approvalId' = $2 order by seq desc limit 1",
      [r.target_ref, approvalId],
    );
    const detail = scopeRows.rows[0]?.detail ?? {};
    const votes = await this.database.pool.query('select approver_id, approved_at from approval_vote where request_id = $1 order by approved_at', [approvalId]);
    return recordOf(
      r,
      {
        eventId: detail.eventId ?? '',
        accountIds: Array.isArray(detail.accountIds) ? detail.accountIds : [],
        targets: Array.isArray(detail.targets) ? detail.targets : [],
        restrictionEndsAtMs: detail.restrictionEndsAtMs ?? null,
      },
      votes.rows.map((v: any) => v.approver_id),
      votes.rows[0]?.approved_at ? ms(votes.rows[0].approved_at) : null,
    );
  }

  async list(q: { status?: readonly string[]; requesterId?: string; awaitingApprover?: string; limit: number }): Promise<FraudApprovalRecord[]> {
    const rows = await this.database.pool.query(
      `select * from approval_request
       where kind = 'FRAUD_ACTION'
         and ($1::text[] is null or status = any($1))
         and ($2::text is null or requested_by = $2::uuid)
         and ($3::text is null or not exists (select 1 from approval_vote v where v.request_id = approval_request.id and v.approver_id = $3::uuid))
       order by created_at desc limit $4`,
      [q.status ?? null, q.requesterId ?? null, q.awaitingApprover ?? null, q.limit],
    );
    const out: FraudApprovalRecord[] = [];
    for (const r of rows.rows) {
      const found = await this.get(r.id);
      if (found) out.push(found);
    }
    return out;
  }

  async setStatus(i: { approvalId: string; status: FraudApprovalRecord['status']; approverId?: string | null; reason?: string | null; closeReason?: string | null; nowMs: number }): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.execute(sql`
        update approval_request set status = ${i.status}, close_reason = coalesce(${i.closeReason ?? null}, close_reason),
          approver_id = coalesce(${i.approverId ?? null}::uuid, approver_id), updated_at = ${new Date(i.nowMs)}, version = version + 1
        where id = ${i.approvalId}::uuid
      `);
      if (i.approverId && i.reason) {
        await tx.execute(sql`
          insert into approval_vote (request_id, approver_id, requester_id, approved_at, reason)
          select ${i.approvalId}::uuid, ${i.approverId}::uuid, requested_by, ${new Date(i.nowMs)}, ${i.reason} from approval_request where id = ${i.approvalId}::uuid
          on conflict do nothing
        `);
      }
    });
  }

  async recordSummaryView(i: { approvalId: string; adminAccountId: string; nowMs: number }): Promise<number> {
    await this.database.pool.query('insert into approval_summary_view (approval_id, admin_account_id, first_viewed_at) values ($1, $2, $3) on conflict do nothing', [i.approvalId, i.adminAccountId, new Date(i.nowMs)]);
    const row = await this.database.pool.query('select first_viewed_at from approval_summary_view where approval_id = $1 and admin_account_id = $2', [i.approvalId, i.adminAccountId]);
    return ms(row.rows[0]?.first_viewed_at) ?? i.nowMs;
  }

  async summaryViewedAt(i: { approvalId: string; adminAccountId: string }): Promise<number | null> {
    const row = await this.database.pool.query('select first_viewed_at from approval_summary_view where approval_id = $1 and admin_account_id = $2', [i.approvalId, i.adminAccountId]);
    return ms(row.rows[0]?.first_viewed_at ?? null);
  }
}
