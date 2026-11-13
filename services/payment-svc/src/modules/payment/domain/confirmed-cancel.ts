// 결제 후 일반 취소(부분·전액)의 값과 규칙(docs/features/payment.md §4.1, docs/features/transfer-refund.md §3.1, GAT-080).
// 입금 전 취소(deposit-cancel.ts)와 달리 APPROVED·PARTIAL_CANCELED 원장에서 결제사 부분 취소를 부르고,
// 성공한 금액을 payment.cancelled_amount에 더한다. 프레임워크·저장소를 모른다.
import { createHash } from 'node:crypto';
import { isLowerUuid, PaymentInputError, type PaymentLedgerStatus } from './confirm-command.js';
import type { PgName } from './payment-gateway.js';

const CANCELLATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
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

/** beginConfirmedCancel의 결과. DONE은 그 취소 ID로 이미 끝났다, NOT_CONFIRMED는 일반 취소 대상 상태가 아니다 */
export type ConfirmedCancelBegin = 'BEGUN' | 'DONE' | 'NOT_CONFIRMED';

/** CancelPaymentResponse.result의 앞머리를 뗀 값 */
export type ConfirmedCancelResult = 'CANCELLED' | 'CANCEL_PENDING' | 'REJECTED' | 'UNKNOWN';

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
