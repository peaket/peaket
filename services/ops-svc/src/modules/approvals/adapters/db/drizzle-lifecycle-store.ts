// 승인 업무 수명주기 Drizzle 저장소(F-06-3, ops 0038·0039). approval_request·approval_vote를 쓴다.
// 상태·감사·투표는 같은 트랜잭션에 쓰고, 판은 직전 판 조건으로만 올린다(동시 승인 CAS).
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import { appendAuditIn, type AuditRecord } from '../../../audit/audit.js';
import { LIFECYCLE_KINDS, approverRolesOf, type ApprovalLifecycleRecord, type LifecycleKind } from '../../domain/approval-lifecycle.js';
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
  expectedHolderAccountId: r.expectedHolderAccountId,
  approverId: r.approverId,
  requesterId: r.requestedBy,
  requesterRole: r.requesterRole,
  approverRoles: approverRolesOf(r.kind as LifecycleKind, r.requiredApprovals),
  approvals: votes.map((v) => ({ approverId: v.approverId, role: '', votedAt: v.approvedAt, reason: v.reason })),
  requiredApprovals: r.requiredApprovals,
  status: r.status as ApprovalLifecycleRecord['status'],
  closeReason: r.closeReason,
  dueAt: r.dueAt ?? r.createdAt,
  appealNotBefore: r.appealNotBefore,
  entryStartsAt: r.entryStartsAt,
  restrictionEndsAt: r.restrictionEndsAt,
  escalatedAt: r.escalatedAt,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  version: r.version,
});

const kindOf = (r: typeof approvalRequest.$inferSelect): LifecycleKind => r.kind as LifecycleKind;

export class DrizzleApprovalLifecycleStore implements ApprovalLifecycleStore {
  constructor(private readonly database: Database) {}

  async insert(record: ApprovalLifecycleRecord, audit?: AuditRecord): Promise<void> {
    await this.database.transaction(async (tx) => {
      await tx.insert(approvalRequest).values({
        id: record.approvalId,
        kind: record.kind,
        targetRef: record.targetRef,
        targetAccountId: record.targetAccountId,
        expectedHolderAccountId: record.expectedHolderAccountId,
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
        restrictionEndsAt: record.restrictionEndsAt,
        escalatedAt: record.escalatedAt,
        approverId: record.approverId,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        version: record.version,
      });
      if (audit) await appendAuditIn(tx, audit);
    });
  }

  async withTickLease<T>(fn: () => Promise<T>): Promise<T | undefined> {
    return this.database.transaction(async (tx) => {
      const r = await tx.execute(sql`select pg_try_advisory_xact_lock(6283) as ok`);
      if ((r.rows[0] as { ok?: boolean } | undefined)?.ok !== true) return undefined;
      return fn();
    });
  }

  async find(approvalId: string): Promise<ApprovalLifecycleRecord | undefined> {
    const rows = await this.database.db.select().from(approvalRequest).where(eq(approvalRequest.id, approvalId)).limit(1);
    if (!rows[0] || !isLifecycleKind(rows[0].kind)) return undefined;
    const votes = await this.database.db.select().from(approvalVote).where(eq(approvalVote.requestId, approvalId));
    return recordOf(rows[0], votes);
  }

  async save(record: ApprovalLifecycleRecord, audit?: AuditRecord | readonly AuditRecord[]): Promise<boolean> {
    return this.database.transaction(async (tx) => {
      // 실행 중→실패만 같은 판을 쓰고, 그 밖의 전이는 직전 판(record.version−1)에서만 올라간다.
      const expected = record.status === 'FAILED' ? record.version : record.version - 1;
      const updated = await tx
        .update(approvalRequest)
        .set({
          status: record.status,
          closeReason: record.closeReason,
          dueAt: record.dueAt,
          escalatedAt: record.escalatedAt,
          approverId: record.approverId,
          updatedAt: record.updatedAt,
          version: record.version,
        })
        .where(and(eq(approvalRequest.id, record.approvalId), eq(approvalRequest.version, expected)))
        .returning({ id: approvalRequest.id });
      if (updated.length === 0) return false;
      for (const vote of record.approvals) {
        await tx.insert(approvalVote).values({ requestId: record.approvalId, approverId: vote.approverId, requesterId: record.requesterId, approvedAt: vote.votedAt, reason: vote.reason }).onConflictDoNothing();
      }
      if (audit) for (const a of Array.isArray(audit) ? audit : [audit]) await appendAuditIn(tx, a);
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
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(approvalRequest.createdAt))
      .limit(filter.limit);
    const lifecycle = rows.filter((r) => isLifecycleKind(r.kind));
    if (lifecycle.length === 0) return [];
    const votes = await this.database.db.select().from(approvalVote).where(inArray(approvalVote.requestId, lifecycle.map((r) => r.id)));
    const byId = new Map<string, (typeof approvalVote.$inferSelect)[]>();
    for (const vote of votes) byId.set(vote.requestId, [...(byId.get(vote.requestId) ?? []), vote]);
    return lifecycle.map((r) => recordOf(r, byId.get(r.id) ?? []));
  }
}

const LIFECYCLE_KIND_SET = new Set(['SYSTEM_FAULT_REFUND', 'DISCRETIONARY_WAIVER', 'TRANSFER_RECLAIM', 'MINOR_CONTRACT_CANCEL', 'BOOKING_RESTRICTION']);
const isLifecycleKind = (kind: string): kind is LifecycleKind => LIFECYCLE_KIND_SET.has(kind);
