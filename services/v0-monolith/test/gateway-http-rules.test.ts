// v0 입구의 머리 규칙 시험(docs/infra.md §3 'v0 배포' 2·4·5·6, docs/api/guidelines.md §2·§9,
// docs/security/asvs/v0-baseline.md 4.1.3·3.5.1·3.4.1·3.4.4).
import type { IncomingHttpHeaders } from 'node:http';
import { describe, expect, test } from 'vitest';
import {
  clientIp,
  downstreamResponseHeaders,
  gatewayProblem,
  isIdentityHeader,
  needsOriginCheck,
  originAllowed,
  upstreamRequestHeaders,
} from '../src/gateway/http-rules.js';
import { HSTS_VALUE, PROBLEM_CONTENT_TYPE, identityHeadersOf, lowerKeys } from './gateway-helpers.js';

const UPSTREAM_HOST = '127.0.0.1:8080';
const ORIGINS = ['https://www.peaket.local', 'https://127.0.0.1:8443'];
const TRACE = '0af7651916cd43dd8448eb211c80319c';

describe('isIdentityHeader', () => {
  test('BSL050_x-user-로_시작하는_머리와_x-session-id는_신원머리다(대소문자_무시) [ASVS v5.0.0-4.1.3]', () => {
    for (const name of ['x-user-id', 'X-User-Id', 'x-user-pid', 'x-user-pid-prev', 'X-USER-SCOPE', 'x-user-aud', 'x-user-anything-new', 'x-session-id', 'X-Session-Id', 'X-SESSION-ID']) {
      expect(isIdentityHeader(name), name).toBe(true);
    }
  });

  test('BSL050_이름이_비슷하기만_한_머리는_신원머리가_아니다', () => {
    for (const name of ['x-users', 'x-user', 'x-userid', 'user-id', 'x-sessionid', 'x-session', 'x-forwarded-for', 'cookie', 'authorization']) {
      expect(isIdentityHeader(name), name).toBe(false);
    }
  });
});

