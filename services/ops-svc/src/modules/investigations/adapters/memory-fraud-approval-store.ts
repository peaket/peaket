// F-04-13 FRAUD_ACTION 승인 저장소 메모리 판(시험·로컬).
import type { FraudApprovalRecord, FraudApprovalStore } from '../domain/ports.js';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryFraudApprovalStore implements FraudApprovalStore {
  readonly updatesCase = false;
  readonly records = new Map<string, FraudApprovalRecord>();
  readonly views = new Map<string, number>();
  readonly #key = (approvalId: string, adminAccountId: string) => `${approvalId}:${adminAccountId}`;

  async request(i: FraudApprovalRecord): Promise<void> {
    if (this.records.has(i.approvalId)) throw new Error('approval_request 중복');
    this.records.set(i.approvalId, clone(i));
  }
  async get(approvalId: string): Promise<FraudApprovalRecord | null> {
    return this.records.get(approvalId) ?? null;
  }
  async list(q: { status?: readonly string[]; requesterId?: string; awaitingApprover?: string; limit: number }): Promise<FraudApprovalRecord[]> {
    return [...this.records.values()]
      .filter((r) => (q.status === undefined || q.status.includes(r.status)) && (q.requesterId === undefined || r.requestedBy === q.requesterId))
      .sort((a, b) => (b.requestedAtMs ?? b.nowMs ?? 0) - (a.requestedAtMs ?? a.nowMs ?? 0))
      .slice(0, q.limit);
  }
  async setStatus(i: { approvalId: string; status: FraudApprovalRecord['status']; approverId?: string | null; reason?: string | null; closeReason?: string | null; nowMs: number }): Promise<void> {
    const r = this.records.get(i.approvalId);
    if (!r) throw new Error('approval_request 없음');
    r.status = i.status;
    if (i.approverId !== undefined) r.approverId = i.approverId;
    if (i.approverId) r.approvals = [...new Set([...r.approvals, i.approverId])];
    if (i.approverId && i.reason) r.approvedAtMs = i.nowMs;
    if (i.closeReason !== undefined) r.closeReason = i.closeReason;
  }
  async recordSummaryView(i: { approvalId: string; adminAccountId: string; nowMs: number }): Promise<number> {
    const k = this.#key(i.approvalId, i.adminAccountId);
    const found = this.views.get(k);
    if (found !== undefined) return found;
    this.views.set(k, i.nowMs);
    return i.nowMs;
  }
  async summaryViewedAt(i: { approvalId: string; adminAccountId: string }): Promise<number | null> {
    return this.views.get(this.#key(i.approvalId, i.adminAccountId)) ?? null;
  }
}
