// 재현 시험(2026-11-03, BUILD_ORDER BSL-050 kind e2e에서 드러난 입구 결함 둘).
// 1. 앱 쪽 연결은 연결 풀에서 다시 쓰는데, 요청마다 그 소켓에 'close' 듣는 함수를 하나씩 더해 쌓였다(MaxListenersExceededWarning, 메모리 누수)
// 2. 노는 손님 연결을 Node 기본 5초 만에 닫아, 연결을 다시 쓰는 클라이언트(부하 발생기·e2e)가 막 닫힌 연결에 요청을 실어 'socket hang up'을 받았다
import https from 'node:https';
import net from 'node:net';
import tlsMod from 'node:tls';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { fakeClock } from '@peaket/platform';
import { type GatewayConfig } from '../src/gateway/config.js';
import { createV0Gateway, type V0Gateway } from '../src/gateway/server.js';
import { FakeUpstream, ISSUER, defaultUpstreamReply, httpsCall, makeFanKey, parseRawResponse, selfSignedCert, tlsExchange } from './gateway-helpers.js';

const ORIGIN = 'https://127.0.0.1:8443';
let cert = '';
let upstream: FakeUpstream;
let gw: V0Gateway;
let port = 0;

beforeAll(async () => {
  const tls = selfSignedCert();
  cert = tls.cert;
  upstream = await FakeUpstream.start();
  upstream.handler = defaultUpstreamReply;
  const config: GatewayConfig = {
    env: 'local',
    port: 0,
    managementPort: 0,
    upstream: new URL(`http://127.0.0.1:${upstream.port}`),
    tlsCert: tls.cert,
    tlsKey: tls.key,
    jwks: { keys: [makeFanKey('k1').publicJwk] },
    issuer: ISSUER,
    allowedOrigins: [ORIGIN],
    trustedProxyHops: 1,
    ratePerSecond: 1000,
    burst: 1000,
    maxKeys: 1000,
    upstreamTimeoutMs: 20_000,
  };
  gw = createV0Gateway({ config, clock: fakeClock() });
  ({ port } = await gw.listen('127.0.0.1'));
});

afterAll(async () => {
  await gw?.close();
  await upstream?.close();
});

describe('입구 재현 시험', () => {
  test('BSL050_앱쪽연결을다시써도_소켓에듣는함수가쌓이지않는다(재현)', async () => {
    const warnings: string[] = [];
    const onWarning = (w: Error): void => {
      if (w.name === 'MaxListenersExceededWarning') warnings.push(w.message);
    };
    process.on('warning', onWarning);
    try {
      // 앱 쪽은 연결 풀(keep-alive)이라 차례로 보낸 요청이 같은 소켓을 다시 쓴다
      for (let i = 0; i < 25; i += 1) {
        const r = await httpsCall(port, cert, { path: `/reuse/${i}`, headers: { 'x-forwarded-for': '203.0.113.7' } });
        expect(r.status).toBe(200);
      }
      // 경고는 다음 틱에 나온다
      await new Promise((ok) => setTimeout(ok, 50));
    } finally {
      process.off('warning', onWarning);
    }
    expect(warnings).toEqual([]);
  });

  test('BSL050_노는손님연결을_5초넘게두어도닫지않아_다시쓴연결로요청이간다(재현)', { timeout: 20_000 }, async () => {
    const agent = new https.Agent({ keepAlive: true, maxSockets: 1 });
    const once = (path: string): Promise<{ status: number; reused: boolean }> =>
      new Promise((resolve, reject) => {
        const req = https.request({ host: '127.0.0.1', port, path, ca: cert, agent, headers: { 'x-forwarded-for': '203.0.113.8' } }, (res) => {
          res.resume();
          res.on('end', () => resolve({ status: res.statusCode ?? 0, reused: req.reusedSocket }));
        });
        req.on('error', reject);
        req.end();
      });
    try {
      expect((await once('/idle/1')).status).toBe(200);
      // Node http 서버의 기본 유휴 시간(5초)을 넘겨 논다
      await new Promise((ok) => setTimeout(ok, 6_000));
      const second = await once('/idle/2');
      expect(second.status).toBe(200);
      expect(second.reused).toBe(true);
    } finally {
      agent.destroy();
    }
  });
});

