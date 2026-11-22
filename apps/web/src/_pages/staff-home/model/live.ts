// SCR-061 내 현장 배정 실제 흐름의 화면 값(d5 §5.35 '배지와 칸', BUILD_ORDER F-05-7 = GAT-240, ADR-0362, I-T93).
// 목록 GET /v1/staff-assignments(features/staff-invitation listAssignments)의 배정마다 회차 공개 요약으로 공연명·회차·상호를 채우고,
// 배지(곧 시작·진행 중·종료·해제)와 칸(현재 배정·지난 배정)은 지금 시각을 받아 정한다. 경로 별칭 없이 상대 경로로 가져온다(node 시험이 바로 읽는다).
import type { EventSummaryAnswer } from '../../../entities/event-summary/index.ts';
import {
  isCurrentAssignment,
  STAFF_PHASE_BADGE,
  STAFF_PHASE_LABEL,
  STAFF_ROLE_LABEL,
  staffPhaseAt,
  staffValidFromAtText,
  staffValidRangeText,
  staffWhenText,
  type StaffAssignmentPhase,
  type StaffAssignmentSelf,
} from '../../../entities/staff-assignment/index.ts';

/** 실제 흐름의 화면 상태(d5 §5.35 상태 이름) */
export type StaffHomeLiveState = '조회 중' | '기본' | '빈 화면' | '못 불러옴';

export interface LiveAssignmentCard {
  id: string;
  /** 공연명. 회차 공개 요약을 못 읽었으면 null(카드는 '공연 정보를 불러오지 못했습니다') */
  title: string | null;
  /** 현재 배정: 회차 시작 '10/25(일) 18:00' · 지난 배정: '9/19(토) 19:30 · (주)스텔라엔터테인먼트'(보드) */
  sub: string;
  /** 판매자 상호. 못 읽었으면 null(파트너 줄 없음) */
  partnerName: string | null;
  roleLabel: string;
  phase: StaffAssignmentPhase;
  phaseLabel: string;
  phaseBadge: string;
  /** '10/25(일) 13:30 ~ 22:00' */
  validText: string;
  /** 곧 시작 안내의 '10/25(일) 13:30' */
  validFromText: string;
  /** '지금 로그인한 스캐너: {이름}'(activeScannerDeviceName이 있을 때만) */
  scannerName: string | null;
}

export interface StaffHomeLiveView {
  current: LiveAssignmentCard[];
  past: LiveAssignmentCard[];
  /** 스캐너 로그인 방법 안내: 곧 시작·진행 중 배정이 있을 때만 */
  guide: boolean;
  empty: boolean;
}

function cardOf(a: StaffAssignmentSelf, s: EventSummaryAnswer | undefined, nowMs: number, place: 'current' | 'past'): LiveAssignmentCard {
  const phase = staffPhaseAt(a, nowMs);
  const summary = s?.kind === 'ok' ? s.summary : null;
  const when = summary ? staffWhenText(summary.startsAt) : '';
  const sub = place === 'current' ? when : [when, summary?.sellerName].filter(Boolean).join(' · ');
  return {
    id: a.assignmentId,
    title: summary?.title ?? null,
    sub,
    partnerName: summary?.sellerName ?? null,
    roleLabel: STAFF_ROLE_LABEL[a.role],
    phase,
    phaseLabel: STAFF_PHASE_LABEL[phase],
    phaseBadge: STAFF_PHASE_BADGE[phase],
    validText: staffValidRangeText(a.validFrom, a.validUntil),
    validFromText: staffValidFromAtText(a.validFrom),
    scannerName: a.activeScannerDeviceName,
  };
}

/**
 * 목록과 요약 → 두 칸. 곧 시작·진행 중과 validUntil이 지나지 않은 해제는 현재 배정, 나머지는 지난 배정이다(목록의 차례 그대로, 유효 시작이 늦은 순).
 * 빈 목록이면 empty
 */
export function staffHomeLiveView(items: readonly StaffAssignmentSelf[], summaries: ReadonlyMap<string, EventSummaryAnswer>, nowMs: number): StaffHomeLiveView {
  const current: LiveAssignmentCard[] = [];
  const past: LiveAssignmentCard[] = [];
  for (const a of items) {
    if (isCurrentAssignment(a, nowMs)) current.push(cardOf(a, summaries.get(a.eventId), nowMs, 'current'));
    else past.push(cardOf(a, summaries.get(a.eventId), nowMs, 'past'));
  }
  return { current, past, guide: current.some((c) => c.phase === 'soon' || c.phase === 'active'), empty: items.length === 0 };
}
