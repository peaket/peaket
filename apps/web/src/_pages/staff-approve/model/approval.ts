// SCR-051 기기 승인 요청 한 건의 목업(캔버스 보드 SCR-051의 기기 동문-03·확인 코드 WDJB-MJHT·내 배정 줄을 옮겼다)과 배정·공연·회차·파트너를 합치는 일.
// 조회는 기기 이름과 이 기기 파트너 회차의 내 유효 배정만 준다. 파트너 상호와 공연명은 회차 공개 요약에서 읽는다(d5 §5.27 '파트너 이름').
import { ME_HANEUL, type MeSummary } from '@/entities/me';
import { getPerformance } from '@/entities/performance';
import { getProduction } from '@/entities/production';
import { getSeller } from '@/entities/seller';
import {
  DEMO_STAFF_ASSIGNMENT_ID,
  getStaffAssignment,
  STAFF_ROLE_LABEL,
  staffValidCompactText,
  staffValidText,
  staffValidTimeText,
  type StaffAssignment,
} from '@/entities/staff-assignment';

export const APPROVAL_REQUEST = {
  deviceName: '동문-03',
  /** 스캐너 화면과 대조하는 확인 코드(5분마다 바뀐다) */
  code: 'WDJB-MJHT',
  /** 기기의 배정 파트너(seller 목업 id) */
  sellerId: 'sel-stella',
  /** 승인 대기의 내 배정(하나) */
  assignmentId: DEMO_STAFF_ASSIGNMENT_ID,
  /** 배정 고르기의 내 유효 배정(둘) */
  pickAssignmentIds: ['sta-lumen-1025', 'sta-lumen-1026'],
} as const;

/** 상태 '권한 없음 · 대리 승인'의 로그인한 계정: 도윤(현장 스태프). 합성 이름이다 */
export const STAFF_DOYUN: MeSummary = {
  ...ME_HANEUL,
  id: 'fan-doyun',
  name: '도윤',
  avatarText: '도',
  provider: 'kakao',
  likedProductionIds: [],
};

/** 확인 코드 낭독 이름 '확인 코드 W D J B 하이픈 M J H T'(한 글자씩 읽게 한다, d3 SCR-051) */
export function codeLabel(code: string): string {
  return `확인 코드 ${[...code].map((c) => (c === '-' ? '하이픈' : c)).join(' ')}`;
}

function assignmentOf(id: string): StaffAssignment {
  const a = getStaffAssignment(id);
  if (!a) throw new Error(`배정 목업이 없습니다: ${id}`);
  return a;
}

/** 공연명 + 회차 'LUMEN 콘서트 2026 서울 10/25(일) 18:00' */
function showText(a: StaffAssignment): string {
  const production = getProduction(a.productionId);
  const perf = a.performanceId ? getPerformance(a.performanceId) : undefined;
  return [production?.title, perf?.label ?? a.performanceLabel].filter(Boolean).join(' ');
}

export interface ApprovalModel {
  deviceName: string;
  code: string;
  partnerName: string;
  /** 내 배정(하나): 공연명 줄과 '현장 책임자 · 권한 유효 13:30 ~ 22:00' 줄 */
  single: { show: string; meta: string };
  /** 공개 요약을 읽지 못했을 때의 줄 '10/25 13:30~22:00 · 현장 책임자' */
  singleCompact: string;
  /** 배정 고르기 후보 'LUMEN 콘서트 2026 서울 10/25(일) 18:00 · 현장 책임자' */
  options: { id: string; label: string }[];
  /** 승인됨 카드 줄 '동문-03 · LUMEN 콘서트 2026 서울 10/25(일) 18:00 · 현장 책임자' */
  approvedText: string;
  /** 운영 시간 밖의 '내 권한 유효 시간 10/25(일) 13:30 ~ 22:00' */
  validText: string;
}

export function approvalModel(): ApprovalModel {
  const a = assignmentOf(APPROVAL_REQUEST.assignmentId);
  const role = STAFF_ROLE_LABEL[a.role];
  return {
    deviceName: APPROVAL_REQUEST.deviceName,
    code: APPROVAL_REQUEST.code,
    partnerName: getSeller(APPROVAL_REQUEST.sellerId)?.name ?? '',
    single: { show: showText(a), meta: `${role} · 권한 유효 ${staffValidTimeText(a)}` },
    singleCompact: `${staffValidCompactText(a)} · ${role}`,
    options: APPROVAL_REQUEST.pickAssignmentIds.map((id) => {
      const o = assignmentOf(id);
      return { id, label: `${showText(o)} · ${STAFF_ROLE_LABEL[o.role]}` };
    }),
    approvedText: `${APPROVAL_REQUEST.deviceName} · ${showText(a)} · ${role}`,
    validText: staffValidText(a),
  };
}
