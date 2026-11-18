// 결제 후 일반 취소(부분·전액)의 값과 규칙(docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1, GAT-080).
// 입금 전 취소(deposit-cancel.ts)와 달리 APPROVED·PARTIAL_CANCELED 원장에서 결제사 부분 취소를 부르고,
// 성공한 금액을 payment.cancelled_amount에 더한다. 프레임워크·저장소를 모른다.
import { createHash } from 'node:crypto';
import { isLowerUuid, PaymentInputError, type PaymentLedgerStatus } from './confirm-command.js';
import type { PgName } from './payment-gateway.js';

/** 취소 ID: 영문자·숫자·_·- 9~64자. 결제사 멱등키 cancel-{취소 ID}가 포트원 규격(16자 이상)에 맞게 한다(docs/features/payment.md §4.1 '취소 ID의 길이') */
const CANCELLATION_ID = /^[A-Za-z0-9_-]{9,64}$/;
const CONTROL = /[\u0000-\u001f\u007f]/;
/** 취소 사유 길이 상한 200자 [가정](토스 cancelReason 상한과 같다) */
export const CONFIRMED_CANCEL_REASON_MAX = 200;
/** payment_event의 내부 표시: 결제사 일반 취소 호출 앞에 남긴다(exported = false) */
export const CONFIRMED_CANCEL_SENT_EVENT_TYPE = 'CONFIRMED_CANCEL_SENT';

/** gRPC 입력(검사 전) */
export interface ConfirmedCancelInput {
  readonly paymentId: string;
  readonly cancellationId: string;
  readonly reason: string;
  /** 환급액(원). 없으면 남은 전액이다 */
  readonly amount?: number;
  /**
   * 가상계좌 결제의 환불 계좌(검사 전, 선택). 모양이 맞을 때만 결제사 본문에 싣고 저장·기록하지 않는다
   * (docs/features/payment.md §6 '가상계좌 환불 계좌 전달의 첫 구현', BUILD_ORDER GAT-090)
   */
  readonly refundAccount?: { readonly bankCode: string; readonly accountNumber: string; readonly holderName: string };
}

/** 저장소가 읽은 원장 값 */
export interface ConfirmedCancelTarget {
  readonly paymentId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly pg: PgName;
  readonly paymentRef: string;
  readonly txId?: string;
  readonly amount: number;
  readonly cancelledAmount: number;
  readonly status: PaymentLedgerStatus;
}

/** 같은 결제의 다른 진행 중 취소 건이 이보다 어리면 보내지 않는다(10분 [가정], docs/features/payment.md §4.1 '취소 건 기록과 기대 잔액') */
export const CONFIRMED_CANCEL_BUSY_WINDOW_MS = 600_000;
/** 취소 건을 만든 지 이 시간 이상 지난 재시도는 먼저 조회한다(3시간 [가정], P-T21) */
export const CONFIRMED_CANCEL_QUERY_AFTER_MS = 10_800_000;

/** payment_cancel.status(docs/data.md payment_cancel) */
export type PaymentCancelStatus = 'REQUESTED' | 'CANCEL_PENDING' | 'CANCELED' | 'FAILED';

/** 첫 전송 직전에 저장한 취소 건(payment_cancel 한 행). 재시도는 이 값을 그대로 보낸다 */
export interface ConfirmedCancelRecord {
  /** cancel-{cancellationId} */
  readonly idemKey: string;
  readonly amount: number;
  readonly reason: string;
  readonly fullCancel: boolean;
  readonly expectedBalance: number;
  readonly status: PaymentCancelStatus;
  readonly createdAtMs: number;
}

/**
 * beginConfirmedCancel의 결과(BUILD_ORDER GAT-080, BAT-415 계획 §3).
 * BEGUN: 보낼 본문(replay = 이 취소 ID의 행이 이미 있었다), DONE: 그 행이 CANCELED, BUSY: 같은 결제의 다른 진행 중 행이 10분 안,
 * NOT_CONFIRMED: 원장이 APPROVED·PARTIAL_CANCELED가 아니다, NO_BALANCE: 새 취소인데 남은 금액 0 이하,
 * OVER_REMAINING: 요청액 > 결제 금액 − 누적 취소액 − 진행 중 다른 취소 합, AMOUNT_MISMATCH: 같은 취소 ID에 다른 금액
 */
