// OTel Node SDK 시작(docs/devops.md §4.4 'SDK 설정은 packages/platform 시작 코드 한 곳에서만', openspec 변경 add-service-logging 결정 7).
// 실행 명령: node --import @peaket/platform/telemetry/register dist/main.js
// 자동 계측은 계측할 모듈(Fastify가 쓰는 node:http)보다 먼저 서야 한다. 서비스 코드는 @opentelemetry/api만 쓴다.
// SDK 핵심은 telemetry-sdk.ts, 같은 출처 앱 서버(web·partner)의 시작은 telemetry-app-server.ts(@peaket/platform/telemetry/app-server)다.
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { startSdk, type Telemetry, type TelemetryOptions } from './telemetry-sdk.js';
import { tracePropagationSuppressed } from './trace-boundary.js';

export { withoutTracePropagation } from './trace-boundary.js';
export type { InboundTrust } from './trace-boundary.js';
export { shutdownTelemetry } from './telemetry-sdk.js';
export type { Telemetry, TelemetryOptions } from './telemetry-sdk.js';
export { startAppServerTelemetry, type AppServerTelemetryOptions } from './telemetry-app-server.js';

// 게이트웨이가 옮긴 브라우저 traceparent 머리 이름(docs/observability.md §6 '앱 서버가 브라우저 값을 받는 길', BUILD_ORDER HOT-400)
export { BROWSER_TRACEPARENT_HEADER } from './trace-boundary.js';

export function startTelemetry(o: TelemetryOptions): Telemetry {
  return startSdk(o, [
    // 관리 포트의 지표 긁기는 요청 기록을 만들지 않는다
    new HttpInstrumentation({ ignoreIncomingRequestHook: (req) => req.method === 'GET' && req.url === '/metrics' }),
    // 외부 호출 클라이언트의 요청(전파를 끈 맥락)은 건너뛴다. 클라이언트가 경로 틀로 span을 직접 만든다
    new UndiciInstrumentation({ ignoreRequestHook: () => tracePropagationSuppressed() }),
  ]);
}
