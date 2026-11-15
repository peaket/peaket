// 앱 서버용 모드: 바깥(브라우저)에서 온 추적 문맥을 부모로 쓰지 않고 링크로만 남긴다
// (docs/observability.md §6 '신뢰 경계의 추적 문맥', V-T31 ②의 단위 시험, openspec 변경 add-service-logging 결정 6).
import { createRequire } from 'node:module';
import { propagation, trace } from '@opentelemetry/api';
import { InMemorySpanExporter, SimpleSpanProcessor } from '@opentelemetry/sdk-trace';
import { afterAll, describe, expect, test } from 'vitest';
import { BROWSER_TRACEPARENT_HEADER, startTelemetry, withoutTracePropagation } from '../src/telemetry.js';

const exporter = new InMemorySpanExporter();
const telemetry = startTelemetry({ serviceName: 'web', env: 'ci', inbound: 'untrusted', spanProcessors: [new SimpleSpanProcessor({ exporter })] });
afterAll(() => telemetry.shutdown());
// node:http는 SDK를 시작한 뒤에 읽는다(ESM으로 먼저 읽은 이름은 계측되지 않는다. 실제 앱 서버는 CJS로 읽는다)
const { createServer } = createRequire(import.meta.url)('node:http') as typeof import('node:http');

const SENT = '0af7651916cd43dd8448eb211c80319c';

async function serve(headers: Record<string, string>) {
  const seen: { traceId?: string; baggage?: unknown } = {};
  const server = createServer((_req, res) => {
    seen.traceId = trace.getActiveSpan()?.spanContext().traceId;
    seen.baggage = propagation.getActiveBaggage()?.getAllEntries();
    res.end('ok');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as { port: number }).port;
  await withoutTracePropagation(async () => (await fetch(`http://127.0.0.1:${port}/`, { headers })).text());
  await new Promise((r) => setTimeout(r, 30));
  server.close();
  return seen;
}

describe('앱 서버용 모드', () => {
  test('ADR0130_바깥traceparent는_부모가아니라_새trace의링크로만남고_baggage는버린다', async () => {
    const seen = await serve({ traceparent: `00-${SENT}-b7ad6b7169203331-01`, tracestate: 'x=1', baggage: 'queue.seq=999' });
    expect(seen.traceId).toBeDefined();
    expect(seen.traceId).not.toBe(SENT);
    expect(seen.baggage).toBeUndefined();
    const server = exporter.getFinishedSpans().find((x) => x.kind === 1);
    expect(server?.parentSpanContext).toBeUndefined();
    expect(server?.links.map((l) => l.context.traceId)).toEqual([SENT]);
    exporter.reset();
  });

  test('ADR0130_형식이틀린traceparent는_링크도남기지않는다', async () => {
    await serve({ traceparent: '00-zzzz-b7ad6b7169203331-01' });
    const server = exporter.getFinishedSpans().find((x) => x.kind === 1);
    expect(server?.links).toEqual([]);
    exporter.reset();
  });
});

// 게이트웨이가 브라우저 traceparent를 x-peaket-browser-traceparent로 옮긴 뒤(docs/observability.md §6 '앱 서버가 브라우저 값을 받는 길', BUILD_ORDER HOT-400).
// 머리 이름은 정본 값을 그대로 적는다(상수를 가져와 견주지 않는다).
describe('앱 서버용 모드: 게이트웨이가 옮긴 브라우저 추적 값', () => {
  const BROWSER = '4bf92f3577b34da6a3ce929d0e0e4736';
  const OTHER = '5c0a2f3577b34da6a3ce929d0e0e4799';
  const serverSpan = () => exporter.getFinishedSpans().find((x) => x.kind === 1);

  test('V-T31 ② 머리 이름은 x-peaket-browser-traceparent다', () => {
    expect(BROWSER_TRACEPARENT_HEADER).toBe('x-peaket-browser-traceparent');
  });

  test('V-T31 ② 앱 서버 모드는 x-peaket-browser-traceparent를 부모가 아니라 링크로 남긴다', async () => {
    const seen = await serve({ 'x-peaket-browser-traceparent': `00-${BROWSER}-b7ad6b7169203331-01` });
    expect(seen.traceId).toBeDefined();
    expect(seen.traceId).not.toBe(BROWSER);
    const s = serverSpan();
    expect(s?.parentSpanContext).toBeUndefined();
    expect(s?.links.map((l) => l.context.traceId)).toEqual([BROWSER]);
    exporter.reset();
  });

  test('V-T31 ② 두 머리가 다 오면 x-peaket-browser-traceparent를 먼저 읽고 traceparent는 링크로 남기지 않는다', async () => {
    const seen = await serve({ 'x-peaket-browser-traceparent': `00-${BROWSER}-b7ad6b7169203331-01`, traceparent: `00-${OTHER}-b7ad6b7169203331-01` });
    expect([BROWSER, OTHER]).not.toContain(seen.traceId);
    const s = serverSpan();
    expect(s?.parentSpanContext).toBeUndefined();
    expect(s?.links.map((l) => l.context.traceId)).toEqual([BROWSER]);
    exporter.reset();
  });

  test('V-T31 ② x-peaket-browser-traceparent만 오고 형식이 틀리면 버리고 링크를 남기지 않는다', async () => {
    const seen = await serve({ 'x-peaket-browser-traceparent': `00-${BROWSER}-zzzz-01` });
    expect(seen.traceId).toBeDefined();
    expect(seen.traceId).not.toBe(BROWSER);
    expect(serverSpan()?.links).toEqual([]);
    exporter.reset();
  });

  test('V-T31 ② 머리가 없고 traceparent만 오면(게이트웨이 없이 띄운 로컬) 그 값을 링크로 남긴다', async () => {
    await serve({ traceparent: `00-${OTHER}-b7ad6b7169203331-01` });
    const s = serverSpan();
    expect(s?.parentSpanContext).toBeUndefined();
    expect(s?.links.map((l) => l.context.traceId)).toEqual([OTHER]);
    exporter.reset();
  });
});
