// 관제 실시간 표 지표(docs/streaming.md §2.7·§9·§14, docs/features/control-tower.md §16, F-04-1).
// - rt_query_seconds{view}: 조회 하나의 시간(히스토그램, 표준 지연 칸. 경보 0.25초가 칸 경계다)
// - rt_freshness_seconds{path}: 주기마다 두 길(cumulative·bucket)의 신선도(히스토그램. 1분 창 p95가 NFR-009 판정값, 5·60초가 칸 경계다)
// - rt_query_failures_total{view}: 실패한 조회 수
// - rt_degraded: Degraded면 1(실시간 표 패널을 Prometheus 대체 표시로, SEV3 경보의 원천)
// - rt_trade_gap_events: 거래 사건이 60초 넘게 끊긴 관심 회차 수(C-T37 SEV3의 원천)
// - rt_watched_events: 관심 회차 수
// 회차 ID는 이름표에 싣지 않는다(카디널리티 규칙, observability §8). 경보 규칙은 이 일 밖이다(F-04-1 계획 '남긴 것').
import { Counter, Gauge, Histogram, LATENCY_BUCKETS_SECONDS, type Registry } from '@peaket/platform';
import type { RtSignals, RtView } from '../domain/ports.js';

const VIEWS: readonly RtView[] = ['v_cumulative', 'v_bucket', 'v_freshness', 'seat_map'];

export class PromRtSignals implements RtSignals {
  readonly querySeconds = new Histogram({
    name: 'rt_query_seconds',
    help: '관제 실시간 표 조회 하나의 시간(초, view v_cumulative·v_bucket·v_freshness·seat_map)',
    labelNames: ['view'] as const,
    buckets: [...LATENCY_BUCKETS_SECONDS],
    registers: [],
  });
  readonly freshnessSeconds = new Histogram({
    name: 'rt_freshness_seconds',
    help: '관제 실시간 표 신선도(초, path cumulative·bucket). 조회 주기마다 잰다',
    labelNames: ['path'] as const,
    buckets: [...LATENCY_BUCKETS_SECONDS],
    registers: [],
  });
  readonly queryFailures = new Counter({
    name: 'rt_query_failures_total',
    help: '관제 실시간 표 조회 실패 수(view)',
    labelNames: ['view'] as const,
    registers: [],
  });
  readonly degraded = new Gauge({ name: 'rt_degraded', help: '관제 실시간 표가 Degraded(신선도 p95 5초 초과 3분 넘게)면 1', registers: [] });
  readonly tradeGapEvents = new Gauge({ name: 'rt_trade_gap_events', help: '거래 사건이 60초 넘게 끊긴 관심 회차 수(판매 중으로 본 회차만)', registers: [] });
  readonly watchedEvents = new Gauge({ name: 'rt_watched_events', help: '관제 실시간 표가 주기마다 읽는 관심 회차 수', registers: [] });

  constructor() {
    // 처음 긁을 때 0인 계열도 보이게 한다
    for (const view of VIEWS) this.queryFailures.inc({ view }, 0);
    this.degraded.set(0);
    this.tradeGapEvents.set(0);
    this.watchedEvents.set(0);
  }

  query(view: RtView, seconds: number, ok: boolean): void {
    this.querySeconds.observe({ view }, Math.max(0, seconds));
    if (!ok) this.queryFailures.inc({ view });
  }

  freshness(path: 'cumulative' | 'bucket', seconds: number): void {
    this.freshnessSeconds.observe({ path }, Math.max(0, seconds));
  }

  state(s: { readonly degraded: boolean; readonly tradeGapEvents: number; readonly watchedEvents: number }): void {
    this.degraded.set(s.degraded ? 1 : 0);
    this.tradeGapEvents.set(s.tradeGapEvents);
    this.watchedEvents.set(s.watchedEvents);
  }

  register(registry: Registry): this {
    for (const m of [this.querySeconds, this.freshnessSeconds, this.queryFailures, this.degraded, this.tradeGapEvents, this.watchedEvents]) registry.registerMetric(m);
    return this;
  }
}
