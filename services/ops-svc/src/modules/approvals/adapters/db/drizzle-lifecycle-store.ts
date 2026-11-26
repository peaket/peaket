// 승인 업무 수명주기 Drizzle 저장소(F-06-3, ops 0038). approval_request·approval_vote를 쓴다.
// 결제자 계정(target_account_id)은 저장만 하고 응답·감사·로그에 싣지 않는다.
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { AuditChain, AuditRecord } from '../../../audit/index.js';
import type { Database } from '@peaket/platform';
import { LIFECYCLE_KINDS, type ApprovalLifecycleRecord, type LifecycleKind, type LifecycleVote } from '../../domain/approval-lifecycle.js';
import type { ApprovalLifecycleStore } from '../../domain/lifecycle-ports.js';
import { approvalRequest, approvalVote } from './schema.js';

const recordOf = (r: typeof approvalRequest.$inferSelect, votes: readonly (typeof approvalVote.$inferSelect)[]): ApprovalLifecycleRecord => ({
  approvalId: r.id,
  kind: r.kind as LifecycleKind,
  targetRef: r.targetRef,
  relatedOrderIds: r.relatedOrderIds ?? [],
  amount: Number(r.amount ?? 0),
  reasonCode: r.reasonCode ?? '',
  reasonText: r.reasonText,
  evidenceChecked: r.evidenceChecked,
  targetAccountId: r.targetAccountId,
  requesterId: r.requestedBy,
  requesterRole: r.requesterRole,
  approverRoles: [],
  approvals: votes.map((v) => ({ approverId: v.approverId, role: '', votedAt: v.approvedAt, reason: v.reason })),
  requiredApprovals: r.requiredApprovals,
  status: r.status as ApprovalLifecycleRecord['status'],
  closeReason: r.closeReason,
  dueAt: r.dueAt ?? r.createdAt,
  appealNotBefore: r.appealNotBefore,
  entryStartsAt: r.entryStartsAt,
  escalatedAt: r.escalatedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  version: r.version,
});

export class DrizzleApprovalLifecycleStore implements ApprovalLifecycleStore {
  constructor(
    private readonly database: Database,
    private readonly audit?: AuditChain,
  ) {}

  async insert(record: ApprovalLifecycleRecord, audit?: AuditRecord): Promise<void> {
    await this.database.db.insert(approvalRequest).values({
      id: record.approvalId,
      kind: record.kind,
      targetRef: record.targetRef,
      targetAccountId: record.targetAccountId,
      relatedOrderIds: record.relatedOrderIds,
      amount: record.amount,
      reasonCode: record.reasonCode,
      reasonText: record.reasonText,
      evidenceChecked: record.evidenceChecked,
      requestedBy: record.requesterId,
      requesterRole: record.requesterRole,
      requiredApprovals: record.requiredApprovals,
      status: record.status,
      closeReason: record.closeReason,
      dueAt: record.dueAt,
      appealNotBefore: record.appealNotBefore,
      entryStartsAt: record.entryStartsAt,
      escalatedAt: record.escalatedAt,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      version: record.version,
    });
    if (audit) await this.audit?.append(audit);
  }

  async find(approvalId: string): Promise<ApprovalLifecycleRecord | undefined> {
    const rows = await this.database.db.select().from(approvalRequest).where(and(eq(approvalRequest.id, approvalId), inArray(approvalRequest.kind, [...LIFECYCLE_KINDS]))).limit(1);
    if (!rows[0]) return undefined;
    const votes = await this.database.db.select().from(approvalVote).where(eq(approvalVote.requestId, approvalId));
    return recordOf(rows[0], votes);
  }

  async save(record: ApprovalLifecycleRecord, audit?: AuditRecord): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      const updated = await tx
        .update(approvalRequest)
        .set({
          status: record.status,
          closeReason: record.closeReason,
          dueAt: record.dueAt,
          escalatedAt: record.escalatedAt,
          updatedAt: record.updatedAt,
          version: record.version,
        })
        .where(and(eq(approvalRequest.id, record.approvalId), inArray(approvalRequest.version, [record.version, record.version - 1])))
        .returning({ id: approvalRequest.id });
      if (updated.length === 0) return false;
      for (const vote of record.approvals) {
        await tx.insert(approvalVote).values({ requestId: record.approvalId, approverId: vote.approverId, requesterId: record.requesterId, approvedAt: vote.votedAt, reason: vote.reason }).onConflictDoNothing();
      }
      if (audit) await this.audit?.append(audit);
      return true;
    });
  }

  async list(filter: { status?: readonly string[] | undefined; kind?: LifecycleKind | undefined; targetAccountId?: string | undefined; limit: number }): Promise<ApprovalLifecycleRecord[]> {
    const conditions = [inArray(approvalRequest.kind, [...LIFECYCLE_KINDS])];
    if (filter.status && filter.status.length > 0) conditions.push(inArray(approvalRequest.status, [...filter.status]));
    if (filter.kind) conditions.push(eq(approvalRequest.kind, filter.kind));
    if (filter.targetAccountId) conditions.push(eq(approvalRequest.targetAccountId, filter.targetAccountId));
    const rows = await this.database.db
      .select()
      .from(approvalRequest)
      .where(and(...conditions))
      .orderBy(desc(approvalRequest.createdAt))
      .limit(filter.limit);
    return rows.map((r) => recordOf(r, []));
  }
}

export type { LifecycleVote };
