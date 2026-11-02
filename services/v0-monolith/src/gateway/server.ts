// v0 입구 서버(docs/infra.md §3 'v0 배포'). HTTPS 하나로 받아 레이트 리밋 → 출처 확인 → 토큰 검증 → 머리 규칙을 거친 뒤 앱(평문 HTTP)으로 넘긴다.
// 레이트 리밋을 맨 앞에 둬 거절할 요청에 서명 검증(비싼 일)을 하지 않는다. 출처로 막은 요청도 토큰을 쓴다.
// WebSocket 업그레이드도 같은 순서를 거쳐 앱과 소켓을 잇는다(wss만, ASVS v5.0.0-4.4.1).
// 관리 포트(평문 HTTP)는 /metrics·/ready·/livez만 답한다.
import { randomBytes } from 'node:crypto';
import http, { type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse, STATUS_CODES } from 'node:http';
import https from 'node:https';
import type { Duplex } from 'node:stream';
import type { AddressInfo, Socket } from 'node:net';
import { type Clock, systemClock } from '@peaket/platform';
import { type GatewayConfig } from './config.js';
import { clientIp, downstreamResponseHeaders, type GatewayProblem, gatewayProblem, needsOriginCheck, originAllowed, upstreamRequestHeaders } from './http-rules.js';
import { IpRateLimiter } from './rate-limit.js';
import { accessTokenFromCookie, createTokenVerifier, type FanIdentity, TOKEN_REJECTIONS, type TokenRejection } from './token.js';

/** 요청 결과(지표 v0_gateway_requests_total{outcome}의 값) */
export type GatewayOutcome = 'forwarded' | 'rate_limited' | 'origin_rejected' | 'upstream_error' | 'upstream_timeout';
export const GATEWAY_OUTCOMES: readonly GatewayOutcome[] = ['forwarded', 'rate_limited', 'origin_rejected', 'upstream_error', 'upstream_timeout'];

export interface V0GatewayOptions {
  config: GatewayConfig;
  /** 시계(토큰 시각·레이트 리밋). 기본 systemClock */
  clock?: Clock;
  /** 입구 오류 Problem의 traceId 만들기(기본: 32자리 16진수 난수) */
  traceId?: () => string;
}

export interface V0GatewayCounters {
  requests: Record<GatewayOutcome, number>;
  tokenRejections: Record<TokenRejection, number>;
}

export interface V0Gateway {
  /** 두 포트를 연다. 설정의 포트가 0이면 운영체제가 고른 포트를 돌려준다 */
  listen(host?: string): Promise<{ port: number; managementPort: number }>;
  /**
   * 새 연결을 받지 않고, 처리 중인 일반 요청이 끝나기를 graceMs(기본 0)까지 기다린 뒤 남은 연결(업그레이드한 소켓 포함)을 닫는다
   */
  close(graceMs?: number): Promise<void>;
  /** 지금까지의 수(시험용) */
  counters(): V0GatewayCounters;
  /** Prometheus 글 형식(/metrics의 본문) */
  metricsText(): string;
}

/** 노는 손님 연결을 두는 시간 [가정](docs/infra.md §3 'v0 배포' 7) */
export const CLIENT_IDLE_TIMEOUT_MS = 65_000;
/** 업그레이드를 거절한 앱 응답 본문을 모으는 상한(그 위는 버리고 끊는다) */
const MAX_REFUSAL_BODY_BYTES = 64 * 1024;

const zeros = <K extends string>(keys: readonly K[]): Record<K, number> => Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;