describe('clientIp', () => {
  const REMOTE = '10.0.0.9';

  test('BSL050_믿는_홉이_0이면_X-Forwarded-For를_보지_않고_연결주소다 [ASVS v5.0.0-4.1.3]', () => {
    expect(clientIp(REMOTE, undefined, 0)).toBe(REMOTE);
    expect(clientIp(REMOTE, '203.0.113.7', 0)).toBe(REMOTE);
    expect(clientIp(REMOTE, ['203.0.113.7', '198.51.100.1'], 0)).toBe(REMOTE);
  });

  test('BSL050_믿는_홉이_n이면_오른쪽에서_n번째_값이다 [ASVS v5.0.0-4.1.3]', () => {
    // 맨 왼쪽은 클라이언트가 마음대로 적은 값이라 믿지 않는다
    expect(clientIp(REMOTE, '6.6.6.6, 203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientIp(REMOTE, '6.6.6.6, 203.0.113.7, 198.51.100.1', 2)).toBe('203.0.113.7');
    expect(clientIp(REMOTE, '203.0.113.7, 198.51.100.1', 2)).toBe('203.0.113.7');
    expect(clientIp(REMOTE, '2001:db8::7', 1)).toBe('2001:db8::7');
  });

  test('BSL050_여러_X-Forwarded-For_머리는_쉼표로_이어_센다', () => {
    expect(clientIp(REMOTE, ['6.6.6.6', '203.0.113.7, 198.51.100.1'], 1)).toBe('198.51.100.1');
    expect(clientIp(REMOTE, ['6.6.6.6', '203.0.113.7, 198.51.100.1'], 2)).toBe('203.0.113.7');
    expect(clientIp(REMOTE, ['6.6.6.6', '203.0.113.7, 198.51.100.1'], 3)).toBe('6.6.6.6');
  });

  test('BSL050_값_앞뒤_공백은_무시한다', () => {
    expect(clientIp(REMOTE, '  6.6.6.6 ,203.0.113.7  ', 1)).toBe('203.0.113.7');
    expect(clientIp(REMOTE, '  6.6.6.6 ,203.0.113.7  ', 2)).toBe('6.6.6.6');
  });

  test('BSL050_값이_모자라거나_IP가_아니면_연결주소다 [ASVS v5.0.0-4.1.3]', () => {
    expect(clientIp(REMOTE, '203.0.113.7', 2)).toBe(REMOTE);
    expect(clientIp(REMOTE, undefined, 1)).toBe(REMOTE);
    expect(clientIp(REMOTE, '', 1)).toBe(REMOTE);
    expect(clientIp(REMOTE, [], 1)).toBe(REMOTE);
    for (const bad of ['not-an-ip', 'unknown', '999.1.1.1', '203.0.113.7:5678', '[2001:db8::1]', '203.0.113.7/24', 'localhost']) {
      expect(clientIp(REMOTE, `6.6.6.6, ${bad}`, 1), bad).toBe(REMOTE);
    }
  });

  test('BSL050_IPv4를_담은_IPv6는_IPv4로_쓰고_연결주소가_없으면_unknown이다', () => {
    expect(clientIp('::ffff:10.0.0.9', undefined, 0)).toBe('10.0.0.9');
    expect(clientIp(REMOTE, '::ffff:203.0.113.7', 1)).toBe('203.0.113.7');
    expect(clientIp('::ffff:10.0.0.9', 'garbage', 1)).toBe('10.0.0.9');
    expect(clientIp('::1', undefined, 0)).toBe('::1');
    expect(clientIp(undefined, undefined, 0)).toBe('unknown');
    expect(clientIp(undefined, 'garbage', 1)).toBe('unknown');
    expect(clientIp(undefined, '203.0.113.7', 1)).toBe('203.0.113.7');
  });
});

describe('needsOriginCheck·originAllowed', () => {
  test('BSL050_액세스쿠키를_실은_쓰기요청만_출처를_본다 [ASVS v5.0.0-3.5.1]', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'Delete']) {
      expect(needsOriginCheck(method, true), method).toBe(true);
      expect(needsOriginCheck(method, false), `${method} 쿠키 없음`).toBe(false);
    }
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'get']) {
      expect(needsOriginCheck(method, true), method).toBe(false);
    }
    expect(needsOriginCheck(undefined, true)).toBe(false);
  });

  test('BSL050_Origin은_허용목록과_정확히_같아야_한다 [ASVS v5.0.0-3.5.1]', () => {
    expect(originAllowed('https://www.peaket.local', ORIGINS)).toBe(true);
    expect(originAllowed('https://127.0.0.1:8443', ORIGINS)).toBe(true);
    for (const bad of [
      'https://www.peaket.local/',
      'https://www.peaket.local:443',
      'http://www.peaket.local',
      'https://WWW.peaket.local',
      'https://127.0.0.1:8444',
      'https://127.0.0.1',
      'https://evil.www.peaket.local',
      'https://www.peaket.local.evil.example',
      'https://www.peaket.local, https://evil.example',
      '',
    ]) {
      expect(originAllowed(bad, ORIGINS), bad).toBe(false);
    }
  });

  test('BSL050_Origin이_없거나_null이면_거절한다(목록에_null이_있어도) [ASVS v5.0.0-3.5.1]', () => {
    expect(originAllowed(undefined, ORIGINS)).toBe(false);
    expect(originAllowed('null', ORIGINS)).toBe(false);
    expect(originAllowed('null', [...ORIGINS, 'null'])).toBe(false);
    // 출처 값이 둘이면 어느 것도 믿지 않는다
    expect(originAllowed(['https://www.peaket.local', 'https://evil.example'], ORIGINS)).toBe(false);
  });
});

