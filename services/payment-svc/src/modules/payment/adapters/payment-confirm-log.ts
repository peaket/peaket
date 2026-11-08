// 승인 실행기의 로그(BUILD_ORDER PRF-181, ASVS v5.0.0-16.2.5). 주문 ID·결제사만 싣고 결제 키·토큰·금액은 싣지 않는다.
// 오류 객체는 싣지 않고 safeErrorCode만 싣는다(드라이버 오류의 글에 SQL 문장 값이 실릴 수 있다).
import type { PlatformLogger } from '@peaket/platform';
import type { PaymentConfirmLog } from '../domain/ports.js';
import { safeErrorCode } from '../../../safe-error-code.js';

/** 로그 때문에 실행기가 멈추지 않게 로거의 예외를 삼킨다 */
function quietly(write: () => void): void {
  try {
    write();
  } catch {
    // 삼킨다
  }
}

/**
 * 플랫폼 로거에 잇는다. 줄의 kind: amountMismatch는 error(payment-confirm-amount-mismatch, SEV1, severity 칸), noAdapter는 warn(payment-confirm-no-adapter),
 * writeFailed는 error(payment-confirm-write-failed, code·stage), staleAnswer는 warn(payment-confirm-stale), runError는 error(payment-confirm-run, what·code). 로거가 던져도 삼킨다
 */
export function paymentConfirmLog(logger: Pick<PlatformLogger, 'warn' | 'error'>): PaymentConfirmLog {
  return {
    amountMismatch: ({ orderId }) => quietly(() => logger.error({ kind: 'payment-confirm-amount-mismatch', severity: 'SEV1', orderId }, '결제사 승인 금액이 원장과 다르거나 답에 없어 UNKNOWN으로 썼다')),
    noAdapter: ({ pg }) => quietly(() => logger.warn({ kind: 'payment-confirm-no-adapter', pg }, '결제사 어댑터가 없어 승인 명령을 미뤘다')),
    writeFailed: ({ orderId, stage, code }) => quietly(() => logger.error({ kind: 'payment-confirm-write-failed', orderId, stage, code }, '승인 실행기 쓰기가 다시 해도 실패했다')),
    staleAnswer: ({ orderId }) => quietly(() => logger.warn({ kind: 'payment-confirm-stale', orderId }, '원장이 이미 ACCEPTED가 아니어서 늦은 답을 쓰지 않았다')),
    runError: ({ what, orderId, err }) => quietly(() => logger.error({ kind: 'payment-confirm-run', what, code: safeErrorCode(err), ...(orderId === undefined ? {} : { orderId }) }, '승인 실행기 처리 실패')),
  };
}
