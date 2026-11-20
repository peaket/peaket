// COMMANDER_ROLE_CHANGE 승인 업무의 값·표시(POL-038 ⑨, ADR-0322). due_at은 요청 뒤 5영업일 [가정]이다.
import type { AdminRole } from './admin-account.js';
import type { RoleChangeApprovalRecord } from './ports.js';

export const APPROVAL_DUE_BUSINESS_DAYS = 5;

/** 요청 시각(ms) 뒤 영업일 n일(토·일을 건너뛴다). 같은 시각의 그날이다 */
export function addBusinessDays(ms: number, days: number): number {
  const d = new Date(ms);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d.getTime();
}

export interface RoleChangeApprovalView {
  approvalId: string;
  kind: 'COMMANDER_ROLE_CHANGE';
  targetRef: string;
  requestedRole: AdminRole;
  amount: 0;
  reasonCode: 'COMMANDER_ROLE_CHANGE';
  reasonText: string;
  status: RoleChangeApprovalRecord['status'];
  requiredApprovals: 2;
  approvals: string[];
  requestedBy: { adminAccountId: string; displayName: null; role: AdminRole };
  requestedAt: string;
  canApprove: boolean;
  dueAt: string;
  closeReason: string | null;
}

export const roleChangeApprovalView = (r: RoleChangeApprovalRecord, actor: { accountId: string; role: string }): RoleChangeApprovalView => ({
  approvalId: r.approvalId,
  kind: 'COMMANDER_ROLE_CHANGE',
  targetRef: r.targetRef,
  requestedRole: r.requestedRole,
  amount: 0,
  reasonCode: 'COMMANDER_ROLE_CHANGE',
  reasonText: r.reason,
  status: r.status,
  requiredApprovals: 2,
  approvals: r.approverId ? [r.approverId] : [],
  requestedBy: { adminAccountId: r.requestedBy, displayName: null, role: 'commander' },
  requestedAt: new Date(r.createdAtMs).toISOString(),
  canApprove: (r.status === 'PENDING_APPROVAL' || r.status === 'FAILED') && r.requestedBy !== actor.accountId && actor.role === 'commander',
  dueAt: new Date(r.dueAtMs).toISOString(),
  closeReason: r.closeReason,
});
