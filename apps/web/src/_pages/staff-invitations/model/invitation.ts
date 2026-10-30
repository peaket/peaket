// SCR-050 초대 한 건의 목업(캔버스 보드 SCR-050의 초대 요약 카드·두 동의 카드 문구를 옮겼다)과 배정·공연·회차·공연장·파트너를 합치는 일.
// 이메일은 가린 합성 주소다. 동의 고지 항목은 04-ia §3 SCR-050 ③④(개인정보 보호법 §15②·§17②)와 보드 문구 그대로다.
import { getPerformance } from '@/entities/performance';
import { getProduction, type PosterArt } from '@/entities/production';
import { getSeller } from '@/entities/seller';
import { DEMO_STAFF_ASSIGNMENT_ID, getStaffAssignment, STAFF_ROLE_LABEL, staffValidText } from '@/entities/staff-assignment';
import { getVenue } from '@/entities/venue';

export const INVITATION = {
  assignmentId: DEMO_STAFF_ASSIGNMENT_ID,
  /** 초대 이메일(이 계정의 검증된 이메일과 같다) */
  emailMasked: 'ha***@example.com',
  /** 상태 '이메일 불일치'의 초대 이메일(이 계정 이메일과 다르다) */
  otherEmailMasked: 'ha***@example.org',
} as const;

export interface InvitationSummary {
  title: string;
  posterArt: PosterArt;
  posterShort: string;
  /** '10/25(일) 18:00 · 피켓 아레나' */
  whenWhere: string;
  partnerName: string;
  roleLabel: string;
  /** '10/25(일) 13:30 ~ 22:00' */
  validText: string;
}

export function invitationSummary(): InvitationSummary {
  const a = getStaffAssignment(INVITATION.assignmentId);
  if (!a) throw new Error('초대 배정 목업이 없습니다');
  const production = getProduction(a.productionId);
  const perf = a.performanceId ? getPerformance(a.performanceId) : undefined;
  const venue = production ? getVenue(production.venueId) : undefined;
  return {
    title: production?.title ?? '',
    posterArt: production?.poster.art ?? 'lumen',
    posterShort: production?.poster.short ?? '',
    whenWhere: [perf?.label ?? a.performanceLabel, venue?.name].filter(Boolean).join(' · '),
    partnerName: getSeller(a.sellerId)?.name ?? '',
    roleLabel: STAFF_ROLE_LABEL[a.role],
    validText: staffValidText(a),
  };
}

/** 동의 카드의 고지 항목 한 줄 */
export interface ConsentRow {
  term: string;
  detail: string;
}

const REFUSAL = '동의를 거부할 수 있습니다. 동의하지 않으면 현장 스태프로 배정되지 않습니다.';

/** ③ 수집·이용 동의 네 항목 */
export const COLLECT_ROWS: readonly ConsentRow[] = [
  { term: '목적', detail: '현장 검표 배정과 스캔 기록' },
  { term: '항목', detail: '계정 ID · 닉네임 · 역할 · 스캔 기록' },
  { term: '보유 기간', detail: '회차 종료 뒤 1년' },
  { term: '거부권과 불이익', detail: REFUSAL },
];

/** ④ 파트너 제공 동의 다섯 항목(받는 자는 이 회차의 파트너 상호) */
export function provideRows(partnerName: string): ConsentRow[] {
  return [
    { term: '받는 자', detail: `${partnerName}(이 회차의 파트너)` },
    { term: '목적', detail: '현장 인력 관리' },
    { term: '항목', detail: '닉네임 · 역할 · 수락 여부 · 스캔 건수 · 예외 통과 건수' },
    { term: '보유 기간', detail: '회차가 끝나고 1년까지(피켓의 배정 기록과 같은 기간)' },
    { term: '거부권과 불이익', detail: REFUSAL },
  ];
}
