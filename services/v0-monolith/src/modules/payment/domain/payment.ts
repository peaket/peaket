// 결제 v0(docs/features/payment.md §13 동작 2 ③). 결제 확정 요청 안에서 결제사 승인을 부르고 응답을 기다린다(동기 결제 체인).

/** 결제 행 상태 */
export const PAYMENT_STATUSES = ['CONFIRMING', 'APPROVED', 'FAILED'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface PaymentRequest {
  /** 주문 ID(UUID). 결제사 주문 ID로도 쓰고 승인 멱등키는 confirm-{orderId}다 */
  orderId: string;
  eventId: string;
  /** 결제사가 결제창 인증 뒤 준 결제 참조(출력 가능한 ASCII 1~200자) */
  paymentKey: string;
  /** 서버가 계산한 주문 금액(원, 양의 정수) */
  amount: number;
  /** 유닉스 밀리초(결제 행 생성 시각, 결제사가 승인 시각을 주지 않을 때의 승인 시각) */
  nowMs: number;
}

/**
 * 결제 결과.
 * - approved: 결제사 APPROVED·ALREADY_APPROVED이고 승인 금액이 주문 금액과 같다
 * - declined: 결제사가 거절했다(422 payment-declined)
 * - failed: 그 밖(결과 모름·처리 중·입금 대기·금액 다름). 결제사에 다시 묻지 않는다(K7의 v0 한계, 502 payment-failed)
 * - already-exists: 그 주문의 결제 행이 이미 있다(결제사를 부르지 않는다)
 * failure는 결과와 결제사 코드(예 'DECLINED:REJECT_CARD_COMPANY', 'UNKNOWN')다
 */
export type PaymentResult =
  | { kind: 'approved'; paymentId: string; approvedAtMs: number }
  | { kind: 'declined'; paymentId: string; failure: string }
  | { kind: 'failed'; paymentId: string; failure: string }
  | { kind: 'already-exists' };

/**
 * 결제사가 승인했는데 결제 행에 승인을 적지 못했다(다시 적어도 실패). 결과를 아는 승인이므로 부르는 쪽은 좌석을 되돌리지 않는다
 * (결제 행은 CONFIRMING에 남고 불변식 P6이 센다, payment §13 동작 2 ③)
 */
export class ApprovalNotRecordedError extends Error {
  override name = 'ApprovalNotRecordedError';
  constructor(
    readonly paymentId: string,
    options?: { cause?: unknown },
  ) {
    super(`결제 ${paymentId}의 결제사 승인을 결제 행에 적지 못했다`, options);
  }
}

export interface Payments {
  confirm(r: PaymentRequest): Promise<PaymentResult>;
}
