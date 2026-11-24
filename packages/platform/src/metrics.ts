// 네 신호 계측(NFR-011, ADR-0077 결정 1·5, ADR-0069 결정 5, docs/observability.md §3·§8).
// 지표 정의는 이 파일 한 곳에 둔다(docs/devops.md §4.4 '@prometheus-io/client').
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from '@prometheus-io/client';

/**
 * 지연 히스토그램 표준 칸(초). 서비스 템플릿과 Envoy가 같은 목록을 쓰고 개별 서비스가 바꾸지 않는다(observability §8).
 * SLO·경보 기준값을 모두 칸 경계로 담는다. 바꿀 때는 observability §8의 목록을 먼저 고친다(시험이 둘을 견준다).
 */
export const LATENCY_BUCKETS_SECONDS: readonly number[] = Object.freeze([
  0.005, 0.01, 0.02, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3, 0.5, 0.6, 0.8, 1, 1.5, 1.8, 2, 2.5, 3, 5, 10, 30, 60,
]);

const DONE_LABELS = ['service', 'route', 'method', 'status_class'] as const;
const ACTIVE_LABELS = ['service', 'route', 'method'] as const;
const RPC_LABELS = ['service', 'method', 'code'] as const;

/**
 * OpenMetrics 레지스트리. prom-client 0.16.1은 OpenMetrics 노출 때 공유 Counter의 이름에서 `_total`을 떼어 두므로
 * (registry.js `standardizeCounterName`), 노출이 끝나면 원래 이름으로 되돌린다. 그래야 다음 서비스의 시작 검사가
 * `_total` 없는 Counter로 오해하지 않는다. 노출 글은 라이브러리가 `_total`을 붙여 내므로 바뀌지 않는다
 */
class OpenMetricsRegistry extends Registry {
  readonly #names = new WeakMap<object, string>();

  constructor() {
    super(Registry.OPENMETRICS_CONTENT_TYPE);
  }

  override async metrics(): Promise<string> {
    const counters = this.getMetricsAsArray().filter((m) => m.type === 'counter');
    for (const m of counters) if (!this.#names.has(m)) this.#names.set(m, String(m.name));
    try {
      return await super.metrics();
    } finally {
      for (const m of counters) (m as { name: string }).name = this.#names.get(m)!;
    }
  }
}

/**
 * 시간 초과 신호(ADR-0070, docs/architecture.md §5 '지표는', docs/observability.md §3 '시간 초과 신호'). 경보가 아니라 원인을 가르는 지표다.
 * DB 풀·Redis 연결은 서비스 뼈대보다 먼저(또는 따로) 만들어져 지표 묶음을 받지 못하므로, 프로세스 하나에 하나씩 두고
 * 서비스 뼈대가 만드는 지표 묶음마다 함께 싣는다(관리 포트 /metrics). 합본처럼 한 프로세스에 서비스가 여럿이면 라벨로 가른다
 */
export const TIMEOUT_METRICS = Object.freeze({
  /** 풀 대기 한도(핫패스 100ms·일반 1초)를 넘겨 429 server-busy로 답한 연결 받기 */
  dbPoolWaitTimeouts: new Counter({ name: 'db_pool_wait_timeout_total', help: 'DB 연결 풀 대기 한도를 넘긴 수(429 server-busy, ADR-0070)', labelNames: ['service'] as const, registers: [] }),
  /** 서버 상한으로 취소된 문장(SQLSTATE 57014) */
  dbStatementTimeouts: new Counter({ name: 'db_statement_timeout_total', help: 'statement_timeout으로 취소된 문장 수(SQLSTATE 57014, ADR-0070)', labelNames: ['role'] as const, registers: [] }),
  /** 명령 시간 초과·호출 쪽 마감을 넘긴 Redis 호출 */
  redisCommandTimeouts: new Counter({ name: 'redis_command_timeout_total', help: 'Redis 명령 시간 초과·호출 마감을 넘긴 호출 수(ADR-0070·0176)', labelNames: ['cluster'] as const, registers: [] }),
});

export class PlatformMetrics {
  readonly registry: Registry = new OpenMetricsRegistry();
  /** 지연(OTel http.server.request.duration). exemplar(남길 trace의 traceId·spanId)를 싣는다(V-T50 ⑧) */
  readonly requestDuration: Histogram<(typeof DONE_LABELS)[number]>;
  /** 처리 중 요청 수(OTel http.server.active_requests). 처리 중에는 상태 코드를 모른다 */
  readonly activeRequests: Gauge<(typeof ACTIVE_LABELS)[number]>;
  /** 5xx 응답 */
  readonly errors: Counter<(typeof DONE_LABELS)[number]>;
  /** 정상 분기로 표시한 Problem으로 답한 응답(예: 좌석 경합 409, guidelines §2) */
  readonly businessRejections: Counter<(typeof DONE_LABELS)[number]>;
  /** 업무 gRPC 포트가 받은 호출 하나의 처리 시간(OTel rpc.server.call.duration, docs/observability.md §3 'gRPC 서버 지표') */
  readonly rpcServerDuration: Histogram<(typeof RPC_LABELS)[number]>;
  /** 진단 수집(RB-31) 결과. result는 고정 목록이다(diagnose.ts DIAGNOSE_RESULTS) */
  readonly diagnoseResults: Counter<'service' | 'result'>;
  /** 파트너 테넌트 한도 판정 결과(allowed·limited·unavailable, BAT-173, docs/observability.md §3). 테넌트 ID는 라벨에 싣지 않는다 */
  readonly tenantRateLimit: Counter<'service' | 'result'>;

