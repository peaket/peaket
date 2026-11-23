// SLO 지연 초과 표시(V-T49 ⑤의 서비스 쪽, docs/observability.md §1 '설정 원천과 로컬 확인'의 꼬리 표본 정책 ③, docs/verification.md V-T49 ⑤,
// 계획 docs/review/plans/F-01-3.md §3 'SLO 지연 초과 표시'·§5).
// 정본: 서비스 템플릿이 응답을 보내기 직전에 그 경로의 SLO 지연(@LogPolicy의 sloLatencyMs, 없으면 서비스 기본값 PEAKET_LOG_SLO_LATENCY_MS)을
// 넘었으면 서버 span에 peaket.slo.exceeded=true를 단다. 넘지 않으면 속성을 달지 않는다. 문턱은 정규 로그 줄의 지연 초과 전수와 같다.
// 걸린 시간은 서비스에 주입한 가짜 시계로 만든다(실제로 기다리지 않는다). 문턱 값은 시험이 고른다: 경로 250ms, 서비스 기본 700ms
// (코드 기본값 500ms와 다르다. 그래서 '경로 값을 무시하고 서비스 기본값만 보는' 구현과 '코드 기본값을 쓰는' 구현이 모두 걸린다).
// SDK는 계측할 모듈(Fastify가 쓰는 node:http)보다 먼저 서야 하므로 파일 맨 위에서 시작하고 시험 서비스는 뒤에 읽는다(telemetry.test.ts와 같은 꼴).
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { startTelemetry, withoutTracePropagation } from '../src/telemetry.js';

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ serviceName: 'slo-svc', env: 'ci', spanProcessors: [new SimpleSpanProcessor({ exporter })] });

const SERVICE_DEFAULT_SLO_MS = 700;
const ATTR = 'peaket.slo.exceeded';

type App = typeof import('./slo-exceeded-app.js');
let app: App;
let svc: Awaited<ReturnType<App['startSloService']>>;
let base: string;

beforeAll(async () => {
  app = await import('./slo-exceeded-app.js');
  svc = await app.startSloService({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '1', PEAKET_LOG_SLO_LATENCY_MS: String(SERVICE_DEFAULT_SLO_MS), PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
  // real-time: 서버 span은 node:http 자동 계측이 만든다(inject는 계측을 지나지 않는다, telemetry.test.ts와 같다) F-01-3
  const { port } = await svc.listen('127.0.0.1');
  base = `http://127.0.0.1:${port}`;
}, 60_000);
afterAll(async () => {
  await svc.close();
  await telemetry.shutdown();
});
afterEach(() => exporter.reset());

/** 요청 하나를 보내고 그 요청의 서버 span 하나를 돌려준다(서버 span이 끝날 때까지 내보내기를 당겨 본다) */
async function serverSpanOf(path: string): Promise<ReadableSpan> {
  const res = await withoutTracePropagation(() => fetch(`${base}${path}`));
  expect(res.status).toBe(200);
  await res.text();
  await expect.poll(() => exporter.getFinishedSpans().filter((s) => s.kind === 1).length, { timeout: 5_000, interval: 10 }).toBe(1);
  const [span] = exporter.getFinishedSpans().filter((s) => s.kind === 1);
  return span!;
}

describe('V-T49 ⑤ 서버 span의 SLO 지연 초과 표시', () => {
  test.each([
    ['경로 문턱(250ms)을 넘음', '/v1/slo/with-policy?ms=251', '/v1/slo/with-policy'],
    ['경로 문턱은 넘고 서비스 기본(700ms)은 넘지 않음', '/v1/slo/with-policy?ms=600', '/v1/slo/with-policy'],
    ['정책 없는 경로가 서비스 기본(700ms)을 넘음', '/v1/slo/default?ms=701', '/v1/slo/default'],
  ])('V-T49 ⑤-1 SLO 지연을 넘은 요청의 서버 span에만 peaket.slo.exceeded가 참이다: %s', async (_what, path, route) => {
    const span = await serverSpanOf(path);
    expect(span.attributes['http.route']).toBe(route);
    expect(span.attributes[ATTR]).toBe(true);
  });

  test.each([
    ['경로 문턱(250ms) 안', '/v1/slo/with-policy?ms=249', '/v1/slo/with-policy'],
    ['정책 없는 경로가 서비스 기본(700ms) 안', '/v1/slo/default?ms=699', '/v1/slo/default'],
    ['정책 없는 경로가 경로 문턱 값(250ms)은 넘지만 서비스 기본 안', '/v1/slo/default?ms=300', '/v1/slo/default'],
    ['정책 없는 경로가 코드 기본값(500ms)은 넘지만 서비스 기본 안', '/v1/slo/default?ms=550', '/v1/slo/default'],
  ])('V-T49 ⑤-2 SLO 지연을 넘지 않은 요청의 서버 span에는 peaket.slo.exceeded가 없다: %s', async (_what, path, route) => {
    const span = await serverSpanOf(path);
    expect(span.attributes['http.route']).toBe(route);
    expect(Object.keys(span.attributes)).not.toContain(ATTR);
  });
});
