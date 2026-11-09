// UNKNOWN 해소의 로그(BUILD_ORDER PRF-182, ASVS v5.0.0-16.2.5·16.3.4). 주문 ID·결제사만 싣고 결제 키·토큰·금액은 싣지 않는다.
// 오류 객체는 싣지 않고 safeErrorCode만 싣는다(드라이버 오류의 글에 SQL 문장 값이 실릴 수 있다).
import type { PlatformLogger } from '@peaket/platform';
import type { PaymentUnknownLog } from '../domain/ports.js';
import { safeErrorCode } from '../../../safe-error-code.js';

/** CS 처리함 건의 종류 표시(계약이 없어 로그 표시로만 둔다, GAT-280) */
export const PAYMENT_UNKNOWN_CS_CASE = 'PAYMENT_UNKNOWN';
/** FAILED로 끝난 결제에 입금이 확인된 건의 CS 처리함 표시(같은 까닭으로 로그 표시로만 둔다) */
export const PAYMENT_LATE_DEPOSIT_CS_CASE = 'PAYMENT_LATE_DEPOSIT';

/** 로그 때문에 실행기가 멈추지 않게 로거의 예외를 삼킨다 */
function quietly(write: () => void): void {
  try {
    write();
  } catch {
    // 삼킨다
  }
}

/**
 * 플랫폼 로거에 잇는다. 줄의 kind: amountMismatch는 error(payment-unknown-amount-mismatch, SEV1), orderMismatch는 error(payment-unknown-order-mismatch, SEV1),
 * cancelledAtPg는 error(payment-unknown-cancelled-at-pg, SEV1, csCase), lateDeposit은 error(payment-late-deposit, SEV1, csCase), overdue는 error(payment-unknown-overdue, SEV2, csCase), noAdapter는 warn(payment-unknown-no-adapter), writeFailed는 error(payment-unknown-write-failed, code),
 * staleAnswer는 warn(payment-unknown-stale), runError는 error(payment-unknown-run, what·code). 로거가 던져도 삼킨다
 */
export function paymentUnknownLog(logger: Pick<PlatformLogger, 'warn' | 'error'>): PaymentUnknownLog {
  return {
    amountMismatch: ({ orderId }) => quietly(() => logger.error({ kind: 'payment-unknown-amount-mismatch', severity: 'SEV1', orderId }, '결제사 조회 금액이 원장과 달라 승인으로 쓰지 않았다')),
    orderMismatch: ({ orderId }) => quietly(() => logger.error({ kind: 'payment-unknown-order-mismatch', severity: 'SEV1', orderId }, '결제사 조회 답의 주문 ID가 원장과 달라 결과로 쓰지 않았다')),
    cancelledAtPg: ({ orderId }) =>
      quietly(() => logger.error({ kind: 'payment-unknown-cancelled-at-pg', severity: 'SEV1', orderId, csCase: PAYMENT_UNKNOWN_CS_CASE }, '승인을 기록한 적 없는 결제를 결제사가 취소했다(사람이 본다)')),
    lateDeposit: ({ orderId }) => quietly(() => logger.error({ kind: 'payment-late-deposit', severity: 'SEV1', orderId, csCase: PAYMENT_LATE_DEPOSIT_CS_CASE }, '실패로 끝난 결제에 입금이 확인됐다(사람이 본다, 대사 단계가 닫는다)')),
    overdue: ({ orderId }) => quietly(() => logger.error({ kind: 'payment-unknown-overdue', severity: 'SEV2', orderId, csCase: PAYMENT_UNKNOWN_CS_CASE }, '결과를 모르는 결제가 1시간 넘게 풀리지 않았다')),
    noAdapter: ({ pg }) => quietly(() => logger.warn({ kind: 'payment-unknown-no-adapter', pg }, '결제사 어댑터가 없어 단독 조회를 건너뛰었다')),
    writeFailed: ({ orderId, code }) => quietly(() => logger.error({ kind: 'payment-unknown-write-failed', orderId, code }, '단독 조회 결과를 쓰지 못했다(다음 간격에 다시 조회한다)')),
    staleAnswer: ({ orderId }) => quietly(() => logger.warn({ kind: 'payment-unknown-stale', orderId }, '원장이 이미 UNKNOWN이 아니어서 조회 답을 쓰지 않았다')),
    depositReversed: ({ orderId }) => quietly(() => logger.warn({ kind: 'payment-deposit-reversed', orderId }, '결제사가 입금을 되돌려 입금 대기로 되돌렸다')),
    reversalUnconfirmed: ({ orderId }) => quietly(() => logger.warn({ kind: 'payment-deposit-reversal-unconfirmed', orderId }, '입금 오류 통보 뒤 10분이 지나도 결제사가 입금 완료라고 답해 되돌림 확인을 끝냈다')),
    reversalOverdue: ({ orderId }) => quietly(() => logger.error({ kind: 'payment-deposit-reversal-overdue', severity: 'SEV1', orderId }, '입금 오류 통보 뒤 1시간이 지나도 결제사 조회로 되돌림을 확인하지 못했다(사람이 본다, 조회는 이어 간다)')),
    runError: ({ what, orderId, err }) => quietly(() => logger.error({ kind: 'payment-unknown-run', what, code: safeErrorCode(err), ...(orderId === undefined ? {} : { orderId }) }, 'UNKNOWN 조회 실행기 처리 실패')),
  };
}