/** 원시 소켓에 HTTP/1.1 응답 머리를 쓴다(업그레이드 경로) */
function rawHead(status: number, headers: OutgoingHttpHeaders): string {
  const lines = [`HTTP/1.1 ${status} ${STATUS_CODES[status] ?? ''}`];
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${String(one)}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

export function createV0Gateway(options: V0GatewayOptions): V0Gateway {
  const { config } = options;
  const clock = options.clock ?? systemClock;
  const traceId = options.traceId ?? (() => randomBytes(16).toString('hex'));
  const verify = createTokenVerifier({ jwks: config.jwks, issuer: config.issuer, clock });
  const limiter = new IpRateLimiter({ ratePerSecond: config.ratePerSecond, burst: config.burst, maxKeys: config.maxKeys, clock });
  const counters: V0GatewayCounters = { requests: zeros(GATEWAY_OUTCOMES), tokenRejections: zeros(TOKEN_REJECTIONS) };
  const upstreamHost = config.upstream.host;
  const upstreamPort = Number(config.upstream.port || 80);
  /** 열린 소켓(손님 쪽 TLS 연결과 앱 쪽 연결). close()가 모두 닫는다 */
  const sockets = new Set<Duplex>();
  /** 처리 중인 일반 요청 수와, 그것이 0이 되기를 기다리는 종료(close의 유예) */
  let inFlight = 0;
  const drainWaiters: Array<() => void> = [];
  /** 손님 연결마다 아직 답하지 않은 일반 요청 수(이어 보낸 업그레이드가 앞 응답보다 먼저 나가지 않게) */
  const pendingOnSocket = new WeakMap<object, number>();
  /** 종료(close)를 시작했다: 그 뒤에 TLS를 마친 연결은 받지 않는다 */
  let shuttingDown = false;
  // 앱 쪽 연결은 연결 풀에서 다시 쓰므로 같은 소켓이 여러 번 온다. 처음 볼 때만 듣는다(요청마다 더하면 듣는 함수가 쌓인다, 2026-11-03 kind e2e)
  const track = (s: Duplex) => {
    if (sockets.has(s)) return;
    sockets.add(s);
    s.once('close', () => sockets.delete(s));
  };

  type Admission = { ok: true; identity: FanIdentity | undefined; ip: string } | { ok: false; problem: GatewayProblem };

  /** 레이트 리밋 → 출처 → 토큰 순서로 본다. 거절한 요청은 서명 검증(비싼 일)을 하지 않는다 */
  function admit(req: IncomingMessage): Admission {
    const ip = clientIp(req.socket.remoteAddress, req.headers['x-forwarded-for'], config.trustedProxyHops);
    const rate = limiter.take(ip);
    if (!rate.allowed) {
      counters.requests.rate_limited += 1;
      return { ok: false, problem: gatewayProblem(429, traceId(), rate.retryAfterSeconds) };
    }
    const token = accessTokenFromCookie(req.headers.cookie);
    const hasAccessCookie = token !== undefined;
    if (needsOriginCheck(req.method, hasAccessCookie) && !originAllowed(req.headers.origin, config.allowedOrigins)) {
      counters.requests.origin_rejected += 1;
      return { ok: false, problem: gatewayProblem(403, traceId()) };
    }
    let identity: FanIdentity | undefined;
    if (token !== undefined) {
      const result = verify(token);
      if (result.ok) identity = result.identity;
      else counters.tokenRejections[result.reason] += 1;
    }
    return { ok: true, identity, ip };
  }

  function sendProblem(res: ServerResponse, problem: GatewayProblem): void {
    if (res.headersSent) {
      res.destroy();
      return;
    }
    res.writeHead(problem.status, problem.headers);
    res.end(problem.body);
  }

  function onRequest(req: IncomingMessage, res: ServerResponse): void {
    inFlight += 1;
    const clientSocket = req.socket;
    pendingOnSocket.set(clientSocket, (pendingOnSocket.get(clientSocket) ?? 0) + 1);
    res.once('close', () => {
      inFlight -= 1;
      pendingOnSocket.set(clientSocket, Math.max(0, (pendingOnSocket.get(clientSocket) ?? 1) - 1));
      if (inFlight === 0) for (const done of drainWaiters.splice(0)) done();
    });
    const a = admit(req);
    if (!a.ok) {
      // 받지 않은 요청의 본문은 읽어 버린다(앱으로 넘기지 않는다)
      req.resume();
      sendProblem(res, a.problem);
      return;
    }
    const up = http.request({
      host: config.upstream.hostname,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: upstreamRequestHeaders(req.headers, { upstreamHost, identity: a.identity, clientIp: a.ip }),
    });
    let settled = false;
    // 앱의 응답 머리까지만 잰다. 머리를 받은 뒤 본문이 늦는 것은 끊지 않는다
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      counters.requests.upstream_timeout += 1;
      up.destroy();
      sendProblem(res, gatewayProblem(504, traceId()));
    }, config.upstreamTimeoutMs);
    up.on('socket', (s) => track(s));
    up.on('response', (upRes) => {
      if (settled) {
        upRes.resume();
        return;
      }
      settled = true;
      clearTimeout(timer);
      // 앱이 최종 응답이 아닌 상태(1xx)나 HTTP 밖의 상태를 주면 넘기지 않는다(writeHead가 던져 입구가 죽었다, 2026-11-03 코드 리뷰 2차)
      const status = upRes.statusCode ?? 0;
      if (status < 200 || status > 599) {
        counters.requests.upstream_error += 1;
        upRes.resume();
        up.destroy();
        sendProblem(res, gatewayProblem(502, traceId()));
        return;
      }
      counters.requests.forwarded += 1;
      res.writeHead(status, downstreamResponseHeaders(upRes.headers));
      upRes.pipe(res);
      upRes.on('error', () => res.destroy());
    });
    up.on('error', () => {
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      counters.requests.upstream_error += 1;
      sendProblem(res, gatewayProblem(502, traceId()));
    });
    // 손님이 먼저 끊으면 앱 요청도 거둔다. 앱 오류로 세지 않게 먼저 끝난 것으로 둔다(2026-11-03 코드 리뷰)
    res.on('close', () => {
      clearTimeout(timer);
      if (res.writableFinished) {
        // 앱이 본문을 다 받기 전에 답했다(415·413 등): 남은 본문은 버리고 반쯤 쓴 앱 쪽 연결을 닫는다(2026-11-03 코드 리뷰 2차)
        if (!req.complete) {
          req.unpipe(up);
          up.destroy();
          req.resume();
        }
        return;
      }
      settled = true;
      up.destroy();
    });
    req.pipe(up);
  }

  function writeRaw(socket: Duplex, problem: GatewayProblem): void {
    socket.end(rawHead(problem.status, { ...problem.headers, connection: 'close' }) + problem.body);
  }

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    socket.on('error', () => socket.destroy());
    // 같은 연결에 아직 답하지 않은 요청이 있는데 업그레이드가 이어 오면 응답 차례가 깨진다. 받지 않고 연결을 끊는다(2026-11-03 코드 리뷰 2차)
    if ((pendingOnSocket.get(req.socket) ?? 0) > 0) {
      socket.destroy();
      return;
    }
    const a = admit(req);
    if (!a.ok) {
      writeRaw(socket, a.problem);
      return;
    }
    // 업그레이드 요청은 본문이 없어야 한다. 실린 본문은 101 뒤 터널로 새어 앱 쪽과 어긋나므로 400으로 받지 않는다(2026-11-03 코드 리뷰 2차)
    const contentLength = req.headers['content-length'];
    if (req.headers['transfer-encoding'] !== undefined || (contentLength !== undefined && contentLength.trim() !== '0')) {
      writeRaw(socket, gatewayProblem(400, traceId()));
      return;
    }
    const up = http.request({
      host: config.upstream.hostname,
      port: upstreamPort,
      method: req.method,
      path: req.url,
      headers: upstreamRequestHeaders(req.headers, { upstreamHost, identity: a.identity, clientIp: a.ip, upgrade: true }),
      // 업그레이드한 소켓은 연결 풀에 돌려주지 않는다
      agent: false,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      counters.requests.upstream_timeout += 1;
      up.destroy();
      writeRaw(socket, gatewayProblem(504, traceId()));
    }, config.upstreamTimeoutMs);
    up.on('socket', (s) => track(s));
    up.on('upgrade', (upRes, upSocket, upHead) => {
      if (settled) {
        upSocket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      counters.requests.forwarded += 1;
      track(upSocket);
      const headers: OutgoingHttpHeaders = { ...downstreamResponseHeaders(upRes.headers), connection: 'Upgrade' };
      if (upRes.headers.upgrade !== undefined) headers.upgrade = upRes.headers.upgrade;
      // 101 응답에는 본문이 없으므로 no-store를 붙이지 않는다
      if (upRes.headers['cache-control'] === undefined) delete headers['cache-control'];
      socket.write(rawHead(upRes.statusCode ?? 101, headers));
      if (upHead.length > 0) socket.write(upHead);
      if (head.length > 0) upSocket.write(head);
      upSocket.on('error', () => socket.destroy());
      upSocket.on('close', () => socket.destroy());
      socket.on('close', () => upSocket.destroy());
      upSocket.pipe(socket);
      socket.pipe(upSocket);
    });
    // 앱이 업그레이드를 거절했다(401·403 등): 그 응답을 보안 머리와 함께 넘기고 끊는다
    up.on('response', (upRes) => {
      if (settled) {
        upRes.resume();
        return;
      }
      settled = true;
      clearTimeout(timer);
      const refusal = upRes.statusCode ?? 0;
      if (refusal < 200 || refusal > 599) {
        counters.requests.upstream_error += 1;
        upRes.resume();
        up.destroy();
        writeRaw(socket, gatewayProblem(502, traceId()));
        return;
      }
      counters.requests.forwarded += 1;
      const chunks: Buffer[] = [];
      let size = 0;
      upRes.on('data', (c: Buffer) => {
        size += c.length;
        if (size <= MAX_REFUSAL_BODY_BYTES) chunks.push(c);
      });
      upRes.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: OutgoingHttpHeaders = { ...downstreamResponseHeaders(upRes.headers), 'content-length': String(body.length), connection: 'close' };
        socket.end(Buffer.concat([Buffer.from(rawHead(refusal, headers)), body]));
      });
      upRes.on('error', () => socket.destroy());
    });
    up.on('error', () => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      counters.requests.upstream_error += 1;
      writeRaw(socket, gatewayProblem(502, traceId()));
    });
    socket.on('close', () => {
      clearTimeout(timer);
      if (settled) return;
      // 손님이 업그레이드 도중 끊었다: 앱 오류로 세지 않는다
      settled = true;
      up.destroy();
    });
    up.end();
  }

  const server = https.createServer({ cert: config.tlsCert, key: config.tlsKey, minVersion: 'TLSv1.2' }, onRequest);
  // 노는 손님 연결을 65초 [가정]까지 둔다. Node 기본 5초면 연결을 다시 쓰는 클라이언트(부하 발생기 등)가 막 닫힌 연결에 요청을 실어 끊긴다
  // (2026-11-03 kind e2e). 머리 시간 상한은 그보다 길게 둔다
  server.keepAliveTimeout = CLIENT_IDLE_TIMEOUT_MS;
  server.headersTimeout = CLIENT_IDLE_TIMEOUT_MS + 1_000;
  server.on('upgrade', onUpgrade);
  // TLS 손잡기 전 연결도 센다(종료가 기다리지 않고 닫게). 종료를 시작한 뒤에 TLS를 마친 연결은 받지 않는다(2026-11-03 코드 리뷰 2차)
  server.on('connection', (s: Socket) => track(s));
  server.on('secureConnection', (s: Socket) => {
    if (shuttingDown) {
      s.destroy();
      return;
    }
    track(s);
  });
  // TLS 손잡기 실패(평문 HTTP, 낮은 TLS 판)는 그 연결만 닫는다
  server.on('tlsClientError', (_err, s) => s.destroy());

  function metricsText(): string {
    const lines = [
      '# HELP v0_gateway_requests_total v0 입구 요청 결과(앱에 넘김·레이트 리밋·출처 거절·앱 오류·앱 시간 초과)',
      '# TYPE v0_gateway_requests_total counter',
      ...GATEWAY_OUTCOMES.map((o) => `v0_gateway_requests_total{outcome="${o}"} ${counters.requests[o]}`),
      '# HELP v0_gateway_token_rejections_total v0 입구가 거절한 액세스 토큰 수(까닭별)',
      '# TYPE v0_gateway_token_rejections_total counter',
      ...TOKEN_REJECTIONS.map((r) => `v0_gateway_token_rejections_total{reason="${r}"} ${counters.tokenRejections[r]}`),
    ];
    return `${lines.join('\n')}\n`;
  }

  const management = http.createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && path === '/metrics') {
      res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
      res.end(metricsText());
      return;
    }
    // 준비·생존: 입구는 시작 작업이 없다. 떠서 관리 포트가 열렸으면 준비다(공유 의존성을 보지 않는다)
    if (req.method === 'GET' && path === '/ready') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"status":"ready"}');
      return;
    }
    if (req.method === 'GET' && path === '/livez') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end('{"status":"live"}');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
  });
  management.on('connection', (s: Socket) => track(s));

  const listenOn = (srv: http.Server | https.Server, port: number, host: string) =>
    new Promise<number>((resolve, reject) => {
      srv.once('error', reject);
      srv.listen(port, host, () => {
        srv.off('error', reject);
        resolve((srv.address() as AddressInfo).port);
      });
    });

  return {
    async listen(host = '0.0.0.0') {
      const port = await listenOn(server, config.port, host);
      const managementPort = await listenOn(management, config.managementPort, host);
      return { port, managementPort };
    },
    async close(graceMs = 0) {
      shuttingDown = true;
      const closing = [server, management].map(
        (srv) =>
          new Promise<void>((resolve) => {
            if (!srv.listening) {
              resolve();
              return;
            }
            srv.close(() => resolve());
          }),
      );
      // 노는 연결은 바로 닫고, 처리 중인 요청(동기 결제 체인 등)은 유예 안에서 끝나기를 기다린다(2026-11-03 코드 리뷰)
      server.closeIdleConnections();
      management.closeIdleConnections();
      if (graceMs > 0 && inFlight > 0) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, graceMs);
          drainWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
        });
      }
      for (const s of sockets) s.destroy();
      sockets.clear();
      server.closeAllConnections();
      management.closeAllConnections();
      await Promise.all(closing);
    },
    counters: () => ({ requests: { ...counters.requests }, tokenRejections: { ...counters.tokenRejections } }),
    metricsText,
  };
}