  constructor(readonly service: string) {
    const registers = [this.registry];
    this.requestDuration = new Histogram({
      name: 'http_server_request_duration_seconds',
      help: 'HTTP 요청 처리 시간(초). 칸은 표준 목록(docs/observability.md §8)',
      labelNames: DONE_LABELS,
      buckets: [...LATENCY_BUCKETS_SECONDS],
      // OpenMetrics exemplar(traceId·spanId, docs/observability.md §2 'SLI 실시간 산출'). 레지스트리도 OpenMetrics 형식이어야 실린다
      enableExemplars: true,
      registers,
    });
    this.activeRequests = new Gauge({
      name: 'http_server_active_requests',
      help: '처리 중인 HTTP 요청 수(ADR-0077 결정 5)',
      labelNames: ACTIVE_LABELS,
      registers,
    });
    this.errors = new Counter({
      name: 'http_server_errors_total',
      help: '5xx로 답한 HTTP 요청 수',
      labelNames: DONE_LABELS,
      registers,
    });
    this.businessRejections = new Counter({
      name: 'http_server_business_rejections_total',
      help: '업무상 정상 분기(예: 좌석 경합 409)로 거절한 HTTP 요청 수. 오류와 따로 센다(docs/api/guidelines.md §2)',
      labelNames: DONE_LABELS,
      registers,
    });
    this.rpcServerDuration = new Histogram({
      name: 'rpc_server_call_duration_seconds',
      help: 'gRPC 서버 호출 하나의 처리 시간(초). method는 등록한 이름이나 unknown, code는 상태 이름(docs/observability.md §3)',
      labelNames: RPC_LABELS,
      buckets: [...LATENCY_BUCKETS_SECONDS],
      registers,
    });
    this.diagnoseResults = new Counter({
      name: 'diagnose_collections_total',
      help: '진단 수집(RB-31) 결과 수. 힙 스냅샷을 건너뛴 까닭도 result로 센다',
      labelNames: ['service', 'result'] as const,
      registers,
    });
    this.tenantRateLimit = new Counter({
      name: 'tenant_rate_limit_total',
      help: '파트너 테넌트 한도 판정 결과(allowed·limited·unavailable, docs/api/guidelines.md §6)',
      labelNames: ['service', 'result'] as const,
      registers,
    });
    for (const m of Object.values(TIMEOUT_METRICS) as Counter<string>[]) this.registry.registerMetric(m);
    // 포화도: 이벤트 루프 지연 등 Node 기본 지표
    collectDefaultMetrics({ register: this.registry });
  }
}

/** Fastify 경로 틀을 계약 표기로: /v1/events/:eventId → /v1/events/{eventId}. 맞는 경로가 없으면 unmatched */
export function routeLabel(url: string | undefined): string {
  if (!url) return 'unmatched';
  return url.replace(/:([A-Za-z0-9_]+)(\([^)]*\))?/g, '{$1}');
}

export const statusClass = (code: number): string => `${Math.floor(code / 100)}xx`;

/** 지연 히스토그램 라벨(처리 중 게이지와 같다) */
export interface HttpMetricLabels {
  service: string;
  route: string;
  method: string;
  status_class: string;
}

/** 지연 점에 붙일 exemplar(남길 trace만). 서버 span이 없으면 traceId만 있다 */
export interface RequestExemplar {
  traceId: string;
  spanId?: string;
}

/**
 * 지연 히스토그램을 한 번 관측한다(docs/observability.md §2 'SLI 실시간 산출', V-T50 ⑧).
 * exemplar를 켠 히스토그램은 `{ labels, value, exemplarLabels }` 꼴로만 관측하므로 이 함수로 모은다.
 */
export function observeRequestDuration(metrics: PlatformMetrics, labels: HttpMetricLabels, seconds: number, exemplar?: RequestExemplar): void {
  // 라이브러리 형은 exemplar 라벨 이름을 지표 라벨 이름으로 제한하지만(잘못된 형), 실제 OpenMetrics exemplar는 자기 라벨(traceId·spanId)을 갖는다
  const exemplarLabels = exemplar as unknown as Partial<Record<keyof HttpMetricLabels, string>> | undefined;
  metrics.requestDuration.observe(exemplarLabels ? { labels, value: seconds, exemplarLabels } : { labels, value: seconds });
}