export type ConfirmedCancelBegin =
  /** virtualAccount: 결제 행 잠금 안에서 본 가상계좌 결제 여부(AWAITING_DEPOSIT 사건이 있다). 없으면 거짓이다 */
  | { readonly status: 'BEGUN'; readonly record: ConfirmedCancelRecord; readonly replay: boolean; readonly virtualAccount?: boolean }
  /** 가상계좌 결제인데 환불 계좌가 없고 이 취소 ID의 행도 없다. 행을 만들지 않았다(docs/features/payment.md §6 '결제 후 일반 취소의 가상계좌 갈래') */
  | { readonly status: 'ACCOUNT_REQUIRED' }
  | { readonly status: 'DONE'; readonly cancelledAmount: number }
  | { readonly status: 'BUSY' }
  | { readonly status: 'NOT_CONFIRMED' }
  | { readonly status: 'NO_BALANCE' }
  | { readonly status: 'OVER_REMAINING' }
  | { readonly status: 'AMOUNT_MISMATCH' }
  /** 그 행이 FAILED(거절로 끝남). 결제사를 부르지 않고 REJECTED다(리뷰 B3, docs/features/payment.md §4.1 '같은 취소 ID의 재요청 세부' ③) */
  | { readonly status: 'REJECTED' };

/** 3시간 지난 재시도의 조회 대조. 잔액 = 기대 잔액 − 금액이면 APPLIED, = 기대 잔액이면 NOT_APPLIED, 그 밖 UNKNOWN(P-T21) */
export function settleByBalance(record: Pick<ConfirmedCancelRecord, 'amount' | 'expectedBalance'>, balanceAmount: number): 'APPLIED' | 'NOT_APPLIED' | 'UNKNOWN' {
  if (balanceAmount === record.expectedBalance - record.amount) return 'APPLIED';
  if (balanceAmount === record.expectedBalance) return 'NOT_APPLIED';
  return 'UNKNOWN';
}

/**
 * 3시간 지난 재시도에서 잔액으로 이 취소의 반영을 가를 수 있는가(리뷰 B1, docs/features/payment.md §4.1 '잔액으로 가르는 조건').
 * 지금 원장의 남은 금액이 저장한 기대 잔액과 같고, 같은 결제에 이 행 말고 진행 중 행이 없을 때만 참이다. BAT-415 리뷰 반영 빈 뼈대
 */
export function canSettleByBalance(q: { readonly ledgerRemaining: number; readonly expectedBalance: number; readonly otherInFlight: number }): boolean {
  return q.ledgerRemaining === q.expectedBalance && q.otherInFlight === 0;
}

/** CancelPaymentResponse.result의 앞머리를 뗀 값. REFUND_ACCOUNT_REQUIRED는 가상계좌 결제의 계좌 없음·계좌 거절이다(BUILD_ORDER GAT-090) */
export type ConfirmedCancelResult = 'CANCELLED' | 'CANCEL_PENDING' | 'REJECTED' | 'UNKNOWN' | 'REFUND_ACCOUNT_REQUIRED';

export interface ConfirmedCancelAnswer {
  readonly result: ConfirmedCancelResult;
  /** 이 취소까지 반영한 누적 취소액(원). 끝나지 않았으면 지금 값 */
  readonly cancelledAmount: number;
}

/** 입력을 검사한다. @throws PaymentInputError 결제 ID·취소 ID·사유·금액이 틀림 */
export function parseConfirmedCancel(input: ConfirmedCancelInput): ConfirmedCancelInput {
  if (!isLowerUuid(input.paymentId)) throw new PaymentInputError('payment_id');
  if (!CANCELLATION_ID.test(input.cancellationId)) throw new PaymentInputError('cancellation_id');
  if (input.reason.length === 0 || input.reason.length > CONFIRMED_CANCEL_REASON_MAX || CONTROL.test(input.reason)) throw new PaymentInputError('reason');
  if (input.amount !== undefined && (!Number.isSafeInteger(input.amount) || input.amount < 1)) throw new PaymentInputError('amount');
  return input;
}

/** 결제사 멱등키 cancel-{cancellationId}(입금 전 취소와 같은 규칙) */
export function confirmedCancelIdemKey(cancellationId: string): string {
  return `cancel-${cancellationId}`;
}

/** 내부 표시의 event_key(UUID 버전 8, 결제 ID·취소 ID에서 정해진다) */
export function confirmedCancelEventKey(paymentId: string, cancellationId: string): string {
  const b = Buffer.from(createHash('sha256').update(`ConfirmedCancel:${paymentId}:${cancellationId}`).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** 남은 취소 가능액 */
export function remainingCancellable(target: Pick<ConfirmedCancelTarget, 'amount' | 'cancelledAmount'>): number {
  return target.amount - target.cancelledAmount;
}

/** 일반 취소 대상 상태인가(승인·부분 취소만) */
export function isConfirmedStatus(status: PaymentLedgerStatus): boolean {
  return status === 'APPROVED' || status === 'PARTIAL_CANCELED';
}
