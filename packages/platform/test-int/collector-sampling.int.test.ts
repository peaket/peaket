// 정상 trace와 정상 로그 줄의 짝(V-T30 ②, docs/observability.md §6 '테일 기반 적응형 샘플링'·§7 정규 로그 줄 표본, ADR-0125,
// docs/verification.md V-T30 ②, 계획 docs/review/plans/F-01-3.md §6).
// 정본: 서비스 템플릿이 요청마다 trace ID 끝 56비트로 한 번 정한 정상 표본(peaket.sample.keep)을 서버 span에 달고, 꼬리 표본기는 그 속성을 읽는다.
// 정규 로그 줄의 정상 표본도 같은 값으로 정하므로, 남긴 정상 trace의 로그 줄이 함께 남는다. 5xx·SLO 지연 초과는 trace와 로그 줄 모두 전수다.
// 실제 게이트웨이 수집기 하나(운영 판 + 로컬 판)에 OTEL_EXPORTER_OTLP_ENDPOINT를 돌린 서비스 템플릿 서비스(createService, test/fixture.ts)를 잇고
// 요청 1만 건을 흘린다. 표본은 N = 10(PEAKET_LOG_SAMPLE_ONE_IN). 비율 판정은 p = 1/N ± 4σ(σ = √(p(1−p)/n), 정상 요청 n건).
// 요청은 하나씩 차례로 보낸다: 시험 서비스는 가짜 시계 하나를 나눠 쓰므로(slow-120이 시계를 120ms 돌린다) 겹치면 다른 요청의 걸린 시간이 늘어난다.
// SDK는 계측할 모듈(node:http)보다 먼저 서야 하므로 수집기를 띄우고 끝점을 정한 뒤 SDK를 시작하고, 시험 서비스는 그 뒤에 읽는다.
// collector.ts는 node 기본 모듈만 읽는다.
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import type { Telemetry } from '../src/telemetry.js';
import { attr, metricSum, pollUntil, startGateway, type CollectorContainer } from './collector.js';

const N = 10;
const TOTAL = 10_000;
/** 요청 n번째의 종류: 20건마다 5xx 하나, SLO 지연 초과 하나, 나머지는 정상 */
const kindOf = (n: number): 'error' | 'slow' | 'normal' => (n % 20 === 0 ? 'error' : n % 20 === 10 ? 'slow' : 'normal');
const PATH = { error: '/v1/demo/boom', slow: '/v1/demo/slow-120', normal: '/v1/demo/items/{itemId}' } as const;

type Fixture = typeof import('../test/fixture.js');
type LogLine = Record<string, unknown>;
let gw: CollectorContainer;
let telemetry: Telemetry | undefined;
let s: Awaited<ReturnType<Fixture['start']>> | undefined;
const counts = { error: 0, slow: 0, normal: 0 };
let lines: LogLine[] = [];
/** 결과 파일의 서버 span: trace ID → 경로 */
let keptRoutes = new Map<string, string>();

