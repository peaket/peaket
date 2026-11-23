// 에이전트의 trace ID 부하 분산(V-T49 ④, docs/observability.md §1 '수집기 구성'·'설정 원천과 로컬 확인', §6 '테일 기반 적응형 샘플링',
// docs/verification.md V-T49 ④, 계획 docs/review/plans/F-01-3.md §5·§6).
// 정본: 에이전트는 trace ID 기준 부하 분산 내보내기로 한 trace의 span을 모두 게이트웨이 수집기의 같은 복제에 보낸다(꼬리 표본이 trace 전체를 보려면).
// 에이전트 하나 + 게이트웨이 둘(별칭 peaket-gw-0·peaket-gw-1)을 띄우고, trace마다 span 넷을 서로 다른 OTLP 요청으로 섞어 보낸다
// (모든 trace의 첫 span, 그다음 모든 trace의 둘째 span … 차례). span은 모두 peaket.sample.keep=true라 꼬리 표본을 지나 남는다.
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { GATEWAY_ALIASES, bool, createNetwork, podLogs, pollUntil, postOtlp, spanIdOf, startAgent, startGateway, str, traceIdOf, type CollectorContainer } from './collector.js';

/** trace 수(계획 §6 제안 200)와 trace마다 span 수 */
const TRACES = 200;
const SPANS_PER_TRACE = 4;

let net: ReturnType<typeof createNetwork>;
let pods: ReturnType<typeof podLogs>;
const gateways: CollectorContainer[] = [];
let agent: CollectorContainer | undefined;
/** 게이트웨이마다 받은 (trace ID → span ID 목록) */
let received: Map<string, string[]>[] = [];

const spanOf = (t: number, i: number) => ({
  traceId: traceIdOf(0x1000 + t),
  spanId: spanIdOf(0x1000 + t, i + 1),
  ...(i > 0 ? { parentSpanId: spanIdOf(0x1000 + t, 1) } : {}),
  name: i === 0 ? 'GET /v1/demo/items/{itemId}' : `step-${i}`,
  kind: i === 0 ? 2 : 1,
  startTimeUnixNano: String(1795400000000000000n + BigInt(t * 1000 + i) * 1000n),
  endTimeUnixNano: String(1795400000000000000n + BigInt(t * 1000 + i) * 1000n + 500n),
  attributes: [bool('peaket.sample.keep', true)],
});

beforeAll(async () => {
  net = createNetwork();
  pods = podLogs({ namespace: 'peaket-it', pod: 'lb-0', uid: '00000000-aaaa-bbbb-cccc-000000000000', container: 'lb' });
  for (const alias of GATEWAY_ALIASES) gateways.push(await startGateway({ network: net.name, alias }));
  agent = await startAgent({ network: net.name, podLogsDir: pods.dir });
  // span 하나가 OTLP 요청 하나. 동시에 8개씩 보낸다
  const jobs: (() => Promise<void>)[] = [];
  for (let i = 0; i < SPANS_PER_TRACE; i++)
    for (let t = 0; t < TRACES; t++)
      jobs.push(() => postOtlp(agent!.otlpHttp, 'traces', { resourceSpans: [{ resource: { attributes: [str('service.name', 'lb-svc')] }, scopeSpans: [{ spans: [spanOf(t, i)] }] }] }));
  for (let k = 0; k < jobs.length; k += 8) await Promise.all(jobs.slice(k, k + 8).map((j) => j()));
  const want = TRACES * SPANS_PER_TRACE;
  received = await pollUntil(
    '두 게이트웨이의 결과',
    () => {
      const per = gateways.map((g) => {
        const m = new Map<string, string[]>();
        for (const { span } of g.output().spans) m.set(span.traceId, [...(m.get(span.traceId) ?? []), span.spanId]);
        return m;
      });
      const total = per.reduce((n, m) => n + [...m.values()].reduce((k, v) => k + v.length, 0), 0);
      return total >= want ? per : undefined;
    },
    { timeoutMs: 120_000, intervalMs: 500 },
  ).catch((err: unknown) => {
    throw new Error(`${String(err)}\n--- 에이전트 로그\n${agent?.logs()}\n--- 게이트웨이 로그\n${gateways.map((g) => g.logs()).join('\n---\n')}`);
  });
}, 300_000);

afterAll(() => {
  agent?.stop();
  for (const g of gateways) g.stop();
  net?.remove();
  pods?.remove();
});

describe('V-T49 ④ trace ID 부하 분산', () => {
  test('V-T49 ④-1 한 trace의 span은 여러 요청으로 와도 한 게이트웨이에만 가고, 두 게이트웨이가 모두 trace를 받는다', () => {
    const [a, b] = received;
    // 두 게이트웨이 모두 trace를 받았다(한쪽만 받으면 분산이 아니다)
    expect(a!.size).toBeGreaterThan(0);
    expect(b!.size).toBeGreaterThan(0);
    const misplaced: string[] = [];
    for (let t = 0; t < TRACES; t++) {
      const id = traceIdOf(0x1000 + t);
      const inA = a!.get(id) ?? [];
      const inB = b!.get(id) ?? [];
      if (inA.length > 0 && inB.length > 0) misplaced.push(`${id}: gw-0 ${inA.length}, gw-1 ${inB.length}`);
      // 한 곳에 넷이 모두 있고, 같은 span이 두 번 오지 않았다
      const spans = [...inA, ...inB].sort();
      expect(spans, id).toEqual(Array.from({ length: SPANS_PER_TRACE }, (_, i) => spanIdOf(0x1000 + t, i + 1)).sort());
    }
    expect(misplaced).toEqual([]);
    expect(a!.size + b!.size).toBe(TRACES);
  });
});
