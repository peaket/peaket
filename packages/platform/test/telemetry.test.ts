// OTel SDK를 띄운 시험: 서버 span, 메시 모드의 부모 잇기, 정상 표본 문턱, 진입 경로, 외부 호출(V-T31 ③)
// (docs/observability.md §6, docs/verification.md V-T31, openspec 변경 add-service-logging 결정 3·6·7).
// SDK는 계측할 모듈(Fastify가 쓰는 node:http)보다 먼저 서야 하므로 파일 맨 위에서 시작하고 서비스 모듈은 뒤에 읽는다.
import { createServer } from 'node:http';
import { InMemorySpanExporter, SimpleSpanProcessor, type ReadableSpan } from '@opentelemetry/sdk-trace';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { startTelemetry, withoutTracePropagation } from '../src/telemetry.js';
import { TRACE_PROPAGATION_HEADERS, probeTraceHeaders } from '../src/testing.js';

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ serviceName: 'demo-svc', version: '1.4.2', env: 'ci', spanProcessors: [new SimpleSpanProcessor({ exporter })] });

type Fixture = typeof import('./fixture.js');
type Platform = typeof import('../src/index.js');
let fx: Fixture;
let platform: Platform;
let s: Awaited<ReturnType<Fixture['start']>>;
let base: string;

// 준비는 서비스 전체(src/index.js)를 불러와 띄운다. CI의 node 잡은 모든 패키지를 한꺼번에 돌려, 붐빌 때 불러오기만으로
// 기본 제한 10초를 넘었다(2026-11-03 원격 CI, 그 실행의 시간 69%가 불러오기). 준비 단계만 60초로 둔다
beforeAll(async () => {
  fx = await import('./fixture.js');
  platform = await import('../src/index.js');
  s = await fx.start({ PEAKET_ENV: 'ci', PEAKET_LOG_SAMPLE_ONE_IN: '10', PORT: '0', PEAKET_MANAGEMENT_PORT: '0' });
  const { port } = await s.svc.listen('127.0.0.1');
  base = `http://127.0.0.1:${port}`;
}, 60_000);
afterAll(async () => {
  await s.svc.close();
  await telemetry.shutdown();
});
afterEach(() => {
  exporter.reset();
  s.lines.length = 0;
});

const TWO56 = 2n ** 56n;
const T10 = TWO56 - TWO56 / 10n;
/** 끝 56비트가 r인 trace ID */
const traceWithR = (r: bigint, head = 'c0ffee00c0ffee00c0') => `${head}${r.toString(16).padStart(14, '0')}`;
const tp = (traceId: string, sampled = true) => `00-${traceId}-b7ad6b7169203331-${sampled ? '01' : '00'}`;