describe('upstreamRequestHeaders', () => {
  const forged: IncomingHttpHeaders = {
    host: 'gateway.peaket.local:8443',
    accept: 'application/json',
    'content-type': 'application/json',
    'content-length': '12',
    'idempotency-key': 'idem-1',
    'user-agent': 'k6',
    origin: 'https://www.peaket.local',
    // 위조한 신원 머리(대소문자 섞음)
    'x-user-id': 'forged-user',
    'X-User-Scope': 'ops:all',
    'x-user-aud': 'ops',
    'x-user-pid': 'forged-pid',
    'x-user-pid-prev': 'forged-prev',
    'x-user-role': 'admin',
    'X-Session-Id': 'forged-session',
    // 추적 머리
    traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    tracestate: 'congo=t61rcWkgMzE',
    baggage: 'userId=alice',
    // 앞단 주소 머리(forwarded·x-real-ip·x-forwarded-로 시작하는 머리 전부)
    forwarded: 'for=6.6.6.6;proto=http;host=evil.example',
    'x-real-ip': '6.6.6.6',
    'x-forwarded-proto': 'http',
    'X-Forwarded-Host': 'evil.example',
    'x-forwarded-port': '80',
    'x-forwarded-prefix': '/admin',
    'x-forwarded-client-cert': 'Hash=forged',
    // 지우지 않아야 하는 비슷한 머리(모든 x- 머리를 지우는 구현을 잡는다)
    'x-client-version': 'web-1.2.3',
    'x-request-id': 'req-1',
    // 쿠키와 연결 머리. Connection에 적힌 이름(x-hop-secret)도 연결 머리다(RFC 9110 §7.6.1)
    cookie: '__Secure-peaket_at=tok; theme=dark',
    connection: 'keep-alive, X-Hop-Secret',
    'x-hop-secret': 'only-for-this-hop',
    'keep-alive': 'timeout=5',
    'proxy-connection': 'keep-alive',
    'proxy-authorization': 'Basic Zm9vOmJhcg==',
    te: 'trailers',
    trailer: 'x-checksum',
    'transfer-encoding': 'chunked',
    upgrade: 'h2c',
    'x-forwarded-for': '6.6.6.6, 203.0.113.7',
  };

  test('BSL050_신원·추적·앞단주소·쿠키·연결머리를_지우고_검증한_신원만_넣는다 [ASVS v5.0.0-4.1.3]', () => {
    const out = lowerKeys(upstreamRequestHeaders(forged, { upstreamHost: UPSTREAM_HOST, identity: { sub: 'u-1', sid: 's-1', scope: 'ticket:buy', pid: 'p-1' }, clientIp: '203.0.113.7' }));
    expect(out).toEqual({
      host: UPSTREAM_HOST,
      accept: 'application/json',
      'content-type': 'application/json',
      'content-length': '12',
      'idempotency-key': 'idem-1',
      'user-agent': 'k6',
      origin: 'https://www.peaket.local',
      'x-client-version': 'web-1.2.3',
      'x-request-id': 'req-1',
      'x-forwarded-for': '203.0.113.7',
      'x-user-id': 'u-1',
      'x-session-id': 's-1',
      'x-user-aud': 'fan',
      'x-user-scope': 'ticket:buy',
      'x-user-pid': 'p-1',
    });
  });

  test('BSL050_신원이_없으면_신원머리를_하나도_넘기지_않는다 [ASVS v5.0.0-4.1.3]', () => {
    const out = upstreamRequestHeaders(forged, { upstreamHost: UPSTREAM_HOST, identity: undefined, clientIp: '10.0.0.9' });
    expect(identityHeadersOf(out)).toEqual({});
    const lower = lowerKeys(out);
    expect(lower['x-forwarded-for']).toBe('10.0.0.9');
    expect(lower.host).toBe(UPSTREAM_HOST);
    for (const name of [
      'cookie',
      'traceparent',
      'tracestate',
      'baggage',
      'connection',
      'keep-alive',
      'transfer-encoding',
      'upgrade',
      'te',
      'trailer',
      'proxy-authorization',
      'proxy-connection',
      'forwarded',
      'x-real-ip',
      'x-forwarded-proto',
      'x-forwarded-host',
      'x-forwarded-port',
      'x-forwarded-prefix',
      'x-forwarded-client-cert',
      'x-hop-secret',
    ]) {
      expect(lower[name], name).toBeUndefined();
    }
    expect(Object.keys(lower).filter((name) => name.startsWith('x-forwarded-'))).toEqual(['x-forwarded-for']);
  });

  test('BSL050_Connection에_적힌_이름은_대소문자·공백과_상관없이_지우고_X-Forwarded-For는_배열이어도_하나로_쓴다 [ASVS v5.0.0-4.1.3]', () => {
    const out = lowerKeys(
      upstreamRequestHeaders(
        { connection: ' Keep-Alive ,X-HOP-ONE,  x-hop-two ', 'x-hop-one': '1', 'x-hop-two': '2', 'x-forwarded-for': ['6.6.6.6', '7.7.7.7'], 'x-real-ip': '6.6.6.6', accept: '*/*' },
        { upstreamHost: UPSTREAM_HOST, identity: undefined, clientIp: '198.51.100.9' },
      ),
    );
    expect(out).toEqual({ host: UPSTREAM_HOST, accept: '*/*', 'x-forwarded-for': '198.51.100.9' });
  });

  test('BSL050_Connection에_입구가_쓰는_머리_이름을_적어도_입구가_넣은_값은_남는다 [ASVS v5.0.0-4.1.3]', () => {
    // 연결 머리 지우기를 신원·주소 머리를 넣은 뒤에 하면, 클라이언트가 Connection에 적은 이름으로 입구의 머리를 지우게 된다
    const out = lowerKeys(
      upstreamRequestHeaders(
        { connection: 'x-user-id, x-session-id, x-user-aud, x-user-scope, x-user-pid, x-forwarded-for, host', 'x-user-id': 'forged', accept: '*/*' },
        { upstreamHost: UPSTREAM_HOST, identity: { sub: 'u-9', sid: 's-9', scope: 'ticket:buy', pid: 'p-9' }, clientIp: '203.0.113.9' },
      ),
    );
    expect(out).toEqual({
      host: UPSTREAM_HOST,
      accept: '*/*',
      'x-forwarded-for': '203.0.113.9',
      'x-user-id': 'u-9',
      'x-session-id': 's-9',
      'x-user-aud': 'fan',
      'x-user-scope': 'ticket:buy',
      'x-user-pid': 'p-9',
    });
  });

  test('BSL050_pid가_없는_신원은_x-user-pid를_넣지_않는다 [ASVS v5.0.0-4.1.3]', () => {
    const out = upstreamRequestHeaders(forged, { upstreamHost: UPSTREAM_HOST, identity: { sub: 'u-2', sid: 's-2', scope: 'ticket:buy' }, clientIp: '10.0.0.9' });
    expect(identityHeadersOf(out)).toEqual({ 'x-user-id': 'u-2', 'x-session-id': 's-2', 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy' });
  });

  test('BSL050_빈_scope는_빈_값이거나_머리가_없다', () => {
    const out = identityHeadersOf(upstreamRequestHeaders({}, { upstreamHost: UPSTREAM_HOST, identity: { sub: 'u-3', sid: 's-3', scope: '' }, clientIp: '10.0.0.9' }));
    const { 'x-user-scope': scope, ...rest } = out;
    expect(rest).toEqual({ 'x-user-id': 'u-3', 'x-session-id': 's-3', 'x-user-aud': 'fan' });
    expect([undefined, '']).toContain(scope);
  });

  test('BSL050_업그레이드_요청은_Connection_Upgrade와_WebSocket_머리와_Origin을_남긴다 [ASVS v5.0.0-4.4.1]', () => {
    const incoming: IncomingHttpHeaders = {
      host: 'gateway.peaket.local:8443',
      connection: 'keep-alive, Upgrade, X-Hop-Secret',
      'x-hop-secret': 'only-for-this-hop',
      'x-real-ip': '6.6.6.6',
      forwarded: 'for=6.6.6.6',
      'x-forwarded-proto': 'ws',
      'x-forwarded-for': '6.6.6.6',
      'x-user-pid': 'forged-pid',
      baggage: 'userId=alice',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'peaket.v0',
      'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
      origin: 'https://www.peaket.local',
      cookie: '__Secure-peaket_at=tok',
      'x-user-id': 'forged',
      'x-session-id': 'forged',
      traceparent: '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01',
    };
    const out = lowerKeys(upstreamRequestHeaders(incoming, { upstreamHost: UPSTREAM_HOST, identity: { sub: 'u-1', sid: 's-1', scope: 'ticket:buy' }, clientIp: '203.0.113.7', upgrade: true }));
    expect(out).toEqual({
      host: UPSTREAM_HOST,
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
      'sec-websocket-version': '13',
      'sec-websocket-protocol': 'peaket.v0',
      'sec-websocket-extensions': 'permessage-deflate; client_max_window_bits',
      origin: 'https://www.peaket.local',
      'x-forwarded-for': '203.0.113.7',
      'x-user-id': 'u-1',
      'x-session-id': 's-1',
      'x-user-aud': 'fan',
      'x-user-scope': 'ticket:buy',
    });
  });

  test('BSL050_업그레이드가_아니면_upgrade_머리를_넘기지_않는다', () => {
    const out = lowerKeys(upstreamRequestHeaders({ connection: 'Upgrade', upgrade: 'websocket', accept: '*/*' }, { upstreamHost: UPSTREAM_HOST, identity: undefined, clientIp: '10.0.0.9' }));
    expect(out).toEqual({ host: UPSTREAM_HOST, accept: '*/*', 'x-forwarded-for': '10.0.0.9' });
  });
});

describe('downstreamResponseHeaders', () => {
  test('BSL050_앱_응답에_HSTS와_nosniff를_덮어쓰고_Cache-Control이_없으면_no-store [ASVS v5.0.0-3.4.1] [ASVS v5.0.0-3.4.4]', () => {
    const out = lowerKeys(
      downstreamResponseHeaders({
        'content-type': 'application/json',
        'content-length': '2',
        etag: '"v1"',
        'x-trace-id': TRACE,
        'set-cookie': ['a=1', 'b=2'],
        'strict-transport-security': 'max-age=0',
        'x-content-type-options': 'sniff',
        connection: 'keep-alive',
        'keep-alive': 'timeout=5',
        'transfer-encoding': 'chunked',
        'proxy-authenticate': 'Basic',
        trailer: 'x-checksum',
        upgrade: 'h2c',
      }),
    );
    expect(out).toEqual({
      'content-type': 'application/json',
      'content-length': '2',
      etag: '"v1"',
      'x-trace-id': TRACE,
      'set-cookie': ['a=1', 'b=2'],
      'strict-transport-security': HSTS_VALUE,
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    });
  });

  test('BSL050_앱이_준_Cache-Control은_그대로_둔다 [ASVS v5.0.0-3.4.1] [ASVS v5.0.0-3.4.4]', () => {
    for (const cacheControl of ['public, max-age=1', 'private, no-store', 'no-cache']) {
      const out = lowerKeys(downstreamResponseHeaders({ 'cache-control': cacheControl }));
      expect(out).toEqual({ 'cache-control': cacheControl, 'strict-transport-security': HSTS_VALUE, 'x-content-type-options': 'nosniff' });
    }
  });

  test('BSL050_빈_앱_응답에도_보안머리를_붙인다 [ASVS v5.0.0-3.4.1] [ASVS v5.0.0-3.4.4]', () => {
    expect(lowerKeys(downstreamResponseHeaders({}))).toEqual({ 'strict-transport-security': HSTS_VALUE, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
  });
});

describe('gatewayProblem', () => {
  const cases = [
    [403, 'Forbidden'],
    [429, 'Too Many Requests'],
    [502, 'Bad Gateway'],
    [504, 'Gateway Timeout'],
  ] as const;

  test('BSL050_입구_오류는_about:blank_Problem과_보안머리와_no-store다 [ASVS v5.0.0-3.4.1] [ASVS v5.0.0-3.4.4]', () => {
    for (const [status, title] of cases) {
      const problem = gatewayProblem(status, TRACE, status === 429 ? 3 : undefined);
      expect(problem.status, title).toBe(status);
      // instance·detail은 싣지 않는다(docs/api/guidelines.md §2 '이름이 아직 없는 HTTP 오류')
      expect(JSON.parse(problem.body), title).toEqual({ type: 'about:blank', title, status, traceId: TRACE });
      const headers = lowerKeys(problem.headers);
      expect(headers['content-type'], title).toMatch(PROBLEM_CONTENT_TYPE);
      expect(headers['strict-transport-security'], title).toBe(HSTS_VALUE);
      expect(headers['x-content-type-options'], title).toBe('nosniff');
      // 입구가 직접 내는 오류는 Cache-Control: no-store를 단다(docs/infra.md §3 'v0 배포' 6)
      expect(headers['cache-control'], title).toBe('no-store');
      if (headers['content-length'] !== undefined) expect(Number(headers['content-length']), title).toBe(Buffer.byteLength(problem.body));
      // 입구 오류는 쿠키를 주지 않는다
      expect(headers['set-cookie'], title).toBeUndefined();
    }
  });

  test('K6_429에만_Retry-After를_단다 [ASVS v5.0.0-2.4.1]', () => {
    expect(String(lowerKeys(gatewayProblem(429, TRACE, 3).headers)['retry-after'])).toBe('3');
    expect(String(lowerKeys(gatewayProblem(429, TRACE, 17).headers)['retry-after'])).toBe('17');
    for (const status of [403, 502, 504] as const) {
      expect(lowerKeys(gatewayProblem(status, TRACE, 5).headers)['retry-after'], String(status)).toBeUndefined();
      expect(lowerKeys(gatewayProblem(status, TRACE).headers)['retry-after'], String(status)).toBeUndefined();
    }
  });

  test('BSL050_traceId는_받은_값을_그대로_싣는다', () => {
    expect(JSON.parse(gatewayProblem(502, 'ffffffffffffffffffffffffffffffff').body).traceId).toBe('ffffffffffffffffffffffffffffffff');
  });
});
