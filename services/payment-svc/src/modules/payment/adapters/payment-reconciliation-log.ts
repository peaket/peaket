// 대사 로그(docs/features/payment.md §8 '대사의 첫 구현', BUILD_ORDER HOT-153, ASVS v5.0.0-16.2.5·16.3.3). 주문 ID·결제사·종류만 싣는다. 금액·결제 키는 싣지 않는다.
import type { PlatformLogger } from '@peaket/platform';
import type { PaymentReconciliationLog } from '../domain/ports.js';

/** 로그 때문에 대사가 멈추지 않게 로거의 예외를 삼킨다 */
function quietly(write: () => void): void {
  try {
    write();
  } catch {
    // 삼킨다
  }
}

/** 플랫폼 로거에 잇는다: mismatch(SEV1, payment-reconciliation-mismatch), failed·overdue(SEV2), mismatchSuppressed(SEV1 요약 한 줄), done(info), calendarUnavailable·runLost·recheckMissing(warn). 로거가 던져도 삼킨다 */
export function paymentReconciliationLog(logger: Pick<PlatformLogger, 'error' | 'warn' | 'info'>): PaymentReconciliationLog {
  return {
    mismatch: ({ pg, diffKind, orderId, csCase }) => quietly(() => logger.error({ kind: 'payment-reconciliation-mismatch', severity: 'SEV1', pg, diffKind, ...(orderId === undefined ? {} : { orderId }), ...(csCase === undefined ? {} : { csCase }) }, '대사에서 불일치를 찾았다')),
    failed: ({ pg, date, code }) => quietly(() => logger.error({ kind: 'payment-reconciliation-failed', severity: 'SEV2', pg, date, code }, '대사 실행이 실패했다(다음 날 다시 한다)')),
    done: ({ pg, date, listed, matched, mismatched, seconds, perSecond }) => quietly(() => logger.info({ kind: 'payment-reconciliation-done', pg, date, listed, matched, mismatched, seconds, perSecond }, '대사 실행을 끝냈다')),
    calendarUnavailable: ({ code }) => quietly(() => logger.warn({ kind: 'payment-reconciliation-calendar', code }, '온세일 일정을 읽지 못해 일정 없음으로 본다')),
    overdue: ({ pg, count, oldest }) => quietly(() => logger.error({ kind: 'payment-reconciliation-overdue', severity: 'SEV2', pg, count, oldest }, '되돌아보는 기간을 넘겨 대사를 끝내지 못한 날이 있다')),
    runLost: ({ pg, date }) => quietly(() => logger.warn({ kind: 'payment-reconciliation-run-lost', pg, date }, '다른 실행이 이어 받아 이 대사 실행을 멈췄다')),
    recheckMissing: ({ pg, orderId }) => quietly(() => logger.warn({ kind: 'payment-reconciliation-recheck-missing', pg, orderId }, '다시 확인 조회가 없다고 답해 그 줄을 판단하지 않았다')),
    mismatchSuppressed: ({ pg, date, suppressed }) => quietly(() => logger.error({ kind: 'payment-reconciliation-mismatch-suppressed', severity: 'SEV1', pg, date, suppressed }, '불일치가 많아 건마다의 경보를 줄였다(기록은 reconciliation_diff에 모두 있다)')),
  };
}
