// 현장 스태프 배정 목업(캔버스 보드 SCR-050·051·061의 LUMEN 10/25 현장 책임자 배정·10/26 배정·지난 배정과 d5 §5.26·5.27·5.35를 옮겼다).
// 값은 모두 합성이고 시각은 KST 표기 글이다. 공연·회차·판매자(파트너)는 id로만 가진다(entities끼리 가져오지 않는다).
// 공연 이름·회차 글·공연장·파트너 상호는 페이지가 production·performance·venue·seller 목업에서 읽어 합친다.
import { dateTimeText, kstParts } from '../../shared/lib/kst.ts';

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

// ── 실제 응답(BUILD_ORDER F-05-7 = GAT-240, d5 §5.35, ADR-0362) ──
// 아래는 서버 응답(openapi StaffAssignmentSelf·StaffAssignment)을 다루는 순수 함수다. 위 목업은 ?state= 미리보기가 쓴다.

/** openapi StaffAssignmentSelf(내 현장 배정 한 줄). 공연명·상호는 eventId로 회차 공개 요약에서 읽는다 */
export interface StaffAssignmentSelf {
  assignmentId: string;
  eventId: string;
  role: StaffRole;
  status: 'ASSIGNED' | 'REVOKED' | 'ENDED';
  validFrom: string;
  validUntil: string;
  activeScannerDeviceName: string | null;
}

const isRole = (v: unknown): v is StaffRole => v === 'gate_lead' || v === 'gate_staff';
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** 응답 한 줄 → StaffAssignmentSelf. 모양이 틀리면 null(그 쪽 전체를 실패로 본다) */
export function staffAssignmentSelfOf(v: unknown): StaffAssignmentSelf | null {
  const r = v as Partial<Record<keyof StaffAssignmentSelf, unknown>> | null;
  if (!r || typeof r !== 'object') return null;
  if (typeof r.assignmentId !== 'string' || typeof r.eventId !== 'string' || !isRole(r.role)) return null;
  if (r.status !== 'ASSIGNED' && r.status !== 'REVOKED' && r.status !== 'ENDED') return null;
  if (!isTime(r.validFrom) || !isTime(r.validUntil)) return null;
  const name = r.activeScannerDeviceName;
  if (name !== undefined && name !== null && typeof name !== 'string') return null;
  return {
    assignmentId: r.assignmentId,
    eventId: r.eventId,
    role: r.role,
    status: r.status,
    validFrom: r.validFrom,
    validUntil: r.validUntil,
    activeScannerDeviceName: typeof name === 'string' && name !== '' ? name : null,
  };
}

/**
 * 배지(d5 §5.35 '배지와 칸', I-T93 ①). REVOKED는 해제, ENDED는 종료. ASSIGNED는 지금이 validFrom 전이면 곧 시작,
 * validFrom ≤ 지금 ≤ validUntil이면 진행 중(양 끝 포함), validUntil 뒤면 종료다. 시각을 읽지 못하면 종료로 둔다
 */
export function staffPhaseAt(a: { status: string; validFrom: string; validUntil: string }, nowMs: number): StaffAssignmentPhase {
  if (a.status === 'REVOKED') return 'revoked';
  if (a.status !== 'ASSIGNED') return 'ended';
  const from = Date.parse(a.validFrom);
  const until = Date.parse(a.validUntil);
  if (Number.isNaN(from) || Number.isNaN(until)) return 'ended';
  if (nowMs < from) return 'soon';
  if (nowMs <= until) return 'active';
  return 'ended';
}

/** 위 칸(현재 배정)에 두는가: 곧 시작·진행 중과 validUntil이 지나지 않은(지금 ≤ validUntil) 해제. 나머지는 지난 배정(d5 §5.35) */
export function isCurrentAssignment(a: { status: string; validFrom: string; validUntil: string }, nowMs: number): boolean {
  const phase = staffPhaseAt(a, nowMs);
  if (phase === 'soon' || phase === 'active') return true;
  if (phase !== 'revoked') return false;
  const until = Date.parse(a.validUntil);
  return !Number.isNaN(until) && nowMs <= until;
}

/** 한국 시각 조각(shared/lib/kst.ts의 글 모양과 같다) */
function kst(ms: number): { m: number; d: number; wd: string; hm: string } {
  const k = kstParts(ms);
  return { m: k.m, d: k.d, wd: k.wd, hm: `${k.hh}:${k.mm}` };
}

/** 회차 시작 '10/25(일) 18:00'(KST). 틀리면 '' */
export function staffWhenText(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  return dateTimeText(t);
}

/** 권한 유효 시간 '10/25(일) 13:30 ~ 22:00'(끝이 다른 날이면 '10/26(월) 00:30'처럼 날짜를 붙인다). 틀리면 '' */
export function staffValidRangeText(fromIso: string, untilIso: string): string {
  const f = Date.parse(fromIso);
  const u = Date.parse(untilIso);
  if (Number.isNaN(f) || Number.isNaN(u)) return '';
  const a = kst(f);
  const b = kst(u);
  const sameDay = a.m === b.m && a.d === b.d;
  return `${a.m}/${a.d}(${a.wd}) ${a.hm} ~ ${sameDay ? b.hm : `${b.m}/${b.d}(${b.wd}) ${b.hm}`}`;
}

/** 짧은 줄 '10/25 13:30~22:00'(SCR-051 '파트너 이름을 읽지 못함'의 배정 줄). 틀리면 '' */
export function staffValidCompactRangeText(fromIso: string, untilIso: string): string {
  const f = Date.parse(fromIso);
  const u = Date.parse(untilIso);
  if (Number.isNaN(f) || Number.isNaN(u)) return '';
  const a = kst(f);
  const b = kst(u);
  return `${a.m}/${a.d} ${a.hm}~${b.hm}`;
}

/** 시각만 '13:30 ~ 22:00'. 틀리면 '' */
export function staffValidTimeRangeText(fromIso: string, untilIso: string): string {
  const f = Date.parse(fromIso);
  const u = Date.parse(untilIso);
  if (Number.isNaN(f) || Number.isNaN(u)) return '';
  return `${kst(f).hm} ~ ${kst(u).hm}`;
}

/** 유효 시작 '10/25(일) 13:30'(곧 시작 안내). 틀리면 '' */
export function staffValidFromAtText(fromIso: string): string {
  return staffWhenText(fromIso);
}
