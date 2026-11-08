// 결제사 호출 보호의 로그(BUILD_ORDER PRF-183, ASVS v5.0.0-16.2.5·16.3.4). 결제사와 낮춘 뒤 상한만 싣는다(주문·결제 값은 싣지 않는다).
import type { PlatformLogger } from '@peaket/platform';
import type { PgCallGuardLog } from '../domain/ports.js';

/** 플랫폼 로거에 잇는다. throttledFirst는 error(pg-throttled-first, SEV2, severity 칸). 로거가 던져도 삼킨다 */
export function pgCallGuardLog(logger: Pick<PlatformLogger, 'error'>): PgCallGuardLog {
  return {
    throttledFirst: ({ pg, rps, concurrency }) => {
      try {
        logger.error({ kind: 'pg-throttled-first', severity: 'SEV2', pg, rps, concurrency }, '결제사가 첫 승인 호출을 429로 거절해 채널 상한을 낮췄다');
      } catch {
        // 로그 때문에 실행기가 멈추지 않게 삼킨다
      }
    },
  };
}