// 재현 시험(2026-11-03, 새 맥락 코드 리뷰 높음-1): 입구가 본문 길이 표시(Transfer-Encoding, 또는 Connection에 적힌 Content-Length)를 지워
// 앱이 본문 안에 숨긴 두 번째 요청을 따로 읽었다(요청 밀반입). 앱은 신원 머리를 그대로 믿으므로 다른 사람 신원으로 쓰기를 넣을 수 있었다
describe('입구 재현 시험: 요청 밀반입', () => {
  const smuggled = 'POST /smuggled HTTP/1.1\r\nHost: up\r\nx-user-id: victim\r\nx-session-id: s-victim\r\nx-user-aud: fan\r\ncontent-length: 0\r\n\r\n';

  test('BSL050_Transfer-Encoding본문안에숨긴요청이_앱에따로들어가지않는다(재현) [ASVS v5.0.0-4.1.3]', async () => {
    const chunk = `${Buffer.byteLength(smuggled).toString(16)}\r\n${smuggled}\r\n0\r\n\r\n`;
    const raw = `GET /first-te HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 198.51.100.1\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n${chunk}`;
    const reply = parseRawResponse(await tlsExchange(port, cert, raw));
    expect(reply.status).toBe(200);
    // 앱이 다음 요청을 읽을 틈을 준다
    await httpsCall(port, cert, { path: '/after-te', headers: { 'x-forwarded-for': '198.51.100.2' } });
    expect(upstream.requests.some((r) => r.url === '/smuggled')).toBe(false);
    const first = upstream.requests.find((r) => r.url === '/first-te');
    expect(first?.body).toBe(smuggled);
    expect(first?.headers['x-user-id']).toBeUndefined();
  });

  test.each(['GET', 'DELETE', 'OPTIONS'])(
    'BSL050_%s요청의_Connection에적은Content-Length도지우지않아_숨긴요청이_앱에따로들어가지않는다(재현) [ASVS v5.0.0-4.1.3]',
    async (method) => {
      const path = `/first-cl-${method.toLowerCase()}`;
      const raw = `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nX-Forwarded-For: 198.51.100.3\r\nConnection: close, content-length\r\nContent-Length: ${Buffer.byteLength(smuggled)}\r\n\r\n${smuggled}`;
      const reply = parseRawResponse(await tlsExchange(port, cert, raw));
      expect(reply.status).toBe(200);
      await httpsCall(port, cert, { path: `/after-${method}`, headers: { 'x-forwarded-for': '198.51.100.4' } });
      expect(upstream.requests.some((r) => r.url === '/smuggled')).toBe(false);
      expect(upstream.requests.find((r) => r.url === path)?.body).toBe(smuggled);
    },
  );
});

// 재현 시험(2026-11-03, 새 맥락 코드 리뷰 낮음-2): 손님이 먼저 끊은 요청을 앱 오류(upstream_error)로 셌다
describe('입구 재현 시험: 손님 중단', () => {
  test('BSL050_앱이답하기전에_손님이끊으면_앱오류로세지않는다(재현)', async () => {
    const before = gw.counters().requests.upstream_error;
    upstream.handler = () => undefined; // 답하지 않는다
    try {
      await new Promise<void>((resolve) => {
        const req = https.request({ host: '127.0.0.1', port, path: '/client-abort', ca: cert, agent: false, headers: { 'x-forwarded-for': '198.51.100.9' } });
        req.on('error', () => resolve());
        req.end();
        setTimeout(() => req.destroy(), 300);
      });
      await new Promise((ok) => setTimeout(ok, 200));
    } finally {
      upstream.handler = defaultUpstreamReply;
    }
    expect(gw.counters().requests.upstream_error).toBe(before);
  });
});

