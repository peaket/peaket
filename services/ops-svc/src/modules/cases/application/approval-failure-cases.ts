// 실패한 승인 업무의 CS 건(F-06-2 GAT-280, ADR-0364 결정 6, R-T20 ③, d5 §7.6 '승인 업무 실행 실패' 행).
// 승인 업무 실행이 실패해 FAILED가 되면 APPROVAL_EXECUTION_FAILED 건(대상 승인 ID, category 승인 종류)을 연다. 기한은 원래 승인 업무의 기한을 이어받고,
// 기한이 없는 승인이면 기한이 없다. 다시 실행은 승인자가 같은 승인 ID로 approve를 다시 부르는 것이고(재인증, ADR-0073), 성공하면 그 건을 시스템이 해결로 닫는다.
// 같은 승인이 여러 번 실패해도 열린 건은 하나다(같은 (종류, 대상)). 실패 시도마다 eventKey가 다르므로 해결된 뒤 다시 실패하면 새 건이 열린다.
import type { ApprovalFailureCases } from '../domain/cs-case.js';
import type { CsCases } from './cs-cases.js';
import type { ReceiveCaseRequested } from './receive-case-requested.js';
import type { CsCaseStore } from '../domain/cs-case.js';

const RESOLVE_NOTE = '승인 업무를 같은 승인 ID로 다시 실행해 성공했습니다(시스템이 닫음)';

export class CsApprovalFailureCases implements ApprovalFailureCases {
  constructor(
    private readonly receive: ReceiveCaseRequested,
    private readonly store: CsCaseStore,
    private readonly cases: CsCases,
  ) {}

  async failed(a: { approvalId: string; kind: string; dueAtMs: number | null }, nowMs: number): Promise<void> {
    await this.receive.handle(
      {
        // 실패한 시도마다 다른 키(같은 시도를 다시 알려도 한 번)
        eventKey: `approval-execution-failed:${a.approvalId}:${nowMs}`,
        kind: 'APPROVAL_EXECUTION_FAILED',
        sourceId: a.approvalId,
        category: a.kind,
        createdAt: new Date(nowMs).toISOString(),
      },
      nowMs,
      { inheritedDueMs: a.dueAtMs },
    );
  }

  async succeeded(approvalId: string, nowMs: number): Promise<void> {
    const open = await this.store.findOpen('APPROVAL_EXECUTION_FAILED', approvalId);
    if (open) await this.cases.resolveAsSystem(open.caseId, RESOLVE_NOTE, nowMs);
  }
}
