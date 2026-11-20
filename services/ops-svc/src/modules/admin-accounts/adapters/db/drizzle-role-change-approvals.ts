// 승인 업무(COMMANDER_ROLE_CHANGE) 저장소: 메모리(시험·local)와 PostgreSQL(운영).
import { DATABASE, type Database } from '@peaket/platform';
import { Inject, Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { RoleChangeApprovalRecord, RoleChangeApprovalStore } from '../../domain/ports.js';

export class MemoryRoleChangeApprovalStore implements RoleChangeApprovalStore {
  readonly rows = new Map<string, RoleChangeApprovalRecord>();
  async insert(r: RoleChangeApprovalRecord): Promise<void> {
    this.rows.set(r.approvalId, { ...r });
  }
  async find(approvalId: string): Promise<RoleChangeApprovalRecord | null> {
    const r = this.rows.get(approvalId);
    return r ? { ...r } : null;
  }
  async save(r: RoleChangeApprovalRecord, expectedVersion: number): Promise<boolean> {
    const cur = this.rows.get(r.approvalId);
    if (!cur || cur.updatedAtMs !== expectedVersion) return false;
    this.rows.set(r.approvalId, { ...r });
    return true;
  }
  async list(filter: { status?: readonly string[]; limit: number }): Promise<RoleChangeApprovalRecord[]> {
    return [...this.rows.values()]
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
      .slice(0, filter.limit)
      .map((r) => ({ ...r }));
  }
}

interface Row {
  id: string;
  target_ref: string;
  requested_role: string;
  from_role: string;
  reason_text: string;
  requested_by: string;
  status: string;
  close_reason: string | null;
  due_at: Date | string;
  target_version: number | string;
  created_at: Date | string;
  updated_at: Date | string;
  approver_id: string | null;
}

const toRecord = (r: Row): RoleChangeApprovalRecord => ({
  approvalId: r.id,
  kind: 'COMMANDER_ROLE_CHANGE',
  targetRef: r.target_ref,
  requestedRole: r.requested_role as RoleChangeApprovalRecord['requestedRole'],
  fromRole: r.from_role as RoleChangeApprovalRecord['fromRole'],
  targetVersion: Number(r.target_version),
  reason: r.reason_text,
  requestedBy: r.requested_by,
  status: r.status as RoleChangeApprovalRecord['status'],
  requiredApprovals: 2,
  approverId: r.approver_id,
  closeReason: r.close_reason,
  createdAtMs: new Date(r.created_at).getTime(),
  updatedAtMs: new Date(r.updated_at).getTime(),
  dueAtMs: new Date(r.due_at).getTime(),
});

const SELECT = sql`select r.id, r.target_ref, r.requested_role, r.from_role, r.reason_text, r.requested_by, r.status, r.close_reason, r.due_at, r.target_version, r.created_at, r.updated_at,
  (select v.approver_id from approval_vote v where v.request_id = r.id order by v.approved_at desc limit 1) as approver_id
  from approval_request r`;

@Injectable()
export class DrizzleRoleChangeApprovalStore implements RoleChangeApprovalStore {
  constructor(@Inject(DATABASE) private readonly database: Database) {}

  async insert(r: RoleChangeApprovalRecord): Promise<void> {
    await this.database.db.execute(sql`
      insert into approval_request (id, kind, target_ref, requested_role, from_role, amount, reason_text, requested_by, required_approvals, status, close_reason, due_at, target_version, created_at, updated_at)
      values (${r.approvalId}::uuid, ${r.kind}, ${r.targetRef}, ${r.requestedRole}, ${r.fromRole}, 0, ${r.reason}, ${r.requestedBy}, ${r.requiredApprovals}, ${r.status}, ${r.closeReason}, ${new Date(r.dueAtMs)}, ${r.targetVersion}, ${new Date(r.createdAtMs)}, ${new Date(r.updatedAtMs)})`);
  }

  async find(approvalId: string): Promise<RoleChangeApprovalRecord | null> {
    const rows = (
      await this.database.db.execute(sql`${SELECT} where r.id = ${approvalId}::uuid and r.kind = 'COMMANDER_ROLE_CHANGE'`)
    ).rows as unknown as Row[];
    const row = rows[0];
    return row ? toRecord(row) : null;
  }

  async save(r: RoleChangeApprovalRecord, expectedVersion: number): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const done = await tx.execute(sql`
        update approval_request set status = ${r.status}, close_reason = ${r.closeReason}, updated_at = ${new Date(r.updatedAtMs)}
        where id = ${r.approvalId}::uuid and updated_at = ${new Date(expectedVersion)}`);
      if ((done.rowCount ?? 0) === 0) return false;
      if (r.approverId) {
        await tx.execute(sql`
          insert into approval_vote (request_id, approver_id, requester_id, approved_at, reason)
          values (${r.approvalId}::uuid, ${r.approverId}, ${r.requestedBy}, ${new Date(r.updatedAtMs)}, ${r.closeReason})
          on conflict (request_id, approver_id) do nothing`);
      }
      return true;
    });
  }

  async list(filter: { status?: readonly string[]; limit: number }): Promise<RoleChangeApprovalRecord[]> {
    const statuses = filter.status && filter.status.length > 0 ? sql`and r.status in (${sql.join(filter.status.map((s) => sql`${s}`), sql`, `)})` : sql``;
    const rows = (
      await this.database.db.execute(sql`${SELECT} where r.kind = 'COMMANDER_ROLE_CHANGE' ${statuses} order by r.created_at desc limit ${filter.limit}`)
    ).rows as unknown as Row[];
    return rows.map(toRecord);
  }
}
