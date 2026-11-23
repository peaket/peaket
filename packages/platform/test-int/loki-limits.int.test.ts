// 로컬 판 Loki의 한도(V-T30 ④, docs/verification.md V-T30, ADR-0125 결정 4, docs/observability.md §3 운영 확인 표 Loki 줄). 계획 docs/review/plans/F-01-4.md §3·§6.
// --render loki로 겹친 로컬 판 Loki(한도는 운영 판 그대로)의 gw-queue 스트림 하나(라벨 넷 고정)에 '표본 뒤 피크 + 오류 10% 폭주'(ADR-0125 결정 4: 초당 약 10MB,
// 줄 하나 약 500바이트)를 20초 [제안] 넣는다. 모든 push가 2xx이고 거절 지표가 0이며 라벨로 센 줄 수가 보낸 수와 같아야 한다.
// 대조: 한도 넷만 Loki 기본값(ADR-0125 맥락)으로 덮은 같은 Loki에 같은 부하를 넣으면 거절이 생긴다(이 시험이 거절을 볼 수 있음을 보인다).
// PC가 초당 10MB를 내지 못하면 실패로 끝나고 도달한 속도를 적는다(통과로 꾸미지 않는다). 부하·한도 값은 시험이 ADR에서 읽는다.
// 수백 MB를 보내므로 다른 무거운 통합 시험과 겹치지 않게 돌린다(계획 §6).
import { afterAll, expect, test } from 'vitest';
import { otlpAttrs, parseYaml, readRepo, renderConfig, startLoki, stringifyYaml, sumMetric, type Container } from './observability-stores.js';

const ADR = readRepo('docs/adr/0125-entry-path-head-sampling-collector-sizing-shared-sample-threshold.md');
const num = (re: RegExp, what: string) => {
  const m = re.exec(ADR);
  if (!m) throw new Error(`ADR-0125에서 ${what}을 읽지 못했다`);
  return Number(m[1]);
};
/** 결정 4: 오류 10% 폭주 때 gw-queue 스트림 하나의 초당 MB, 맥락: 줄 하나의 바이트 */
const STREAM_MB = num(/gw-queue 스트림 하나에 초당 약 (\d+)MB/, 'gw-queue 스트림 초당 양');
const LINE_BYTES = num(/줄 하나 약 (\d+)바이트/, '줄 하나 크기');
/** 맥락: Loki 기본 한도(테넌트 초당·순간, 스트림 초당·순간) */
const DEFAULTS = {
  ingestion_rate_mb: num(/테넌트 초당 (\d+)MB\(`ingestion_rate_mb`/, '기본 테넌트 한도'),
  ingestion_burst_size_mb: num(/`ingestion_rate_mb`, 순간 (\d+)MB\)/, '기본 테넌트 순간 한도'),
  per_stream_rate_limit: `${num(/스트림 하나 초당 (\d+)MB\(`per_stream_rate_limit`/, '기본 스트림 한도')}MB`,
  per_stream_rate_limit_burst: `${num(/`per_stream_rate_limit`, 순간 (\d+)MB\)/, '기본 스트림 순간 한도')}MB`,
};
/** 넣는 시간 [제안 20초, 계획 §3] */
const SECONDS = 20;
/** 넣는 속도: 초당 STREAM_MB MiB로 보내고, 도달 속도는 10진 MB(10^6)로 판정한다(속도 판정에 조금의 여유) */
const RATE_BYTES = STREAM_MB * 2 ** 20;
const LINES_PER_PUSH = 2000;
const WORKERS = 8;
const LABELS = { namespace: 'edge', service: 'gw-queue', env: 'it', cluster: `it-${process.pid}` };

const started: Container[] = [];
afterAll(() => {
  for (const c of started) c.stop();
});

interface Load {
  lines: number;
  bytes: number;
  statuses: Map<number, number>;
  mbPerSecond: number;
}

