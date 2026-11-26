// SCR-060 지연 환급 계좌 입력의 실제 API 값 해석(F-07-15 I-05).
// 취소 상세에서 화면이 쓰는 칸만 옮기고 계좌 원문 칸은 담지 않는다.
const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const intAtLeast0 = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

export type CancellationStatus = 'REQUESTED' | 'REFUND_PENDING' | 'REFUNDED' | 'VOIDED';
const STATUSES: readonly CancellationStatus[] = ['REQUESTED', 'REFUND_PENDING', 'REFUNDED', 'VOIDED'];

export interface CancellationView {
  cancellationId: string;
  orderId: string;
  eventId: string;
  refundAmount: number;
  deductionAmount: number;
  /** 공제율(%). deductionBp ÷ 100 */
  deductionPercent: number;
  reason: string;
  status: CancellationStatus;
  /** 지금 계좌를 입력해야 한다 */
  form: boolean;
  done: boolean;
  createdAt: string;
}

/** 취소 상세를 화면 값으로 바꾼다. 금액·공제율·상태가 계약 밖이면 null이다 */
export function cancellationViewOf(raw: unknown): CancellationView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const refundAmount = intAtLeast0(v.refundAmount);
  const deductionAmount = intAtLeast0(v.deductionAmount);
  const deductionBp = intAtLeast0(v.deductionBp);
  const status = v.status as CancellationStatus;
  if (refundAmount === null || deductionAmount === null || deductionBp === null || deductionBp > 10_000) return null;
  if (!STATUSES.includes(status) || typeof v.refundAccountRequired !== 'boolean') return null;
  return {
    cancellationId: textOf(v.cancellationId),
    orderId: textOf(v.orderId),
    eventId: textOf(v.eventId),
    refundAmount,
    deductionAmount,
    deductionPercent: deductionBp / 100,
    reason: textOf(v.reason),
    status,
    form: status === 'REFUND_PENDING' && v.refundAccountRequired,
    done: status === 'REFUNDED',
    createdAt: textOf(v.createdAt),
  };
}
