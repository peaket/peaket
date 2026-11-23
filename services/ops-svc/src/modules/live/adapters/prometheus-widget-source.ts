// 위젯 값의 Prometheus 원천(클러스터 안 Prometheus HTTP API /api/v1/query·/api/v1/query_range, ADR-0068 결정 2, ADR-0360 결정 9).
// 위젯 키 둘: 대기열 팀 입장 비율(admission-ctrl 지표, 회차 라벨 event_id)과 구매 팀 결제사(payment-svc 지표, 결제사 라벨 pg).
// 쿼리는 이 파일에 고정한다(화면이 임의 쿼리를 보내지 못한다, openapi '임의 쿼리를 받지 않는다'). 회차 ID는 UUID만 받아 라벨 값에 넣는다.
// 원천이 답하지 않거나 모양이 틀리면 WidgetSourceUnavailable을 던진다(흐름·조회가 source-unavailable로 낸다).
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import { WidgetSourceUnavailable, type WidgetReadQuery, type WidgetSource } from '../domain/ports.js';
import { WIDGET_KEYS, WIDGET_SOURCE_OF, type WidgetKey, type WidgetValue } from '../domain/widgets.js';

/** 한 번 묻는 시간 상한 2초 [가정]: 위젯 주기(1초)보다 길게 걸리면 다음 주기가 건너뛴다 */
export const PROMETHEUS_TIMEOUT_MS = 2_000;
/** 그래프 점 간격 15초 [가정](15분 창에 60점) */
export const PROMETHEUS_RANGE_STEP_S = 15;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PromSample {
  metric: Record<string, string>;
  value?: [number, string];
  values?: [number, string][];
}

const sel = (eventId: string | null): string => {
  if (eventId === null) return '';
  if (!UUID.test(eventId)) throw new WidgetSourceUnavailable('회차 ID가 UUID가 아니다');
  return `{event_id="${eventId.toLowerCase()}"}`;
};

/** 위젯 키별 쿼리(control-tower §13 위젯 원천 표가 지표 이름을 가리킨다) */
export const WIDGET_QUERIES = {
  admission: (eventId: string | null) => {
    const s = sel(eventId);
    return {
      ratio: `max(admission_ratio${s})`,
      target: `max(admission_target${s})`,
      slotsUsed: `max(admission_slots_used${s})`,
      inFlight: `max(admission_in_flight${s})`,
      soonWaiting: `max(admission_soon_waiting${s})`,
    };
  },
  pg: {
    limitRatio: 'max by (pg) (payment_pg_limit_ratio)',
    circuitOpen: 'max by (pg) (payment_pg_circuit_open)',
    inflight: 'sum by (pg) (payment_pg_inflight)',
    saturatedPerMin: 'sum by (pg) (rate(payment_pg_saturated_total[1m])) * 60',
  },
} as const;

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** Prometheus가 원천인 키(WIDGET_SOURCE_OF가 prometheus인 키). rt-sales.summary는 관제 실시간 표 원천이 맡는다(F-04-1) */
export const PROMETHEUS_WIDGET_KEYS: readonly WidgetKey[] = WIDGET_KEYS.filter((k) => WIDGET_SOURCE_OF[k] === 'prometheus');

export class PrometheusWidgetSource implements WidgetSource {
  readonly keys: readonly WidgetKey[] = PROMETHEUS_WIDGET_KEYS;

  constructor(private readonly http: ExternalHttpClient) {}

  static fromUrl(baseUrl: string): PrometheusWidgetSource {
    return new PrometheusWidgetSource(createExternalHttpClient({ provider: 'prometheus', baseUrl, timeoutCapMs: PROMETHEUS_TIMEOUT_MS }));
  }

  private async query(path: '/api/v1/query' | '/api/v1/query_range', query: Record<string, string | number>): Promise<PromSample[]> {
    let res: Response;
    try {
      res = await this.http.request({ method: 'GET', path, query });
    } catch (err) {
      throw new WidgetSourceUnavailable(err instanceof Error ? err.name : 'request');
    }
    if (!res.ok) throw new WidgetSourceUnavailable(`status ${res.status}`);
    const body = (await res.json().catch(() => undefined)) as { status?: string; data?: { result?: unknown } } | undefined;
    if (body?.status !== 'success' || !Array.isArray(body.data?.result)) throw new WidgetSourceUnavailable('응답 모양');
    return body.data.result as PromSample[];
  }

