// 탈퇴 후기 다시 정리 반복(소유자 결정 2026-11-16 OPEN[44], ADR-0278, docs/streaming.md §2.6 'core-svc 소비자', docs/features/identity.md §8 '다시 정리').
// 소비자를 켠 파드마다 60초 [가정]마다 때가 된 예약을 100개 [가정]씩 다시 파기한다. 여러 파드가 겹쳐 돌아도 저장소가 예약을 SKIP LOCKED로 잡아 한 예약은 한 번만 처리된다.
// 밀린 시간은 정비 보존 지표 maintenance_retention_overdue_seconds{service="core-svc", table="review_withdrawal_recheck"}로 낸다(5일 [가정] 넘으면 SEV2 legal).
// 한 번 돌 때마다 성공·실패와 관계없이 밀린 시간을 따로 읽어 고치고, 실패 수 review_withdrawal_recheck_failures_total{service}와
// 마지막 성공 시각 review_withdrawal_recheck_last_success_timestamp_seconds{service}(모든 파드에서 30분 [가정] 넘게 없으면 SEV3 legal)를 낸다
// (docs/observability.md 운영 확인 '탈퇴 후기 다시 정리' 행, W8-audit2a 리뷰 A1). 이 파일은 Kafka 클라이언트(네이티브 모듈)를 싣지 않는다(시작 파일 start.ts만 싣는다).
import { Counter, errorSummary, Gauge, type Registry, systemClock } from '@peaket/platform';
import type { Reviews } from '../modules/review/index.js';

/** 반복 간격 60초 [가정]·한 번에 잡는 예약 100개 [가정](docs/features/identity.md §8 '다시 정리') */
export const REVIEW_RECHECK_DEFAULTS = { everyMs: 60_000, limit: 100 } as const;

const SERVICE = 'core-svc';
const OVERDUE_METRIC = 'maintenance_retention_overdue_seconds';
const FAILURES_METRIC = 'review_withdrawal_recheck_failures_total';
const LAST_SUCCESS_METRIC = 'review_withdrawal_recheck_last_success_timestamp_seconds';
const OVERDUE_LABELS = { service: SERVICE, table: 'review_withdrawal_recheck' } as const;

export interface ReviewRecheckLoopOptions {
  reviews: Pick<Reviews, 'runWithdrawalRechecks' | 'oldestOverdueRecheckMs'>;
  /** 기본 60_000 [가정] */
  everyMs?: number;
  /** 기본 100 [가정] */
  limit?: number;
  /** maintenance_retention_overdue_seconds{service,table}·review_withdrawal_recheck_failures_total{service}·review_withdrawal_recheck_last_success_timestamp_seconds{service}를 단다 */
  registry?: Registry;
  logger?: { warn(o: object, msg?: string): void; info?(o: object, msg?: string): void };
  /** 시험이 바꾼다. 멈춤 신호가 오면 바로 풀려야 한다 */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** 마지막 성공 시각(review_withdrawal_recheck_last_success_timestamp_seconds)에 쓴다. 기본 systemClock */
  clock?: { now(): number };
}

/** 멈춤 신호가 오면 바로 풀리는 쉼 */
const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const onAbort = () => {
      clearTimeout(t);
      resolve();
    };
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });

interface RecheckMetrics {
  overdue: Gauge<'service' | 'table'>;
  failures: Counter<'service'>;
  lastSuccess: Gauge<'service'>;
}

/**
 * 지표 셋. 같은 이름이 이미 저장소에 있으면 그것을 쓴다(같은 이름을 두 번 만들면 실패한다. 반복을 두 번 켜거나 정비 지표가 먼저 있을 때).
 * 밀린 시간 지표의 칸 이름·도움말은 platform maintenanceMetrics와 같다
 */
