// SCR-061 내 현장 배정 상태별로 무엇을 보일지(캔버스 보드 SCR-061-m의 renderVals를 옮겼다. 태블릿·데스크톱 보드는 '기본' 한 상태)와
// 배정 목업에 공연·회차·공연장·파트너를 합친 카드 값.
import { getPerformance } from '@/entities/performance';
import { getProduction, type PosterArt } from '@/entities/production';
import { getSeller } from '@/entities/seller';
import {
  DEMO_STAFF_ASSIGNMENT_ID,
  STAFF_ASSIGNMENTS,
  STAFF_PHASE_BADGE,
  STAFF_PHASE_LABEL,
  STAFF_ROLE_LABEL,
  getStaffAssignment,
  staffValidFromText,
  staffValidText,
  type StaffAssignment,
  type StaffAssignmentPhase,
} from '@/entities/staff-assignment';
import { getVenue } from '@/entities/venue';
import type { Scr061State } from '@/shared/config/screens.account';

export interface StaffHomeView {
  loading: boolean;
  /** 현재 배정 카드의 배지(곧 시작·진행 중·해제). null이면 현재 배정 칸이 없다 */
  nowPhase: StaffAssignmentPhase | null;
  /** 지난 배정 칸 */
  past: boolean;
  /** '스캐너에 로그인하는 방법' 안내(곧 시작·진행 중에만) */
  guide: boolean;
  empty: boolean;
}

const NOW_PHASE: Partial<Record<Scr061State, StaffAssignmentPhase>> = { 기본: 'active', '곧 시작': 'soon', 해제됨: 'revoked' };

export function staffHomeView(st: Scr061State): StaffHomeView {
  const nowPhase = NOW_PHASE[st] ?? null;
  return {
    loading: st === '조회 중',
    nowPhase,
    past: nowPhase !== null,
    guide: nowPhase === 'active' || nowPhase === 'soon',
    empty: st === '빈 화면',
  };
}

export interface AssignmentCard {
  id: string;
  title: string;
  posterArt: PosterArt;
  posterShort: string;
  /** 현재 배정: '10/25(일) 18:00 · 피켓 아레나' · 지난 배정: '9/19(토) 19:30 · (주)스텔라엔터테인먼트'(보드) */
  sub: string;
  partnerName: string;
  roleLabel: string;
  phase: StaffAssignmentPhase;
  phaseLabel: string;
  phaseBadge: string;
  /** '10/25(일) 13:30 ~ 22:00' */
  validText: string;
  /** 곧 시작 안내의 '10/25(일) 13:30' */
  validFromText: string;
  scannerName?: string;
}

function toCard(a: StaffAssignment, phase: StaffAssignmentPhase, subWith: 'venue' | 'partner'): AssignmentCard {
  const production = getProduction(a.productionId);
  const perf = a.performanceId ? getPerformance(a.performanceId) : undefined;
  const venue = production ? getVenue(production.venueId) : undefined;
  const partnerName = getSeller(a.sellerId)?.name ?? '';
  const when = perf?.label ?? a.performanceLabel;
  return {
    id: a.id,
    title: production?.title ?? '',
    posterArt: production?.poster.art ?? 'lumen',
    posterShort: production?.poster.short ?? '',
    sub: [when, subWith === 'venue' ? venue?.name : partnerName].filter(Boolean).join(' · '),
    partnerName,
    roleLabel: STAFF_ROLE_LABEL[a.role],
    phase,
    phaseLabel: STAFF_PHASE_LABEL[phase],
    phaseBadge: STAFF_PHASE_BADGE[phase],
    validText: staffValidText(a),
    validFromText: staffValidFromText(a),
    scannerName: a.scannerName,
  };
}

/** 현재 배정 카드(보드는 LUMEN 10/25 현장 책임자 한 건을 세 배지로 그린다) */
export function currentAssignmentCard(phase: StaffAssignmentPhase): AssignmentCard {
  const a = getStaffAssignment(DEMO_STAFF_ASSIGNMENT_ID);
  if (!a) throw new Error('대표 배정 목업이 없습니다');
  return toCard(a, phase, 'venue');
}

/** 지난 배정(종료) 카드들 */
export function pastAssignmentCards(): AssignmentCard[] {
  return STAFF_ASSIGNMENTS.filter((a) => a.phase === 'ended').map((a) => toCard(a, 'ended', 'partner'));
}
