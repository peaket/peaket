// 시험용 게이트웨이 대역(docs/features/seat-hold.md §14 '로컬 실행'). 로컬 브라우저 확인에서만 쓴다.
// 브라우저에는 게이트웨이가 없어 신원 머리(x-user-*·x-session-id)를 실을 수 없다. 이 대역이 시험 계정 쿠키를 신원 머리로 바꿔 v0 모놀리스에 넘긴다.
// - PEAKET_ENV가 local일 때만, 127.0.0.1에만 묶는다. Host가 루프백 주소가 아니면 받지 않는다(DNS 리바인딩)
// - 브라우저가 보낸 신원 머리(x-user-*, x-session-id)는 늘 지운다
// - GET /__as/<이름>?next=<경로>: 시험 계정 쿠키(v0_test_as)를 심고 next로 보낸다(같은 사이트 안 경로만)
// - WebSocket 업그레이드도 같은 방식으로 머리를 바꿔 넘긴다
// 쓰는 법: PEAKET_ENV=local V0_UPSTREAM=http://127.0.0.1:8080 V0_GATEWAY_PORT=8088 node scripts/local-gateway.mjs
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const NAME = /^[A-Za-z0-9_-]{1,32}$/;
const COOKIE = 'v0_test_as';
/** 게이트웨이가 넘기는 신원 머리. 브라우저가 보낸 같은 이름은 지운다 */
const IDENTITY = /^(x-user-|x-session-id$)/;

/**
 * 시험 계정 이름 → 신원 머리(게이트웨이가 토큰을 검증한 뒤 넘기는 머리, docs/features/identity.md §3)
 * @param {string} name
 */
export function identityHeaders(name) {
  return { 'x-user-id': `acc-${name}`, 'x-session-id': `s-${name}`, 'x-user-aud': 'fan', 'x-user-scope': 'ticket:buy', 'x-user-pid': `pid-${name}` };
}

/**
 * 쿠키 머리에서 시험 계정 이름
 * @param {string | undefined} cookie
 */
export function accountFromCookie(cookie) {
  for (const part of (cookie ?? '').split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE && v && NAME.test(v)) return v;
  }
  return undefined;
}

/**
 * 넘길 머리: 브라우저의 신원 머리를 지우고 시험 계정이 있으면 신원 머리를 더한다
 * @param {import('node:http').IncomingHttpHeaders} headers
 * @param {string} upstreamHost
 */
export function forwardHeaders(headers, upstreamHost) {
  /** @type {Record<string, string | string[]>} */
  const out = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !IDENTITY.test(k)) out[k] = v;
  out.host = upstreamHost;
  const name = accountFromCookie(typeof headers.cookie === 'string' ? headers.cookie : undefined);
  if (name) Object.assign(out, identityHeaders(name));
  return out;
}

/**
 * 시험 계정 고르기 뒤 갈 경로. 같은 사이트의 경로와 쿼리만 받는다(\·탭·제어 문자·다른 출처는 거절, 열린 리디렉트 방지)
 * @param {string | null} next
 * @returns {string | undefined}
 */
export function safeNext(next) {
  if (typeof next !== 'string' || !next.startsWith('/') || /[\\\u0000-\u001f\u007f]/.test(next)) return undefined;
  try {
    const u = new URL(next, 'http://local');
    // 정리한 경로가 //나 /\로 시작하면 브라우저는 다른 출처로 읽는다(/..//evil 같은 입력, 2차 리뷰)
    if (u.origin !== 'http://local' || u.pathname.startsWith('//') || u.pathname.startsWith('/\\')) return undefined;
    return u.pathname + u.search;
  } catch {
    return undefined;
  }
}

/**
 * /__as/<이름> 경로의 이름. 깨진 퍼센트 인코딩이나 형식이 틀린 이름은 undefined(던지지 않는다)
 * @param {string} pathname
 * @returns {string | undefined}
 */
export function parseAsPath(pathname) {
  const m = /^\/__as\/([^/]+)$/.exec(pathname);
  if (!m) return undefined;
  try {
    const name = decodeURIComponent(m[1] ?? '');
    return NAME.test(name) ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Host 머리가 이 대역의 루프백 주소인지(DNS 리바인딩으로 다른 사이트가 닿는 것을 막는다)
 * @param {string | undefined} host
 * @param {number} port
 */
export function hostAllowed(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * @param {{ upstream: URL, port: number }} o
 */
export function startLocalGateway(o) {
  if (process.env.PEAKET_ENV !== 'local') throw new Error('게이트웨이 대역은 PEAKET_ENV=local에서만 돈다');
  const server = http.createServer((req, res) => {
    if (!hostAllowed(req.headers.host, o.port)) {
      res.writeHead(421).end();
      return;
    }
    const url = new URL(req.url ?? '/', 'http://local');
    if (url.pathname.startsWith('/__as/')) {
      const name = parseAsPath(url.pathname);
      const next = safeNext(url.searchParams.get('next') ?? '/');
      if (!name || !next) {
        res.writeHead(400).end();
        return;
      }
      res.writeHead(302, { 'set-cookie': `${COOKIE}=${name}; Path=/; HttpOnly; SameSite=Strict`, location: next }).end();
      return;
    }
    const up = http.request(
      { host: o.upstream.hostname, port: o.upstream.port, method: req.method, path: req.url, headers: forwardHeaders(req.headers, o.upstream.host) },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(up);
  });
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {});
    if (!hostAllowed(req.headers.host, o.port)) {
      socket.destroy();
      return;
    }
    const up = net.connect(Number(o.upstream.port), o.upstream.hostname, () => {
      const headers = forwardHeaders(req.headers, o.upstream.host);
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (const [k, v] of Object.entries(headers)) for (const one of Array.isArray(v) ? v : [v]) lines.push(`${k}: ${one}`);
      up.write(`${lines.join('\r\n')}\r\n\r\n`);
      if (head.length > 0) up.write(head);
      up.pipe(socket);
      socket.pipe(up);
    });
    up.on('error', () => socket.destroy());
    socket.on('close', () => up.destroy());
  });
  server.listen(o.port, '127.0.0.1');
  return server;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const upstream = new URL(process.env.V0_UPSTREAM ?? 'http://127.0.0.1:8080');
  const port = Number(process.env.V0_GATEWAY_PORT ?? 8088);
  startLocalGateway({ upstream, port });
  console.log(`게이트웨이 대역: http://127.0.0.1:${port} → ${upstream.origin}. 시험 계정 고르기: /__as/<이름>?next=/v0/seatmap/<회차>`);
}
