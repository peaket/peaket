// 결제사 호출 보호의 로그(BUILD_ORDER PRF-183, ASVS v5.0.0-16.2.5·16.3.4). 결제사와 낮춘 뒤 상한만 싣는다(주문·결제 값은 싣지 않는다).
import type { PlatformLogger } from '@peaket/platform';
import type { PgCallGuardLog } from '../domain/ports.js';

/** 플랫폼 로거에 잇는다. throttledFirst는 error(pg-throttled-first, SEV2, severity 칸), limitRestored는 info(pg-limit-restored, BUILD_ORDER PRF-203). 로거가 던져도 삼킨다 */
export function pgCallGuardLog(logger: Pick<PlatformLogger, 'error' | 'info'>): PgCallGuardLog {
  return {
    throttledFirst: ({ pg, rps, concurrency }) => {
      try {
        logger.error({ kind: 'pg-throttled-first', severity: 'SEV2', pg, rps, concurrency }, '결제사가 첫 승인 호출을 429로 거절해 채널 상한을 낮췄다');
      } catch {
        // 로그 때문에 실행기가 멈추지 않게 삼킨다
      }
    },
    limitRestored: ({ pg, rps, concurrency }) => {
      try {
        logger.info({ kind: 'pg-limit-restored', pg, rps, concurrency }, '낮춘 결제사 채널 상한이 만료돼 처음 상한으로 돌아갔다');
      } catch {
        // 삼킨다
      }
    },
  };
}
