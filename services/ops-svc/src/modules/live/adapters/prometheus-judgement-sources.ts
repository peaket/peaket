// 관제 판단 위젯의 지표 창고(Prometheus) 원천(F-03-3 OPS-380, ADR-0371 결정 8): 여정별 남은 허용 실패·포화도 요약·진단 힌트, 그리고 T-30분 점검의 실시간 항목.
// 쿼리는 이 파일에 고정한다(화면이 임의 쿼리를 보내지 못한다). 원천은 서비스 시계 시각에 묻는다(F-03-1 PrometheusWidgetSource와 같다).
// 시계열이 없거나 NaN인 칸은 null과 까닭이고 0으로 읽지 않는다. 이름은 docs/observability.md §8 '관제 판단 위젯 원천'에 적는다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import type { ReadinessService } from '../../readiness/index.js';
import { WidgetSourceUnavailable, type WidgetReadQuery, type WidgetSource } from '../domain/ports.js';
import { BUDGET_JOURNEYS, LINKED_JOURNEYS, type WidgetKey, type WidgetValue } from '../domain/widgets.js';
import { PROMETHEUS_TIMEOUT_MS } from './prometheus-widget-source.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PromSample {
  metric: Record<string, string>;
  value?: [number, string];
}

const num = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 즉시 쿼리 한 번(원천이 답하지 않거나 모양이 틀리면 WidgetSourceUnavailable) */
export class PrometheusQuery {
  constructor(private readonly http: Pick<ExternalHttpClient, 'request'>) {}

  static fromUrl(baseUrl: string): PrometheusQuery {
    return new PrometheusQuery(createExternalHttpClient({ provider: 'prometheus', baseUrl, timeoutCapMs: PROMETHEUS_TIMEOUT_MS }));
  }

  async instant(query: string, nowMs: number): Promise<PromSample[]> {
    let res: Response;
    try {
      res = await this.http.request({ method: 'GET', path: '/api/v1/query', query: { query, time: nowMs / 1000 } });
    } catch (err) {
      throw new WidgetSourceUnavailable(err instanceof Error ? err.name : 'request');
    }
    if (!res.ok) throw new WidgetSourceUnavailable(`status ${res.status}`);
    const body = (await res.json().catch(() => undefined)) as { status?: string; data?: { result?: unknown } } | undefined;
    if (body?.status !== 'success' || !Array.isArray(body.data?.result)) throw new WidgetSourceUnavailable('응답 모양');
    return body.data.result as PromSample[];
  }

  async scalar(query: string, nowMs: number): Promise<number | null> {
    return num((await this.instant(query, nowMs))[0]?.value?.[1]);
  }
}

/** 여정별 남은 허용 실패의 기록 규칙(OPS-090이 만든다. 그 전에는 시계열이 없어 여정마다 null) */
export const BUDGET_RULES = {
  allowed: 'peaket:slo:onsale_allowed',
  used: 'peaket:slo:onsale_used',
  burnShort: 'peaket:slo:onsale_burn_short',
  burnLong: 'peaket:slo:onsale_burn_long',
} as const;

/** 포화도 쿼리와 기준 [가정](CPU·Redis 메모리는 비율, Kafka 밀림은 메시지 수, 이벤트 루프는 초) */
export const SATURATION_QUERIES = {
  cpu: '1 - avg(rate(node_cpu_seconds_total{mode="idle"}[5m]))',
  redisMemory: 'max(redis_memory_used_bytes / redis_memory_max_bytes)',
  kafkaLag: 'max(kafka_consumergroup_lag)',
  eventLoop: 'max(nodejs_eventloop_lag_p99_seconds)',
} as const;
export const SATURATION_THRESHOLDS: Record<keyof typeof SATURATION_QUERIES, { warn: number; danger: number }> = {
  cpu: { warn: 0.7, danger: 0.85 },
  redisMemory: { warn: 0.75, danger: 0.9 },
  kafkaLag: { warn: 1_000, danger: 10_000 },
  eventLoop: { warn: 0.1, danger: 0.5 },
};

type Level = 'ok' | 'warn' | 'danger' | 'unknown';
const RANK: Record<Level, number> = { ok: 0, unknown: 1, warn: 2, danger: 3 };

export function saturationLevelOf(value: number | null, t: { warn: number; danger: number }): Level {
  if (value === null) return 'unknown';
  if (value >= t.danger) return 'danger';
  if (value >= t.warn) return 'warn';
  return 'ok';
}

/** 요약은 가장 나쁜 칸(위험 > 주의 > 받지 못함 > 정상). 값이 없는 칸이 있으면 정상이 아니다 */
export function worstLevel(levels: readonly Level[]): Level {
  return levels.reduce<Level>((w, l) => (RANK[l] > RANK[w] ? l : w), 'ok');
}

