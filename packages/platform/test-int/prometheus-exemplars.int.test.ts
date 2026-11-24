// exemplar 저장을 켠 Prometheus가 남길 trace의 exemplar를 돌려주는지(V-T50 ⑧, docs/verification.md:671,
// docs/observability.md:138·:290, 계획 docs/review/plans/F-01-9.md §6). 서비스 템플릿을 실제 소켓으로 띄우고
// (trace ID는 traceparent로 고정, 표본 비율 2), Docker의 Prometheus가 `--enable-feature=exemplar-storage`로 관리 포트를 긁는다.
// `/api/v1/query_exemplars`에 남긴 셋(정상 표본·5xx·SLO 지연 초과)의 traceId가 있고 표본 밖 traceId는 없는지 본다.
// 가짜 없음: 실제 Prometheus 이미지다. Docker 네트워크는 만들지 않고 호스트를 host.docker.internal로 부른다(Alertmanager 도우미와 같은 꼴).
import { afterAll, beforeAll, expect, test } from 'vitest';
import { startTelemetry } from '../src/telemetry.js';
import { PROMETHEUS_IMAGE, startContainer, until, type Container } from './observability-stores.js';

const telemetry = startTelemetry({ serviceName: 'exemplar-svc', env: 'ci', spanProcessors: [] });

type Started = import('../test/fixture.js').Started;
let s: Started;
let base: string;
let prom: Container | undefined;

/** 표본 비율 2에서 문턱(2^55) 위·아래 trace ID(ADR-0125 결정 3의 식으로 시험이 고른 값) */
const KEPT = 'aaaaaaaaaaaaaaaaaa80000000000000';
const DROPPED_ITEM = 'bbbbbbbbbbbbbbbbbb7fffffffffffff';
const DROPPED_5XX = 'cccccccccccccccccc7fffffffffffff';
const DROPPED_SLO = 'dddddddddddddddddd7fffffffffffff';
const SPAN = '2222222222222222';
const traceparent = (traceId: string) => `00-${traceId}-${SPAN}-01`;

async function hit(path: string, traceId: string): Promise<void> {
  const res = await fetch(`${base}${path}`, { headers: { traceparent: traceparent(traceId) } });
  await res.text();
}

type ExemplarResponse = {
  status: string;
  data?: { seriesLabels?: Record<string, string>; exemplars?: { labels?: Record<string, string>; value?: string; timestamp?: number }[] }[];
};

beforeAll(async () => {
  const app = await import('../test/fixture.js');
  s = await app.start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '2', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
  const { port, managementPort } = await s.svc.listen('0.0.0.0');
  base = `http://127.0.0.1:${port}`;
  prom = startContainer({
    image: PROMETHEUS_IMAGE,
    ports: [9090],
    runArgs: ['--add-host=host.docker.internal:host-gateway'],
    files: {
      '/etc/prometheus/prometheus.yml': `global:\n  scrape_interval: 1s\nscrape_configs:\n  - job_name: exemplar-svc\n    static_configs:\n      - targets: ['host.docker.internal:${managementPort}']\n`,
    },
    args: ['--config.file=/etc/prometheus/prometheus.yml', '--storage.tsdb.path=/prometheus', '--enable-feature=exemplar-storage'],
  });
  await until('Prometheus 준비', 120_000, async () => (await fetch(`${prom!.url(9090)}/-/ready`)).status, (code) => code === 200, prom);
}, 180_000);
afterAll(async () => {
  prom?.stop();
  await s?.svc.close();
  await telemetry.shutdown();
});

test('V-T50 ⑧ exemplar 저장을 켠 Prometheus가 남길 trace의 exemplar를 돌려준다', async () => {
  await hit('/v1/demo/items/keep-1', KEPT);
  await hit('/v1/demo/items/drop-1', DROPPED_ITEM);
  await hit('/v1/demo/boom', DROPPED_5XX);
  await hit('/v1/demo/slow-120', DROPPED_SLO);

  const end = Math.floor(Date.now() / 1000) + 10;
  const start = end - 600;
  const query = `http_server_request_duration_seconds_bucket`;
  const url = () => `${prom!.url(9090)}/api/v1/query_exemplars?query=${encodeURIComponent(query)}&start=${start}&end=${end}`;
  const got = await until(
    'exemplar 질의',
    120_000,
    async () => {
      const body = (await (await fetch(url())).json()) as ExemplarResponse;
      if (body.status !== 'success') throw new Error(`exemplar 질의 실패: ${JSON.stringify(body)}`);
      return (body.data ?? []).flatMap((series) => (series.exemplars ?? []).map((e) => ({ series: series.seriesLabels ?? {}, exemplar: e.labels ?? {} })));
    },
    (rows) => [KEPT, DROPPED_5XX, DROPPED_SLO].every((id) => rows.some((r) => r.exemplar.traceId === id)),
    prom,
  );

  // 남긴 셋은 traceId와 서버 span의 spanId(16자리)를 함께 싣는다
  for (const id of [KEPT, DROPPED_5XX, DROPPED_SLO]) {
    const row = got.find((r) => r.exemplar.traceId === id)!;
    expect(row.exemplar.spanId, `${id}의 spanId`).toMatch(/^[0-9a-f]{16}$/);
    expect(row.series.route, `${id}의 지표 라벨`).toBeTruthy();
  }
  // 표본에 들지 않은 정상 요청의 trace ID는 어디에도 없다
  expect(got.some((r) => r.exemplar.traceId === DROPPED_ITEM)).toBe(false);
  // 보낸 trace가 아닌 exemplar는 없어야 한다(빈 결과·다른 trace가 섞여 통과하지 않게)
  const sent = new Set([KEPT, DROPPED_5XX, DROPPED_SLO]);
  expect(got.every((r) => sent.has(r.exemplar.traceId ?? ''))).toBe(true);
}, 240_000);
