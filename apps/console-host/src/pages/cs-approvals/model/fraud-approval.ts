// SCR-046 부정 예매 조치(승인 업무 FRAUD_ACTION) 목업 하나(d5 §7.7 '부정 예매 조치', add-fraud-investigation-screens design.md 결정 8).
// 사건 CASE-2610-0005(entities/fraud-case 목업)를 승인자 사건 요약(openapi FraudCaseSummary)의 칸으로만 옮긴다.
// 계정 ID·가명 값·IP·연락처·결제 수단 값·연결 그래프·리플레이 파일은 여기에 두지 않는다(docs/security/authz-matrix.md §4.1 '부정 예매 사건 요약',
// docs/features/control-tower.md §9.2 '승인자가 보는 범위'). 데이터 연결 단계에서 GET /v1/ops/approval-requests/{approvalId} 응답으로 바꾼다.
// 예외는 범위 줄이기용 대상 줄(targets)의 계정 ID·표 ID다. 승인 본문(excludeAccountIds·excludeTicketIds)에만 쓰고 화면에는 '계정 1·2…'로 보인다
// (openapi FraudCaseSummary.targets, ADR-0173 결정 2, apply-legal-review-to-screens).
import { DESIGNATED, OPERATORS } from '@/entities/operator';
import {
  APPROVAL_SUMMARY_VIEWED_AT,
  APPROVAL_TARGETS,
  EVENT,
  SNAPSHOT,
  cancelDeadlineNotice,
  formatKst,
  getCase,
  getCluster,
  type FraudLinkKind,
  type FraudReasonCategory,
  type ApprovalTarget,
  type FraudSignal,
} from '@/entities/fraud-case';
import type { FraudVariant } from '../states';

/** 승인자 사건 요약(openapi FraudCaseSummary의 칸만. caseId·eventId는 요청 쪽에 둔다) */
export interface FraudCaseSummaryView {
  reasonCategory: FraudReasonCategory;
  accountCount: number;
  ticketCount: number;
  purchaseCount: number;
  limitPerPerson: number;
  sharedAttributes: readonly FraudLinkKind[];
  signals: readonly FraudSignal[];
  appealCounts: { accepted: number; rejected: number; expired: number; submitted: number; pending: number };
  investigatorOpinion: string | null;
  cancelDeadlineAt: string;
  snapshotHash: string;
  /** 범위 줄이기용 대상 줄(계정마다 한 줄) */
  targets: readonly ApprovalTarget[];
}

export interface FraudApproval {
  approvalId: string;
  caseId: string;
  fraudAction: 'CANCEL_TICKETS';
  eventTitle: string;
  eventStartsAt: string;
  requester: { name: string; role: string };
  requestedAt: string;
  /** 표 취소의 승인 기한은 취소 마감이다(POL-038 ⑪) */
  dueAt: string;
  /** 요청할 때 적은 근거(목업 글). 조사관 의견은 사건 요약 쪽 칸이다 */
  reasonText: string;
  summary: FraudCaseSummaryView;
  /** 이 승인자가 사건 요약을 처음 연 시각(상세 응답의 summaryViewedAt). 없으면 승인할 수 없다(409 fraud-summary-not-viewed) */
  summaryViewedAt: string | null;
}

const CASE_ID = 'CASE-2610-0005';
const c = getCase(CASE_ID)!;
const cl = getCluster(c.clusterId)!;

export const FRAUD_APPROVAL: FraudApproval = {
  approvalId: 'apr-fraud-0005',
  caseId: c.caseId,
  fraudAction: 'CANCEL_TICKETS',
  eventTitle: EVENT.title,
  eventStartsAt: EVENT.startsAt,
  requester: { name: DESIGNATED.investigator.name, role: 'cs_lead' },
  requestedAt: c.timeline.actionRequestedAt,
  dueAt: c.cancelDeadlineAt,
  reasonText: `소명 기한 ${formatKst(c.timeline.appealDueAt)} KST가 지났고, 인정된 소명이 없습니다. ${c.accountCount}계정 ${c.ticketCount}장 모두 표 취소와 환급을 요청합니다.`,
  summary: {
    reasonCategory: c.reasonCategory,
    accountCount: c.accountCount,
    ticketCount: c.ticketCount,
    purchaseCount: cl.purchaseCount,
    limitPerPerson: EVENT.limitPerPerson,
    sharedAttributes: cl.sharedAttributes,
    signals: cl.signals,
    appealCounts: c.appealCounts,
    investigatorOpinion: c.investigatorOpinion,
    cancelDeadlineAt: c.cancelDeadlineAt,
    snapshotHash: SNAPSHOT.invHash,
    targets: APPROVAL_TARGETS,
  },
  summaryViewedAt: APPROVAL_SUMMARY_VIEWED_AT,
};

/** 이 상태들의 '지금'. 위 상태 바 시계(20:04:12 KST)와 같은 시각이고, 취소 마감 지남은 같은 시계의 마감 뒤 날(10/24(토))이다 */
export const NOW_PENDING = '2026-10-19T20:04:12+09:00';
export const NOW_EXPIRED = '2026-10-24T20:04:12+09:00';

export function nowFor(variant: FraudVariant | null): string {
  return variant === 'expired' ? NOW_EXPIRED : NOW_PENDING;
}

/** 그 상태의 '지금'에 취소 마감이 지났는지(배지는 entities/fraud-case의 CancelDeadlineBadge, CMP-040 cancel-deadline) */
export function deadlinePassed(variant: FraudVariant | null): boolean {
  return cancelDeadlineNotice(nowFor(variant), FRAUD_APPROVAL.summary.cancelDeadlineAt).tone === 'passed';
}

/** '10/24(토) 16:00 KST' */
export function kst(iso: string): string {
  return `${formatKst(iso)} KST`;
}

/** 해시 앞 8자리…끝 8자리 */
export function shortHash(hash: string): string {
  return `${hash.slice(0, 8)}…${hash.slice(-8)}`;
}

/**
 * 부정 예매 조치 상태에서 요청 목록 머리가 보이는 사람의 글과 수(보드 사람 대신 그 상태의 사람, Page.tsx와 같다).
 * 승인자 수진(commander, 지정 없음) · 요청한 조사관 도윤(cs_lead) · 열 수 없는 가명정보 취급자 태오(commander).
 */
export function fraudListVals(variant: FraudVariant) {
  if (variant === 'own') {
    return { kinds: `${DESIGNATED.investigator.name}(CS 책임자)이 요청할 수 있는 종류: 양도 회수, 정산서 수기 조정. 부정 예매 조치는 사건 작업대에서 요청합니다`, nMine: '0', nReq: '1' };
  }
  if (variant === 'closed') {
    return { kinds: `${DESIGNATED.pseudonym.name}(commander)가 요청할 수 있는 종류: commander 역할 부여·회수`, nMine: '1', nReq: '0' };
  }
  // 승인자 수진: 양도 회수와 이 요청을 기다린다. 만료되면 이 요청은 빠진다
  return { kinds: `${OPERATORS.commander.name}(commander)이 요청할 수 있는 종류: commander 역할 부여·회수`, nMine: variant === 'expired' ? '1' : '2', nReq: '0' };
}