/** 줄 크기 LINE_BYTES의 줄을 초당 RATE_BYTES로 SECONDS초 동안 OTLP HTTP로 넣는다 */
async function push(loki: Container, run: string): Promise<Load> {
  const pushes = Math.ceil((RATE_BYTES * SECONDS) / (LINE_BYTES * LINES_PER_PUSH));
  const pad = 'x'.repeat(LINE_BYTES);
  const base = BigInt(Date.now()) * 1_000_000n;
  const statuses = new Map<number, number>();
  let lines = 0;
  let bytes = 0;
  let next = 0;
  const t0 = performance.now();
  let lastEnd = t0;
  const worker = async () => {
    for (;;) {
      const k = next++;
      if (k >= pushes) return;
      // fixed-wait: 도착률을 맞추는 의도한 간격(조건을 기다리는 것이 아니라 부하의 모양), F-01-4 V-T30 ④
      const due = t0 + (k * LINE_BYTES * LINES_PER_PUSH * 1000) / RATE_BYTES;
      const wait = due - performance.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      const logRecords = Array.from({ length: LINES_PER_PUSH }, (_, i) => {
        const n = k * LINES_PER_PUSH + i;
        const head = `${run} ${n} `;
        return { timeUnixNano: String(base + BigInt(n) * 1000n), body: { stringValue: head + pad.slice(head.length) } };
      });
      const body = JSON.stringify({ resourceLogs: [{ resource: { attributes: otlpAttrs(LABELS) }, scopeLogs: [{ scope: { name: 'v-t30-it' }, logRecords }] }] });
      const res = await fetch(`${loki.url(3100)}/otlp/v1/logs`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      await res.arrayBuffer();
      statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      lines += LINES_PER_PUSH;
      bytes += LINES_PER_PUSH * LINE_BYTES;
      lastEnd = Math.max(lastEnd, performance.now());
    }
  };
  await Promise.all(Array.from({ length: WORKERS }, worker));
  return { lines, bytes, statuses, mbPerSecond: bytes / 1e6 / ((lastEnd - t0) / 1000) };
}

const discarded = async (loki: Container) => sumMetric(await (await fetch(`${loki.url(3100)}/metrics`)).text(), 'loki_discarded_samples_total');
const show = (l: Load) => `줄 ${l.lines}, ${(l.bytes / 1e6).toFixed(0)}MB, 도달 초당 ${l.mbPerSecond.toFixed(2)}MB, 응답 ${JSON.stringify([...l.statuses])}`;

test('V-T30 ④ 로컬 판 Loki는 표본 뒤 피크와 오류 10% 폭주를 거절 없이 받는다', async () => {
  const config = renderConfig('loki');
  const loki = await startLoki(config);
  started.push(loki);
  const run = `vt30-${Date.now()}`;
  const load = await push(loki, run);
  // 부하가 정한 양에 닿았는가(못 닿으면 이 PC로는 판정하지 못한다: 실패로 남긴다)
  expect(load.mbPerSecond, `도달 속도가 초당 ${STREAM_MB}MB보다 낮다: ${show(load)}`).toBeGreaterThanOrEqual(STREAM_MB);
  // 모든 push가 2xx(429 0건), 거절 지표 합 0
  const non2xx = [...load.statuses].filter(([s]) => s < 200 || s >= 300).reduce((n, [, c]) => n + c, 0);
  expect(non2xx, show(load)).toBe(0);
  expect(await discarded(loki)).toBe(0);
  // 라벨 넷으로 센 줄 수 = 보낸 줄 수
  const selector = `{${Object.entries(LABELS).map(([k, v]) => `${k}="${v}"`).join(', ')}}`;
  const q = new URLSearchParams({ query: `sum(count_over_time(${selector}[1h]))`, time: String(Date.now() / 1000) });
  const res = await fetch(`${loki.url(3100)}/loki/api/v1/query?${q}`);
  const counted = ((await res.json()) as { data?: { result?: { value: [number, string] }[] } }).data?.result?.map((r) => Number(r.value[1])) ?? [];
  expect(counted, show(load)).toEqual([load.lines]);

  // 대조: 한도 넷만 Loki 기본값으로 덮은 같은 설정에 같은 부하 → 거절이 1건 이상
  const cfg = parseYaml(config) as { limits_config?: Record<string, unknown> };
  cfg.limits_config = { ...cfg.limits_config, ...DEFAULTS };
  const strict = await startLoki(stringifyYaml(cfg));
  started.push(strict);
  const contrast = await push(strict, `${run}-default`);
  const rejected = [...contrast.statuses].filter(([s]) => s === 429).reduce((n, [, c]) => n + c, 0) + (await discarded(strict));
  expect(rejected, `기본 한도에서 거절이 없다: ${show(contrast)}`).toBeGreaterThan(0);
}, 300_000);
