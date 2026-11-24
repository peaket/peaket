// 남길 trace의 지연 점에만 붙는 exemplar(V-T50 ⑧, docs/verification.md:671, docs/observability.md:138·§2 'SLI 실시간 산출',
// 계획 docs/review/plans/F-01-9.md §3·§6). 정본: 정상 표본에 든 요청·5xx·SLO 지연 초과 요청의 지연 히스토그램 점에만
// exemplar `traceId`·`spanId`가 붙고, 표본에 들지 않은 정상 요청에는 붙지 않는다. 표본 문턱은 ADR-0125 결정 3의
// `R ≥ (1 − 1/N) × 2^56`이고, 시험은 N=2에서 문턱(2^55 = 0x80000000000000) 위·아래 trace ID를 정본 식으로 골라 하드코딩한다.
// 서버 span이 있어야 spanId가 붙으므로 OTel SDK를 먼저 켜고 실제 소켓으로 부른다(inject는 자동 계측을 지나지 않는다).
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startTelemetry } from '../src/telemetry.js';

const telemetry = startTelemetry({ serviceName: 'exemplar-svc', env: 'ci', spanProcessors: [] });

type Started = import('./fixture.js').Started;
type App = typeof import('./fixture.js');
let app: App;
let s: Started;
let base: string;

beforeAll(async () => {
  app = await import('./fixture.js');
  s = await app.start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '2', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
  const { port } = await s.svc.listen('127.0.0.1');
  base = `http://127.0.0.1:${port}`;
}, 60_000);
afterAll(async () => {
  await s?.svc.close();
  await telemetry.shutdown();
});

/** 표본 비율 2(1/2)에서 남는 trace ID: 끝 56비트 0x80000000000000 >= 문턱 */
const KEPT = 'aaaaaaaaaaaaaaaaaa80000000000000';
/** 표본에서 빠지는 trace ID: 끝 56비트 0x7fffffffffffff < 문턱 */
const DROPPED_ITEM = 'bbbbbbbbbbbbbbbbbb7fffffffffffff';
const DROPPED_5XX = 'cccccccccccccccccc7fffffffffffff';
const DROPPED_SLO = 'dddddddddddddddddd7fffffffffffff';
const SPAN = '1111111111111111';
const traceparent = (traceId: string) => `00-${traceId}-${SPAN}-01`;

type Record_ = { metric: string; labels: Record<string, string>; exemplar: Record<string, string> };
const pairs = (text: string): Record<string, string> =>
  Object.fromEntries([...text.matchAll(/([A-Za-z0-9_.]+)="((?:[^"\\]|\\.)*)"/g)].map((m) => [m[1]!, m[2]!]));

/** 지표 글에서 exemplar가 붙은 줄만: `<지표>{<라벨>} <값> # {<exemplar 라벨>} <값> <시각>`. OpenMetrics 형식이다 */
function exemplars(text: string): Record_[] {
  const out: Record_[] = [];
  for (const line of text.split('\n')) {
    const m = /^([A-Za-z_:][A-Za-z0-9_:]*)\{([^}]*)\}\s+\S+ # \{([^}]*)\}\s+\S+\s+\S+$/.exec(line);
    if (m) out.push({ metric: m[1]!, labels: pairs(m[2]!), exemplar: pairs(m[3]!) });
  }
  return out;
}

async function hit(path: string, traceId: string): Promise<void> {
  const res = await fetch(`${base}${path}`, { headers: { traceparent: traceparent(traceId) } });
  await res.text();
}

test('V-T50 ⑧ 로컬 Prometheus는 exemplar 저장을 켠다', () => {
  const yaml = readFileSync(new URL('../../../deploy/local/observability.yaml', import.meta.url), 'utf8');
  expect(yaml, 'docs/observability.md:290의 로컬 Prometheus exemplar 저장').toMatch(/- --enable-feature=exemplar-storage\b/);
});

test('V-T50 ⑧ 남길 trace의 지연 점에만 exemplar가 붙고 표본 밖 요청에는 붙지 않는다', async () => {
  await hit('/v1/demo/items/keep-1', KEPT);
  await hit('/v1/demo/items/drop-1', DROPPED_ITEM);

  const res = await s.svc.management.inject({ method: 'GET', url: '/metrics' });
  expect(res.statusCode).toBe(200);
  // OpenMetrics 형식으로 낸다(정본 §2 'SLI 실시간 산출'). 형식이 아니면 exemplar가 실리지 않는다
  expect(String(res.headers['content-type'])).toMatch(/^application\/openmetrics-text/);
  const text = String(res.payload);
  expect(text).toMatch(/^# EOF$/m);

  const all = exemplars(text);
  const kept = all.find((e) => e.exemplar.traceId === KEPT);
  expect(kept, `남긴 trace의 exemplar가 없다:\n${text.split('\n').filter((l) => l.includes('#')).join('\n')}`).toBeDefined();
  expect(kept!.metric).toBe('http_server_request_duration_seconds_bucket');
  expect(kept!.labels.route).toBe('/v1/demo/items/{itemId}');
  // 서버 span이 있으므로 spanId도 붙는다(16자리 16진수)
  expect(kept!.exemplar.spanId).toMatch(/^[0-9a-f]{16}$/);
  // 표본에 들지 않은 정상 요청에는 붙지 않는다
  expect(all.some((e) => e.exemplar.traceId === DROPPED_ITEM)).toBe(false);
});

test('V-T50 ⑧ 5xx와 SLO 지연 초과 요청에는 표본 밖이어도 exemplar가 붙는다', async () => {
  await hit('/v1/demo/boom', DROPPED_5XX);
  await hit('/v1/demo/slow-120', DROPPED_SLO);

  const text = await s.metrics();
  const all = exemplars(text);
  for (const [traceId, route, why] of [
    [DROPPED_5XX, '/v1/demo/boom', '5xx'],
    [DROPPED_SLO, '/v1/demo/slow-120', 'SLO 지연 초과'],
  ] as const) {
    const got = all.find((e) => e.exemplar.traceId === traceId);
    expect(got, `${why} 요청의 exemplar가 없다`).toBeDefined();
    expect(got!.labels.route).toBe(route);
    expect(got!.exemplar.spanId).toMatch(/^[0-9a-f]{16}$/);
  }
  // exemplar는 지연 히스토그램에만 붙는다(오류 카운터 줄에는 붙지 않는다)
  expect(all.every((e) => e.metric.startsWith('http_server_request_duration_seconds_'))).toBe(true);
});