// 재현 시험(2026-11-03, 새 맥락 코드 리뷰 낮음-6): 종료(close)가 처리 중인 요청을 바로 끊었다. 유예를 주면 끝까지 답한다
describe('입구 재현 시험: 우아한 종료', () => {
  test('BSL050_유예를준종료는_처리중인요청을끝까지답한뒤닫는다(재현)', { timeout: 15_000 }, async () => {
    const slow = await FakeUpstream.start();
    slow.handler = (_req, res) => {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, 600);
    };
    const tls2 = selfSignedCert();
    const g = createV0Gateway({
      config: {
        env: 'local', port: 0, managementPort: 0, upstream: new URL(`http://127.0.0.1:${slow.port}`), tlsCert: tls2.cert, tlsKey: tls2.key,
        jwks: { keys: [makeFanKey('k2').publicJwk] }, issuer: ISSUER, allowedOrigins: [ORIGIN], trustedProxyHops: 0, ratePerSecond: 100, burst: 100, maxKeys: 100, upstreamTimeoutMs: 20_000,
      },
      clock: fakeClock(),
    });
    const { port: p } = await g.listen('127.0.0.1');
    try {
      const pending = httpsCall(p, tls2.cert, { path: '/slow' });
      await new Promise((ok) => setTimeout(ok, 150)); // 앱에 닿은 뒤
      const closed = g.close(5_000);
      const reply = await pending;
      expect(reply.status).toBe(200);
      expect(reply.body).toBe('{"ok":true}');
      await closed;
    } finally {
      await g.close();
      await slow.close();
    }
  });
});

// 재현 시험(2026-11-03, 새 맥락 코드 리뷰 2차). 앱 대역은 바이트를 그대로 다루는 TCP 서버다

interface RawUpstream {
  port: number;
  /** 지금 열려 있는 앱 쪽 연결 수 */
  open(): number;
  /** 앱이 받은 바이트(연결마다) */
  received: string[];
  close(): Promise<void>;
}

