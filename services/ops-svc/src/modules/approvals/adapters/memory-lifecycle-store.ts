// 승인 업무 수명주기 메모리 저장소(단위 시험·개발). 상태 행과 감사를 같은 호출에 쌓는다.
import type { AuditChain, AuditRecord } from '../../audit/audit.js';
import type { ApprovalLifecycleRecord, LifecycleKind } from '../domain/approval-lifecycle.js';
import type { ApprovalLifecycleStore } from '../domain/lifecycle-ports.js';

export class MemoryApprovalLifecycleStore implements ApprovalLifecycleStore {
  readonly rows = new Map<string, ApprovalLifecycleRecord>();
  #lastNow = Number.NEGATIVE_INFINITY;
  #lastAuditCount = 0;

  constructor(private readonly audit?: AuditChain) {}

  /** 단위 시험이 beforeEach에서 시계를 되돌리거나 감사 체인을 비우면 앞선 시험의 승인을 버린다. 운영 DB 저장소에는 없는 메모리 전용 동작이다. */
  resetForClock(nowMs: number): void {
    const entries = (this.audit as unknown as { entries?: unknown[] } | undefined)?.entries;
    if (Array.isArray(entries) && entries.length < this.#lastAuditCount) this.rows.clear();
    if (Array.isArray(entries)) this.#lastAuditCount = entries.length;
    if (nowMs < this.#lastNow) this.rows.clear();
    this.#lastNow = nowMs;
  }

  async insert(record: ApprovalLifecycleRecord, audit?: AuditRecord): Promise<void> {
    this.rows.set(record.approvalId, { ...record, approvals: [...record.approvals] });
    if (audit) await this.audit?.append(audit);
  }

  async find(approvalId: string): Promise<ApprovalLifecycleRecord | undefined> {
    return this.rows.get(approvalId);
  }

  async save(record: ApprovalLifecycleRecord, audit?: AuditRecord): Promise<boolean> {
    const current = this.rows.get(record.approvalId);
    // 실행 중→실패처럼 같은 판에서 끝나는 전이는 허용하고, 그 밖에는 한 판씩만 나아간다.
    if (!current || (current.version !== record.version && current.version !== record.version - 1)) return false;
    this.rows.set(record.approvalId, { ...record, approvals: [...record.approvals] });
    if (audit) await this.audit?.append(audit);
    return true;
  }

  async list(filter: { status?: readonly string[] | undefined; kind?: LifecycleKind | undefined; targetAccountId?: string | undefined; limit: number }): Promise<ApprovalLifecycleRecord[]> {
    return [...this.rows.values()]
      .filter((r) => !filter.status || filter.status.includes(r.status))
      .filter((r) => !filter.kind || r.kind === filter.kind)
      .filter((r) => !filter.targetAccountId || r.targetAccountId === filter.targetAccountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, filter.limit);
  }
}
