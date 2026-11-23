// 게이트웨이 수집기의 꼬리 표본 정책(V-T49 ⑤, docs/observability.md §1 '설정 원천과 로컬 확인', §6 '테일 기반 적응형 샘플링',
// docs/verification.md V-T49 ⑤, 계획 docs/review/plans/F-01-3.md §5·§6).
// 정본: 정책은 다섯이다. ① peaket.sample.mode가 head ② span 상태 ERROR ③ peaket.slo.exceeded가 참 ④ 드문 경로마다 하나(http.route 같음 + 메서드 같음
// + rate_limiting) ⑤ peaket.sample.keep이 참. probabilistic 정책은 없다. 어느 정책에도 맞지 않는 trace는 남지 않는다.
// 드문 경로: docs/api/guidelines.md §'드문 경로 표시'가 정한 정산 지급 POST /v1/ops/payout-batches(openapi에 x-peaket-trace-rare: true).
// 같은 경로의 GET(목록 조회)은 표시가 없어 남지 않아야 한다. 메서드 속성 이름은 지금 서버 span이 싣는 http.request.method다
// (시험 담당이 telemetry.test.ts 꼴로 확인, 계획 '시험 결과').
// trace마다 span 둘(서버 span + 안쪽 span)을 한 요청으로 게이트웨이에 바로 보낸다. 표시는 정책에 따라 서버 span이나 안쪽 span에 단다.
// 기다림은 /metrics의 판정 수가 보낸 trace 수에 닿을 때까지 당겨 본다(고정 대기 없음).
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { bool, metricSum, pollUntil, postOtlp, spanIdOf, startGateway, str, traceIdOf, type CollectorContainer, type OtlpKeyValue } from './collector.js';

const RARE = { method: 'POST', route: '/v1/ops/payout-batches' };
const METHOD_ATTR = 'http.request.method';
const PER_KIND = 3;

interface Kind {
  name: string;
  keep: boolean;
  /** 서버 span 속성 */
  root: OtlpKeyValue[];
  /** 안쪽 span 상태 코드(2 = ERROR) */
  childStatus?: number;
}

const normal = (method: string, route: string, extra: OtlpKeyValue[] = []): OtlpKeyValue[] => [str(METHOD_ATTR, method), str('http.route', route), bool('peaket.sample.keep', false), ...extra];

const KINDS: Kind[] = [
  // 남는 것(정책마다)
  { name: 'head', keep: true, root: normal('POST', '/v1/queues/{eventId}/entries', [str('peaket.sample.mode', 'head')]) },
  { name: 'error', keep: true, root: normal('POST', '/v1/events/{eventId}/holds'), childStatus: 2 },
  { name: 'slo-exceeded', keep: true, root: normal('GET', '/v1/events/{eventId}', [bool('peaket.slo.exceeded', true)]) },
  { name: 'rare', keep: true, root: normal(RARE.method, RARE.route) },
  { name: 'normal-keep', keep: true, root: [str(METHOD_ATTR, 'GET'), str('http.route', '/v1/events/{eventId}'), bool('peaket.sample.keep', true)] },
  // 버려지는 것
  { name: 'normal-drop', keep: false, root: normal('GET', '/v1/events/{eventId}') },
  { name: 'rare-path-other-method', keep: false, root: normal('GET', RARE.route) },
  { name: 'slo-false', keep: false, root: normal('GET', '/v1/events/{eventId}', [bool('peaket.slo.exceeded', false)]) },
  { name: 'mode-not-head', keep: false, root: normal('GET', '/v1/events/{eventId}', [str('peaket.sample.mode', 'tail')]) },
  { name: 'child-ok-status', keep: false, root: normal('POST', '/v1/events/{eventId}/holds'), childStatus: 1 },
];

let gw: CollectorContainer;
const sent: { id: string; kind: string; keep: boolean }[] = [];
let kept = new Set<string>();
let metricsText = '';

