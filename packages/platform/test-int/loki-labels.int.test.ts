// 로컬 판 Loki의 라벨 허용 목록(V-T50 ④, docs/verification.md V-T50, docs/observability.md §7 'Loki 라벨 허용 목록'·§1 '관측 저장소 설정 원천과 로컬 확인',
// ASVS v5.0.0-16.2.4). 계획 docs/review/plans/F-01-4.md §6.
// --render loki로 겹친 로컬 판 Loki에 자원 속성·로그 속성이 많은 로그를 OTLP HTTP(/otlp/v1/logs)로 넣는다. 라벨 이름 집합이 정본의 넷과 정확히 같고
// (지어 붙인 service_name 같은 라벨 없음), 라벨 넷으로 고른 질의가 보낸 줄을 모두 돌려주며, 다른 속성은 줄마다 구조화 메타데이터로 나오는지 본다.
// 라벨 넷은 시험이 정본(§7)에서 읽는다. 가짜 없음: 실제 Loki 이미지다.
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { otlpAttrs, readRepo, renderConfig, startLoki, until, type Container } from './observability-stores.js';

/** docs/observability.md §7 'Loki 라벨 허용 목록' 행의 라벨 이름('…만 쓴다' 앞의 글자 묶음) */
function canonLabels(): string[] {
  const line = readRepo('docs/observability.md').split(/\r?\n/).find((l) => /^\|\s*Loki 라벨 허용 목록/.test(l));
  if (!line) throw new Error("docs/observability.md §7에 'Loki 라벨 허용 목록' 행이 없다");
  const labels = [...line.split('만 쓴다')[0]!.matchAll(/`([a-z]+)`/g)].map((m) => m[1]!);
  if (labels.length === 0) throw new Error('라벨 허용 목록을 읽지 못했다');
  return labels;
}
/** Loki가 OTLP 속성 이름을 저장하는 꼴(점 등 글자·숫자·밑줄이 아닌 것을 밑줄로) */
const stored = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '_');

const LINES = 12;
const run = randomBytes(4).toString('hex');
/** 라벨이 될 자원 속성 넷(값은 이 실행만의 것)과 라벨이 되면 안 되는 자원 속성 셋 */
const labelValues = { namespace: `peaket-it-${run}`, service: 'queue-svc', env: 'it', cluster: `it-${run}` };
const otherResource = { 'service.name': 'queue-svc', 'k8s.pod.name': `queue-svc-7d9f-${run}`, 'k8s.namespace.name': `peaket-it-${run}` };

let loki: Container | undefined;
beforeAll(async () => {
  loki = await startLoki(renderConfig('loki'));
}, 180_000);
afterAll(() => loki?.stop());

test('V-T50 ④ [ASVS v5.0.0-16.2.4] 로컬 판 Loki의 라벨은 자원 속성 넷뿐이다', async () => {
  const labels = canonLabels();
  expect(Object.keys(labelValues).sort()).toEqual([...labels].sort());
  const now = BigInt(Date.now()) * 1_000_000n;
  const records = Array.from({ length: LINES }, (_, i) => ({
    body: `v-t50-4 ${run} line ${i}`,
    attrs: { level: i % 3 === 0 ? 'warn' : 'info', traceId: randomBytes(16).toString('hex'), route: `/v1/queue/${i % 4}`, eventId: `evt-${run}-${i % 2}` },
    ts: String(now + BigInt(i) * 1_000_000n),
  }));
  const body = {
    resourceLogs: [
      {
        resource: { attributes: otlpAttrs({ ...labelValues, ...otherResource }) },
        scopeLogs: [{ scope: { name: 'v-t50-it' }, logRecords: records.map((r) => ({ timeUnixNano: r.ts, body: { stringValue: r.body }, attributes: otlpAttrs(r.attrs) })) }],
      },
    ],
  };
  const res = await fetch(`${loki!.url(3100)}/otlp/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  expect(res.status, await res.text()).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);

  const start = String(now - 3_600_000_000_000n);
  const end = String(now + 3_600_000_000_000n);
  // 라벨 이름 집합 = 정본의 넷(정확히). 줄이 들어와 라벨이 생길 때까지 다시 본다
  const names = await until(
    '라벨 목록',
    60_000,
    async () => ((await (await fetch(`${loki!.url(3100)}/loki/api/v1/labels?start=${start}&end=${end}`)).json()) as { data?: string[] }).data ?? [],
    (d) => d.length > 0,
    loki,
  );
  expect([...names].sort()).toEqual([...labels].sort());
  expect(names).not.toContain('service_name');

  // 라벨 넷으로 고른 질의가 보낸 줄을 모두 돌려주고, 줄마다 다른 속성이 구조화 메타데이터로 나온다
  const selector = `{${Object.entries(labelValues).map(([k, v]) => `${k}="${v}"`).join(', ')}}`;
  type Stream = { stream: Record<string, string>; values: [string, string, { structuredMetadata?: Record<string, string> }?][] };
  const streams = await until(
    '라벨 넷 질의',
    60_000,
    async () => {
      const q = new URLSearchParams({ query: selector, start, end, limit: '1000', direction: 'forward' });
      const r = await fetch(`${loki!.url(3100)}/loki/api/v1/query_range?${q}`, { headers: { 'X-Loki-Response-Encoding-Flags': 'categorize-labels' } });
      return ((await r.json()) as { data?: { result?: Stream[] } }).data?.result ?? [];
    },
    (s) => s.reduce((n, x) => n + x.values.length, 0) === LINES,
    loki,
  );
  for (const s of streams) expect(Object.keys(s.stream).sort()).toEqual([...labels].sort());
  const byLine = new Map(streams.flatMap((s) => s.values.map((v) => [v[1], v[2]?.structuredMetadata ?? {}] as const)));
  expect([...byLine.keys()].sort()).toEqual(records.map((r) => r.body).sort());
  for (const r of records) {
    const meta = byLine.get(r.body)!;
    for (const [k, v] of Object.entries({ ...r.attrs, ...otherResource })) expect(meta[stored(k)], `${r.body}: ${k}`).toBe(v);
  }
}, 240_000);
