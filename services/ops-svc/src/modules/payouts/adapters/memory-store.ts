// 지�??�인 ?�무 메모�??�?�소(?�위 ?�험·개발).
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import type { PayoutApprovalStore } from '../domain/ports.js';
import { PayoutApprovalProblem, type PayoutApprovalRecord } from '../domain/payout-approval.js';

export class MemoryPayoutApprovalStore implements PayoutApprovalStore {
  readonly rows = new Map<string, PayoutApprovalRecord>();

  constructor(private readonly audit?: AuditChain) {}

  async insert(record: PayoutApprovalRecord, audit?: AuditRecord) {
    this.rows.set(record.approvalId, { ...record });
    if (audit) await this.audit?.append(audit);
  }
  async find(approvalId: string) {
    return this.rows.get(approvalId);
  }
  async findActiveByBatch(batchId: string) {
    return [...this.rows.values()].find((r) => r.batchId === batchId && (r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED' || r.status === 'EXECUTING'));
  }
  async save(record: PayoutApprovalRecord, audit?: AuditRecord): Promise<boolean> {
    const current = this.rows.get(record.approvalId);
    if (!current || current.version !== record.version - 1) return false;
    this.rows.set(record.approvalId, { ...record });
    if (audit) await this.audit?.append(audit);
    return true;
  }
  async list(filter: { status?: readonly string[] | undefined; requesterId?: string | undefined; awaitingApprover?: string | undefined; limit: number }) {
    return [...this.rows.values()]
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .filter((r) => !filter.requesterId || r.requesterId === filter.requesterId)
      .filter((r) => !filter.awaitingApprover || ((r.status === 'PENDING_APPROVAL' || r.status === 'FAILED') && r.requesterId !== filter.awaitingApprover))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit);
  }
}
