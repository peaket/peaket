// SCR-046 승인 업무 화면의 값 해석(F-06-3 GAT-290·GAT-300, d5 §7.7, transfer-refund §7.2, settlement §9).
// 서버 응답에서 화면이 쓰는 칸만 남기고, 결제자·계좌·연락처 같은 개인정보 칸은 버린다.
// 판(version)은 ETag에서 읽어 If-Match로 되돌려 보낸다.
export type ApprovalKind =
  | 'SYSTEM_FAULT_REFUND'
  | 'DISCRETIONARY_WAIVER'
  | 'TRANSFER_RECLAIM'
  | 'MINOR_CONTRACT_CANCEL'
  | 'PAYOUT_BATCH'
  | 'SETTLEMENT_ADJUSTMENT'
  | 'COMMANDER_ROLE_CHANGE'
  | 'CONTRACT_TERMS_CHANGE'
  | 'SALE_SUSPENSION'
  | 'SALE_RESUMPTION'
  | 'FRAUD_ACTION'
  | 'BOOKING_RESTRICTION';

export type ApprovalStatus = 'REQUESTED' | 'PENDING_APPROVAL' | 'ESCALATED' | 'APPROVED' | 'EXECUTING' | 'DONE' | 'FAILED' | 'REJECTED' | 'WITHDRAWN' | 'EXPIRED';

export interface ApprovalView {
  approvalId: string;
  kind: ApprovalKind;
  targetRef: string;
  amount: number | null;
  reasonCode: string | null;
  reasonText: string;
  evidenceChecked: string | null;
  requiredApprovals: 1 | 2 | 3;
  approvals: string[];
  status: ApprovalStatus;
  requestedBy: { adminAccountId: string; displayName: string | null; role: string };
  requestedAt: string;
  canApprove: boolean;
  dueAt: string | null;
  closeReason: string | null;
  payeeDigest: string | null;
  version: number;
}

const KINDS: readonly string[] = [
  'SYSTEM_FAULT_REFUND',
  'DISCRETIONARY_WAIVER',
  'TRANSFER_RECLAIM',
  'MINOR_CONTRACT_CANCEL',
  'PAYOUT_BATCH',
  'SETTLEMENT_ADJUSTMENT',
  'COMMANDER_ROLE_CHANGE',
  'CONTRACT_TERMS_CHANGE',
  'SALE_SUSPENSION',
  'SALE_RESUMPTION',
  'FRAUD_ACTION',
  'BOOKING_RESTRICTION',
];
const STATUSES: readonly string[] = ['REQUESTED', 'PENDING_APPROVAL', 'ESCALATED', 'APPROVED', 'EXECUTING', 'DONE', 'FAILED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'];

