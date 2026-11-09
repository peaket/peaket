// identity-svc가 부르는 바깥 제공자 호출의 추적(docs/api/guidelines.md §8 '바깥 연동은 추적 머리를 싣지 않는다', docs/observability.md §6).
// OTel SDK를 메모리 span 처리기로 띄우고(packages/platform/test/telemetry.test.ts와 같은 꼴) 흉내 서버에 보낸 뒤, 이 서비스가 만든 span(흉내 서버 자신의 서버 span은 뺀다)과
// 흉내 서버가 받은 머리를 본다.
// - 유출 비밀번호 범위 조회(AC-T7 '로그·트레이스에 SHA-1과 그 앞 5자가 0건', docs/security/auth-controls.md §4.3 10): 앞 5자 없음은 고치기 전에도 맞았다
//   (플랫폼 BoundarySpanProcessor가 자동 계측의 url.full을 출처로 줄이고 url.path·url.query를 비운다). 그 규칙이 빠져도 잡도록 둔다.
//   고치기 전에 실패한 것은 경로 틀 span(바깥 호출 클라이언트)과 traceparent 없음이다.
// - 사람 확인 검증(Turnstile siteverify, auth-controls §2.3): 고치기 전에는 전역 fetch라 traceparent가 Cloudflare에 실렸다.
// SDK는 계측할 호출보다 먼저 서야 하므로 파일 맨 위에서 시작하고 어댑터는 뒤에 읽는다.
import { createHash } from 'node:crypto';
import { createServer, type IncomingHttpHeaders } from 'node:http';
import { startTelemetry } from '@peaket/platform/telemetry';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';

type Processor = NonNullable<Parameters<typeof startTelemetry>[0]['spanProcessors']>[number];
type Ended = Parameters<Processor['onEnd']>[0];

/** 끝난 span을 모으는 메모리 처리기(시험 전용, 내보내지 않는다) */
const ended: Ended[] = [];
const memory: Processor = {
  onStart: () => {},
  onEnd: (span) => {
    ended.push(span);
  },
  forceFlush: async () => {},
  shutdown: async () => {},
};
const telemetry = startTelemetry({ serviceName: 'identity-svc', env: 'ci', spanProcessors: [memory] });

const PASSWORD = 'correct horse battery staple!';
const SHA1 = createHash('sha1').update(PASSWORD.normalize('NFC'), 'utf8').digest('hex').toUpperCase();
const PREFIX = SHA1.slice(0, 5);

const seen: { path: string; headers: IncomingHttpHeaders }[] = [];
const server = createServer((req, res) => {
  seen.push({ path: req.url ?? '', headers: req.headers });
  req.resume();
  req.on('end', () => {
    if ((req.url ?? '').startsWith('/range/')) {
      // 그 비밀번호가 목록에 있다(횟수 12)와 채움 줄 하나
      res.end(`${SHA1.slice(5)}:12\r\n0000000000000000000000000000000000A:0`);
      return;
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ success: true, hostname: 'console.peaket.example', action: 'login' }));
  });
});
let url = '';
let HibpBreachList: typeof import('../src/modules/admin/adapters/hibp-breach-list.js').HibpBreachList;
let TurnstileHumanCheck: typeof import('../src/modules/admin/adapters/turnstile-human-check.js').TurnstileHumanCheck;

// 어댑터는 SDK를 띄운 뒤 읽는다. 플랫폼 전체를 불러오므로 다른 시험과 함께 돌아 붐비면 기본 제한(5초)을 넘을 수 있어 준비만 60초로 둔다(packages/platform/test/telemetry.test.ts와 같다)
beforeAll(async () => {
  ({ HibpBreachList } = await import('../src/modules/admin/adapters/hibp-breach-list.js'));
  ({ TurnstileHumanCheck } = await import('../src/modules/admin/adapters/turnstile-human-check.js'));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 60_000);
beforeEach(() => {
  ended.length = 0;
  seen.length = 0;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  await telemetry.shutdown();
});

/** 이 서비스가 만든 span(흉내 서버 자신의 서버 span, SpanKind.SERVER = 1은 뺀다). span은 응답을 받은 뒤 끝난다 */
async function ours(): Promise<Ended[]> {
  await new Promise((r) => setTimeout(r, 30));
  return ended.filter((s) => s.kind !== 1);
}

test('AC-T7③_유출목록범위조회의span은_이름·속성어디에도SHA-1앞5자가없고_경로틀만남으며_traceparent를보내지않는다', async () => {
  expect(await new HibpBreachList({ baseUrl: url, timeoutMs: 2_000 }).isBreached(PASSWORD)).toBe(true);
  const spans = await ours();
  expect(spans.length).toBeGreaterThan(0);
  for (const s of spans) {
    expect(s.name).not.toContain(PREFIX);
    expect(JSON.stringify(s.attributes)).not.toContain(PREFIX);
    for (const e of s.events) expect(JSON.stringify(e.attributes ?? {})).not.toContain(PREFIX);
  }
  // 바깥 호출 클라이언트의 경로 틀 span 하나만 남는다(자동 계측의 주소 속성 url.full·url.path가 없다)
  expect(spans.map((s) => s.attributes)).toEqual([expect.objectContaining({ 'url.template': '/range/{prefix}', 'peaket.provider': 'hibp', 'http.request.method': 'GET' })]);
  expect(spans[0]!.attributes['url.full']).toBeUndefined();
  // 바깥 제공자에게 추적 머리를 싣지 않는다(docs/api/guidelines.md §8)
  expect(seen.at(-1)!.headers).toMatchObject({ 'add-padding': 'true' });
  expect(seen.at(-1)!.headers.traceparent).toBeUndefined();
});

test('BOT-111넘김_사람확인검증은_traceparent를보내지않고_경로틀span하나만남는다', async () => {
  const h = new TurnstileHumanCheck({ url: `${url}/turnstile/v0/siteverify`, secret: 'test-secret', hostnames: { partner: 'partner.peaket.example', ops: 'console.peaket.example' } });
  expect(await h.verify('t', { aud: 'ops', remoteIp: '198.51.100.1' })).toBe('OK');
  expect(seen.map((x) => x.path)).toEqual(['/turnstile/v0/siteverify']);
  for (const k of ['traceparent', 'tracestate', 'baggage']) expect(seen[0]!.headers[k]).toBeUndefined();
  expect((await ours()).map((s) => s.attributes)).toEqual([expect.objectContaining({ 'url.template': '/turnstile/v0/siteverify', 'peaket.provider': 'turnstile', 'http.request.method': 'POST' })]);
});