  private async instant(q: string, nowMs: number): Promise<PromSample[]> {
    return this.query('/api/v1/query', { query: q, time: nowMs / 1000 });
  }

  private async range(q: string, r: { fromMs: number; toMs: number }): Promise<PromSample[]> {
    return this.query('/api/v1/query_range', { query: q, start: r.fromMs / 1000, end: r.toMs / 1000, step: PROMETHEUS_RANGE_STEP_S });
  }

  async read(key: WidgetKey, q: WidgetReadQuery): Promise<WidgetValue> {
    const at = new Date(q.nowMs).toISOString();
    if (key === 'queue-admission-rate.summary') {
      const qs = WIDGET_QUERIES.admission(q.eventId);
      const [ratio, target, slotsUsed, inFlight, soonWaiting] = await Promise.all([qs.ratio, qs.target, qs.slotsUsed, qs.inFlight, qs.soonWaiting].map((x) => this.instant(x, q.nowMs)));
      const first = (s: PromSample[] | undefined) => num(s?.[0]?.value?.[1]);
      const series = q.range ? (await this.range(qs.ratio, q.range))[0]?.values ?? [] : undefined;
      return {
        widgetKey: key,
        source: 'prometheus',
        at,
        eventId: q.eventId,
        ratio: first(ratio),
        target: first(target),
        slotsUsed: first(slotsUsed),
        inFlight: first(inFlight),
        soonWaiting: first(soonWaiting),
        ...(series ? { series: series.flatMap(([t, v]) => (num(v) === null ? [] : [{ at: new Date(t * 1000).toISOString(), ratio: num(v)! }])) } : {}),
      };
    }
    // 이 원천이 맡지 않는 키(rt-sales.summary는 관제 실시간 표 원천, F-04-1)
    if (key !== 'purchase-pg-status.summary') throw new WidgetSourceUnavailable(`이 원천의 키가 아니다: ${key}`);
    const p = WIDGET_QUERIES.pg;
    const [limitRatio, circuitOpen, inflight, saturated] = await Promise.all([p.limitRatio, p.circuitOpen, p.inflight, p.saturatedPerMin].map((x) => this.instant(x, q.nowMs)));
    const byPg = (s: PromSample[]) => new Map(s.map((x) => [x.metric.pg ?? '', num(x.value?.[1])] as const));
    const maps = { limitRatio: byPg(limitRatio!), circuitOpen: byPg(circuitOpen!), inflight: byPg(inflight!), saturated: byPg(saturated!) };
    const names = [...new Set([...maps.limitRatio.keys(), ...maps.circuitOpen.keys(), ...maps.inflight.keys(), ...maps.saturated.keys()])].filter((n) => n !== '').sort();
    const series = q.range ? await this.range(p.limitRatio, q.range) : undefined;
    return {
      widgetKey: key,
      source: 'prometheus',
      at,
      eventId: q.eventId,
      pgs: names.map((pg) => {
        const open = maps.circuitOpen.get(pg);
        return {
          pg,
          limitRatio: maps.limitRatio.get(pg) ?? null,
          circuitOpen: open === undefined || open === null ? null : open > 0,
          inflight: maps.inflight.get(pg) ?? null,
          saturatedPerMin: maps.saturated.get(pg) ?? null,
        };
      }),
      ...(series
        ? {
            series: series.flatMap((s) =>
              (s.values ?? []).flatMap(([t, v]) => (num(v) === null ? [] : [{ at: new Date(t * 1000).toISOString(), pg: s.metric.pg ?? '', limitRatio: num(v)! }])),
            ),
          }
        : {}),
    };
  }
}

/** 원천 주소가 없을 때(local·시험): 늘 source-unavailable */
export class UnavailableWidgetSource implements WidgetSource {
  readonly keys: readonly WidgetKey[] = PROMETHEUS_WIDGET_KEYS;
  async read(): Promise<WidgetValue> {
    throw new WidgetSourceUnavailable('PEAKET_PROMETHEUS_URL이 없다');
  }
}
