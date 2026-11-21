// trust-svc가 부르는 바깥 제공자(사람 확인 Turnstile siteverify)의 추적 머리와 리디렉트(docs/observability.md §6 '신뢰 경계의 추적 문맥' 나가는 쪽,
// docs/api/guidelines.md §8, docs/security/asvs/delivery.md 14.2.3·15.3.2, ADR-0334 결정 5, BUILD_ORDER OPS-020 '다른 서비스의 바깥 호출', BAT-215).
// OTel SDK를 메모리 span 처리기로 먼저 띄우고(identity-svc test/outbound-trace.test.ts와 같은 꼴) 어댑터는 뒤에 읽는다. 흉내 서버가 받은 머리를 본다.
// SDK를 띄운 채 전역 fetch로 부르면 traceparent가 실리는 것을 먼저 확인해(대조) 이 탐침이 새는 것을 잡을 수 있음을 보인다.
import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { startTelemetry } from '../../../packages/platform/src/telemetry.js';

type Processor = NonNullable<Parameters<typeof startTelemetry>[0]['spanProcessors']>[number];
const memory: Processor = { onStart: () => {}, onEnd: () => {}, forceFlush: async () => {}, shutdown: async () => {} };
const telemetry = startTelemetry({ serviceName: 'trust-svc', env: 'ci', spanProcessors: [memory] });

const TRACE_HEADERS = ['traceparent', 'tracestate', 'baggage'];
const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
// real-time: 전역 fetch(SDK 자동 계측이 머리를 넣는 자리)가 실제로 보내는 요청을 받는 흉내 서버(빈 포트 0, 127.0.0.1) BAT-215
const server = createServer((req, res) => {
  seen.push({ path: req.url ?? '', headers: req.headers });
  req.resume();
  req.on('end', () => {
    if ((req.url ?? '').startsWith('/moved/')) {
      // 다른 곳으로 보내는 응답: 따라가면 아래 경로에 요청이 하나 더 온다
      res.writeHead(302, { location: '/turnstile/v0/siteverify' });
      res.end();
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, hostname: 'www.peaket.example', action: 'preverify', 'error-codes': [] }));
  });
});
let base = '';
let TurnstileHumanCheck: typeof import('../src/modules/scoring/adapters/turnstile-human-check.js').TurnstileHumanCheck;

// 어댑터는 SDK를 띄운 뒤 읽는다. 플랫폼 전체를 불러오므로 붐비면 기본 제한을 넘을 수 있어 준비만 60초로 둔다(identity-svc와 같다)
beforeAll(async () => {
  ({ TurnstileHumanCheck } = await import('../src/modules/scoring/adapters/turnstile-human-check.js'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 60_000);
beforeEach(() => {
  seen.length = 0;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await telemetry.shutdown();
});

const request = (deadlineMs = 2_000) => ({ token: 'tok-1', action: 'preverify' as const, remoteIp: '198.51.100.7', deadlineAtMs: Date.now() + deadlineMs });

test('V-T31 ③ [ASVS v5.0.0-14.2.3] (대조) SDK를 띄운 채 전역 fetch로 부르면 흉내 서버가 traceparent를 받는다', async () => {
  const r = await fetch(`${base}/turnstile/v0/siteverify`, { method: 'POST', body: 'x=1' });
  await r.text();
  expect(seen).toHaveLength(1);
  expect(seen[0]!.headers.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
});

test('V-T31 ③ [ASVS v5.0.0-14.2.3] 사람 확인 검증은 바깥 제공자에게 traceparent·tracestate·baggage를 하나도 싣지 않는다', async () => {
  const check = new TurnstileHumanCheck({ url: `${base}/turnstile/v0/siteverify`, secret: 'test-secret', hostname: 'www.peaket.example' });
  expect(await check.verify(request())).toBe('PASSED');
  expect(seen.map((x) => x.path)).toEqual(['/turnstile/v0/siteverify']);
  for (const k of TRACE_HEADERS) expect(seen[0]!.headers[k], k).toBeUndefined();
});

test('V-T31 ③ [ASVS v5.0.0-15.3.2] [ASVS v5.0.0-14.2.3] 사람 확인 검증은 3xx를 따라가지 않아 옮긴 곳에 요청이 가지 않고 검증 보류(PENDING)이며, 보낸 요청에도 추적 머리가 없다', async () => {
  const check = new TurnstileHumanCheck({ url: `${base}/moved/v0/siteverify`, secret: 'test-secret', hostname: 'www.peaket.example' });
  expect(await check.verify(request())).toBe('PENDING');
  expect(seen.length).toBeGreaterThan(0);
  expect(seen.every((x) => x.path === '/moved/v0/siteverify')).toBe(true);
  for (const x of seen) for (const k of TRACE_HEADERS) expect(x.headers[k], k).toBeUndefined();
});
