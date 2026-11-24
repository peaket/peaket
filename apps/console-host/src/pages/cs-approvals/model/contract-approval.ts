// SCR-046 계약 조건 변경 승인 카드의 표시·판정 규칙(F-07-2, d5 §7.7·§7.13, settlement §9·§10, ADR-0060).
// 서버의 2인 승인 길(요청자가 아닌 commander가 재인증 뒤 승인, 반려는 사유 필수)을 화면이 그대로 따르게 하는 순수 함수만 둔다.
import type { ApprovalRequest } from '@peaket/api-client/model';

// 파트너 화면(SCR-065)과 같은 표기 규칙이다. 시험이 `node --test`로 이 파일만 읽으므로 런타임 의존을 두지 않는다
// (계약 화면의 정본 표기는 docs/design/d5 §7.13, 10,000bp=100%).
const guaranteeLabel = (kind: string | null | undefined): string => (kind === 'PERFORMANCE_BOND' ? '이행보증보험' : '보증금');
const formatBp = (bp: number | null | undefined): string => {
  if (bp === null || bp === undefined || !Number.isFinite(bp)) return '-';
  const value = bp / 100;
  return Number.isInteger(value) ? `${value}%` : `${value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')}%`;
};
const kst = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' });
const kstTime = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hour12: false });
const formatKst = (iso: string | null | undefined): string => {
  if (!iso) return '-';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '-';
  return `${kst.format(d).replace(/\s/g, '')} ${kstTime.format(d)} KST`;
};

export type ConsoleRole = 'viewer' | 'operator' | 'commander' | 'cs_agent' | 'cs_lead';

/** 이 카드가 다루는 승인 업무인가. 다른 종류(수기 조정·부정 예매 등)는 각자의 화면이 맡는다 */
export function isContractApproval(a: Pick<ApprovalRequest, 'kind' | 'status'>): boolean {
  return a.kind === 'CONTRACT_TERMS_CHANGE' && a.status === 'PENDING_APPROVAL';
}

export interface ApprovalEligibility {
  canApprove: boolean;
  /** 승인할 수 없을 때 화면에 보일 한 줄(정본 문구) */
  reason?: string;
}

/**
 * 승인 자격(settlement §9, d5 §7.7): 요청자가 아닌 commander만 승인한다.
 * 요청자 본인은 [승인]이 비활성이고 이유가 보인다. operator·CS·viewer는 요청·조회만 한다.
 */
export function approvalEligibility(a: Pick<ApprovalRequest, 'requestedBy' | 'status'>, me: { accountId: string; role: ConsoleRole }): ApprovalEligibility {
  if (me.role !== 'commander') return { canApprove: false, reason: '이 역할은 승인할 수 없습니다. 요청자와 다른 commander가 승인합니다.' };
  if (a.status !== 'PENDING_APPROVAL') return { canApprove: false, reason: '이미 처리된 승인 요청입니다.' };
  if (a.requestedBy?.adminAccountId === me.accountId) return { canApprove: false, reason: '요청한 분은 승인할 수 없습니다.' };
  return { canApprove: true };
}

/** 승인 카드의 현재 값↔바꿀 값 줄. 서버가 준 바꿀 값이 비어 있으면(칸을 보내지 않음) 지금 값 그대로다 */
export function contractRowsOf(terms: NonNullable<ApprovalRequest['contractTerms']>): readonly { label: string; current: string; requested: string; changed: boolean }[] {
  const current = terms.current ?? {};
  const rows = [
    { label: '중개수수료율', current: formatBp(current.commissionRateBp), requested: formatBp(terms.requestedCommissionRateBp ?? current.commissionRateBp), change: terms.requestedCommissionRateBp !== null && terms.requestedCommissionRateBp !== undefined },
    { label: '계약 보증', current: formatBp(current.guaranteeRateBp), requested: formatBp(terms.requestedGuaranteeRateBp ?? current.guaranteeRateBp), change: terms.requestedGuaranteeRateBp !== null && terms.requestedGuaranteeRateBp !== undefined },
    { label: '보증 종류', current: guaranteeLabel(current.guaranteeKind), requested: guaranteeLabel(terms.requestedGuaranteeKind ?? current.guaranteeKind), change: terms.requestedGuaranteeKind !== null && terms.requestedGuaranteeKind !== undefined },
  ];
  return rows.map(({ label, current: c, requested, change }) => ({ label, current: c, requested, changed: change }));
}

/** 승인 본문: 계약 변경은 판단 이유가 필수가 아니다(서버 계약). 있으면 1~1000자만 보낸다 */
export function approvalBodyOf(reason?: string): { reason?: string } {
  const text = reason?.trim() ?? '';
  return text === '' ? {} : { reason: text };
}

/** 반려 본문: 사유가 필수다. 비었거나 1000자를 넘으면 보내지 않는다(undefined) */
export const REJECTION_REASON_MAX = 1000;
export function rejectionBodyOf(reason: string): { reason: string } | undefined {
  const text = reason.trim();
  return text === '' || text.length > REJECTION_REASON_MAX ? undefined : { reason: text };
}

/** 승인 카드의 오류 문구: 서버 title 원문 대신 정본의 상태별 문구만 보인다 */
export function contractApprovalProblemMessage(err: unknown): string {
  const status = (err as { status?: number } | undefined)?.status;
  const type = (err as { type?: string } | undefined)?.type;
  if (status === 403 && type === 'reauth-required') return '재인증이 만료되었거나 이미 썼습니다. 다시 본인확인한 뒤 승인해 주세요.';
  if (status === 403) return '요청한 분은 승인할 수 없습니다. 다른 commander가 승인해야 합니다.';
  if (status === 409) return '다른 사람이 먼저 처리했습니다. 목록을 새로 고친 뒤 다시 확인해 주세요.';
  if (status === 422) return '보낼 값을 확인해 주세요. 반려는 사유가 필요하고, 승인은 재인증이 필요합니다.';
  if (status === 503) return '승인 업무 서버에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
  if (status === 404) return '없는 승인 요청이거나 지금 역할로 열 수 없습니다.';
  return '요청을 보내지 못했습니다. 잠시 뒤 다시 시도해 주세요.';
}

/** 카드 머리의 요청 정보 한 줄(요청자·요청 시각·기한) */
export function approvalMetaOf(a: Pick<ApprovalRequest, 'requestedBy' | 'requestedAt' | 'dueAt'>): string {
  const who = a.requestedBy?.displayName ?? a.requestedBy?.adminAccountId ?? '요청자';
  const at = a.requestedAt ? formatKst(a.requestedAt) : '-';
  const due = a.dueAt ? ` · 기한 ${formatKst(a.dueAt)}` : '';
  return `${who} · ${at}${due}`;
}