beforeAll(async () => {
  gw = await startGateway();
  vi.stubEnv('OTEL_EXPORTER_OTLP_ENDPOINT', gw.otlpHttp);
  vi.stubEnv('OTEL_TRACES_EXPORTER', 'otlp');
  // 1만 건을 잃지 않게 SDK 묶음 내보내기 대기열을 넉넉히 둔다(기본 2048)
  vi.stubEnv('OTEL_BSP_MAX_QUEUE_SIZE', '20000');
  const { startTelemetry, withoutTracePropagation } = await import('../src/telemetry.js');
  telemetry = startTelemetry({ serviceName: 'demo-svc', version: '1.0.0', env: 'ci' });
  const fx: Fixture = await import('../test/fixture.js');
  s = await fx.start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: String(N), PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
  const { port } = await s.svc.listen('127.0.0.1');
  for (let n = 0; n < TOTAL; n++) {
    const kind = kindOf(n);
    counts[kind] += 1;
    const path = kind === 'normal' ? `/v1/demo/items/i${n}` : PATH[kind];
    const res = await withoutTracePropagation(() => fetch(`http://127.0.0.1:${port}${path}`));
    await res.text();
    if (res.status !== (kind === 'error' ? 500 : 200)) throw new Error(`${path}: ${res.status}`);
  }
  // 남은 span을 모두 보낸다
  await telemetry.shutdown();
  lines = s.requests();
  const text = await pollUntil(
    '꼬리 표본 판정 수',
    async () => {
      const t = await gw.metrics();
      const decided = metricSum(t, 'otelcol_processor_tail_sampling_global_count_traces_sampled');
      return decided !== undefined && decided >= TOTAL ? t : undefined;
    },
    { timeoutMs: 120_000, intervalMs: 500 },
  ).catch((err: unknown) => {
    throw new Error(`${String(err)}\n${gw.logs()}`);
  });
  const keptCount = metricSum(text, 'otelcol_processor_tail_sampling_global_count_traces_sampled', { sampled: 'true' }) ?? 0;
  keptRoutes = await pollUntil(
    '남긴 trace가 결과 파일에',
    () => {
      const m = new Map<string, string>();
      for (const { span } of gw.output().spans) {
        const route = attr(span.attributes, 'http.route')?.stringValue;
        if (route) m.set(span.traceId, route);
      }
      return keptCount > 0 && m.size >= keptCount ? m : undefined;
    },
    { timeoutMs: 60_000, intervalMs: 500 },
  );
}, 900_000);

afterAll(async () => {
  await s?.svc.close();
  await telemetry?.shutdown();
  gw?.stop();
  vi.unstubAllEnvs();
});

const linesOf = (route: string, status: number) => lines.filter((l) => l.route === route && l.status === status);

describe('V-T30 ② 정상 trace와 정상 로그 줄', () => {
  test('V-T30 ②-1 요청 1만 건이 모두 처리되고 정상·5xx·SLO 초과가 정한 수만큼이다', () => {
    expect(counts).toEqual({ error: 500, slow: 500, normal: 9_000 });
    // 5xx·SLO 지연 초과 줄은 전수다
    expect(linesOf(PATH.error, 500)).toHaveLength(500);
    expect(linesOf(PATH.slow, 200)).toHaveLength(500);
  });

  test('V-T30 ②-2 정상 trace를 남긴 요청은 모두 정상 로그 줄이 있다', () => {
    const normalLineIds = new Set(linesOf(PATH.normal, 200).map((l) => l.traceId as string));
    const keptNormal = [...keptRoutes].filter(([, route]) => route === PATH.normal).map(([id]) => id);
    // 남은 정상 trace가 0이면 실패(빈 결과가 통과로 새지 않게)
    expect(keptNormal.length).toBeGreaterThan(0);
    expect(keptNormal.filter((id) => !normalLineIds.has(id))).toEqual([]);
  });

  test('V-T30 ②-3 정상 로그 줄 비율이 p ± 4σ 안이다', () => {
    const p = 1 / N;
    const n = counts.normal;
    const sigma = Math.sqrt((p * (1 - p)) / n);
    const ratio = linesOf(PATH.normal, 200).length / n;
    expect(ratio).toBeGreaterThanOrEqual(p - 4 * sigma);
    expect(ratio).toBeLessThanOrEqual(p + 4 * sigma);
  });

  test.each([
    ['5xx', PATH.error, 500],
    ['SLO 지연 초과', PATH.slow, 200],
  ] as const)('V-T30 ②-4 %s 요청은 trace와 로그 줄이 모두 있다(전수)', (_what, route, status) => {
    const ids = linesOf(route, status).map((l) => l.traceId as string);
    expect(ids).toHaveLength(500);
    const missing = ids.filter((id) => keptRoutes.get(id) !== route);
    expect(missing.length).toBe(0);
  });
});
