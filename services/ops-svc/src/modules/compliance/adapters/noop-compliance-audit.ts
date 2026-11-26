// 감사 대역이 없을 때(단위 조립). 운영 조립은 AuditCompliance를 넘긴다.
import type { ComplianceAudit } from '../domain/ports.js';

export class NoopComplianceAudit implements ComplianceAudit {
  async record(): Promise<void> {
    // 감사 체인을 넘기지 않은 조립(시험)에서는 아무것도 하지 않는다
  }
}
