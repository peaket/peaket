// v0 입구 서버 시험(진짜 소켓, docs/infra.md §3 'v0 배포' 1~8). 자체 서명 인증서(openssl)로 HTTPS를 열고, 가짜 앱(평문 HTTP)에 잇는다.
// 머리 지우기·토큰·출처·레이트 리밋·응답 머리·502·504·wss·관리 포트·TLS 버전·평문 거절·닫기를 본다.
import { fakeClock } from '@peaket/platform';
import http from 'node:http';
import tls from 'node:tls';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import { type GatewayConfig } from '../src/gateway/config.js';
import { GATEWAY_OUTCOMES, createV0Gateway, type V0Gateway, type V0GatewayCounters } from '../src/gateway/server.js';
import { TOKEN_REJECTIONS } from '../src/gateway/token.js';
import {
  FakeUpstream,
  HSTS_VALUE,
  ISSUER,
  PROBLEM_CONTENT_TYPE,
  b64json,
  closedPort,
  defaultUpstreamReply,
  fanClaims,
  fanHeader,
  fanToken,
  httpCall,
  httpsCall,
  identityHeadersOf,
  makeFanKey,
  parseRawResponse,
  rawHeaderNames,
  selfSignedCert,
  signSegments,
  tlsExchange,
  within,
  type RecordedRequest,
  type Reply,
} from './gateway-helpers.js';

/** docs/infra.md §3 'v0 배포' 8의 이름 그대로(모듈의 목록을 믿지 않고 글자로 견준다) */
const SPEC_OUTCOMES = ['forwarded', 'rate_limited', 'origin_rejected', 'upstream_error', 'upstream_timeout'];
const SPEC_REASONS = ['malformed', 'alg', 'typ', 'kid', 'signature', 'issuer', 'audience', 'expired', 'not_yet_valid', 'claims'];

const ORIGIN = 'https://www.peaket.local';
const FIXED_TRACE = '0af7651916cd43dd8448eb211c80319c';
const START_MS = Date.parse('2026-11-03T09:00:00.000Z');

const keyA = makeFanKey('kid-a');
/** kid가 같은 다른 키(서명이 틀린 토큰) */
const impostor = makeFanKey('kid-a');

let cert = '';
let certKey = '';
let upstream: FakeUpstream;

let seq = 0;
/** 시험마다 겹치지 않는 경로 */
const uniquePath = (name: string): string => `/v0/t/${name}-${++seq}?q=${seq}`;
let ipSeq = 0;
/** 시험마다 겹치지 않는 클라이언트 IP(레이트 리밋 버킷이 섞이지 않게) */
const nextIp = (): string => `198.18.${Math.floor(++ipSeq / 250)}.${(ipSeq % 250) + 1}`;

function baseConfig(over: Partial<GatewayConfig> = {}): GatewayConfig {
  return {
    env: 'local',
    port: 0,
    managementPort: 0,
    upstream: upstream.url,
    tlsCert: cert,
    tlsKey: certKey,
    jwks: { keys: [keyA.publicJwk] },
    issuer: ISSUER,
    allowedOrigins: [ORIGIN],
    trustedProxyHops: 1,
    ratePerSecond: 1,
    burst: 3,
    maxKeys: 1_000,
    upstreamTimeoutMs: 1_000,
    ...over,
  };
}

function expectSecurityHeaders(reply: Pick<Reply, 'headers'>, what = ''): void {
  expect(reply.headers['strict-transport-security'], `${what} HSTS`).toBe(HSTS_VALUE);
  expect(reply.headers['x-content-type-options'], `${what} nosniff`).toBe('nosniff');
}

function expectProblem(reply: Reply, status: number, title: string, traceId: string | RegExp = FIXED_TRACE): void {
  expect(reply.status).toBe(status);
  expect(reply.headers['content-type']).toMatch(PROBLEM_CONTENT_TYPE);
  expect(JSON.parse(reply.body)).toEqual({ type: 'about:blank', title, status, traceId: typeof traceId === 'string' ? traceId : expect.stringMatching(traceId) });
  expectSecurityHeaders(reply, String(status));
  // 입구가 직접 내는 오류는 Cache-Control: no-store를 단다(docs/infra.md §3 'v0 배포' 6)
  expect(reply.headers['cache-control'], `${status} Cache-Control`).toBe('no-store');
  // Retry-After는 429에만
  if (status !== 429) expect(reply.headers['retry-after'], `${status} Retry-After`).toBeUndefined();
  expect(reply.headers['set-cookie'], `${status} Set-Cookie`).toBeUndefined();
}

const snapshot = (gw: V0Gateway): V0GatewayCounters => structuredClone(gw.counters());

/** 앱이 그 경로를 받았어야 한다 */
function forwardedTo(path: string): RecordedRequest {
  const got = upstream.find(path);
  if (!got) throw new Error(`앱이 ${path}를 받지 못했다`);
  return got;
}

/** /metrics 본문에서 한 줄의 값 */
function metricValue(text: string, series: string): number | undefined {
  const escaped = series.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`^${escaped} (\\S+)$`, 'm').exec(text);
  return match ? Number(match[1]) : undefined;
}

function openWs(port: number, path: string, headers: Record<string, string>, origin = ORIGIN): WebSocket {
  return new WebSocket(`wss://127.0.0.1:${port}${path}`, { ca: cert, headers, origin });
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    ws.once('message', (data) => resolve(String(data)));
    ws.once('error', reject);
  });
}

function wsOpened(ws: WebSocket): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('unexpected-response', (_req, res) => reject(new Error(`업그레이드 대신 ${res.statusCode}`)));
  });
}

/** TLS 연결 시도: 맺으면 협상한 판, 못 맺으면 오류 */
function tlsHandshake(port: number, options: tls.ConnectionOptions): Promise<{ ok: true; protocol: string | null } | { ok: false; error: Error }> {
  return new Promise((resolve) => {
    const socket = tls.connect({ host: '127.0.0.1', port, ca: cert, ...options }, () => {
      const protocol = socket.getProtocol();
      socket.end();
      resolve({ ok: true, protocol });
    });
    socket.once('error', (error) => resolve({ ok: false, error }));
  });
}

