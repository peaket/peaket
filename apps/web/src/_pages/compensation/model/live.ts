// SCR-043 배상금 계좌 입력의 실제 API 값 해석(F-07-15 I-04).
// 서버가 준 칸만 옮기고 모르는 칸은 버린다. 계좌 원문은 응답에도 화면 값에도 두지 않는다.
const textOf = (v: unknown): string => (typeof v === 'string' ? v : '');
const intAtLeast0 = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : null);

export type CompensationStatus = 'ACCOUNT_PENDING' | 'REQUESTED' | 'PAID' | 'FAILED';
const STATUSES: readonly CompensationStatus[] = ['ACCOUNT_PENDING', 'REQUESTED', 'PAID', 'FAILED'];

export interface CompensationView {
  compensationId: string;
  orderId: string;
  eventId: string;
  amount: number;
  status: CompensationStatus;
  /** 계좌 폼을 그린다 */
  form: boolean;
  requested: boolean;
  paid: boolean;
  failed: boolean;
  reasonText: string;
  accountLast4: string | null;
  createdAt: string;
}

export function compensationReasonText(reason: unknown): string {
  if (reason === 'ORGANIZER') return '주최 측 사정으로 공연이 취소되었습니다';
  if (reason === 'CONTENT_CHANGE') return '공연 내용이 변경되었습니다';
  return '';
}

/** 배상금 응답을 화면 값으로 바꾼다. 금액·상태·사유가 계약 밖이면 null이다 */
export function compensationViewOf(raw: unknown): CompensationView | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const v = raw as Record<string, unknown>;
  const amount = intAtLeast0(v.amount);
  const status = v.status as CompensationStatus;
  const reasonText = compensationReasonText(v.reason);
  if (amount === null || !STATUSES.includes(status) || reasonText === '') return null;
  return {
    compensationId: textOf(v.compensationId),
    orderId: textOf(v.orderId),
    eventId: textOf(v.eventId),
    amount,
    status,
    form: status === 'ACCOUNT_PENDING',
    requested: status === 'REQUESTED',
    paid: status === 'PAID',
    failed: status === 'FAILED',
    reasonText,
    accountLast4: typeof v.accountLast4 === 'string' ? v.accountLast4 : null,
    createdAt: textOf(v.createdAt),
  };
}
