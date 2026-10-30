// SCR-044 회차 취소·연기 요청 목업(합성 데이터). 숫자·시각은 보드 SCR-044-m·t·d 그대로다.
// 배상 합계 ₩4,804,800 = 312명 × R석 ₩154,000의 10%(POL-038, 배상은 대상 수·합계만 보인다).

export type FaultOpinion = '의견 없음' | '주최 측 귀책' | '불가항력' | '공연 내용 변경';

export const FAULT_OPTIONS: readonly FaultOpinion[] = ['의견 없음', '주최 측 귀책', '불가항력', '공연 내용 변경'];

export interface PostponeRequest {
  kind: '취소' | '연기';
  /** 입력 칸 값(공연장 시각) */
  newAtInput: string;
  /** 표시용 '10/31(토) 18:00 KST' */
  newAt: string;
  reason: string;
  /** 증빙 참조(evidenceRef). 파일은 받지 않는다 */
  evidenceRef: string;
  fault: FaultOpinion;
  requestedAt: string;
  requestedBy: string;
  /** 판정 기한(요청 뒤 1영업일) */
  judgeDueAt: string;
}

/** 지금 판정을 기다리는(또는 확정된) 연기 요청 */
export const postponeRequest: PostponeRequest = {
  kind: '연기',
  newAtInput: '2026-10-31(토) 18:00',
  newAt: '10/31(토) 18:00 KST',
  reason: '무대 설비 교체 일정이 늦어져 회차를 옮깁니다.',
  evidenceRef: '[증빙 참조]',
  fault: '불가항력',
  requestedAt: '10/19(월) 14:20 KST',
  requestedBy: '파트너 관리자',
  judgeDueAt: '10/20(화) 14:20 KST',
};

/** 앞서 반려된 요청(판정 전 반려, docs/planning/03 §2.11) */
export const rejectedRequest = {
  requestedAt: '10/16(금) 11:30 KST',
  rejectedAt: '10/16(금) 16:20 KST',
  reason: '[운영자가 적은 반려 사유]',
};

/** 판정·확정 뒤 */
export const decision = {
  judgedAt: '10/20(화) 10:40 KST',
  verdict: '주최 측 귀책',
  verdictReason: '[운영자가 적은 판정 사유]',
  confirmedAt: '10/20(화) 15:05 KST',
  approvers: 2,
};

/** 환불·환급 진행(연기: 팬 환급 신청분) */
export const refundProgress = {
  requested: 312,
  done: 200,
  percent: 64,
  deadline: '10/31(토) 18:00 KST',
  compensationTargets: 312,
  compensationTotal: 4_804_800,
};
