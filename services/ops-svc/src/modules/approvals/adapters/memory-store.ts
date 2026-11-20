// 승인 업무 메모리 저장소(단위·HTTP 시험, 로컬). Drizzle 저장소와 같은 규칙을 지킨다.
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import { openContractApproval, type ContractApprovalRecord } from '../domain/approval.js';
import type { ApprovalVote, ContractApprovalStore } from '../domain/ports.js';

export class MemoryContractApprovalStore implements ContractApprovalStore {
  readonly rows = new Map<string, ContractApprovalRecord>();
  readonly votes: ApprovalVote[] = [];

  constructor(private readonly audit?: AuditChain) {}

  async insert(r: ContractApprovalRecord, audit?: AuditRecord) {
    const existing = this.rows.get(r.approvalId);
    if (existing) return { record: { ...existing }, created: false };
    const open = [...this.rows.values()].find((x) => x.promoterId === r.promoterId && openContractApproval(x));
    if (open) return 'conflict' as const;
    // 감사를 먼저 쓴다(실패하면 행도 남지 않는다. DB 트랜잭션과 같은 답)
    if (audit) await this.audit?.append(audit);
    this.rows.set(r.approvalId, { ...r, current: { ...r.current } });
    return { record: { ...r }, created: true };
  }

  async find(approvalId: string) {
    return this.rows.get(approvalId);
  }

  async findOpenByPromoter(promoterId: string) {
    return [...this.rows.values()].find((r) => r.promoterId === promoterId && openContractApproval(r));
  }

  async save(r: ContractApprovalRecord, audit?: AuditRecord, vote?: ApprovalVote): Promise<boolean> {
    const current = this.rows.get(r.approvalId);
    if (!current || current.version !== r.version - 1) return false;
    // 감사를 먼저 쓴다(실패하면 상태·투표도 남지 않는다. DB 트랜잭션과 같은 답)
    if (audit) await this.audit?.append(audit);
    this.rows.set(r.approvalId, { ...r, current: { ...r.current } });
    if (vote) this.votes.push({ ...vote });
    return true;
  }

  async list(filter: { status?: readonly string[] | undefined; requesterId?: string | undefined; awaitingApprover?: string | undefined; limit: number }) {
    return [...this.rows.values()]
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .filter((r) => !filter.requesterId || r.requestedBy === filter.requesterId)
      .filter((r) => !filter.awaitingApprover || ((r.status === 'PENDING_APPROVAL' || r.status === 'FAILED') && r.requestedBy !== filter.awaitingApprover))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit);
  }
}