export class PrometheusBudgetSource implements WidgetSource {
  readonly keys: readonly WidgetKey[] = ['ops-budget.journeys'];
  constructor(private readonly prom: PrometheusQuery) {}

  async read(key: WidgetKey, q: WidgetReadQuery): Promise<WidgetValue> {
    if (q.eventId === null || !UUID.test(q.eventId)) throw new WidgetSourceUnavailable('회차가 없다');
    const sel = `{event_id="${q.eventId.toLowerCase()}"}`;
    const byJourney = async (rule: string) => new Map((await this.prom.instant(`max by (journey) (${rule}${sel})`, q.nowMs)).map((s) => [s.metric.journey ?? '', num(s.value?.[1])] as const));
    const [allowed, used, burnShort, burnLong] = await Promise.all([BUDGET_RULES.allowed, BUDGET_RULES.used, BUDGET_RULES.burnShort, BUDGET_RULES.burnLong].map(byJourney));
    return {
      widgetKey: 'ops-budget.journeys',
      source: 'prometheus',
      at: new Date(q.nowMs).toISOString(),
      eventId: q.eventId,
      journeys: BUDGET_JOURNEYS.map((journey) => {
        const a = allowed!.get(journey) ?? null;
        const u = used!.get(journey) ?? null;
        const linked = LINKED_JOURNEYS.includes(journey);
        if (a === null || u === null) return { journey, linked, allowed: null, used: null, remaining: null, burnShort: null, burnLong: null, reason: 'no-sample' };
        return { journey, linked, allowed: a, used: u, remaining: Math.max(0, a - u), burnShort: burnShort!.get(journey) ?? null, burnLong: burnLong!.get(journey) ?? null };
      }),
    };
  }
}

export class PrometheusSaturationSource implements WidgetSource {
  readonly keys: readonly WidgetKey[] = ['ops-saturation.summary'];
  constructor(private readonly prom: PrometheusQuery) {}

  async read(key: WidgetKey, q: WidgetReadQuery): Promise<WidgetValue> {
    const names = Object.keys(SATURATION_QUERIES) as (keyof typeof SATURATION_QUERIES)[];
    const values = await Promise.all(names.map((n) => this.prom.scalar(SATURATION_QUERIES[n], q.nowMs)));
    const field = (i: number) => ({ value: values[i]!, level: saturationLevelOf(values[i]!, SATURATION_THRESHOLDS[names[i]!]) });
    const [cpu, redisMemory, kafkaLag, eventLoop] = names.map((_n, i) => field(i));
    return {
      widgetKey: 'ops-saturation.summary',
      source: 'prometheus',
      at: new Date(q.nowMs).toISOString(),
      eventId: q.eventId,
      level: worstLevel([cpu!.level, redisMemory!.level, kafkaLag!.level, eventLoop!.level]),
      cpu: cpu!,
      redisMemory: redisMemory!,
      kafkaLag: kafkaLag!,
      eventLoop: eventLoop!,
    };
  }
}

/** 진단 힌트: RUM(OPS-050)·느린 쿼리·네트워크(OPS-090) 원천이 아직 없어 늘 원천 실패 값이다 */
export class PendingDiagnosticsSource implements WidgetSource {
  readonly keys: readonly WidgetKey[] = ['ops-diagnostics.summary'];
  async read(): Promise<WidgetValue> {
    throw new WidgetSourceUnavailable('진단 힌트 원천이 아직 없다');
  }
}

/** 지표 창고 주소가 없을 때(local·시험): 판단 위젯 둘은 늘 원천 실패 값 */
export class UnavailableJudgementSource implements WidgetSource {
  readonly keys: readonly WidgetKey[] = ['ops-budget.journeys', 'ops-saturation.summary'];
  async read(): Promise<WidgetValue> {
    throw new WidgetSourceUnavailable('PEAKET_PROMETHEUS_URL이 없다');
  }
}

/** T-30분 점검의 실시간 항목(readiness 컨텍스트의 점검 계산). 회차가 없으면 원천 실패 값 */
export class ReadinessWidgetSource implements WidgetSource {
  readonly keys: readonly WidgetKey[] = ['ops-readiness.checklist'];
  constructor(private readonly readiness: Pick<ReadinessService, 'checklist'>) {}

  async read(key: WidgetKey, q: WidgetReadQuery): Promise<WidgetValue> {
    if (q.eventId === null || !UUID.test(q.eventId)) throw new WidgetSourceUnavailable('회차가 없다');
    const { items, preview } = await this.readiness.checklist(q.nowMs);
    return { widgetKey: 'ops-readiness.checklist', source: 'prometheus', at: new Date(q.nowMs).toISOString(), eventId: q.eventId, items, preview };
  }
}
