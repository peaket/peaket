// 로컬 판 Tempo의 서비스 그래프(V-T50 ③, docs/verification.md V-T50, docs/observability.md §6 '내부 서비스 지도'·§1 '관측 저장소 설정 원천과 로컬 확인',
// ADR-0078 결정 3). 계획 docs/review/plans/F-01-4.md §6.
// Docker 네트워크 하나에 원격 쓰기를 받는 Prometheus(별칭 peaket-prom)와 --render tempo로 겹친 로컬 판 Tempo를 띄운다.
// trace마다 svc-a의 CLIENT span과 그 자식 svc-b의 SERVER span 한 짝을 OTLP HTTP로 보내고, Tempo metrics-generator가 Prometheus로 보낸
// traces_service_graph_request_total{client, server}이 보낸 짝 수와 같은지, 연결 지표가 1인지, 보내지 않은 방향은 없는지 본다.
// 가짜 없음: Tempo·Prometheus는 실제 이미지다. 기다림은 Prometheus 질의를 값이 나올 때까지 다시 보는 것이다(고정 대기 없음, 상한 2분).
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { createNetwork, otlpAttrs, promQuery, renderConfig, startPrometheus, startTempo, until, type Container, type Network } from './observability-stores.js';

/** 보낼 짝 수 [제안 50, 계획 §6] */
const PAIRS = 50;
const CLIENT = 'svc-a';
const SERVER = 'svc-b';
/** OTLP span 종류(opentelemetry-proto trace.proto SpanKind) */
const SPAN_KIND_SERVER = 2;
const SPAN_KIND_CLIENT = 3;

let net: Network;
let prom: Container | undefined;
let tempo: Container | undefined;
beforeAll(async () => {
  net = createNetwork();
  prom = await startPrometheus(net);
  tempo = await startTempo(renderConfig('tempo'), net);
}, 240_000);
afterAll(() => {
  tempo?.stop();
  prom?.stop();
  net?.remove();
});

function pair(): object {
  const traceId = randomBytes(16).toString('hex');
  const clientSpan = randomBytes(8).toString('hex');
  const serverSpan = randomBytes(8).toString('hex');
  const start = BigInt(Date.now()) * 1_000_000n;
  const ns = (ms: number) => String(start + BigInt(ms) * 1_000_000n);
  const span = (spanId: string, kind: number, parentSpanId: string | undefined, from: number, to: number) => ({
    traceId,
    spanId,
    ...(parentSpanId ? { parentSpanId } : {}),
    name: kind === SPAN_KIND_CLIENT ? 'svc-b/Call' : 'Call',
    kind,
    startTimeUnixNano: ns(from),
    endTimeUnixNano: ns(to),
    status: { code: 1 },
  });
  return {
    resourceSpans: [
      { resource: { attributes: otlpAttrs({ 'service.name': CLIENT }) }, scopeSpans: [{ scope: { name: 'v-t50-it' }, spans: [span(clientSpan, SPAN_KIND_CLIENT, undefined, 0, 20)] }] },
      { resource: { attributes: otlpAttrs({ 'service.name': SERVER }) }, scopeSpans: [{ scope: { name: 'v-t50-it' }, spans: [span(serverSpan, SPAN_KIND_SERVER, clientSpan, 2, 18)] }] },
    ],
  };
}

test('V-T50 ③ 로컬 판 Tempo가 서비스 그래프를 Prometheus로 보낸다', async () => {
  let sent = 0;
  for (let i = 0; i < PAIRS; i++) {
    const res = await fetch(`${tempo!.url(4318)}/v1/traces`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(pair()) });
    expect(res.status, await res.text()).toBe(200);
    sent++;
  }
  expect(sent).toBe(PAIRS);

  // 짝 수가 정확히 보낸 수가 될 때까지 Prometheus를 다시 본다
  const forward = `sum(traces_service_graph_request_total{client="${CLIENT}", server="${SERVER}"})`;
  const got = await until(`${forward} = ${PAIRS}`, 120_000, () => promQuery(prom!, forward), (r) => r.length === 1 && r[0]!.value === PAIRS, tempo);
  expect(got.map((r) => r.value)).toEqual([PAIRS]);

  // 연결 지표: 연결이 있는 동안 1(docs/observability.md §6 '내부 서비스 지도')
  const info = await until('연결 지표', 60_000, () => promQuery(prom!, `max(traces_service_graph_connection_info{client="${CLIENT}", server="${SERVER}"})`), (r) => r.length === 1, tempo);
  expect(info.map((r) => r.value)).toEqual([1]);

  // 보내지 않은 방향은 없고, 서비스 그래프의 연결은 보낸 한 짝뿐이다
  expect(await promQuery(prom!, `traces_service_graph_request_total{client="${SERVER}", server="${CLIENT}"}`)).toEqual([]);
  const edges = await promQuery(prom!, 'count by (client, server) (traces_service_graph_request_total)');
  expect(edges.map((e) => [e.metric.client, e.metric.server])).toEqual([[CLIENT, SERVER]]);
}, 240_000);
