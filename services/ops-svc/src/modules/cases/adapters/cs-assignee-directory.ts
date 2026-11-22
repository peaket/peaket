// 배정 대상 확인(ADR-0364 결정 5): cs_lead가 맡기는 계정이 활성(ACTIVE) cs_agent·cs_lead인지 identity 관리 계정 조회로 본다.
// 없는 계정·다른 역할·초대 중·삭제는 false(422 case-assignee-invalid), identity에 닿지 못하면 던진다(503).
import type { AdminIdentity } from '../../admin-accounts/index.js';
import type { CsAssigneeDirectory } from '../domain/cs-case.js';

const CS_ROLES: ReadonlySet<string> = new Set(['cs_agent', 'cs_lead']);

export class IdentityCsAssigneeDirectory implements CsAssigneeDirectory {
  constructor(private readonly identity: Pick<AdminIdentity, 'get'>) {}

  async isActiveCsAgent(adminAccountId: string): Promise<boolean> {
    const a = await this.identity.get(adminAccountId);
    return a !== null && a.status === 'ACTIVE' && CS_ROLES.has(a.role);
  }
}