const rec = (v: unknown): Record<string, unknown> => (typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

export function approvalViewOf(raw: unknown): ApprovalView | null {
  const r = rec(raw);
  const approvalId = str(r.approvalId);
  const kind = str(r.kind);
  const status = str(r.status);
  const required = r.requiredApprovals;
  if (!approvalId || !KINDS.includes(kind) || !STATUSES.includes(status)) return null;
  if (required !== 1 && required !== 2 && required !== 3) return null;
  const requestedBy = rec(r.requestedBy);
  const adminAccountId = str(requestedBy.adminAccountId);
  if (!adminAccountId) return null;
  return {
    approvalId,
    kind: kind as ApprovalKind,
    targetRef: str(r.targetRef),
    amount: numOrNull(r.amount),
    reasonCode: strOrNull(r.reasonCode),
    reasonText: str(r.reasonText),
    evidenceChecked: strOrNull(r.evidenceChecked),
    requiredApprovals: required,
    approvals: Array.isArray(r.approvals) ? r.approvals.filter((v): v is string => typeof v === 'string') : [],
    status: status as ApprovalStatus,
    requestedBy: { adminAccountId, displayName: strOrNull(requestedBy.displayName), role: str(requestedBy.role) },
    requestedAt: str(r.requestedAt),
    canApprove: r.canApprove === true,
    dueAt: strOrNull(r.dueAt),
    closeReason: strOrNull(r.closeReason),
    payeeDigest: strOrNull(r.payeeDigest),
    version: typeof r.version === 'number' && Number.isInteger(r.version) && r.version > 0 ? r.version : 1,
  };
}

export function approvalPageOf(raw: unknown): { items: ApprovalView[]; nextCursor: string | null } {
  const r = rec(raw);
  const items = (Array.isArray(r.items) ? r.items : []).map(approvalViewOf).filter((v): v is ApprovalView => v !== null);
  return { items, nextCursor: strOrNull(r.nextCursor) };
}

export function quorumLabel(requiredApprovals: number): string | null {
  if (requiredApprovals === 1) return '승인 없음';
  if (requiredApprovals === 2) return '1인 승인';
  if (requiredApprovals === 3) return '2인 승인';
  return null;
}

export function evidenceOf(raw: unknown): string | null {
  const value = strOrNull(rec(raw).evidenceChecked);
  if (!value) return null;
  if (value === 'PHONE_VERIFICATION') return '휴대폰 본인확인 대조';
  if (value.startsWith('DOCUMENT:')) return `서류: ${value.slice('DOCUMENT:'.length)}`;
  return value;
}

const KIND_LABELS: Record<string, string> = {
  SYSTEM_FAULT_REFUND: '시스템 잘못 환불',
  DISCRETIONARY_WAIVER: '재량 면제',
  TRANSFER_RECLAIM: '양도 회수',
  MINOR_CONTRACT_CANCEL: '미성년자 계약 취소',
  PAYOUT_BATCH: '지급 묶음',
  SETTLEMENT_ADJUSTMENT: '정산서 수기 조정',
  COMMANDER_ROLE_CHANGE: 'commander 역할 변경',
  CONTRACT_TERMS_CHANGE: '계약 조건 변경',
  SALE_SUSPENSION: '판매 중지',
  SALE_RESUMPTION: '판매 재개',
  FRAUD_ACTION: '부정 예매 조치',
  BOOKING_RESTRICTION: '예매 제한',
};
export const kindLabel = (kind: string): string => KIND_LABELS[kind] ?? kind;

const STATUS_LABELS: Record<string, string> = {
  REQUESTED: '요청',
  PENDING_APPROVAL: '승인 대기',
  ESCALATED: '상위 알림',
  APPROVED: '승인',
  EXECUTING: '실행 중',
  DONE: '완료',
  FAILED: '실패',
  REJECTED: '반려',
  WITHDRAWN: '철회',
  EXPIRED: '만료',
};
export const statusOf = (status: string): string => STATUS_LABELS[status] ?? status;

export interface Actor {
  accountId: string;
  role: string;
}

export function canAct(view: ApprovalView, actor: Actor): { approve: boolean; reject: boolean; withdraw: boolean } {
  const requester = view.requestedBy.adminAccountId === actor.accountId;
  const open = view.status === 'PENDING_APPROVAL' || view.status === 'ESCALATED' || view.status === 'FAILED';
  return {
    approve: !requester && open && view.canApprove,
    reject: !requester && open && view.canApprove,
    withdraw: requester && (view.status === 'PENDING_APPROVAL' || view.status === 'ESCALATED'),
  };
}

export function errorOf(problem: unknown, status: number): { kind: string; text: string } {
  const type = str(rec(problem).type);
  if (type.includes('approval-expired')) return { kind: 'expired', text: '승인 기한이 지나 만료되었습니다' };
  if (type.includes('approval-target-changed')) return { kind: 'target-changed', text: '대상이 바뀌어 승인할 수 없습니다' };
  if (type.includes('approval-self-not-allowed')) return { kind: 'self', text: '요청한 분은 승인할 수 없습니다' };
  if (type.includes('approval-role-required')) return { kind: 'role', text: '이 업무를 승인할 역할이 아닙니다' };
  if (type.includes('reclaim-appeal-window')) return { kind: 'appeal-window', text: '받은 분의 소명 기한이 지난 뒤에 승인할 수 있습니다' };
  if (type.includes('payout-batch-payee-mismatch')) return { kind: 'payee-mismatch', text: '지급 대상이 바뀌었습니다. 다시 불러와 확인해 주세요' };
  return { kind: status === 412 ? 'stale' : 'unknown', text: '처리하지 못했습니다. 다시 불러와 확인해 주세요' };
}

export function payeeDigestOf(raw: unknown): string | null {
  const v = strOrNull(rec(raw).payeeDigest);
  return v && /^[0-9a-f]{64}$/.test(v) ? v : null;
}

export function digestMatches(expected: string | null, current: string | null): boolean {
  return expected !== null && current !== null && expected === current;
}

export function versionOfEtag(etag: string | null): number | null {
  if (typeof etag !== 'string') return null;
  const m = /^"(\d+)"$/.exec(etag);
  return m ? Number(m[1]) : null;
}

export const ifMatchOf = (version: number | null): string | null => (version === null ? null : `"${version}"`);
