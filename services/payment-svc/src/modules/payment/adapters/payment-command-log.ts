// 승인 명령 접수의 로그(BUILD_ORDER PRF-180). 주문 ID만 싣고 결제 키·토큰·금액은 싣지 않는다(ASVS v5.0.0-16.2.5).
import type { PlatformLogger } from '@peaket/platform';
import type { PaymentCommandLog } from '../domain/ports.js';

/** 플랫폼 로거에 잇는다. mismatch는 error 한 줄(kind payment-confirm-mismatch, SEV2) */
export function paymentCommandLog(logger: Pick<PlatformLogger, 'error'>): PaymentCommandLog {
  return {
    mismatch: ({ orderId }) => logger.error({ kind: 'payment-confirm-mismatch', orderId }, '이미 받은 승인 명령과 시도·결제사·금액이 달라 거절했다'),
  };
}
