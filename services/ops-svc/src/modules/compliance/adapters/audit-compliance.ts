// 통보 감사 기록(F-07-11). 기존 ops 감사 체인에 통보 등록·열람·차단·철회를 남긴다.
import type { AuditChain } from '../../audit/index.js';
import type { ComplianceAudit, ComplianceAuditInput } from '../domain/ports.js';

export class AuditCompliance implements ComplianceAudit {
  constructor(private readonly chain: AuditChain) {}

  async record(input: ComplianceAuditInput): Promise<void> {
    await this.chain.append({
      recordType: input.action,
      recordId: input.noticeId,
      payload: { noticeId: input.noticeId, actorId: input.actorId, role: input.role },
      nowMs: input.atMs,
    });
  }
}
