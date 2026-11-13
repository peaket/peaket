// 입금 전 취소의 값과 규칙(docs/features/payment.md §6 '입금 전 취소와 입금 오류 되돌림의 첫 구현', BUILD_ORDER HOT-152, ADR-0062).
// 프레임워크·저장소를 모른다(순수 값과 함수). 결제사 호출과 쓰기는 application/cancel-deposit-payment.ts가 한다.
import { createHash } from 'node:crypto';
import { isLowerUuid, PaymentInputError, type PaymentLedgerStatus } from './confirm-command.js';
import type { CancelResult, PgName, QueryResult } from './payment-gateway.js';

/** 취소 ID: 결제사 멱등키 cancel-{취소 ID}의 재료(CANCEL_IDEM_KEY와 같은 글자) */
const CANCELLATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** 사유의 제어 문자(로그·결제사 요청에 끼어들지 않게) */
const CONTROL = /[\u0000-\u001f\u007f]/;

/** payment_event의 내부 표시: 결제사 취소 호출 앞에 남긴다(exported = false). event_key가 취소 ID에서 정해져 같은 취소 ID를 알아본다 */
export const DEPOSIT_CANCEL_SENT_EVENT_TYPE = 'DEPOSIT_CANCEL_SENT';
/** 취소 사유 길이 상한 200자 [가정](토스 cancelReason 상한과 같다) */
export const DEPOSIT_CANCEL_REASON_MAX = 200;
/** 입금 전 취소가 결제사 호출 한 번을 기다리는 시간 10초 [가정](단독 조회 한도와 같다) */
export const DEPOSIT_CANCEL_CALL_TIMEOUT_MS = 10_000;

/** payment_deposit_cancel_total{outcome}의 값 */
export const DEPOSIT_CANCEL_OUTCOMES = ['cancelled', 'replayed', 'pending', 'rejected', 'unknown', 'not_waiting', 'invalid'] as const;
export type DepositCancelOutcome = (typeof DEPOSIT_CANCEL_OUTCOMES)[number];

/** gRPC 입력(검사 전) */
export interface DepositCancelInput {
  readonly paymentId: string;
  readonly cancellationId: string;
  readonly reason: string;
  /** 금액(원). 칸이 없으면 전액이다 */
  readonly amount?: number;
}

/** 저장소가 읽은 원장 값 */
export interface DepositCancelTarget {
  readonly paymentId: string;
  readonly orderId: string;
  readonly eventId: string;
  readonly attemptNo: number;
  readonly pg: PgName;
  readonly paymentRef: string;
  readonly txId?: string;
  readonly amount: number;
}

/** beginDepositCancel의 결과. DONE은 그 취소 ID로 이미 끝났다, NOT_WAITING은 입금 대기가 아니다 */
export type DepositCancelBegin = 'BEGUN' | 'DONE' | 'NOT_WAITING';

/** CancelPaymentResponse.result의 앞머리를 뗀 값 */
export type DepositCancelResult = 'CANCELLED' | 'CANCEL_PENDING' | 'REJECTED' | 'UNKNOWN';

/** 답. 입금 전이라 취소 금액은 늘 0원이다 */
export interface DepositCancelAnswer {
  readonly result: DepositCancelResult;
}

/** 입금 대기가 아닌 결제의 CancelPayment(gRPC FAILED_PRECONDITION. 일반 취소는 GAT-080). 글에는 내부 값을 싣지 않는다 */
export class PaymentCancelStateError extends Error {
  readonly code = 'FAILED_PRECONDITION' as const;
  constructor(message = '입금 대기 결제만 입금 전 취소할 수 있다') {
    super(message);
    this.name = 'PaymentCancelStateError';
  }
}

/** 취소 답·조회 답 → 할 일. FINISH면 원장을 FAILED로 쓴다, ANSWER면 그 결과로 답하고 원장은 그대로다 */
export type DepositCancelDecision = { readonly kind: 'FINISH' } | { readonly kind: 'ANSWER'; readonly result: DepositCancelResult };

