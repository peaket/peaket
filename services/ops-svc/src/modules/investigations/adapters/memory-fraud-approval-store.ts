// F-04-13 FRAUD_ACTION 승인 저장소 메모리 판(시험·로컬).
// 사건 쓰기는 같은 메모리 저장소의 updateCase로 미뤄 실제 판 경합·상태 전이를 시험과 같게 본다.
import type { FraudApprovalRecord, FraudApprovalStore, InvestigationStore } from '../domain/ports.js';
import { FraudApprovalConflictError, FraudCaseConflictError } from '../domain/ports.js';

const clone = <T>(v: T): T => structuredClone(v);

export class MemoryFraudApprovalStore implements FraudApprovalStore {
  readonly records = new Map<string, FraudApprovalRecord>();
  readonly views = new Map<string, number>();
  readonly #key = (approvalId: string, adminAccountId: string) => `${approvalId}:${adminAccountId}`;

  constructor(private readonly caseWriter?: Pick<InvestigationStore, 'updateCase'>) {}

  async request(
    i: FraudApprovalRecord,
    o: {
      idem?: import('../domain/ports.js').IdempotentWrite;
      result?: unknown;
      audit?: import('../domain/ports.js').CaseAuditRecord;
      events: readonly import('../domain/investigation.js').FraudCaseEventRecord[];
      caseNext?: import('../domain/investigation.js').FraudCaseRecord;
      expectedVersion?: number;
    },
  ): Promise<{ replayed: boolean }> {
    if (this.records.has(i.approvalId)) throw new FraudApprovalConflictError('approval_request 중복');
    if (o.caseNext && this.caseWriter) {
      const out = await this.caseWriter.updateCase(o.caseNext, o.expectedVersion ?? o.caseNext.version - 1, o.events as any, {
        ...(o.idem ? { idem: o.idem } : {}),
        ...(o.result === undefined ? {} : { result: o.result }),
        ...(o.audit ? { audit: o.audit } : {}),
      });
      if (!out.ok) throw new FraudCaseConflictError('fraud case version conflict');
      this.records.set(i.approvalId, clone(i));
      return { replayed: out.replayed === true };
    }
    this.records.set(i.approvalId, clone(i));
    return { replayed: false };
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
  async setStatus(i: {
    approvalId: string;
    status: FraudApprovalRecord['status'];
    approverId?: string | null;
    reason?: string | null;
    closeReason?: string | null;
    nowMs: number;
    from?: readonly FraudApprovalRecord['status'][];
    case?: { next: import('../domain/investigation.js').FraudCaseRecord; expectedVersion: number; events: readonly any[]; audit?: import('../domain/ports.js').CaseAuditRecord };
  }): Promise<{ ok: boolean }> {
    const r = this.records.get(i.approvalId);
    if (!r || (i.from !== undefined && !i.from.includes(r.status))) return { ok: false };
    if (i.case) {
      if (!this.caseWriter) return { ok: false };
      const out = await this.caseWriter.updateCase(i.case.next, i.case.expectedVersion, i.case.events as any, i.case.audit ? { audit: i.case.audit } : {});
      if (!out.ok) return { ok: false };
    }
    r.status = i.status;
    if (i.approverId !== undefined) r.approverId = i.approverId;
    if (i.approverId) r.approvals = [...new Set([...r.approvals, i.approverId])];
    if (i.approverId && i.reason && i.status === 'DONE') r.approvedAtMs = i.nowMs;
    if (i.closeReason !== undefined) r.closeReason = i.closeReason;
    return { ok: true };
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
