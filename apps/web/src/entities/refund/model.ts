// 지연 환급 건 목업(SCR-060 캔버스 보드 예시: d5 §10.3 E-3 소극장 뮤지컬 1매 가상계좌 결제, 공연 당일 입장 시작 뒤 취소로 90% 공제).
// 주문은 id로만 가진다. 결제 금액·공연·회차·결제 수단은 페이지가 order·production·performance에서 읽는다. 값은 모두 합성이다.

export interface DelayedRefund {
  /** 경로의 refundId(= 취소 ID) */
  id: string;
  orderId: string;
  /** 취소 공제율(%) */
  deductionPercent: number;
  /** 공제 이유 한 줄 */
  deductionNote: string;
  /** 환급하는 이유 한 줄 */
  reasonText: string;
}

export const DELAYED_REFUNDS: readonly DelayedRefund[] = [
  {
    id: 'rfd-0001',
    orderId: 'ord-20261012-0004',
    deductionPercent: 90,
    deductionNote: '공연 당일 입장 시작 뒤 취소라 90%를 공제합니다',
    reasonText: '입장 기록이 없어 환급합니다',
  },
];

/** 대표 환급 id(경로 예시 /my/refunds/rfd-0001/account) */
export const DEMO_REFUND_ID = 'rfd-0001';

export function getDelayedRefund(id: string): DelayedRefund | undefined {
  return DELAYED_REFUNDS.find((r) => r.id === id);
}

/** 결제 금액·공제율 → 공제액과 환급액(원) */
export function refundBreakdown(paidAmount: number, deductionPercent: number): { deduction: number; refund: number } {
  const deduction = Math.round((paidAmount * deductionPercent) / 100);
  return { deduction, refund: paidAmount - deduction };
}