/**
 * 입력을 검사한다.
 * @throws PaymentInputError 결제 ID·취소 ID·사유가 틀렸거나 금액이 비지 않았는데 전액이 아니다(전액 대조는 parse에 ledgerAmount를 주었을 때만)
 */
export function parseDepositCancel(input: DepositCancelInput): DepositCancelInput {
  if (!isLowerUuid(input.paymentId)) throw new PaymentInputError('payment_id');
  if (!CANCELLATION_ID.test(input.cancellationId)) throw new PaymentInputError('cancellation_id');
  if (input.reason.length === 0 || input.reason.length > DEPOSIT_CANCEL_REASON_MAX || CONTROL.test(input.reason)) throw new PaymentInputError('reason');
  if (input.amount !== undefined && (!Number.isSafeInteger(input.amount) || input.amount < 1)) throw new PaymentInputError('amount');
  return input;
}

/** 결제사 멱등키 cancel-{cancellationId} */
export function depositCancelIdemKey(cancellationId: string): string {
  return `cancel-${cancellationId}`;
}

/** 내부 표시의 event_key(UUID 버전 8, 결제 ID·취소 ID에서 정해진다) */
export function depositCancelEventKey(paymentId: string, cancellationId: string): string {
  const b = Buffer.from(createHash('sha256').update(`DepositCancel:${paymentId}:${cancellationId}`).digest().subarray(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x80;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/**
 * 취소 답과 조회 답으로 결과를 정한다. 던지지 않는다. 결과는 조회가 정한다(취소 답만으로 원장을 쓰지 않는다).
 * @param cancel 결제사 취소 답
 * @param query 뒤따른 단독 조회 답
 * @param target 원장 값(주문·금액 대조)
 */
export function decideDepositCancel(cancel: CancelResult, query: QueryResult, target: Pick<DepositCancelTarget, 'orderId'>): DepositCancelDecision {
  if (query.kind !== 'FOUND' || query.orderRef !== target.orderId) return ANSWER_UNKNOWN;
  switch (query.status) {
    case 'CANCELED':
    case 'FAILED':
    case 'EXPIRED':
      return FINISH;
    case 'APPROVED':
    case 'PARTIAL_CANCELED':
      // 입금이 먼저 들어왔다: 입금 확인 경로가 T16으로 잇는다
      return ANSWER_REJECTED;
    default:
      if (cancel.outcome === 'REJECTED') return ANSWER_REJECTED;
      return cancel.outcome === 'UNKNOWN' ? ANSWER_UNKNOWN : ANSWER_PENDING;
  }
}

/**
 * 답 반영이 STALE일 때(조회 뒤 원장이 먼저 끝났다) 다시 읽은 상태 → 답. FAILED(취소·기한 경과)는 좌석이 풀리는 끝이라 CANCELLED, APPROVED는 입금이 먼저라 REJECTED, 그 밖은 UNKNOWN이다(BUILD_ORDER HOT-152 코드 리뷰).
 * @param status 다시 읽은 원장 상태. 없으면 undefined
 */
export function depositCancelStaleResult(status: PaymentLedgerStatus | undefined): DepositCancelResult {
  if (status === 'FAILED') return 'CANCELLED';
  return status === 'APPROVED' ? 'REJECTED' : 'UNKNOWN';
}

const FINISH: DepositCancelDecision = { kind: 'FINISH' };
const ANSWER_UNKNOWN: DepositCancelDecision = { kind: 'ANSWER', result: 'UNKNOWN' };
const ANSWER_REJECTED: DepositCancelDecision = { kind: 'ANSWER', result: 'REJECTED' };
const ANSWER_PENDING: DepositCancelDecision = { kind: 'ANSWER', result: 'CANCEL_PENDING' };

