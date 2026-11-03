// 현장 스태프 배정 목업(캔버스 보드 SCR-050·051·061의 LUMEN 10/25 현장 책임자 배정·10/26 배정·지난 배정과 d5 §5.26·5.27·5.35를 옮겼다).
// 값은 모두 합성이고 시각은 KST 표기 글이다. 공연·회차·판매자(파트너)는 id로만 가진다(entities끼리 가져오지 않는다).
// 공연 이름·회차 글·공연장·파트너 상호는 페이지가 production·performance·venue·seller 목업에서 읽어 합친다.

/** 역할(docs/features/identity.md): gate_lead 현장 책임자 · gate_staff 현장 스태프 */
export type StaffRole = 'gate_lead' | 'gate_staff';

/**
 * 화면 배지(d5 §5.35): 곧 시작(ASSIGNED, 권한 유효 시작 전이라 스캐너 로그인 불가) · 진행 중(ASSIGNED, 유효 시간 안) ·
 * 종료(ENDED) · 해제(REVOKED, 파트너가 해제). 초대 만료(EXPIRED)는 배정 목록에 보이지 않는다.
 */
export type StaffAssignmentPhase = 'soon' | 'active' | 'ended' | 'revoked';

export interface StaffAssignment {
  id: string;
  productionId: string;
  /** 회차 목업(performance)의 회차 id. 목업에 없는 지난 회차는 비우고 performanceLabel을 쓴다 */
  performanceId?: string;
  /** 회차 목업에 없는 회차의 글 '9/19(토) 19:30' */
  performanceLabel?: string;
  /** 회차의 파트너(seller 목업 id) */
  sellerId: string;
  role: StaffRole;
  phase: StaffAssignmentPhase;
  /** 권한 유효 시간(입장 시작 3시간 전 ~ 공연 종료 2시간 뒤)의 날짜 '10/25(일)' */
  validDateText: string;
  /** 같은 날짜의 짧은 글 '10/25'(회차 공개 요약을 읽지 못했을 때 쓰는 줄) */
  validDateShortText: string;
  /** 유효 시작 '13:30' */
  validFromText: string;
  /** 유효 끝 '22:00' */
  validUntilText: string;
  /** 지금 이 배정으로 로그인한 스캐너 이름 '동문-03' */
  scannerName?: string;
}

export const STAFF_ROLE_LABEL: Record<StaffRole, string> = { gate_lead: '현장 책임자', gate_staff: '현장 스태프' };

export const STAFF_PHASE_LABEL: Record<StaffAssignmentPhase, string> = {
  soon: '곧 시작',
  active: '진행 중',
  ended: '종료',
  revoked: '해제',
};

/** 배지 클래스(키트 .badge 변형). 종료는 기본 회색 배지 */
export const STAFF_PHASE_BADGE: Record<StaffAssignmentPhase, string> = {
  soon: 'badge badge-primary',
  active: 'badge badge-success',
  ended: 'badge',
  revoked: 'badge badge-danger',
};

export const STAFF_ASSIGNMENTS: readonly StaffAssignment[] = [
  {
    // 보드의 기본 배정: 하늘(현장 책임자), LUMEN 10/25(일) 18:00. 입장 16:30 - 3시간 = 13:30, 공연 끝 20:00 + 2시간 = 22:00
    id: 'sta-lumen-1025',
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1025',
    sellerId: 'sel-stella',
    role: 'gate_lead',
    phase: 'active',
    validDateText: '10/25(일)',
    validDateShortText: '10/25',
    validFromText: '13:30',
    validUntilText: '22:00',
    scannerName: '동문-03',
  },
  {
    // SCR-051 '배정 고르기'의 둘째 배정: LUMEN 10/26(월) 17:00 현장 스태프. 입장 15:30 - 3시간 = 12:30, 공연 끝 19:00 + 2시간 = 21:00
    id: 'sta-lumen-1026',
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1026',
    sellerId: 'sel-stella',
    role: 'gate_staff',
    phase: 'soon',
    validDateText: '10/26(월)',
    validDateShortText: '10/26',
    validFromText: '12:30',
    validUntilText: '21:00',
  },
  {
    // SCR-061 '지난 배정'(보드 [지난 회차 일시]). 회차 목업에는 앞으로의 회차만 있어 지난 회차 글을 여기에 둔다(추천안)
    id: 'sta-musical-0919',
    productionId: 'prd-musical',
    performanceLabel: '9/19(토) 19:30',
    sellerId: 'sel-stella',
    role: 'gate_staff',
    phase: 'ended',
    validDateText: '9/19(토)',
    validDateShortText: '9/19',
    validFromText: '15:30',
    validUntilText: '24:00',
  },
];

/** 대표 배정 id(하늘 · 현장 책임자 · LUMEN 10/25) */
export const DEMO_STAFF_ASSIGNMENT_ID = 'sta-lumen-1025';

export function getStaffAssignment(id: string): StaffAssignment | undefined {
  return STAFF_ASSIGNMENTS.find((a) => a.id === id);
}

/** 권한 유효 시간 '10/25(일) 13:30 ~ 22:00' */
export function staffValidText(a: StaffAssignment): string {
  return `${a.validDateText} ${a.validFromText} ~ ${a.validUntilText}`;
}

/** 시각만 '13:30 ~ 22:00' */
export function staffValidTimeText(a: StaffAssignment): string {
  return `${a.validFromText} ~ ${a.validUntilText}`;
}

/** 짧은 줄 '10/25 13:30~22:00'(SCR-051 '파트너 이름을 읽지 못함') */
export function staffValidCompactText(a: StaffAssignment): string {
  return `${a.validDateShortText} ${a.validFromText}~${a.validUntilText}`;
}

/** 스캐너에 로그인할 수 있게 되는 때 '10/25(일) 13:30' */
export function staffValidFromText(a: StaffAssignment): string {
  return `${a.validDateText} ${a.validFromText}`;
}
