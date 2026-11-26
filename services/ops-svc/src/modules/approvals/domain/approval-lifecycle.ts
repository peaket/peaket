// 승인 업무 수명주기 도메인(F-06-3, transfer-refund §3.2·§7.2, POL-038).
// 요청자 역할·승인 역할·기한·1영업일 상위 알림·만료·대상 변경 판정을 종류별로 정한다.
// 값은 정본에서 가져오고, 시험은 이 파일을 직접 import하지 않고 HTTP 바깥 경계만 본다.
import type { OpsActor } from '../../payouts/index.js';

export class ApprovalLifecycleProblem extends Error {
  constructor(
    readonly type: string,
    readonly status: number,
    readonly title: string,
  ) {
    super(title);
    this.name = 'ApprovalLifecycleProblem';
  }
}

export const LIFECYCLE_KINDS = ['SYSTEM_FAULT_REFUND', 'DISCRETIONARY_WAIVER', 'TRANSFER_RECLAIM', 'MINOR_CONTRACT_CANCEL'] as const;
export type LifecycleKind = (typeof LIFECYCLE_KINDS)[number];

/** 일반 요청 경로가 받지 않는 종류(계약·역할·지급·조정·판매 중지·부정 예매·예매 제한) */
export const NOT_ALLOWED_KINDS = [
  'PAYOUT_BATCH',
  'SETTLEMENT_ADJUSTMENT',
  'COMMANDER_ROLE_CHANGE',
  'CONTRACT_TERMS_CHANGE',
  'SALE_SUSPENSION',
  'SALE_RESUMPTION',
  'FRAUD_ACTION',
  'BOOKING_RESTRICTION',
] as const;

export type LifecycleStatus = 'PENDING_APPROVAL' | 'ESCALATED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED' | 'EXECUTING' | 'DONE' | 'FAILED';

export interface LifecycleVote {
  approverId: string;
  role: string;
  votedAt: Date;
  reason: string | null;
}

export interface ApprovalLifecycleRecord {
  approvalId: string;
  kind: LifecycleKind;
  targetRef: string;
  relatedOrderIds: string[];
  amount: number;
  reasonCode: string;
  reasonText: string;
  evidenceChecked: string | null;
  /** 결제자 계정. 응답·감사·로그에는 싣지 않는다(TR-09). */
  targetAccountId: string | null;
  /** 양도 회수 승인 시점의 보유자(기대 값, IR-08) */
  expectedHolderAccountId: string | null;
  /** 반려한 승인자(IR-14) */
  approverId: string | null;
  requesterId: string;
  requesterRole: string;
  approverRoles: string[];
  approvals: LifecycleVote[];
  requiredApprovals: number;
  status: LifecycleStatus;
  closeReason: string | null;
  dueAt: Date;
  /** 양도 회수의 소명 기한(요청 + 1일). 이 전에는 승인할 수 없다. */
  appealNotBefore: Date | null;
  entryStartsAt: Date | null;
  escalatedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  version: number;
}

export interface ApprovalLifecycleView {
  approvalId: string;
  kind: LifecycleKind;
  targetRef: string;
  amount: number;
  reasonCode: string;
  reasonText: string;
  evidenceChecked?: string;
  requiredApprovals: number;
  approvals: string[];
  status: LifecycleStatus;
  requestedBy: { adminAccountId: string; displayName: null; role: string };
  requestedAt: string;
  canApprove: boolean;
  dueAt: string;
  closeReason: string | null;
  version: number;
}

const ALLOWED_APPROVER_ROLES: Record<LifecycleKind, readonly string[]> = {
  SYSTEM_FAULT_REFUND: ['cs_lead'],
  DISCRETIONARY_WAIVER: ['cs_lead'],
  TRANSFER_RECLAIM: ['commander'],
  MINOR_CONTRACT_CANCEL: ['cs_lead'],
};

const REQUESTER_ROLES: Record<LifecycleKind, readonly string[]> = {
  SYSTEM_FAULT_REFUND: ['cs_agent'],
  DISCRETIONARY_WAIVER: ['cs_agent'],
  TRANSFER_RECLAIM: ['cs_lead'],
  MINOR_CONTRACT_CANCEL: ['cs_agent'],
};

/** 종류별 승인 역할. 재량 면제는 2인(3)일 때만 commander가 더해진다. */
export const approverRolesOf = (kind: LifecycleKind, requiredApprovals: number): string[] => {
  const base = [...ALLOWED_APPROVER_ROLES[kind]];
  if (kind === 'DISCRETIONARY_WAIVER' && requiredApprovals === 3 && !base.includes('commander')) base.push('commander');
  return base;
};

export const canRequestKind = (kind: LifecycleKind, actorRole: string): boolean => REQUESTER_ROLES[kind].includes(actorRole);

export const isLifecycleKind = (kind: string): kind is LifecycleKind => (LIFECYCLE_KINDS as readonly string[]).includes(kind);

/** KST 기준 영업일 더하기(주말만 뺀다). 시각은 그대로 둔다. */
export function addBusinessDaysKst(ms: number, days: number): number {
  const d = new Date(ms);
  let left = days;
  while (left > 0) {
    d.setTime(d.getTime() + 86_400_000);
    const day = new Date(d.getTime() + 9 * 3_600_000).getUTCDay();
    if (day !== 0 && day !== 6) left -= 1;
  }
  return d.getTime();
}

/** 지급일 다음 은행 영업일(토·일만 뺀다). */
export function nextBusinessDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d!));
  do {
    at.setUTCDate(at.getUTCDate() + 1);
  } while (at.getUTCDay() === 0 || at.getUTCDay() === 6);
  return `${at.getUTCFullYear()}-${String(at.getUTCMonth() + 1).padStart(2, '0')}-${String(at.getUTCDate()).padStart(2, '0')}`;
}

export const lifecycleView = (r: ApprovalLifecycleRecord, actor: OpsActor): ApprovalLifecycleView => {
  const voted = r.approvals.some((v) => v.approverId === actor.accountId);
  const pending = r.status === 'PENDING_APPROVAL' || r.status === 'ESCALATED' || r.status === 'FAILED';
  return {
    approvalId: r.approvalId,
    kind: r.kind,
    targetRef: r.targetRef,
    amount: r.amount,
    reasonCode: r.reasonCode,
    reasonText: r.reasonText,
    ...(r.evidenceChecked ? { evidenceChecked: r.evidenceChecked } : {}),
    requiredApprovals: r.requiredApprovals,
    approvals: r.approvals.map((v) => v.approverId),
    status: r.status,
    requestedBy: { adminAccountId: r.requesterId, displayName: null, role: r.requesterRole },
    requestedAt: r.createdAt.toISOString(),
    canApprove: pending && r.requesterId !== actor.accountId && r.approverRoles.includes(actor.role) && (!voted || r.status === 'FAILED'),
    dueAt: r.dueAt.toISOString(),
    closeReason: r.closeReason,
    version: r.version,
  };
};
