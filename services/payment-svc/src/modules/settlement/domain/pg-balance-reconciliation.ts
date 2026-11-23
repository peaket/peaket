// 토스 결제 상점별 결제사 잔액 대사의 순수 규칙(F-07-6 LCH-110, settlement §5.5·§11, ADR-0369 결정 2·11).
// 있어야 할 잔액 = 대사 끝난 승인 − 취소·환불 − 결제사 수수료(정산 조회 fees 누적 + 지급대행 이용료) − 완료한 지급 − PEAKET 몫 인출(0).
// 이용료 = 첫 토스 지급이 생긴 달부터 달마다 월 고정 + (그달 지급 건 수 − 무료 건수)⁺ × 건당 [가정].
// 차이 0이면 NONE, 0이 아니면 CS 건(CASE), 절댓값 1만 원 [가정]을 넘으면 SEV3다.
import type { TossPayoutTerms } from './payout-adapters.js';
import type { PgBalanceReconciliationRecord } from './settlement.js';

/** SEV3로 올리는 차이(절댓값, 원) [가정] */
export const PG_BALANCE_SEV3_KRW = 10_000;

const nextMonth = (month: string): string => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};

/**
 * 첫 지급 달부터 throughMonth('YYYY-MM')까지 달마다 센 지급대행 이용료 합. 지급이 없는 달도 월 고정이 붙는다.
 * throughMonth 뒤의 달은 세지 않는다(그 대사 시각까지의 누적).
 */
export function payoutUsageFee(payoutCountByMonth: Readonly<Record<string, number>>, throughMonth: string, terms: TossPayoutTerms): number {
  const months = Object.keys(payoutCountByMonth)
    .filter((m) => /^\d{4}-\d{2}$/.test(m) && m <= throughMonth && (payoutCountByMonth[m] ?? 0) > 0)
    .sort();
  const first = months[0];
  if (first === undefined) return 0;
  let fee = 0;
  for (let m = first; m <= throughMonth; m = nextMonth(m)) {
    const count = payoutCountByMonth[m] ?? 0;
    fee += terms.feeMonthlyKrw + Math.max(0, count - terms.feeFreeCount) * terms.feePerItemKrw;
  }
  return fee;
}

export function pgBalanceSeverity(diffAmount: number): PgBalanceReconciliationRecord['severity'] {
  if (diffAmount === 0) return 'NONE';
  return Math.abs(diffAmount) > PG_BALANCE_SEV3_KRW ? 'SEV3' : 'CASE';
}

/** 그 시각의 KST 달('YYYY-MM') */
export const kstMonthOf = (at: Date): string => new Date(at.getTime() + 9 * 60 * 60 * 1_000).toISOString().slice(0, 7);
