// 같은 출처 앱 서버(web·partner, Next.js)의 텔레메트리 시작(docs/observability.md §6 '신뢰 경계의 추적 문맥', BUILD_ORDER HOT-400).
// 자동 계측 모듈(http·undici)을 읽지 않는다: Next.js가 @opentelemetry/api로 받은 요청의 span을 직접 만들고(전역 전파기로 추적 값을 꺼낸다),
// 운영 standalone 출력은 계측 모듈의 숨은 의존(forwarded-parse 등)을 담지 못한다(2026-11-16 standalone 실행으로 확인).
import { BROWSER_TRACEPARENT_HEADER } from './trace-boundary.js';
import { startSdk, type Telemetry } from './telemetry-sdk.js';

export { BROWSER_TRACEPARENT_HEADER };

export interface AppServerTelemetryOptions {
  /** OTEL_SERVICE_NAME이 없을 때의 서비스 이름(web·partner) */
  defaultServiceName: string;
  /** 환경 값(시험). 없으면 process.env */
  env?: Record<string, string | undefined>;
}

/**
 * 같은 출처 앱 서버(web·partner, Next.js)의 텔레메트리를 앱 서버 모드(untrusted)로 시작한다(docs/observability.md §6 '신뢰 경계의 추적 문맥', BUILD_ORDER HOT-400).
 * 앱 서버는 브라우저가 보낸 추적 값을 부모로 잇지 않으므로, PEAKET_TRACE_INBOUND가 untrusted가 아닌 값(mesh 등)으로 적혀 있으면
 * 조용히 메시 모드로 돌지 않게 시작하지 않고 던진다. 값이 없으면 untrusted다
 */
export function startAppServerTelemetry(o: AppServerTelemetryOptions): Telemetry {
  const env = o.env ?? process.env;
  const inbound = env.PEAKET_TRACE_INBOUND;
  if (inbound !== undefined && inbound !== '' && inbound !== 'untrusted') {
    throw new Error(`앱 서버는 PEAKET_TRACE_INBOUND=untrusted로만 텔레메트리를 시작한다: ${inbound}(docs/observability.md §6)`);
  }
  return startSdk({ serviceName: env.OTEL_SERVICE_NAME || o.defaultServiceName, version: env.PEAKET_VERSION, env: env.PEAKET_ENV, inbound: 'untrusted' }, []);
}

/**
 * 같은 출처 앱 서버의 시작 확인(서버 액션 키·추적 모드)이 실패했을 때, Next.js 서버 안이면 그 자리에서 프로세스를 끝낸다
 * (리뷰 RV-08·검증 VF-11, docs/devops.md §6.6 '틀리면 서버를 띄우지 않는다'). Next.js 16은 계측 진입점(register)이 던져도 프로세스를
 * 끝내지 않고 모든 요청에 500으로 답하며 남는다. 끝내기를 미루면(타이머) 그 사이 첫 요청에 답해 '떴다'가 된다(2026-11-16 열 번 중 아홉 번).
 * 그래서 오류 줄을 표준 오류에 동기로 쓰고 바로 0이 아닌 코드로 끝낸다. Next.js 서버인지는 서버가 듣기 시작할 때 다는 환경 값
 * `__NEXT_PRIVATE_ORIGIN`으로 본다(next start·standalone server.js 모두, next/dist/server/lib/start-server.js). 그 밖(계측 진입점을 바로 부르는
 * 단위 시험 등)에서는 아무것도 하지 않고 돌아가며, 부르는 쪽이 오류를 다시 던진다
 */
export function exitAfterStartupFailure(error: unknown, env: Record<string, string | undefined> = process.env): void {
  if (env.__NEXT_PRIVATE_ORIGIN === undefined) return;
  process.stderr.write(`서버를 띄우지 않는다: ${error instanceof Error ? error.message : String(error)}
`);
  process.exit(1);
}