/** 우리가 고른 traceparent를 그대로 보낸다(클라이언트 쪽 자동 계측이 덮어쓰지 않게 전파를 끈 채로) */
async function call(path: string, o: { method?: string; traceparent?: string; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { ...o.headers };
  if (o.traceparent) headers.traceparent = o.traceparent;
  const res = await withoutTracePropagation(() => fetch(`${base}${path}`, { method: o.method ?? 'GET', headers }));
  await res.text();
  // 응답을 받은 뒤 서버 span이 끝나고 줄이 쓰일 때까지 잠깐 기다린다
  await new Promise((r) => setTimeout(r, 30));
  return res;
}
const serverSpans = () => exporter.getFinishedSpans().filter((x) => x.kind === 1);
const requests = () => s.requests();

describe('서버 span(SDK)', () => {
  test('ADR0125_서버span은_경로틀이름과_http_route_url_path_표본속성을달고_쿼리와원문IP가없다', async () => {
    const id = traceWithR(TWO56 - 1n);
    await call('/v1/demo/items/a1?token=abc', { traceparent: tp(id), headers: { 'x-forwarded-for': '203.0.113.77' } });
    const [span] = serverSpans() as ReadableSpan[];
    expect(span.name).toBe('GET /v1/demo/items/{itemId}');
    expect(span.attributes).toMatchObject({ 'http.route': '/v1/demo/items/{itemId}', 'url.path': '/v1/demo/items/{itemId}', 'peaket.sample.keep': true });
    expect(span.attributes['url.query'] ?? '').toBe('');
    expect(span.attributes['client.address']).toBe('203.0.113.0/24');
    // 코드 리뷰(2026-11-01): 상대 주소와 User-Agent 원문도 남았다. 앞부분과 계열만 남긴다
    expect(span.attributes['network.peer.address']).toBe('127.0.0.0/24');
    expect(span.attributes['user_agent.original']).toBe('other');
    expect(JSON.stringify(span.attributes)).not.toMatch(/token=abc|a1|203\.0\.113\.77/);
    expect(span.resource.attributes).toMatchObject({ 'service.name': 'demo-svc', 'service.version': '1.4.2', 'deployment.environment.name': 'ci' });
  });

  test('ADR0130_메시모드는_받은부모를잇고_정규로그줄의traceId_spanId가_서버span과같다', async () => {
    const id = traceWithR(TWO56 - 1n);
    await call('/v1/demo/items/a1', { traceparent: tp(id) });
    const [span] = serverSpans();
    expect(span.spanContext().traceId).toBe(id);
    expect(span.parentSpanContext?.spanId).toBe('b7ad6b7169203331');
    const [line] = requests();
    expect(line).toMatchObject({ traceId: id, spanId: span.spanContext().spanId });
  });
});

describe('코드 리뷰가 찾은 것(SDK)', () => {
  test('ADR0125_진입경로에_traceparent가없으면_머리표본이아니다', async () => {
    // SDK가 뿌리 span을 '고름'으로 판정한 것을 들어온 표본 표시로 잘못 읽었다
    for (let i = 0; i < 20; i++) await call('/v1/demo/entry', { method: 'POST' });
    expect(requests().filter((l) => l.sampleRate === 0)).toEqual([]);
    expect(serverSpans().filter((x) => x.attributes['peaket.sample.mode'] === 'head')).toEqual([]);
  });

  test('ADR0069_라우터앞오류줄에도_spanId와durationMs가있고_서버span에는원래경로가없다', async () => {
    await call('/v1/demo/items/%E0%A4%A?pid=p-1', { traceparent: tp(traceWithR(TWO56 - 1n)) });
    const [line] = requests();
    const [span] = serverSpans();
    expect(line).toMatchObject({ route: 'unmatched', status: 400, spanId: span.spanContext().spanId, durationMs: 0 });
    expect(span.attributes).toMatchObject({ 'http.route': 'unmatched', 'url.path': 'unmatched', 'peaket.sample.keep': true });
    expect(span.name).toBe('GET unmatched');
    expect(JSON.stringify(span.attributes)).not.toMatch(/E0%A4|pid=p-1/);
  });

  test('ADR0053_자동계측된나가는호출의span에는_원래경로와쿼리가없다', async () => {
    const server = createServer((_req, res) => res.end('{}'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as { port: number }).port;
    try {
      await (await fetch(`http://127.0.0.1:${port}/v1/orders/raw-order-id/seats/pid-123?token=abc`)).text();
    } finally {
      server.close();
    }
    const spans = exporter.getFinishedSpans().filter((x) => x.kind === 2);
    expect(spans.length).toBeGreaterThan(0);
    expect(JSON.stringify(spans.map((x) => x.attributes))).not.toMatch(/raw-order-id|pid-123|token=abc/);
  });

  test('VT31_탐침은_call이모의서버로요청을보내지않으면_통과하지않는다', async () => {
    await expect(probeTraceHeaders(async () => {})).rejects.toThrow(/요청을 보내지 않았다/);
  });

  test('VT31_경로값의_점이나점두개로_상위경로로빠져나가지못한다', async () => {
    // 코드 리뷰(2026-11-01): encodeURIComponent는 .과 ..을 그대로 둬 URL이 상위 경로로 줄었다(POST /v1/cancel)
    const c = platform.createExternalHttpClient({ provider: 'toss-payments', baseUrl: 'http://127.0.0.1:9/v1', timeoutCapMs: 1_000 });
    for (const v of ['..', '.']) {
      await expect(c.request({ method: 'POST', path: '/payments/{paymentKey}/cancel', params: { paymentKey: v } })).rejects.toThrow(/경로 값/);
    }
  });
});

describe('정상 표본 문턱(SDK)', () => {
  test('ADR0125_문턱이상의정상요청만_줄이남고_서버span의keep과같다', async () => {
    await call('/v1/demo/items/a1', { traceparent: tp(traceWithR(T10)) });
    await call('/v1/demo/items/a1', { traceparent: tp(traceWithR(T10 - 1n)) });
    expect(requests().map((l) => [l.traceId, l.sampleRate])).toEqual([[traceWithR(T10), 10]]);
    const keep = Object.fromEntries(serverSpans().map((x) => [x.spanContext().traceId, x.attributes['peaket.sample.keep']]));
    expect(keep).toEqual({ [traceWithR(T10)]: true, [traceWithR(T10 - 1n)]: false });
  });

  test('ADR0125_문턱밖이라도_4xx는_전수로남는다', async () => {
    await call('/v1/demo/busy', { traceparent: tp(traceWithR(0n)) });
    expect(requests()).toMatchObject([{ status: 429, sampleRate: 1 }]);
  });

  test('ADR0125_진입경로는_429를_정상줄처럼줄이고_머리표본의정상줄은_sampleRate0으로남긴다', async () => {
    await call('/v1/demo/entry-busy', { traceparent: tp(traceWithR(0n), false) });
    await call('/v1/demo/entry', { method: 'POST', traceparent: tp(traceWithR(1n), true) });
    await call('/v1/demo/entry', { method: 'POST', traceparent: tp(traceWithR(2n), false) });
    await call('/v1/demo/entry', { method: 'POST', traceparent: tp(traceWithR(TWO56 - 1n), false) });
    expect(requests().map((l) => [l.route, l.status, l.sampleRate])).toEqual([
      ['/v1/demo/entry', 201, 0],
      ['/v1/demo/entry', 201, 10],
    ]);
    // 고르지 않은(표본 표시 꺼짐) trace의 span은 내보내지 않는다(부모 기반). 머리 표본 span에는 mode=head
    const spans = serverSpans();
    expect(spans.map((x) => x.spanContext().traceId)).toEqual([traceWithR(1n)]);
    expect(spans[0].attributes['peaket.sample.mode']).toBe('head');
  });
});

describe('V-T31 ③ 외부 호출 헤더 검사', () => {
  const client = () => platform.createExternalHttpClient({ provider: 'toss-payments', baseUrl: 'http://placeholder', timeoutCapMs: 1_000 });

  test('[ASVS v5.0.0-14.2.3] VT31_외부호출클라이언트는_span을만들되_추적헤더를싣지않는다', async () => {
    const recorded = await probeTraceHeaders(async (url) => {
      const c = platform.createExternalHttpClient({ provider: 'toss-payments', baseUrl: url, timeoutCapMs: 1_000 });
      const res = await c.request({
        method: 'POST',
        path: '/v1/payments/{paymentKey}/confirm',
        params: { paymentKey: 'tgen_abc' },
        query: { orderId: 'o-1' },
        // 호출하는 쪽이 직접 넣은 추적 헤더도 지운다
        headers: { traceparent: tp(traceWithR(5n)), Baggage: 'k=v', 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(200);
    });
    expect(recorded).toHaveLength(1);
    expect(recorded[0].url).toBe('/v1/payments/tgen_abc/confirm?orderId=o-1');
    for (const h of TRACE_PROPAGATION_HEADERS) expect(recorded[0].headers).not.toHaveProperty(h);
    const spans = exporter.getFinishedSpans().filter((x) => x.kind === 2);
    // 자동 계측(undici) span은 없고 클라이언트가 만든 span 하나다. 쿼리가 든 url.full은 없다
    const ours = spans.filter((x) => x.attributes['peaket.provider'] === 'toss-payments');
    expect(ours).toHaveLength(1);
    expect(ours[0].name).toBe('POST /v1/payments/{paymentKey}/confirm');
    expect(ours[0].attributes).toMatchObject({ 'url.template': '/v1/payments/{paymentKey}/confirm', 'http.request.method': 'POST', 'http.response.status_code': 200 });
    expect(JSON.stringify(spans.map((x) => x.attributes))).not.toMatch(/tgen_abc|orderId=o-1/);
  });

  test('VT31_기본fetch로바꾸면_탐침이_traceparent와baggage를잡는다', async () => {
    const recorded = await probeTraceHeaders(async (url) => {
      await (await fetch(`${url}/v1/payments/x/confirm`, { method: 'POST' })).text();
    });
    expect(recorded[0].headers).toHaveProperty('traceparent');
    expect(recorded[0].headers).toHaveProperty('baggage');
  });

  test('VT31_전파가꺼진곳에서는_탐침이_통과하지않고던진다', async () => {
    await expect(withoutTracePropagation(() => probeTraceHeaders(async () => {}))).rejects.toThrow(/탐침/);
  });

  test('VT31_허용목록모드는_traceparent만싣고_baggage는싣지않는다', async () => {
    const recorded = await probeTraceHeaders(async (url) => {
      const c = platform.createExternalHttpClient({ provider: 'kopis', baseUrl: url, timeoutCapMs: 1_000, traceContext: 'w3c' });
      await (await c.request({ method: 'GET', path: '/x' })).text();
    });
    expect(recorded[0].headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(recorded[0].headers).not.toHaveProperty('baggage');
  });

  test('[ASVS v5.0.0-15.3.2] VT31_외부호출클라이언트는_리디렉트를따르지않는다', async () => {
    const recorded = await probeTraceHeaders(
      async (url) => {
        const c = platform.createExternalHttpClient({ provider: 'toss-payments', baseUrl: url, timeoutCapMs: 1_000 });
        const res = await c.request({ method: 'GET', path: '/start' });
        expect(res.status).toBe(302);
      },
      { respond: (req) => (req.url === '/start' ? { status: 302, headers: { location: '/elsewhere' } } : { status: 200 }) },
    );
    expect(recorded.map((r) => r.url)).toEqual(['/start']);
  });

  test('VT31_경로값이없거나_틀이아닌경로는_보내기전에던진다', async () => {
    await expect(client().request({ method: 'GET', path: '/v1/payments/{paymentKey}' })).rejects.toThrow(/paymentKey/);
    await expect(client().request({ method: 'GET', path: 'v1/no-slash' })).rejects.toThrow(/경로/);
    expect(() => platform.createExternalHttpClient({ provider: 'Toss Payments', baseUrl: 'http://x', timeoutCapMs: 1 })).toThrow(/provider/);
    expect(() => platform.createExternalHttpClient({ provider: 'toss', baseUrl: 'ftp://x', timeoutCapMs: 1 })).toThrow(/baseUrl/);
    expect(() => platform.createExternalHttpClient({ provider: 'toss', baseUrl: 'http://x?q=1', timeoutCapMs: 1 })).toThrow(/baseUrl/);
  });

  test('GL5_요청안에서는_남은시간을_시간초과로쓰고_모자라면504이며_소요는dep에든다', async () => {
    const seen: string[] = [];
    const server = createServer((req, res) => {
      seen.push(req.url ?? '');
      res.end('{}');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    fx.outbound.baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const ok = await call('/v1/demo/call-out?spend=0', { traceparent: tp(traceWithR(TWO56 - 1n)), headers: { 'x-peaket-deadline-ms': '800' } });
      expect(ok.status).toBe(200);
      const span = exporter.getFinishedSpans().find((x) => x.attributes['peaket.provider'] === 'toss-payments');
      expect(span?.attributes['peaket.timeout_ms']).toBe(800);
      expect((requests()[0].dep as Record<string, number>)['toss-payments']).toBeGreaterThanOrEqual(0);
      const late = await call('/v1/demo/call-out?spend=800', { headers: { 'x-peaket-deadline-ms': '800' } });
      expect(late.status).toBe(504);
      expect(seen).toHaveLength(1);
    } finally {
      server.close();
    }
  });
});
