// 결제창 준비의 로그(BUILD_ORDER PRF-190). 결제사·까닭·수단·회차 ID만 싣고 구매자 키·공개 키·주문명은 싣지 않는다(ASVS v5.0.0-16.2.5).
import type { PlatformLogger } from '@peaket/platform';
import type { PrepareCheckoutLog } from '../domain/ports.js';

/** 플랫폼 로거에 잇는다. pgUnavailable은 error 한 줄(kind payment-pg-unavailable, SEV2), methodUnsupported는 warn 한 줄(kind payment-pg-method-unsupported, 결제사 장애가 아니다) */
export function paymentCheckoutLog(logger: Pick<PlatformLogger, 'error' | 'warn'>): PrepareCheckoutLog {
  return {
    pgUnavailable: ({ pg, reason, eventId }) => logger.error({ kind: 'payment-pg-unavailable', pg, reason, eventId }, '고른 결제사를 쓸 수 없어 결제창을 열지 못했다'),
    methodUnsupported: ({ pg, payMethod, eventId }) => logger.warn({ kind: 'payment-pg-method-unsupported', pg, payMethod, eventId }, '고른 결제사가 요청 수단을 받지 않아 결제창을 열지 못했다'),
  };
}
