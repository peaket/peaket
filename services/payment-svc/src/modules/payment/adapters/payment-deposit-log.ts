// 입금 대기 쓰기의 로그(docs/features/payment.md §6 '입금 확인의 첫 구현', BUILD_ORDER HOT-151, ASVS v5.0.0-16.2.5). 주문 ID와 닫힌 까닭만 싣는다. 계좌번호·secret은 싣지 않는다.
import type { PlatformLogger } from '@peaket/platform';
import type { PaymentDepositLog } from '../domain/ports.js';

/** 로그 때문에 결제 처리가 멈추지 않게 로거의 예외를 삼킨다 */
function quietly(write: () => void): void {
  try {
    write();
  } catch {
    // 삼킨다
  }
}

/**
 * 플랫폼 로거에 잇는다. 모든 줄이 error·SEV2다: infoMissing(payment-deposit-info-missing), accountUnsaved(payment-virtual-account-unsaved, reason), accountUnopened(payment-virtual-account-unopened, reason). 로거가 던져도 삼킨다
 */
export function paymentDepositLog(logger: Pick<PlatformLogger, 'warn' | 'error'>): PaymentDepositLog {
  return {
    infoMissing: ({ orderId }) => quietly(() => logger.error({ kind: 'payment-deposit-info-missing', severity: 'SEV2', orderId }, '입금 대기 답에 가상계좌 발급 정보나 입금 기한이 없다')),
    accountUnsaved: ({ orderId, reason }) => quietly(() => logger.error({ kind: 'payment-virtual-account-unsaved', severity: 'SEV2', orderId, reason }, '가상계좌 번호를 저장하지 못했다(결제 상태 응답에 번호가 실리지 않는다)')),
    accountUnopened: ({ orderId, reason }) => quietly(() => logger.error({ kind: 'payment-virtual-account-unopened', severity: 'SEV2', orderId, reason }, '저장한 가상계좌 번호를 열지 못했다')),
  };
}
