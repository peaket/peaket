// 낮춘 상한 맞추기와 포트원 채널 하위 결제사 관측의 로그(docs/features/payment.md §2·§2.2, docs/observability.md 같은 줄, BUILD_ORDER PRF-203, ASVS v5.0.0-16.2.5).
// 결제사·단계·하위 결제사 이름·수단·안전한 오류 코드만 싣는다(채널 키·주문·결제 값은 싣지 않는다).
import type { PlatformLogger } from '@peaket/platform';
import { LogGate, type WallClock } from '../domain/log-gate.js';
import type { PgChannelLimitSyncLog, PgChannelObserverLog } from '../domain/ports.js';

/** 경고 줄의 간격 1분 [가정](결제사·단계마다) */
const WARN_INTERVAL_MS = 60_000;

/**
 * 플랫폼 로거에 잇는다. 로거가 던져도 삼킨다.
 * - limitSyncFailed: warn(pg-limit-sync-failed), 결제사·단계마다 1분 [가정]에 한 줄
 * - providerMismatch: error(pg-channel-provider-mismatch, SEV2). 부르는 쪽이 채널·관측 값마다 한 번만 부른다
 * - observedFailed: warn(pg-channel-observed-failed), 단계마다 1분 [가정]에 한 줄
 */
export function pgChannelLog(logger: Pick<PlatformLogger, 'warn' | 'error'>, clock: WallClock): PgChannelLimitSyncLog & PgChannelObserverLog {
  const gates = new Map<string, LogGate>();
  const allow = (key: string): boolean => {
    let gate = gates.get(key);
    if (gate === undefined) {
      gate = new LogGate(clock, WARN_INTERVAL_MS);
      gates.set(key, gate);
    }
    return gate.allow();
  };
  const safe = (f: () => void): void => {
    try {
      f();
    } catch {
      // 로그 때문에 맞추기·관측이 멈추지 않게 삼킨다
    }
  };
  return {
    limitSyncFailed: ({ step, pg, code }) =>
      safe(() => {
        if (allow(`limit:${step}:${pg ?? '-'}`)) logger.warn({ kind: 'pg-limit-sync-failed', step, ...(pg === undefined ? {} : { pg }), code }, '낮춘 결제사 채널 상한 표를 읽거나 쓰지 못했다(이 파드는 마지막 값을 그 만료까지 쓴다)');
      }),
    providerMismatch: ({ configured, observed, payMethods }) =>
      safe(() => logger.error({ kind: 'pg-channel-provider-mismatch', severity: 'SEV2', pg: 'PORTONE', configured, observed, payMethods: [...payMethods] }, '포트원 채널의 실제 하위 결제사가 설정과 달라 그 채널을 대체 후보에서 뺐다')),
    observedFailed: ({ step, code }) =>
      safe(() => {
        if (allow(`observed:${step}`)) logger.warn({ kind: 'pg-channel-observed-failed', step, code }, '포트원 채널의 관측 하위 결제사 표를 읽거나 쓰지 못했다');
      }),
  };
}
