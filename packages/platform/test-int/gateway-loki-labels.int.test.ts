// 게이트웨이 수집기를 지난 로그의 Loki 라벨 넷(V-T50 ⑨, docs/verification.md:671, docs/observability.md:124·578,
// 계획 docs/review/plans/F-01-9.md §3·§6). 로컬 판 Loki(--render loki)와 게이트웨이 수집기(운영 판+생성 파일+로컬 판+Loki 내보내기 덧판)를
// 같은 Docker 네트워크에 띄우고, 자원 속성 k8s.namespace.name·service.name·deployment.environment와 환경 변수 PEAKET_CLUSTER가
// Loki 라벨 namespace·service·env·cluster의 값이 되는지 본다. 라벨이 되면 안 되는 속성(level·traceId·파드 이름)은 구조화 메타데이터에 있다.
// 가짜 없음: 실제 Loki·수집기 이미지다.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { postOtlp, startGateway, str, type CollectorContainer } from './collector.js';
import { createNetwork, readRepo, renderConfig, startLoki, until, type Container, type Network } from './observability-stores.js';

/** docs/observability.md §7 'Loki 라벨 허용 목록' 행의 라벨 이름 */
function canonLabels(): string[] {
  const line = readRepo('docs/observability.md').split(/\r?\n/).find((l) => /^\|\s*Loki 라벨 허용 목록/.test(l));
  if (!line) throw new Error("docs/observability.md §7에 'Loki 라벨 허용 목록' 행이 없다");
  const labels = [...line.split('만 쓴다')[0]!.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!);
  if (labels.length === 0) throw new Error('라벨 허용 목록을 읽지 못했다');
  return labels;
}
const stored = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_');

const run = randomBytes(4).toString('hex');
/** 보내는 자원 속성: 넷의 원천 셋과 라벨이 되면 안 되는 파드 이름 */
const resource = {
  'k8s.namespace.name': `peaket-it-${run}`,
  'service.name': 'gateway-loki-svc',
  'deployment.environment': 'it',
  'k8s.pod.name': `gateway-loki-${run}`,
};
/** 게이트웨이 수집기의 환경 변수로 넣는 클러스터 이름 */
const CLUSTER = `cluster-${run}`;
const LINE = `v-t50-9 ${run} hello`;
const LOG_ATTRS = { level: 'info', traceId: randomBytes(16).toString('hex'), route: '/v1/queue/entry' };

let net: Network | undefined;
let loki: Container | undefined;
let gw: CollectorContainer | undefined;

beforeAll(async () => {
  net = createNetwork();
  loki = await startLoki(renderConfig('loki'), net, 'peaket-loki');
  gw = await startGateway({
    network: net.name,
    env: { PEAKET_CLUSTER: CLUSTER },
    extraConfig: [
      '# 시험 덧판: 로컬 판의 로그 내보내기를 파일에서 Loki로 바꾼다(계획 F-01-9 §6)',
      'exporters:',
      '  otlp_http/loki:',
      '    endpoint: http://peaket-loki:3100/otlp',
      'service:',
      '  pipelines:',
      '    logs:',
      '      exporters: [otlp_http/loki]',
      '',
    ].join('\n'),
  });
}, 240_000);
afterAll(() => {
  gw?.stop();
  loki?.stop();
  net?.remove();
});

test('V-T50 ⑨ 게이트웨이 수집기를 지난 로그의 Loki 라벨 넷이 자원 속성과 같다', async () => {
  const labels = canonLabels();
  const now = BigInt(Date.now()) * 1_000_000n;
  await postOtlp(gw!.otlpHttp, 'logs', {
    resourceLogs: [
      {
        resource: { attributes: Object.entries(resource).map(([k, v]) => str(k, v)) },
        scopeLogs: [
          {
            scope: { name: 'v-t50-9' },
            logRecords: [{ timeUnixNano: String(now), body: { stringValue: LINE }, attributes: Object.entries(LOG_ATTRS).map(([k, v]) => str(k, v)) }],
          },
        ],
      },
    ],
  });

  const start = String(now - 3_600_000_000_000n);
  const end = String(now + 3_600_000_000_000n);
  // 라벨 이름 집합 = 정본의 넷(정확히). 게이트웨이가 다는 라벨이 넷 밖으로 늘면 실패한다
  const names = await until(
    '라벨 목록',
    90_000,
    async () => ((await (await fetch(`${loki!.url(3100)}/loki/api/v1/labels?start=${start}&end=${end}`)).json()) as { data?: string[] }).data ?? [],
    (d) => d.length > 0,
    loki,
  );
  expect([...names].sort()).toEqual([...labels].sort());

  // 라벨 값이 보낸 자원 속성(클러스터는 게이트웨이 환경 변수)과 같다
  const want: Record<string, string> = {
    namespace: resource['k8s.namespace.name'],
    service: resource['service.name'],
    env: resource['deployment.environment'],
    cluster: CLUSTER,
  };
  for (const name of labels) {
    const values = await until(
      `${name} 라벨 값`,
      60_000,
      async () => ((await (await fetch(`${loki!.url(3100)}/loki/api/v1/label/${name}/values?start=${start}&end=${end}`)).json()) as { data?: string[] }).data ?? [],
      (d) => d.length > 0,
      loki,
    );
    expect(values, `${name} 라벨 값`).toEqual([want[name]]);
  }

  // 넷으로 고른 질의가 보낸 줄을 돌려주고, 라벨이 아닌 속성은 구조화 메타데이터로 남는다
  const selector = `{${labels.map((k) => `${k}="${want[k]}"`).join(', ')}}`;
  type Stream = { stream: Record<string, string>; values: [string, string, { structuredMetadata?: Record<string, string> }?][] };
  const streams = await until(
    '라벨 넷 질의',
    60_000,
    async () => {
      const q = new URLSearchParams({ query: selector, start, end, limit: '100', direction: 'forward' });
      const r = await fetch(`${loki!.url(3100)}/loki/api/v1/query_range?${q}`, { headers: { 'X-Loki-Response-Encoding-Flags': 'categorize-labels' } });
      return ((await r.json()) as { data?: { result?: Stream[] } }).data?.result ?? [];
    },
    (s) => s.some((x) => x.values.some((v) => v[1] === LINE)),
    loki,
  );
  for (const s of streams) expect(Object.keys(s.stream).sort()).toEqual([...labels].sort());
  const line = streams.flatMap((s) => s.values).find((v) => v[1] === LINE);
  expect(line, `보낸 줄이 없다: ${LINE}`).toBeDefined();
  const meta = line![2]?.structuredMetadata ?? {};
  for (const [k, v] of [...Object.entries(LOG_ATTRS), ['k8s.pod.name', resource['k8s.pod.name']] as const]) {
    expect(meta[stored(k)], `구조화 메타데이터 ${k}`).toBe(v);
  }
}, 240_000);