beforeAll(async () => {
  ({ cert, key: certKey } = selfSignedCert());
  upstream = await FakeUpstream.start();
});

afterAll(async () => {
  await upstream?.close();
});

beforeEach(() => {
  if (upstream) upstream.handler = defaultUpstreamReply;
});

describe('v0 입구: 믿는 홉 1, 버킷 3개·초당 1개, 앱 대기 1초', () => {
  const clock = fakeClock({ now: START_MS, monotonic: 0 });
  let gw: V0Gateway;
  let port = 0;
  const nowSec = (): number => Math.floor(clock.now() / 1000);
  const validToken = (claims: Record<string, unknown> = {}): string => fanToken(keyA, nowSec(), { sub: 'acc-1', sid: 'sess-1', scope: 'ticket:buy', pid: 'pid-1', ...claims });
  const call = (options: { method?: string; path: string; headers?: http.OutgoingHttpHeaders; body?: string }, ip = nextIp()): Promise<Reply> =>
    httpsCall(port, cert, { ...options, headers: { 'x-forwarded-for': ip, ...options.headers } });
  /**
   * 입구가 거절 응답을 준 뒤 그 요청을 뒤늦게라도 앱에 보냈다면 닿았을 만큼 기다린다: 다른 IP의 요청 하나를 앱까지 보내 본다.
   * 거절한 요청이 앱에 '없음'을 응답 직후 한 번만 보면, 응답을 먼저 주고 앱에 넘기는 구현을 놓친다
   */
  const settle = async (): Promise<void> => {
    const path = uniquePath('settle');
    expect((await call({ path })).status).toBe(200);
    forwardedTo(path);
  };

  beforeAll(async () => {
    gw = createV0Gateway({ config: baseConfig(), clock, traceId: () => FIXED_TRACE });
    ({ port } = await gw.listen('127.0.0.1'));
  });

  afterAll(async () => {
    await gw?.close();
  });

  test('BSL050_유효한_토큰이면_신원머리를_넣고_쿠키는_앱에_넘기지_않는다 [ASVS v5.0.0-9.1.1] [ASVS v5.0.0-4.1.3]', async () => {
    const path = uniquePath('valid');
    const before = snapshot(gw);
    const reply = await call({
      path,
      headers: {
        cookie: `theme=dark; __Secure-peaket_at=${validToken()}`,
        // 토큰과 함께 보낸 위조 신원 머리
        'X-User-Id': 'forged-user',
        'x-user-pid-prev': 'forged-prev',
        'x-user-aud': 'ops',
        'X-Session-Id': 'forged-session',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        tracestate: 'congo=t61rcWkgMzE',
        baggage: 'userId=alice',
        accept: 'application/json',
      },
    });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('ok');
    const got = upstream.find(path);
    expect(got).toBeDefined();
    expect(got?.method).toBe('GET');
    expect(identityHeadersOf(got?.headers ?? {})).toEqual({
      'x-user-id': 'acc-1',
      'x-session-id': 'sess-1',
      'x-user-aud': 'fan',
      'x-user-scope': 'ticket:buy',
      'x-user-pid': 'pid-1',
    });
    expect(got?.headers.cookie).toBeUndefined();
    expect(got?.headers.traceparent).toBeUndefined();
    expect(got?.headers.tracestate).toBeUndefined();
    expect(got?.headers.baggage).toBeUndefined();
    expect(got?.headers.accept).toBe('application/json');
    expect(got?.headers.host).toBe(upstream.url.host);
    expect(gw.counters().requests.forwarded).toBe(before.requests.forwarded + 1);
    expect(gw.counters().tokenRejections).toEqual(before.tokenRejections);
  });

  test('BSL050_토큰_없이_보낸_위조_신원머리와_추적머리는_지운다 [ASVS v5.0.0-4.1.3]', async () => {
    const path = uniquePath('forged-no-token');
    const reply = await call({
      path,
      headers: {
        'x-user-id': 'forged-user',
        'x-user-scope': 'ops:all',
        'x-user-aud': 'fan',
        'x-user-pid': 'forged-pid',
        'x-session-id': 'forged-session',
        traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
        cookie: 'theme=dark',
      },
    });
    expect(reply.status).toBe(200);
    const got = upstream.find(path);
    expect(got).toBeDefined();
    expect(identityHeadersOf(got?.headers ?? {})).toEqual({});
    expect(got?.headers.traceparent).toBeUndefined();
    expect(got?.headers.cookie).toBeUndefined();
  });

  test('BSL050_X-Forwarded-For는_믿는_홉의_값_하나로_다시_쓴다 [ASVS v5.0.0-4.1.3]', async () => {
    const path = uniquePath('xff');
    const ip = nextIp();
    await call({ path, headers: { 'x-forwarded-for': `6.6.6.6, ${ip}` } });
    const got = upstream.find(path);
    expect(got?.headers['x-forwarded-for']).toBe(ip);
    const lines = (got?.rawHeaders ?? []).filter((_v, i, all) => i % 2 === 0 && all[i]?.toLowerCase() === 'x-forwarded-for');
    expect(lines).toHaveLength(1);
  });

  test('BSL050_앞단주소머리와_Connection에_적힌_머리를_지우고_X-Forwarded-For는_한_줄만_넘긴다 [ASVS v5.0.0-4.1.3]', async () => {
    const path = uniquePath('forwarded-headers');
    const ip = nextIp();
    const reply = await call(
      {
        path,
        headers: {
          'x-forwarded-for': `6.6.6.6, ${ip}`,
          'x-real-ip': '6.6.6.6',
          forwarded: 'for=6.6.6.6;proto=http;host=evil.example',
          'x-forwarded-proto': 'http',
          'X-Forwarded-Host': 'evil.example',
          'x-forwarded-port': '80',
          'x-forwarded-client-cert': 'Hash=forged',
          connection: 'close, X-Hop-Secret',
          'x-hop-secret': 'only-for-this-hop',
          'x-client-version': 'web-1.2.3',
        },
      },
      ip,
    );
    expect(reply.status).toBe(200);
    const got = forwardedTo(path);
    const names = rawHeaderNames(got.rawHeaders);
    for (const name of ['x-real-ip', 'forwarded', 'x-forwarded-proto', 'x-forwarded-host', 'x-forwarded-port', 'x-forwarded-client-cert', 'x-hop-secret']) {
      expect(names, name).not.toContain(name);
    }
    expect(names.filter((name) => name.startsWith('x-forwarded-'))).toEqual(['x-forwarded-for']);
    expect(got.headers['x-forwarded-for']).toBe(ip);
    // 목록에 없는 머리는 그대로 간다
    expect(got.headers['x-client-version']).toBe('web-1.2.3');
  });

  test('BSL050_신원값에_CR·LF·공백·ASCII_밖_글자가_든_토큰은_claims로_세고_신원없이_넘긴다(입구가_죽지_않는다) [ASVS v5.0.0-4.1.3]', async () => {
    // CR·LF·한글은 Node가 머리 값으로 받지 않아 검사 없이 넣으면 요청 처리 중에 던진다. 'é'는 Node가 라틴1로 그대로 보낸다
    const cases: Array<Record<string, string>> = [
      { sub: 'acc-1\r\nx-user-scope: ops:all' },
      { sid: 'sess-1\nx-user-id: admin' },
      { sub: '관리자' },
      { sub: 'usé' },
      { pid: 'pid 1' },
      { scope: 'ticket:buy\r\nx-user-id: admin' },
    ];
    for (const claims of cases) {
      const what = JSON.stringify(claims);
      const path = uniquePath('claims-injection');
      const before = snapshot(gw);
      const reply = await call({ path, headers: { cookie: `__Secure-peaket_at=${validToken(claims)}` } });
      expect(reply.status, what).toBe(200);
      const got = forwardedTo(path);
      expect(identityHeadersOf(got.headers), what).toEqual({});
      expect(rawHeaderNames(got.rawHeaders).filter((name) => name.startsWith('x-user-') || name === 'x-session-id'), what).toEqual([]);
      const after = gw.counters();
      expect(after.tokenRejections, what).toEqual({ ...before.tokenRejections, claims: before.tokenRejections.claims + 1 });
      expect(after.requests.forwarded, what).toBe(before.requests.forwarded + 1);
    }
  });

  test('BSL050_서명이_틀린_토큰은_신원없이_넘기고_까닭만_센다 [ASVS v5.0.0-9.1.1]', async () => {
    const path = uniquePath('bad-signature');
    const before = snapshot(gw);
    const forged = fanToken(impostor, nowSec(), { sub: 'victim', sid: 'victim-session' });
    const reply = await call({ path, headers: { cookie: `__Secure-peaket_at=${forged}`, 'x-user-id': 'victim' } });
    // 입구는 401을 내지 않는다: 신원 없이 넘기고 인증이 필요한 경로는 앱이 401로 답한다
    expect(reply.status).toBe(200);
    expect(identityHeadersOf(forwardedTo(path).headers)).toEqual({});
    const after = gw.counters();
    expect(after.tokenRejections.signature).toBe(before.tokenRejections.signature + 1);
    expect(after.requests.forwarded).toBe(before.requests.forwarded + 1);
  });

  test('BSL050_alg_none_토큰은_신원없이_넘긴다 [ASVS v5.0.0-9.1.2]', async () => {
    const path = uniquePath('alg-none');
    const before = snapshot(gw);
    const valid = validToken().split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'at+jwt', kid: 'kid-a' })).toString('base64url')}.${valid[1]}.${valid[2]}`;
    await call({ path, headers: { cookie: `__Secure-peaket_at=${none}` } });
    expect(identityHeadersOf(forwardedTo(path).headers)).toEqual({});
    expect(gw.counters().tokenRejections.alg).toBe(before.tokenRejections.alg + 1);
  });

  test('BSL050_만료된_토큰은_신원없이_넘긴다 [ASVS v5.0.0-9.2.1]', async () => {
    const path = uniquePath('expired');
    const before = snapshot(gw);
    await call({ path, headers: { cookie: `__Secure-peaket_at=${validToken({ exp: nowSec() })}` } });
    expect(identityHeadersOf(forwardedTo(path).headers)).toEqual({});
    expect(gw.counters().tokenRejections.expired).toBe(before.tokenRejections.expired + 1);
  });

  test('BSL050_다른_대상의_토큰은_신원없이_넘긴다 [ASVS v5.0.0-9.2.3]', async () => {
    const path = uniquePath('audience');
    const before = snapshot(gw);
    await call({ path, headers: { cookie: `__Secure-peaket_at=${validToken({ aud: 'partner' })}` } });
    expect(identityHeadersOf(forwardedTo(path).headers)).toEqual({});
    expect(gw.counters().tokenRejections.audience).toBe(before.tokenRejections.audience + 1);
  });

  test('BSL050_쿠키를_실은_쓰기요청의_Origin이_틀리거나_없으면_403이고_앱을_부르지_않는다 [ASVS v5.0.0-3.5.1]', async () => {
    const cases: Array<[string, string, http.OutgoingHttpHeaders]> = [
      ['다른 출처', 'POST', { origin: 'https://evil.example' }],
      ['Origin 없음', 'POST', {}],
      ['null 출처', 'PUT', { origin: 'null' }],
      ['끝 슬래시', 'PATCH', { origin: `${ORIGIN}/` }],
      ['DELETE 다른 출처', 'DELETE', { origin: 'https://evil.example' }],
    ];
    const rejected: string[] = [];
    for (const [what, method, headers] of cases) {
      const path = uniquePath('csrf');
      rejected.push(path);
      const before = snapshot(gw);
      const reply = await call({ method, path, headers: { cookie: `__Secure-peaket_at=${validToken()}`, 'content-type': 'application/json', ...headers }, body: '{"seat":"A-1"}' });
      expectProblem(reply, 403, 'Forbidden');
      expect(upstream.touched(path), what).toBe(false);
      expect(gw.counters().requests.origin_rejected, what).toBe(before.requests.origin_rejected + 1);
      expect(gw.counters().requests.forwarded, what).toBe(before.requests.forwarded);
    }
    // 403을 준 뒤에 앱으로 넘기는(본문을 흘려보내는) 구현을 잡는다
    await settle();
    for (const path of rejected) expect(upstream.touched(path), path).toBe(false);
  });

  test('BSL050_토큰이_틀려도_액세스쿠키를_실은_쓰기요청은_출처를_본다 [ASVS v5.0.0-3.5.1]', async () => {
    const path = uniquePath('csrf-bad-token');
    const reply = await call({ method: 'POST', path, headers: { cookie: '__Secure-peaket_at=garbage', origin: 'https://evil.example' }, body: '{}' });
    expectProblem(reply, 403, 'Forbidden');
    await settle();
    expect(upstream.touched(path)).toBe(false);
  });

  test('K6_출처로_막은_403도_요청_수에_든다(모든_요청에_한도를_건다) [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-3.5.1]', async () => {
    // docs/infra.md §3 'v0 배포' 5: 경로와 계정을 가리지 않고 모든 요청에 건다. 출처 확인을 먼저 하고 토큰을 쓰지 않는 구현은 403을 무한히 받아 준다
    const ip = nextIp();
    for (let i = 0; i < 3; i++) {
      const reply = await call({ method: 'POST', path: uniquePath('csrf-counts'), headers: { cookie: `__Secure-peaket_at=${validToken()}`, origin: 'https://evil.example' }, body: '{}' }, ip);
      expectProblem(reply, 403, 'Forbidden');
    }
    const path = uniquePath('csrf-counts-after');
    expectProblem(await call({ path }, ip), 429, 'Too Many Requests');
    await settle();
    expect(upstream.touched(path)).toBe(false);
  });

  test('BSL050_허용출처의_쓰기요청은_본문과_함께_넘긴다 [ASVS v5.0.0-3.5.1]', async () => {
    const path = uniquePath('csrf-ok');
    upstream.handler = (_req, res) => {
      res.writeHead(201, { 'content-type': 'application/json' });
      res.end('{"id":"ord-1"}');
    };
    const reply = await call({ method: 'POST', path, headers: { cookie: `__Secure-peaket_at=${validToken()}`, origin: ORIGIN, 'content-type': 'application/json', 'idempotency-key': 'idem-1' }, body: '{"seat":"A-1"}' });
    expect(reply.status).toBe(201);
    expect(reply.body).toBe('{"id":"ord-1"}');
    const got = upstream.find(path);
    expect(got?.method).toBe('POST');
    expect(got?.body).toBe('{"seat":"A-1"}');
    expect(got?.headers.origin).toBe(ORIGIN);
    expect(got?.headers['idempotency-key']).toBe('idem-1');
    expect(got?.headers['x-user-id']).toBe('acc-1');
  });

  test('BSL050_액세스쿠키_없는_쓰기요청과_쿠키있는_GET은_Origin없이도_넘긴다 [ASVS v5.0.0-3.5.1]', async () => {
    const noCookie = uniquePath('post-no-cookie');
    expect((await call({ method: 'POST', path: noCookie, body: '{}' })).status).toBe(200);
    expect(upstream.find(noCookie)?.method).toBe('POST');
    const otherCookie = uniquePath('post-other-cookie');
    expect((await call({ method: 'POST', path: otherCookie, headers: { cookie: 'theme=dark' }, body: '{}' })).status).toBe(200);
    expect(upstream.find(otherCookie)?.headers.cookie).toBeUndefined();
    const get = uniquePath('get-cookie');
    expect((await call({ path: get, headers: { cookie: `__Secure-peaket_at=${validToken()}` } })).status).toBe(200);
    expect(upstream.find(get)?.headers['x-user-id']).toBe('acc-1');
  });

  test('K6_IP마다_버킷을_넘으면_429와_Retry-After이고_앱을_부르지_않는다 [ASVS v5.0.0-2.4.1]', async () => {
    const ip = nextIp();
    const before = snapshot(gw);
    for (let i = 0; i < 3; i++) {
      const path = uniquePath('rl-ok');
      expect((await call({ path }, ip)).status, `${i + 1}번째`).toBe(200);
      expect(upstream.find(path)).toBeDefined();
    }
    const limited = uniquePath('rl-429');
    const reply = await call({ path: limited }, ip);
    expectProblem(reply, 429, 'Too Many Requests');
    expect(reply.headers['retry-after']).toBe('1');
    expect(gw.counters().requests.rate_limited).toBe(before.requests.rate_limited + 1);
    await settle();
    expect(upstream.touched(limited)).toBe(false);
    // 앞단 프록시가 붙인 다른 IP는 따로 센다(믿는 홉 1)
    expect((await call({ path: uniquePath('rl-other-ip') }, nextIp())).status).toBe(200);
    // 맨 왼쪽 값을 바꿔도 믿는 홉의 값이 같으면 같은 버킷이다
    expect((await call({ path: uniquePath('rl-spoof'), headers: { 'x-forwarded-for': `1.2.3.4, ${ip}` } })).status).toBe(429);
    // 1초가 지나면 하나 찬다
    clock.advance(1_000);
    expect((await call({ path: uniquePath('rl-refill') }, ip)).status).toBe(200);
    expect((await call({ path: uniquePath('rl-again') }, ip)).status).toBe(429);
  });

  test('K6_버킷을_넘은_요청은_토큰을_검증하지_않고_429다(서명_검증으로_CPU를_쓰게_두지_않는다) [ASVS v5.0.0-2.4.1]', async () => {
    const ip = nextIp();
    for (let i = 0; i < 3; i++) expect((await call({ path: uniquePath('rl-before-token-fill') }, ip)).status).toBe(200);
    const before = snapshot(gw);
    const limited: string[] = [];
    // 서명이 틀린 토큰, 모양이 틀린 토큰, 만료된 토큰, 맞는 토큰: 어느 것도 검증하지 않고(거절 까닭을 세지 않고) 막는다
    for (const token of [fanToken(impostor, nowSec()), 'garbage', validToken({ exp: nowSec() }), validToken()]) {
      const path = uniquePath('rl-before-token');
      limited.push(path);
      expectProblem(await call({ path, headers: { cookie: `__Secure-peaket_at=${token}` } }, ip), 429, 'Too Many Requests');
    }
    const after = gw.counters();
    expect(after.tokenRejections).toEqual(before.tokenRejections);
    expect(after.requests).toEqual({ ...before.requests, rate_limited: before.requests.rate_limited + 4 });
    await settle();
    for (const path of limited) expect(upstream.touched(path), path).toBe(false);
  });

  test('BSL050_앱_응답에_HSTS와_nosniff를_붙이고_Cache-Control이_없을때만_no-store [ASVS v5.0.0-3.4.1] [ASVS v5.0.0-3.4.4]', async () => {
    const plain = await call({ path: uniquePath('headers-default') });
    expect(plain.status).toBe(200);
    expectSecurityHeaders(plain, '기본');
    expect(plain.headers['cache-control']).toBe('no-store');

    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'public, max-age=60', 'strict-transport-security': 'max-age=0', 'x-content-type-options': 'off' });
      res.end('{}');
    };
    const cached = await call({ path: uniquePath('headers-cache') });
    expectSecurityHeaders(cached, '앱이 덮으려 함');
    expect(cached.headers['cache-control']).toBe('public, max-age=60');

    upstream.handler = (_req, res) => {
      res.writeHead(404, { 'content-type': 'application/problem+json' });
      res.end('{"type":"about:blank","title":"Not Found","status":404}');
    };
    const notFound = await call({ path: uniquePath('headers-404') });
    expect(notFound.status).toBe(404);
    expectSecurityHeaders(notFound, '앱 404');
    expect(notFound.headers['cache-control']).toBe('no-store');
  });

  test('BSL050_앱의_상태와_머리와_본문을_그대로_돌려준다', async () => {
    upstream.handler = (_req, res) => {
      res.writeHead(202, { 'content-type': 'application/json', 'x-app': 'v0', etag: '"v7"', 'x-trace-id': 'abc' });
      res.end('{"accepted":true}');
    };
    const reply = await call({ path: uniquePath('passthrough') });
    expect(reply.status).toBe(202);
    expect(reply.body).toBe('{"accepted":true}');
    expect(reply.headers['content-type']).toBe('application/json');
    expect(reply.headers['x-app']).toBe('v0');
    expect(reply.headers.etag).toBe('"v7"');
    expect(reply.headers['x-trace-id']).toBe('abc');
  });

  test('BSL050_앱이_응답머리를_제때_주지_않으면_504 [ASVS v5.0.0-3.4.1] [ASVS v5.0.0-3.4.4]', async () => {
    upstream.handler = (_req, res) => {
      const timer = setTimeout(() => {
        if (!res.destroyed) res.end('late');
      }, 4_000);
      res.on('close', () => clearTimeout(timer));
    };
    const before = snapshot(gw);
    const started = performance.now();
    const reply = await call({ path: uniquePath('slow') });
    const elapsed = performance.now() - started;
    // 판정은 상태로 한다: 설정한 1초가 아닌 기본 20초를 쓰면 앱의 4초 뒤 'late'(200)가 먼저 온다.
    // 아래쪽 경계는 너무 일찍 끊지 않았는지를 본다(입구의 타이머는 요청을 받은 뒤에 시작하므로 클라이언트가 잰 시간이 더 길다)
    expectProblem(reply, 504, 'Gateway Timeout');
    expect(elapsed).toBeGreaterThanOrEqual(950);
    expect(elapsed).toBeLessThan(3_900);
    expect(gw.counters().requests.upstream_timeout).toBe(before.requests.upstream_timeout + 1);
  }, 10_000);

  test('BSL050_앱이_1xx만_보내며_최종_응답머리를_미뤄도_504다(연결이_조용한지가_아니라_응답머리를_기다린다)', async () => {
    // 102 Processing을 0.2초마다 보내 소켓은 늘 바쁘다. 소켓 유휴 시간(setTimeout)으로 재는 구현은 끊지 않고 4초 뒤 'late'를 넘긴다
    upstream.handler = (_req, res) => {
      const ticker = setInterval(() => {
        if (!res.destroyed) res.writeProcessing();
      }, 200);
      const late = setTimeout(() => {
        if (!res.destroyed) res.end('late');
      }, 4_000);
      res.on('close', () => {
        clearInterval(ticker);
        clearTimeout(late);
      });
    };
    const before = snapshot(gw);
    const reply = await call({ path: uniquePath('slow-1xx') });
    expectProblem(reply, 504, 'Gateway Timeout');
    expect(gw.counters().requests.upstream_timeout).toBe(before.requests.upstream_timeout + 1);
  }, 10_000);

  test('BSL050_응답머리를_받은_뒤에는_본문이_늦어도_끊지_않는다', async () => {
    upstream.handler = (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.flushHeaders();
      res.write('first,');
      const timer = setTimeout(() => res.end('second'), 1_300);
      res.on('close', () => clearTimeout(timer));
    };
    const reply = await call({ path: uniquePath('slow-body') });
    expect(reply.status).toBe(200);
    expect(reply.body).toBe('first,second');
  }, 10_000);

  test('BSL050_wss_업그레이드는_신원머리와_Origin을_실어_앱과_양방향으로_잇는다 [ASVS v5.0.0-4.4.1] [ASVS v5.0.0-4.1.3]', async () => {
    const path = uniquePath('ws');
    const ip = nextIp();
    const ws = openWs(port, path, {
      cookie: `__Secure-peaket_at=${validToken()}`,
      'x-user-id': 'forged',
      'x-user-scope': 'ops:all',
      'x-session-id': 'forged',
      'x-forwarded-for': `6.6.6.6, ${ip}`,
      'x-real-ip': '6.6.6.6',
      forwarded: 'for=6.6.6.6',
      'x-forwarded-proto': 'ws',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
      baggage: 'userId=alice',
    });
    try {
      const greeting = nextMessage(ws);
      await within(wsOpened(ws), 3_000, 'wss 열기');
      expect(await within(greeting, 3_000, '앱이 먼저 보낸 글')).toBe('hello');
      const echo = nextMessage(ws);
      ws.send('ping');
      expect(await within(echo, 3_000, '되보낸 글')).toBe('echo:ping');
      const got = upstream.find(path);
      expect(got?.upgrade).toBe(true);
      expect(identityHeadersOf(got?.headers ?? {})).toEqual({ 'x-user-id': 'acc-1', 'x-session-id': 'sess-1', 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': 'pid-1' });
      expect(got?.headers.origin).toBe(ORIGIN);
      expect(got?.headers.cookie).toBeUndefined();
      expect(got?.headers.upgrade).toBe('websocket');
      expect(String(got?.headers.connection)).toMatch(/upgrade/i);
      expect(got?.headers['sec-websocket-key']).toEqual(expect.any(String));
      expect(got?.headers['sec-websocket-version']).toBe('13');
      expect(got?.headers['x-forwarded-for']).toBe(ip);
      // 업그레이드 길도 같은 머리 규칙을 거친다
      const names = rawHeaderNames(got?.rawHeaders ?? []);
      for (const name of ['x-real-ip', 'forwarded', 'x-forwarded-proto', 'traceparent', 'baggage', 'cookie']) expect(names, name).not.toContain(name);
      expect(names.filter((name) => name === 'x-forwarded-for' || name === 'x-user-id' || name === 'x-user-scope' || name === 'x-session-id').sort()).toEqual(['x-forwarded-for', 'x-session-id', 'x-user-id', 'x-user-scope']);
    } finally {
      ws.terminate();
    }
  });

  test('BSL050_평문_ws로는_입구에_잇지_못한다 [ASVS v5.0.0-4.4.1]', async () => {
    const path = uniquePath('plain-ws');
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { 'x-forwarded-for': nextIp() } });
    const outcome = await within(
      new Promise<string>((resolve) => {
        ws.once('open', () => resolve('open'));
        ws.once('error', () => resolve('error'));
        ws.once('unexpected-response', () => resolve('unexpected-response'));
      }),
      5_000,
      '평문 ws 시도',
    );
    ws.terminate();
    expect(outcome).not.toBe('open');
    expect(upstream.find(path)).toBeUndefined();
  });

  test('K6_WebSocket_업그레이드도_레이트리밋에_걸려_소켓에_429를_쓴다 [ASVS v5.0.0-2.4.1]', async () => {
    const ip = nextIp();
    for (let i = 0; i < 3; i++) expect((await call({ path: uniquePath('ws-rl-fill') }, ip)).status).toBe(200);
    const path = uniquePath('ws-rl');
    const before = snapshot(gw);
    const raw = await tlsExchange(
      port,
      cert,
      [
        `GET ${path} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Connection: Upgrade',
        'Upgrade: websocket',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        `Origin: ${ORIGIN}`,
        `X-Forwarded-For: ${ip}`,
        '',
        '',
      ].join('\r\n'),
    );
    const reply = parseRawResponse(raw);
    expectProblem(reply, 429, 'Too Many Requests');
    expect(reply.headers['retry-after']).toBe('1');
    expect(gw.counters().requests.rate_limited).toBe(before.requests.rate_limited + 1);
    await settle();
    expect(upstream.touched(path)).toBe(false);
  });

  test('BSL050_TLS1.1_연결은_맺지_않고_TLS1.2는_맺으며_기본은_TLS1.3이다 [ASVS v5.0.0-12.1.1]', async () => {
    // 이 클라이언트 설정이 TLS 1.1을 실제로 맺을 수 있음을 대조 서버로 먼저 보인다(그래야 입구의 거절이 입구 때문이다)
    const control = tls.createServer({ cert, key: certKey, minVersion: 'TLSv1', ciphers: 'DEFAULT@SECLEVEL=0' }, (socket) => socket.end());
    await new Promise<void>((resolve) => control.listen(0, '127.0.0.1', resolve));
    const legacy: tls.ConnectionOptions = { minVersion: 'TLSv1', maxVersion: 'TLSv1.1', ciphers: 'DEFAULT@SECLEVEL=0' };
    try {
      const controlPort = (control.address() as { port: number }).port;
      expect(await tlsHandshake(controlPort, legacy)).toEqual({ ok: true, protocol: 'TLSv1.1' });
    } finally {
      await new Promise<void>((resolve) => control.close(() => resolve()));
    }
    const refused = await tlsHandshake(port, legacy);
    expect(refused.ok).toBe(false);
    expect(await tlsHandshake(port, { maxVersion: 'TLSv1.2' })).toEqual({ ok: true, protocol: 'TLSv1.2' });
    expect(await tlsHandshake(port, {})).toEqual({ ok: true, protocol: 'TLSv1.3' });
  });

  test('BSL050_HTTPS_포트에_보낸_평문_HTTP는_정상응답을_받지_못하고_앱에_닿지_않는다 [ASVS v5.0.0-12.2.1]', async () => {
    const path = uniquePath('plain-http');
    const outcome = await within(
      httpCall(port, { path, headers: { 'x-forwarded-for': nextIp() } }).then(
        (reply) => ({ kind: 'response' as const, status: reply.status }),
        (err: Error) => ({ kind: 'error' as const, message: err.message }),
      ),
      5_000,
      '평문 HTTP 시도',
    );
    if (outcome.kind === 'response') {
      // 'HTTPS 포트에 평문을 보냈다'는 400을 주는 것까지는 받는다. 넘기거나 옮기라고(3xx) 하지 않는다
      expect(outcome.status).toBe(400);
    }
    expect(upstream.find(path)).toBeUndefined();
  });
});

