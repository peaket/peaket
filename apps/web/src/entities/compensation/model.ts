// 배상 건 목업(SCR-043 캔버스 보드 예시: 주최 측 사정으로 취소된 LUMEN 10/26(월) 17:00 R석 1매, 배상금은 실제 결제 금액의 10%).
// 공연·회차는 id로만 가진다. 실제 결제 금액은 페이지가 공연 등급 가격 × 매수로 읽는다. 값은 모두 합성이다.

export interface Compensation {
  id: string;
  /** 배상 사유 */
  reason: string;
  productionId: string;
  performanceId: string;
  /** 'R석' */
  grade: string;
  quantity: number;
  /** 송금 요청 시각 '10/23(금) 09:12'(완료 화면 타임라인) */
  requestedAtText: string;
}

/** 배상 비율(%) — 분쟁해결기준(실제 결제 금액의 10%) */
export const COMPENSATION_RATE_PERCENT = 10;

export const COMPENSATIONS: readonly Compensation[] = [
  {
    id: 'cmp-0001',
    reason: '주최 측 사정으로 공연이 취소되었습니다',
    productionId: 'prd-lumen',
    performanceId: 'evt-lumen-1026',
    grade: 'R석',
    quantity: 1,
    requestedAtText: '10/23(금) 09:12',
  },
];

/** 대표 배상 id(경로 예시 /my/compensations/cmp-0001) */
export const DEMO_COMPENSATION_ID = 'cmp-0001';

export function getCompensation(id: string): Compensation | undefined {
  return COMPENSATIONS.find((c) => c.id === id);
}

/** 실제 결제 금액 → 배상금(원 단위로 내림) */
export function compensationAmount(paidAmount: number): number {
  return Math.floor((paidAmount * COMPENSATION_RATE_PERCENT) / 100);
}