function recheckMetrics(registry: Registry): RecheckMetrics {
  const registers = [registry];
  return {
    overdue:
      (registry.getSingleMetric(OVERDUE_METRIC) as Gauge<'service' | 'table'> | undefined) ??
      new Gauge({ name: OVERDUE_METRIC, help: '남은 가장 오래된 지울 행이 기한을 넘긴 시간(5일 [가정] 넘으면 SEV2 legal)', labelNames: ['service', 'table'], registers }),
    failures:
      (registry.getSingleMetric(FAILURES_METRIC) as Counter<'service'> | undefined) ??
      new Counter({ name: FAILURES_METRIC, help: '탈퇴 후기 다시 정리 반복이 실패한 수(한 번 돌 때 하나)', labelNames: ['service'], registers }),
    lastSuccess:
      (registry.getSingleMetric(LAST_SUCCESS_METRIC) as Gauge<'service'> | undefined) ??
      new Gauge({ name: LAST_SUCCESS_METRIC, help: '탈퇴 후기 다시 정리 반복의 마지막 성공 시각(유닉스 초, 모든 파드에서 30분 [가정] 넘게 없으면 SEV3 legal)', labelNames: ['service'], registers }),
  };
}

/**
 * 반복을 켠다. 켜자마자 한 번 돈다. 한 번 돌 때 잡은 예약 수(accounts)가 limit과 같으면 쉬지 않고 곧바로 다시 돈다(밀린 것을 비울 때까지).
 * 실패는 경고 한 줄(오류 요약만, 계정 ID 없음) 뒤 다음 간격에 다시 한다. stop()은 돌던 한 번이 끝난 뒤에 풀린다(소비자 멈춤·풀 닫기 전에 반복이 끝나야 한다)
 */
export function startReviewRecheckLoop(o: ReviewRecheckLoopOptions): { stop(): Promise<void> } {
  const everyMs = o.everyMs ?? REVIEW_RECHECK_DEFAULTS.everyMs;
  const limit = o.limit ?? REVIEW_RECHECK_DEFAULTS.limit;
  const sleep = o.sleep ?? abortableSleep;
  const clock = o.clock ?? systemClock;
  const metrics = o.registry ? recheckMetrics(o.registry) : undefined;
  const abort = new AbortController();
  // Drizzle 쿼리 오류의 글에는 매개변수(계정 ID)가 실리므로 쿼리 틀과 DB 오류 코드만 남긴다(errorSummary)
  const warn = (err: unknown, msg: string) => o.logger?.warn({ kind: 'review-withdrawal-recheck', err: errorSummary(err) }, msg);

  /** 한 번 돈다. 곧바로 다시 돌아야 하면 true. 경고는 한 번에 한 줄까지 */
  const once = async (): Promise<boolean> => {
    let again = false;
    let failed = false;
    try {
      const r = await o.reviews.runWithdrawalRechecks(limit);
      metrics?.lastSuccess.set({ service: SERVICE }, Math.floor(clock.now() / 1000));
      if (r.accounts > 0) o.logger?.info?.({ kind: 'review-withdrawal-recheck', accounts: r.accounts, purged: r.purged }, '탈퇴 후기 다시 정리');
      again = r.accounts >= limit;
    } catch (err) {
      failed = true;
      metrics?.failures.inc({ service: SERVICE });
      warn(err, '탈퇴 후기 다시 정리 실패(다음 간격에 다시 한다)');
    }
    // 밀린 시간은 성공·실패와 관계없이 따로 읽어 고친다(반복이 계속 실패해도 경보가 울리게, 리뷰 A1). 그 읽기도 실패하면 값을 그대로 둔다
    if (metrics) {
      try {
        metrics.overdue.set(OVERDUE_LABELS, (await o.reviews.oldestOverdueRecheckMs()) / 1000);
      } catch (err) {
        if (!failed) warn(err, '탈퇴 후기 다시 정리의 밀린 시간을 읽지 못했다(다음 간격에 다시 읽는다)');
      }
    }
    return again;
  };

  const loop = (async () => {
    while (!abort.signal.aborted) {
      const again = await once();
      if (abort.signal.aborted) break;
      if (again) continue;
      await sleep(everyMs, abort.signal);
    }
  })();

  return {
    stop: async () => {
      abort.abort();
      await loop;
    },
  };
}
