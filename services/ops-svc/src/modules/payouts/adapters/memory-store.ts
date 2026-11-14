// 지급 승인 업무 메모리 저장소(단위 시험·개발).
import type { PayoutApprovalStore } from '../domain/ports.js';
import type { PayoutApprovalRecord } from '../domain/payout-approval.js';

export class MemoryPayoutApprovalStore implements PayoutApprovalStore {
  readonly rows = new Map<string, PayoutApprovalRecord>();

  async insert(record: PayoutApprovalRecord) {
    this.rows.set(record.approvalId, { ...record });
  }
  async find(approvalId: string) {
    return this.rows.get(approvalId);
  }
  async findActiveByBatch(batchId: string) {
    return [...this.rows.values()].find((r) => r.batchId === batchId && (r.status === 'PENDING_APPROVAL' || r.status === 'APPROVED' || r.status === 'EXECUTING'));
  }
  async save(record: PayoutApprovalRecord) {
    this.rows.set(record.approvalId, { ...record });
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
