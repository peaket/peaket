// 좌석 홀드 목업(SCR-010 좌석 선택 → SCR-011 주문·결제). 캔버스 보드 SCR-010의 값 그대로다.
// 홀드 7분·1회 3분 연장·구매 세션 최대 45분·무활동 5분(POL-009, d5 §5.10). 금액은 원 단위 정수.

export const HOLD_RULES = {
  /** 홀드 시간(분) */
  holdMinutes: 7,
  /** 연장 한 번에 더하는 시간(분), 횟수 */
  extendMinutes: 3,
  extendCount: 1,
  /** 구매 세션 최대 체류(분) */
  sessionMaxMinutes: 45,
} as const;

export interface HoldSummary {
  /** 'R1구역 12열 7번, 8번' */
  seatsText: string;
  grade: string;
  quantity: number;
  /** 합계(원) */
  amount: number;
  /** 1인 매수 한도 */
  perPerson: number;
  /** 화면이 센 남은 한도(이번 선택을 뺀 수) */
  remaining: number;
}

/** 직접 선택(PICK) 공연에서 고른·홀드한 좌석(E-1 LUMEN) */
export const DEMO_HOLD: HoldSummary = {
  seatsText: 'R1구역 12열 7번, 8번',
  grade: 'R석',
  quantity: 2,
  amount: 308000,
  perPerson: 4,
  remaining: 2,
};

/** 자동 배정(AUTO) 결과 유형(CMP-057 result) */
export type AutoAssignType = '1순위 연석' | '1순위 분리 좌석' | '2순위 연석' | '2순위 분리 좌석';

export interface AutoAssignResult {
  type: AutoAssignType;
  grade: string;
  seatsText: string;
  amount: number;
  /** 희망 조건 요약(SCR-008 ⑧과 같은 글) */
  wish: string;
  /** 수동 선택의 남은 등급 */
  remainingGrades: string[];
  quantity: number;
  perPerson: number;
}

/** 자동 배정 공연의 배정 결과(보드 SCR-010 '자동 배정 결과' 값 그대로) */
export const DEMO_AUTO_ASSIGN: AutoAssignResult = {
  type: '1순위 연석',
  grade: 'R석',
  seatsText: 'R1구역 3열 14번, 15번',
  amount: 308000,
  wish: '희망 R석 2매',
  remainingGrades: ['R석', 'S석'],
  quantity: 2,
  perPerson: 2,
};