describe('v0 입구: 믿는 홉 0(X-Forwarded-For를 믿지 않음)', () => {
  let gw: V0Gateway;
  let port = 0;

  beforeAll(async () => {
    gw = createV0Gateway({ config: baseConfig({ trustedProxyHops: 0, burst: 2 }), clock: fakeClock({ now: START_MS }), traceId: () => FIXED_TRACE });
    ({ port } = await gw.listen('127.0.0.1'));
  });

  afterAll(async () => {
    await gw?.close();
  });

  test('K6_믿는_홉이_0이면_X-Forwarded-For를_바꿔도_연결주소_하나로_센다 [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-4.1.3]', async () => {
    const first = uniquePath('hops0-a');
    const second = uniquePath('hops0-b');
    const third = uniquePath('hops0-c');
    expect((await httpsCall(port, cert, { path: first, headers: { 'x-forwarded-for': '203.0.113.1' } })).status).toBe(200);
    expect((await httpsCall(port, cert, { path: second, headers: { 'x-forwarded-for': '203.0.113.2' } })).status).toBe(200);
    // 클라이언트가 적은 X-Forwarded-For는 앱에 가지 않고 연결 주소로 바뀐다
    expect(upstream.find(first)?.headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(upstream.find(second)?.headers['x-forwarded-for']).toBe('127.0.0.1');
    const limited = await httpsCall(port, cert, { path: third, headers: { 'x-forwarded-for': '203.0.113.3' } });
    expectProblem(limited, 429, 'Too Many Requests');
    expect(upstream.find(third)).toBeUndefined();
  });
});

describe('v0 입구: 앱에 닿지 못함', () => {
  let gw: V0Gateway;
  let port = 0;

  beforeAll(async () => {
    const down = await closedPort();
    // traceId를 주지 않으면 32자리 16진수 난수다
    gw = createV0Gateway({ config: baseConfig({ upstream: new URL(`http://127.0.0.1:${down}`) }), clock: fakeClock({ now: START_MS }) });
    ({ port } = await gw.listen('127.0.0.1'));
  });

  afterAll(async () => {
    await gw?.close();
  });

  test('BSL050_앱에_닿지_못하면_502_Problem이다 [ASVS v5.0.0-3.4.1] [ASVS v5.0.0-3.4.4]', async () => {
    const first = await httpsCall(port, cert, { path: '/v0/anything', headers: { 'x-forwarded-for': nextIp() } });
    expectProblem(first, 502, 'Bad Gateway', /^[0-9a-f]{32}$/);
    const second = await httpsCall(port, cert, { path: '/v0/anything', headers: { 'x-forwarded-for': nextIp() } });
    expectProblem(second, 502, 'Bad Gateway', /^[0-9a-f]{32}$/);
    // 요청마다 새 traceId
    expect(JSON.parse(first.body).traceId).not.toBe(JSON.parse(second.body).traceId);
    expect(gw.counters().requests.upstream_error).toBe(2);
    expect(gw.counters().requests.forwarded).toBe(0);
  });
});

describe('v0 입구: 관리 포트와 수', () => {
  const clock = fakeClock({ now: START_MS });
  let gw: V0Gateway;
  let port = 0;
  let managementPort = 0;
  const nowSec = (): number => Math.floor(clock.now() / 1000);

  beforeAll(async () => {
    gw = createV0Gateway({ config: baseConfig(), clock, traceId: () => FIXED_TRACE });
    ({ port, managementPort } = await gw.listen('127.0.0.1'));
  });

  afterAll(async () => {
    await gw?.close();
  });

  test('BSL050_metrics와_counters가_실제로_일어난_일과_같다', async () => {
    expect(managementPort).not.toBe(port);
    const ipA = nextIp();
    const ipB = nextIp();
    const ipC = nextIp();
    const send = (ip: string, options: { method?: string; path?: string; headers?: http.OutgoingHttpHeaders; body?: string } = {}): Promise<Reply> =>
      httpsCall(port, cert, { path: uniquePath('metrics'), ...options, headers: { 'x-forwarded-for': ip, ...options.headers } });
    // 쿠키 없음 → 넘김(토큰 거절로 세지 않는다)
    expect((await send(ipC)).status).toBe(200);
    // ipA: 맞는 토큰, 서명이 틀린 토큰, 만료된 토큰 → 셋 다 넘김
    expect((await send(ipA, { headers: { cookie: `__Secure-peaket_at=${fanToken(keyA, nowSec())}` } })).status).toBe(200);
    expect((await send(ipA, { headers: { cookie: `__Secure-peaket_at=${fanToken(impostor, nowSec())}` } })).status).toBe(200);
    expect((await send(ipA, { headers: { cookie: `__Secure-peaket_at=${fanToken(keyA, nowSec(), { exp: nowSec() - 1 })}` } })).status).toBe(200);
    // ipA의 넷째 → 429(버킷 3개)
    expect((await send(ipA)).status).toBe(429);
    // ipB: 쿠키를 실은 POST에 다른 출처 → 403
    expect((await send(ipB, { method: 'POST', headers: { cookie: `__Secure-peaket_at=${fanToken(keyA, nowSec())}`, origin: 'https://evil.example' }, body: '{}' })).status).toBe(403);

    const zeroReasons = Object.fromEntries(TOKEN_REJECTIONS.map((r) => [r, 0]));
    expect(gw.counters()).toEqual({
      requests: { forwarded: 4, rate_limited: 1, origin_rejected: 1, upstream_error: 0, upstream_timeout: 0 },
      tokenRejections: { ...zeroReasons, signature: 1, expired: 1 },
    });

    const metrics = await httpCall(managementPort, { path: '/metrics' });
    expect(metrics.status).toBe(200);
    expect(metrics.headers['content-type']).toMatch(/^text\/plain/);
    expect(metrics.body).toBe(gw.metricsText());
    expect(metrics.body).toMatch(/^# TYPE v0_gateway_requests_total counter$/m);
    expect(metrics.body).toMatch(/^# TYPE v0_gateway_token_rejections_total counter$/m);
    const counters = gw.counters();
    // 문서의 이름 그대로 모든 줄이 있다(0인 줄도 낸다)
    expect([...GATEWAY_OUTCOMES].sort()).toEqual([...SPEC_OUTCOMES].sort());
    expect([...TOKEN_REJECTIONS].sort()).toEqual([...SPEC_REASONS].sort());
    for (const outcome of SPEC_OUTCOMES) {
      expect(metricValue(metrics.body, `v0_gateway_requests_total{outcome="${outcome}"}`), outcome).toBe((counters.requests as Record<string, number>)[outcome]);
    }
    for (const reason of SPEC_REASONS) {
      expect(metricValue(metrics.body, `v0_gateway_token_rejections_total{reason="${reason}"}`), reason).toBe((counters.tokenRejections as Record<string, number>)[reason]);
    }
    expect(metricValue(metrics.body, 'v0_gateway_requests_total{outcome="forwarded"}')).toBe(4);
    expect(metricValue(metrics.body, 'v0_gateway_token_rejections_total{reason="signature"}')).toBe(1);
  });

  test('BSL050_관리포트는_ready·livez·metrics만_답하고_앱으로_넘기지_않는다', async () => {
    expect((await httpCall(managementPort, { path: '/ready' })).status).toBe(200);
    expect((await httpCall(managementPort, { path: '/livez' })).status).toBe(200);
    const before = snapshot(gw);
    const path = uniquePath('management');
    const other = await httpCall(managementPort, { path, headers: { 'x-forwarded-for': nextIp() } });
    expect(other.status).toBe(404);
    expect(upstream.find(path)).toBeUndefined();
    // 관리 포트의 요청은 입구 요청 수에 들지 않는다
    expect(gw.counters()).toEqual(before);
  });
});

describe('v0 입구: 토큰 거절 까닭', () => {
  const clock = fakeClock({ now: START_MS });
  let gw: V0Gateway;
  let port = 0;
  let managementPort = 0;

  beforeAll(async () => {
    gw = createV0Gateway({ config: baseConfig(), clock, traceId: () => FIXED_TRACE });
    ({ port, managementPort } = await gw.listen('127.0.0.1'));
  });

  afterAll(async () => {
    await gw?.close();
  });

  test('BSL050_열_가지_까닭을_하나씩_세고_metrics에_문서의_이름으로_낸다 [ASVS v5.0.0-9.1.1] [ASVS v5.0.0-9.1.2] [ASVS v5.0.0-9.2.1] [ASVS v5.0.0-9.2.3]', async () => {
    const now = Math.floor(clock.now() / 1000);
    // 까닭마다 그 까닭 하나만 틀린 토큰(나머지는 맞다)
    const tokens: Record<string, string> = {
      malformed: 'not-a-jwt',
      alg: signSegments(keyA.privateKey, b64json(fanHeader('kid-a', { alg: 'HS256' })), b64json(fanClaims(now))),
      typ: fanToken(keyA, now, {}, { typ: 'JWT' }),
      kid: fanToken(keyA, now, {}, { kid: 'kid-unknown' }),
      signature: fanToken(impostor, now),
      issuer: fanToken(keyA, now, { iss: 'https://evil.example' }),
      audience: fanToken(keyA, now, { aud: 'partner' }),
      expired: fanToken(keyA, now, { exp: now }),
      not_yet_valid: fanToken(keyA, now, { nbf: now + 60 }),
      claims: fanToken(keyA, now, { sub: 'acc-1\r\nx-user-id: admin' }),
    };
    expect(Object.keys(tokens).sort()).toEqual([...SPEC_REASONS].sort());
    for (const [reason, token] of Object.entries(tokens)) {
      const path = uniquePath(`reason-${reason}`);
      const before = structuredClone(gw.counters().tokenRejections) as Record<string, number>;
      const reply = await httpsCall(port, cert, { path, headers: { 'x-forwarded-for': nextIp(), cookie: `theme=dark; __Secure-peaket_at=${token}` } });
      expect(reply.status, reason).toBe(200);
      expect(identityHeadersOf(forwardedTo(path).headers), reason).toEqual({});
      // 그 까닭 하나만 1 오른다
      expect(gw.counters().tokenRejections, reason).toEqual({ ...before, [reason]: (before[reason] ?? 0) + 1 });
    }
    expect(gw.counters()).toEqual({
      requests: { forwarded: 10, rate_limited: 0, origin_rejected: 0, upstream_error: 0, upstream_timeout: 0 },
      tokenRejections: Object.fromEntries(SPEC_REASONS.map((reason) => [reason, 1])),
    });
    const metrics = await httpCall(managementPort, { path: '/metrics' });
    expect(metrics.status).toBe(200);
    for (const reason of SPEC_REASONS) {
      expect(metricValue(metrics.body, `v0_gateway_token_rejections_total{reason="${reason}"}`), reason).toBe(1);
    }
    for (const outcome of SPEC_OUTCOMES) {
      expect(metricValue(metrics.body, `v0_gateway_requests_total{outcome="${outcome}"}`), outcome).toBe(outcome === 'forwarded' ? 10 : 0);
    }
  });
});

describe('v0 입구: 닫기', () => {
  test('BSL050_close는_열린_업그레이드_소켓까지_닫고_새_연결을_받지_않는다 [ASVS v5.0.0-4.4.1]', async () => {
    const gw = createV0Gateway({ config: baseConfig(), clock: fakeClock({ now: START_MS }), traceId: () => FIXED_TRACE });
    const { port } = await gw.listen('127.0.0.1');
    const ws = openWs(port, uniquePath('close'), { 'x-forwarded-for': nextIp() });
    let closed = false;
    try {
      const greeting = nextMessage(ws);
      await within(wsOpened(ws), 3_000, 'wss 열기');
      expect(await within(greeting, 3_000, '앱이 먼저 보낸 글')).toBe('hello');
      const wsClosed = new Promise<void>((resolve) => ws.once('close', () => resolve()));
      await within(gw.close(), 3_000, '입구 close');
      closed = true;
      await within(wsClosed, 3_000, '업그레이드한 소켓 닫힘');
      const again = await tlsHandshake(port, {});
      expect(again.ok).toBe(false);
    } finally {
      ws.terminate();
      if (!closed) await gw.close().catch(() => undefined);
    }
  }, 15_000);
});
