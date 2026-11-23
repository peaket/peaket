// T-30분 점검 항목의 지표 창고(Prometheus) 원천(F-03-3 OPS-380, ADR-0371 결정 2). 쿼리는 이 파일에 고정한다(화면이 쿼리를 보내지 못한다).
// 원천을 묻는 시각은 서비스 시계(시험의 가짜 시계)이고, 즉시 쿼리의 기본 되돌아보기(5분)를 넘게 표본이 없으면 결과가 비어 '확인할 수 없음'(no-sample)이다.
// NaN·무한대·빈 결과도 같다(0이나 통과로 읽지 않는다, ASVS 16.2.2). 지표 창고에 닿지 못하면 지표 항목은 source-unavailable이다.
// 원천 이름(지표·기록 규칙)은 docs/observability.md §8 'T-30분 점검 원천'에 적는다. 이름을 바꾸면 이 표와 그 절을 함께 고친다.
import { createExternalHttpClient, type ExternalHttpClient } from '@peaket/platform';
import {
  CDN_HIT_MIN_REQUESTS,
  CDN_HIT_RATIO_MIN,
  CLOCK_OFFSET_MAX_SECONDS,
  READINESS_ITEMS,
  type ItemDefinition,
  type ReadinessItem,
  type ReadinessProbe,
} from '../domain/readiness.js';

/** 한 번 묻는 시간 상한 2초 [가정](위젯 원천과 같다) */
export const READINESS_PROMETHEUS_TIMEOUT_MS = 2_000;

/** 지표 항목의 고정 쿼리. 값이 1이면 통과, 0이면 실패인 꼴로 만든다(시계 오프셋만 값이 초 단위 최대 절댓값) */
export const READINESS_QUERIES = {
  /** 가장 크게 어긋난 노드의 시계 오프셋(초, 절댓값). node_exporter node_timex_offset_seconds */
  'clock-offset': 'max(abs(node_timex_offset_seconds))',
  /** Redis·PostgreSQL 내보내기의 up과 Kafka 최소 동기 복제본 미달 파티션 0(ADR-0141). 하나라도 없으면 빈 결과(확인할 수 없음) */
  datastores: 'min(redis_up) * min(pg_up) * (max(kafka_server_replicamanager_underminisrpartitioncount) == bool 0)',
  /** 결제사 서킷이 모두 닫혀 있고 지난 5분 한도 초과 응답이 없다(payment-svc 지표, F-03-1 위젯 원천과 같은 이름) */
  'payment-provider': '(max(payment_pg_circuit_open) == bool 0) * (sum(increase(payment_pg_saturated_total[5m])) == bool 0)',
  /** 대기실·공연 상세·결제 종합 합성 점검(blackbox 내보내기 probe_success, probe_group="onsale" [가정]) */
  synthetic: 'min(probe_success{probe_group="onsale"})',
} as const satisfies Record<string, string>;

/** 기록 규칙 이름: peaket:readiness:<항목 키의 -를 _로>(1 통과·0 실패). 원천 기능·클라우드 내보내기가 만든다 */
export const readinessRuleOf = (key: string): string => `peaket:readiness:${key.replace(/-/g, '_')}`;
/** CDN 적중률 기록 규칙(직전 15분 적중률·요청 수) */
export const CDN_RULES = { ratio: 'peaket:cdn_edge_hit_ratio:15m', requests: 'peaket:cdn_edge_requests:15m' } as const;

interface PromSample {
  value?: [number, string];
}

class PromUnavailable extends Error {}

const finite = (v: string | undefined): number | undefined => {
  if (v === undefined) return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

export class PrometheusReadinessProbe implements ReadinessProbe {
  constructor(
    /** 없으면 지표·규칙 항목은 모두 source-unavailable */
    private readonly http: Pick<ExternalHttpClient, 'request'> | undefined,
    /** local·ci·demo면 클라우드 전용 항목은 not-in-env */
    private readonly cloudLocal: boolean,
  ) {}

  static fromUrl(baseUrl: string | undefined, cloudLocal: boolean): PrometheusReadinessProbe {
    return new PrometheusReadinessProbe(baseUrl ? createExternalHttpClient({ provider: 'prometheus', baseUrl, timeoutCapMs: READINESS_PROMETHEUS_TIMEOUT_MS }) : undefined, cloudLocal);
  }

  /** 즉시 쿼리 하나의 첫 값. 빈 결과·NaN은 undefined, 닿지 못하면 PromUnavailable */
  private async scalar(query: string, nowMs: number): Promise<number | undefined> {
    if (!this.http) throw new PromUnavailable();
    let res: Response;
    try {
      res = await this.http.request({ method: 'GET', path: '/api/v1/query', query: { query, time: nowMs / 1000 } });
    } catch {
      throw new PromUnavailable();
    }
    if (!res.ok) throw new PromUnavailable();
    const body = (await res.json().catch(() => undefined)) as { status?: string; data?: { result?: unknown } } | undefined;
    if (body?.status !== 'success' || !Array.isArray(body.data?.result)) throw new PromUnavailable();
    return finite((body.data.result as PromSample[])[0]?.value?.[1]);
  }

  private async one(def: ItemDefinition, nowMs: number): Promise<ReadinessItem> {
    const base = { key: def.key, group: def.group };
    const at = new Date(nowMs).toISOString();
    if (def.source === 'display') return { ...base, status: 'display-only' };
    if (def.source === 'cloud' && this.cloudLocal) return { ...base, status: 'not-in-env' };
    try {
      if (def.key === 'clock-offset') {
        const v = await this.scalar(READINESS_QUERIES['clock-offset'], nowMs);
        if (v === undefined) return { ...base, status: 'unknown', reason: 'no-sample' };
        return { ...base, status: v <= CLOCK_OFFSET_MAX_SECONDS ? 'pass' : 'fail', value: Math.round(v * 1e6) / 1e3, unit: 'ms', at };
      }
      if (def.key === 'cdn-hit-ratio') {
        const [ratio, requests] = await Promise.all([this.scalar(CDN_RULES.ratio, nowMs), this.scalar(CDN_RULES.requests, nowMs)]);
        if (requests !== undefined && requests < CDN_HIT_MIN_REQUESTS) return { ...base, status: 'deferred', value: requests, unit: 'requests', at };
        if (ratio === undefined || requests === undefined) return { ...base, status: 'unknown', reason: 'no-sample' };
        return { ...base, status: ratio >= CDN_HIT_RATIO_MIN ? 'pass' : 'fail', value: ratio, unit: 'ratio', at };
      }
      const query = def.source === 'metric' ? READINESS_QUERIES[def.key as keyof typeof READINESS_QUERIES] : readinessRuleOf(def.key);
      if (query === undefined) return { ...base, status: 'unknown', reason: 'source-not-built' };
      const v = await this.scalar(query, nowMs);
      // 기록 규칙이 아직 없으면(원천 기능 전) 빈 결과다
      if (v === undefined) return { ...base, status: 'unknown', reason: def.source === 'metric' ? 'no-sample' : 'source-not-built' };
      return { ...base, status: v >= 1 ? 'pass' : 'fail', value: v, at };
    } catch (err) {
      if (err instanceof PromUnavailable) return { ...base, status: 'unknown', reason: 'source-unavailable' };
      throw err;
    }
  }

  async check(nowMs: number): Promise<ReadinessItem[]> {
    return Promise.all(READINESS_ITEMS.map((d) => this.one(d, nowMs)));
  }
}
