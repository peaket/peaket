// 지급 승인 업무 Drizzle 저장소(ops DB).
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { Database } from '@peaket/platform';
import type { PayoutApprovalStore } from '../../domain/ports.js';
import type { PayoutApprovalRecord } from '../../domain/payout-approval.js';
import { payoutApproval } from './schema.js';

const record = (r: typeof payoutApproval.$inferSelect): PayoutApprovalRecord => ({
  approvalId: r.id,
  batchId: r.batchId,
  pg: r.pg as PayoutApprovalRecord['pg'],
  pgStore: r.pgStore as PayoutApprovalRecord['pgStore'],
  payoutDate: r.payoutDate,
  amount: r.amount,
  statementCount: r.statementCount,
  status: r.status as PayoutApprovalRecord['status'],
  requesterId: r.requesterId,
  requesterRole: r.requesterRole,
  approverId: r.approverId,
  reasonText: r.reasonText,
  failure: r.failure,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  approvedAt: r.approvedAt,
  executedAt: r.executedAt,
  version: r.version,
});

export class DrizzlePayoutApprovalStore implements PayoutApprovalStore {
  constructor(private readonly db: Database) {}

  async insert(r: PayoutApprovalRecord) {
    await this.db.db.insert(payoutApproval).values({
      id: r.approvalId,
      batchId: r.batchId,
      pg: r.pg,
      pgStore: r.pgStore,
      payoutDate: r.payoutDate,
      amount: r.amount,
      statementCount: r.statementCount,
      status: r.status,
      requesterId: r.requesterId,
      requesterRole: r.requesterRole,
      approverId: r.approverId,
      reasonText: r.reasonText,
      failure: r.failure,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      approvedAt: r.approvedAt,
      executedAt: r.executedAt,
      version: r.version,
    });
  }

  async find(approvalId: string) {
    const rows = await this.db.db.select().from(payoutApproval).where(eq(payoutApproval.id, approvalId)).limit(1);
    return rows[0] ? record(rows[0]) : undefined;
  }

  async findActiveByBatch(batchId: string) {
    const rows = await this.db.db
      .select()
      .from(payoutApproval)
      .where(and(eq(payoutApproval.batchId, batchId), inArray(payoutApproval.status, ['PENDING_APPROVAL', 'APPROVED', 'EXECUTING'])))
      .limit(1);
    return rows[0] ? record(rows[0]) : undefined;
  }

  async save(r: PayoutApprovalRecord) {
    const changed = await this.db.db
      .update(payoutApproval)
      .set({
        status: r.status,
        approverId: r.approverId,
        failure: r.failure,
        updatedAt: r.updatedAt,
        approvedAt: r.approvedAt,
        executedAt: r.executedAt,
        version: r.version,
      })
      .where(and(eq(payoutApproval.id, r.approvalId), eq(payoutApproval.version, r.version - 1)))
      .returning({ id: payoutApproval.id });
    return changed.length === 1;
  }

  async list(filter: { status?: readonly string[] | undefined; requesterId?: string | undefined; awaitingApprover?: string | undefined; limit: number }) {
    const conditions = [];
    if (filter.status && filter.status.length > 0) conditions.push(inArray(payoutApproval.status, [...filter.status]));
    if (filter.requesterId) conditions.push(eq(payoutApproval.requesterId, filter.requesterId));
    const rows = await this.db.db
      .select()
      .from(payoutApproval)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(payoutApproval.createdAt))
      .limit(filter.limit);
    return rows
      .map(record)
      .filter((r) => !filter.awaitingApprover || ((r.status === 'PENDING_APPROVAL' || r.status === 'FAILED') && r.requesterId !== filter.awaitingApprover));
  }
}