beforeAll(async () => {
  gw = await startGateway();
  const spans: unknown[] = [];
  KINDS.forEach((k, ki) => {
    for (let j = 0; j < PER_KIND; j++) {
      const n = 0x2000 + ki * 16 + j;
      const id = traceIdOf(n);
      sent.push({ id, kind: k.name, keep: k.keep });
      const t0 = 1795400000000000000n + BigInt(n) * 1_000_000n;
      spans.push(
        { traceId: id, spanId: spanIdOf(n, 1), name: `${(k.root.find((a) => a.key === METHOD_ATTR)?.value.stringValue) ?? 'GET'} x`, kind: 2, startTimeUnixNano: String(t0), endTimeUnixNano: String(t0 + 5_000_000n), attributes: k.root, status: { code: 0 } },
        { traceId: id, spanId: spanIdOf(n, 2), parentSpanId: spanIdOf(n, 1), name: 'inner', kind: 1, startTimeUnixNano: String(t0 + 1_000_000n), endTimeUnixNano: String(t0 + 2_000_000n), attributes: [], status: { code: k.childStatus ?? 0 } },
      );
    }
  });
  await postOtlp(gw.otlpHttp, 'traces', { resourceSpans: [{ resource: { attributes: [str('service.name', 'tail-svc')] }, scopeSpans: [{ spans }] }] });
  // 판정이 보낸 trace 수에 닿을 때까지(꼬리 표본의 판정 대기만큼 걸린다)
  metricsText = await pollUntil(
    '꼬리 표본 판정 수',
    async () => {
      const text = await gw.metrics();
      const decided = metricSum(text, 'otelcol_processor_tail_sampling_global_count_traces_sampled');
      return decided !== undefined && decided >= sent.length ? text : undefined;
    },
    { timeoutMs: 90_000, intervalMs: 500 },
  ).catch((err: unknown) => {
    throw new Error(`${String(err)}\n${gw.logs()}`);
  });
  const keptCount = metricSum(metricsText, 'otelcol_processor_tail_sampling_global_count_traces_sampled', { sampled: 'true' }) ?? 0;
  // 남긴 trace가 파일에 다 쓰일 때까지
  kept = await pollUntil(
    '남긴 trace가 결과 파일에',
    () => {
      const ids = new Set(gw.output().spans.map((s) => s.span.traceId));
      return ids.size >= keptCount ? ids : undefined;
    },
    { timeoutMs: 30_000, intervalMs: 300 },
  );
}, 240_000);

afterAll(() => gw?.stop());

describe('V-T49 ⑤ 꼬리 표본 정책', () => {
  test('V-T49 ⑤-3 게이트웨이 수집기는 정책에 맞는 trace만 남긴다(남은 trace ID 집합 = 기대 집합)', () => {
    const want = sent.filter((s) => s.keep).map((s) => s.id).sort();
    expect(want).toHaveLength(5 * PER_KIND);
    // 종류마다 따로 보이게(어느 정책이 빠졌는지·어느 버림이 새었는지)
    const byKind = (ids: Iterable<string>) => {
      const set = new Set(ids);
      return Object.fromEntries(KINDS.map((k) => [k.name, sent.filter((s) => s.kind === k.name && set.has(s.id)).length]));
    };
    expect(byKind(kept)).toEqual(Object.fromEntries(KINDS.map((k) => [k.name, k.keep ? PER_KIND : 0])));
    expect([...kept].sort()).toEqual(want);
  });

  test('V-T49 ⑤-4 판정 전에 버린 trace가 없고, 판정 수는 보낸 trace 수와 같다', () => {
    expect(metricSum(metricsText, 'otelcol_processor_tail_sampling_sampling_trace_dropped_too_early') ?? 0).toBe(0);
    expect(metricSum(metricsText, 'otelcol_processor_tail_sampling_global_count_traces_sampled')).toBe(sent.length);
    expect(metricSum(metricsText, 'otelcol_processor_tail_sampling_global_count_traces_sampled', { sampled: 'true' })).toBe(5 * PER_KIND);
  });

  test('V-T49 ⑤-5 남은 trace는 span 둘을 모두 싣는다(trace 단위로 남긴다)', () => {
    const spans = gw.output().spans;
    for (const id of kept) expect(spans.filter((s) => s.span.traceId === id).length, id).toBe(2);
  });
});
