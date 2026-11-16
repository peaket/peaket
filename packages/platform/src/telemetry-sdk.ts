// OTel Node SDK 시작의 핵심(docs/devops.md §4.4 'SDK 설정은 packages/platform 시작 코드 한 곳에서만', openspec 변경 add-service-logging 결정 7).
// 자동 계측(http·undici)은 부르는 쪽이 넘긴다. 이 모듈은 계측 모듈을 읽지 않아, 같은 출처 앱 서버(Next.js)가 계측 없이 SDK만 쓸 수 있다
// (telemetry-app-server.ts, BUILD_ORDER HOT-400). 서비스는 telemetry.ts의 startTelemetry를 쓴다.
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { NodeSDK, type NodeSDKConfiguration } from '@opentelemetry/sdk-node';
import { BatchSpanProcessor, type SpanProcessor } from '@opentelemetry/sdk-trace';
import { BoundaryPropagator, BoundarySpanProcessor, type InboundTrust } from './trace-boundary.js';

export interface TelemetryOptions {
  /** service.name(서비스 이름, 예: purchase-svc) */
  serviceName: string;
  /** service.version(PEAKET_VERSION) */
  version?: string;
  /** deployment.environment.name(PEAKET_ENV) */
  env?: string;
  /** 들어온 추적 문맥을 믿는가. 서비스는 mesh(기본), 같은 출처 앱 서버는 untrusted */
  inbound?: InboundTrust;
  /** 내보내기(시험). 없으면 OTLP로 묶어 보내고, OTEL_TRACES_EXPORTER=none이면 보내지 않는다 */
  spanProcessors?: SpanProcessor[];
}

export interface Telemetry {
  shutdown(): Promise<void>;
}

type Instrumentations = NonNullable<Partial<NodeSDKConfiguration>['instrumentations']>;

let current: NodeSDK | undefined;

/** SDK를 시작한다. instrumentations는 자동 계측(서비스는 http·undici, 앱 서버는 없음) */
export function startSdk(o: TelemetryOptions, instrumentations: Instrumentations): Telemetry {
  if (current) throw new Error('OTel SDK를 이미 시작했다(시작 코드는 한 곳에서만 부른다)');
  const inbound = o.inbound ?? 'mesh';
  const exporters =
    o.spanProcessors ?? (process.env.OTEL_TRACES_EXPORTER === 'none' ? [] : [new BatchSpanProcessor({ exporter: new OTLPTraceExporter() })]);
  const attributes: Record<string, string> = { 'service.name': o.serviceName };
  if (o.version) attributes['service.version'] = o.version;
  if (o.env) attributes['deployment.environment.name'] = o.env;
  const sdk = new NodeSDK({
    // 자원 속성은 직접 정한다. 쿠버네티스 속성은 에이전트 수집기가 붙이고(observability §2 '신호 연결'), 프로세스 명령줄 같은 탐지 값은 싣지 않는다
    autoDetectResources: false,
    resource: resourceFromAttributes(attributes),
    textMapPropagator: new BoundaryPropagator(inbound),
    spanProcessors: [new BoundarySpanProcessor(), ...exporters],
    // 지표는 /metrics(@prometheus-io/client), 로그는 표준 출력(Pino)이다. SDK의 지표·로그 내보내기는 켜지 않는다
    metricReaders: [],
    logRecordProcessors: [],
    instrumentations,
  });
  sdk.start();
  current = sdk;
  return {
    async shutdown() {
      if (current !== sdk) return;
      current = undefined;
      await sdk.shutdown();
    },
  };
}

/** 등록 파일이 시작한 SDK를 끝낸다(남은 span을 보낸다). 서비스 종료 순서의 마지막에 부른다 */
export async function shutdownTelemetry(): Promise<void> {
  const sdk = current;
  current = undefined;
  await sdk?.shutdown();
}