/** 요청 머리를 받으면 reply를 쓰는 TCP 앱(본문은 읽지 않는다) */
async function rawUpstream(reply: string): Promise<RawUpstream> {
  const sockets = new Set<net.Socket>();
  const received: string[] = [];
  const server = net.createServer((s) => {
    sockets.add(s);
    const i = received.push('') - 1;
    let answered = false;
    s.on('data', (c: Buffer) => {
      received[i] += c.toString('latin1');
      if (!answered && received[i]!.includes('\r\n\r\n')) {
        answered = true;
        s.write(reply);
      }
    });
    s.on('error', () => undefined);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  return {
    port: (server.address() as net.AddressInfo).port,
    open: () => sockets.size,
    received,
    close: async () => {
      for (const s of sockets) s.destroy();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

async function gatewayTo(upstreamPort: number): Promise<{ g: V0Gateway; port: number; cert: string }> {
  const t = selfSignedCert();
  const g = createV0Gateway({
    config: {
      env: 'local', port: 0, managementPort: 0, upstream: new URL(`http://127.0.0.1:${upstreamPort}`), tlsCert: t.cert, tlsKey: t.key,
      jwks: { keys: [makeFanKey('k3').publicJwk] }, issuer: ISSUER, allowedOrigins: [ORIGIN], trustedProxyHops: 0, ratePerSecond: 100, burst: 100, maxKeys: 100, upstreamTimeoutMs: 20_000,
    },
    clock: fakeClock(),
  });
  const { port: p } = await g.listen('127.0.0.1');
  return { g, port: p, cert: t.cert };
}

describe('입구 재현 시험: 2차 리뷰', () => {
  test('BSL050_앱이본문을다받기전에답하면_남은본문을버리고_앱쪽연결을닫는다(재현,중간)', { timeout: 15_000 }, async () => {
    const up = await rawUpstream('HTTP/1.1 415 Unsupported Media Type\r\ncontent-length: 0\r\n\r\n');
    const { g, port: p, cert: c } = await gatewayTo(up.port);
    try {
      const raw = await new Promise<string>((resolve) => {
        const sock = tlsMod.connect({ host: '127.0.0.1', port: p, ca: c }, () => sock.write('POST /x HTTP/1.1\r\nHost: x\r\nContent-Type: application/x-weird\r\nContent-Length: 100000\r\n\r\n{"a":'));
        let got = '';
        sock.on('data', (d: Buffer) => {
          got += d.toString('latin1');
          if (got.includes('\r\n\r\n')) sock.destroy();
        });
        sock.on('close', () => resolve(got));
        sock.on('error', () => resolve(got));
      });
      expect(raw.startsWith('HTTP/1.1 415')).toBe(true);
      await new Promise((ok) => setTimeout(ok, 1_000));
      expect(up.open()).toBe(0);
    } finally {
      await g.close();
      await up.close();
    }
  });

  test('BSL050_앱응답상태가200~599밖이면_입구는죽지않고502다(재현)', { timeout: 15_000 }, async () => {
    const up = await rawUpstream('HTTP/1.1 099 X\r\ncontent-length: 2\r\n\r\nok');
    const { g, port: p, cert: c } = await gatewayTo(up.port);
    try {
      const reply = await httpsCall(p, c, { path: '/bad-status' });
      expect(reply.status).toBe(502);
      expect(g.counters().requests.upstream_error).toBe(1);
    } finally {
      await g.close();
      await up.close();
    }
  });

  test('BSL050_종료는_TLS손잡기전연결도기다리지않고닫는다(재현)', { timeout: 15_000 }, async () => {
    const up = await rawUpstream('HTTP/1.1 200 OK\r\ncontent-length: 0\r\n\r\n');
    const { g, port: p } = await gatewayTo(up.port);
    const idle = net.connect(p, '127.0.0.1');
    idle.on('error', () => undefined);
    await new Promise<void>((ok) => idle.once('connect', () => ok()));
    try {
      const started = Date.now();
      await g.close(0);
      expect(Date.now() - started).toBeLessThan(3_000);
    } finally {
      idle.destroy();
      await up.close();
    }
  });

  test('BSL050_처리중인응답이있는연결의_업그레이드는받지않는다(재현)', { timeout: 15_000 }, async () => {
    const up = await rawUpstream('HTTP/1.1 200 OK\r\ncontent-length: 2\r\n\r\nok');
    const { g, port: p, cert: c } = await gatewayTo(up.port);
    try {
      const raw = await tlsExchange(p, c, 'GET /first HTTP/1.1\r\nHost: x\r\n\r\nGET /ws-pipe HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n', 3_000).catch((e: Error) => e.message);
      expect(raw.includes(' 101 ')).toBe(false);
      expect(up.received.some((r) => r.includes('/ws-pipe'))).toBe(false);
    } finally {
      await g.close();
      await up.close();
    }
  });

  test('BSL050_본문을실은업그레이드요청은_400이고앱에보내지않는다(재현)', { timeout: 15_000 }, async () => {
    const up = await rawUpstream('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    const { g, port: p, cert: c } = await gatewayTo(up.port);
    try {
      const raw = await tlsExchange(p, c, 'GET /ws-body HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nContent-Length: 5\r\n\r\nhello', 3_000);
      expect(parseRawResponse(raw).status).toBe(400);
      expect(up.received.length).toBe(0);
    } finally {
      await g.close();
      await up.close();
    }
  });

  test('BSL050_밑줄로쓴신원머리(x_user_id)도_앱에넘기지않는다 [ASVS v5.0.0-4.1.3]', async () => {
    const r = await httpsCall(port, cert, { path: '/underscore', headers: { 'x-forwarded-for': '198.51.100.20', x_user_id: 'victim', x_session_id: 's', x_user_aud: 'fan' } });
    expect(r.status).toBe(200);
    const got = upstream.requests.find((q) => q.url === '/underscore');
    expect(Object.keys(got?.headers ?? {}).filter((k) => /^x_user_|^x_session_id$/.test(k))).toEqual([]);
  });
});
