// 로컬 게이트웨이 대역(docs/features/identity.md §5 '로컬 게이트웨이 대역', BUILD_ORDER BOT-010). local·ci 전용 시험 도구다.
// 로컬에는 gw-fan(Envoy)이 없어, 브라우저가 팬 API 출처로 보낸 요청을 이 대역이 identity-svc로 넘긴다(gw-fan과 같은 규칙만 흉내 낸다).
// - 127.0.0.1에만 묶고 Host가 루프백 이름이 아니면 421(DNS 리바인딩)
// - 팬 액세스 쿠키(__Secure-peaket_at)를 identity 공개키 묶음으로 검증한다: ES256, typ at+jwt, iss, aud fan, exp. 맞으면 신원 머리를 싣는다
//   바깥 요청의 신원 머리(x-user-*·x-session-id, 밑줄 이름 포함)는 늘 지운다. 틀린 토큰은 신원 없이 넘긴다(서비스가 401로 답한다)
// - 소비자 웹 출처 하나에만 자격 증명 포함 CORS를 열고, 쓰기 요청은 Origin이 그 출처가 아니면 403
// - 쿠키는 토큰 갱신 경로(/v1/identity/access-tokens)에만 넘기고, identity가 준 Set-Cookie는 그대로 돌려준다
// - 기본은 /v1/identity/ 경로만 넘긴다. purchaseUrl을 주면 구매 경로(홀드·주문·결제·스냅샷·구매 세션)를 purchase-svc로 넘긴다(BUILD_ORDER HOT-358 리뷰 V2)
//   fallbackUrl을 주면 나머지는 가짜 API로 넘기고, localAdmissionUrl을 주면 POST /v1/local-dev/admission을 그리로 넘긴다(local·ci 전용, 대기실을 거치지 않고 입장 토큰을 받는다)
//   devIdentity를 주면 쿠키가 없는 요청에 그 신원 머리를 싣는다(local·ci 전용, identity-svc 없이 구매 경로를 볼 때)
// - queueUrl을 주면 대기열 API 출처의 /v1/queues/ 경로(진입·입장 확정·추가 검증 등, 로컬에서는 앱 포트가 내는 대기 상태 파일도)를 같은 신원 머리·
//   같은 출처·Origin 규칙으로 queue-svc로 넘긴다(ADR-0259 결정 8). 화면은 대기열 출처 NEXT_PUBLIC_QUEUE_ORIGIN(대기실은 VITE_PEAKET_QUEUE_ORIGIN)에 이 대역 주소를 넣는다
// 실행: PEAKET_ENV=local PEAKET_IDENTITY_HTTP=http://127.0.0.1:<identity 앱 포트> PEAKET_WEB_ORIGIN=http://localhost:3000 \
//       PEAKET_FAN_TOKEN_JWKS_URL=http://127.0.0.1:<identity 앱 포트>/internal/jwks/fan.json PEAKET_TOKEN_ISSUER=… node scripts/local-fan-gateway.mjs [포트]
//       (대기열까지: PEAKET_QUEUE_HTTP=http://127.0.0.1:<queue-svc 앱 포트>)
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createLocalJWKSet, createRemoteJWKSet, jwtVerify } from 'jose';

const ACCESS_COOKIE = '__Secure-peaket_at';
const REFRESH_PATH = '/v1/identity/access-tokens';
const ROUTE = '/v1/identity/';
/** 대기열 API(openapi 호스트 queue). 로컬은 queue-svc 앱 포트가 대기 상태 파일(queue-files)도 낸다 */
const QUEUE_ROUTE = /^\/v1\/queues\/[^/]+\//;
const PURCHASE_ROUTE = /^\/v1\/(holds(\/|$)|orders(\/|$)|events\/[^/]+\/(holds|purchase-session|seatmap-snapshot)(\/|$))/;
const LOCAL_ADMISSION = '/v1/local-dev/admission';
/** 로컬 스택은 좌석맵 파일도 그 판의 좌석 ID로 낸다 */
const LOCAL_LAYOUT = /^\/v1\/events\/[^/]+\/seatmap-layouts\//;
/** 신원 머리: 바깥 요청에서 늘 지운다(앞단이 밑줄을 붙임표로 바꿀 수 있어 밑줄 이름도) */
const IDENTITY_HEADER = /^x[-_]user[-_]|^x[-_]session[-_]id$/i;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host', 'content-length']);
/** 게이트웨이가 정하는 머리: 바깥 값은 지운다(남은 시간·앱 이름·앞단 주소·추적, docs/infra.md 'v0 배포' 입구 2와 같은 갈래) */
const GATEWAY_OWNED = /^(x[-_]peaket[-_]|x[-_]forwarded[-_]|forwarded$|x[-_]real[-_]ip$|traceparent$|tracestate$|baggage$)/i;
/** fetch가 압축을 푼 본문이라 응답에서 뺀다 */
const DECODED = new Set(['content-encoding', 'content-length']);
const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const ID_VALUE = /^[\x21-\x7e]{1,1024}$/;
const SCOPE_VALUE = /^[\x20-\x7e]{0,1024}$/;
const MAX_BODY = 1024 * 1024;

/** @param {string | undefined} header @param {string} name */
function cookieOf(header, name) {
  for (const part of (header ?? '').split(';')) {
    const s = part.trim();
    if (s.startsWith(`${name}=`)) return s.slice(name.length + 1);
  }
  return undefined;
}

/**
 * @param {number} status
 * @param {string} title
 * @param {Record<string, string>} [headers]
 */
const problem = (status, title, headers = {}) => ({
  status,
  headers: { 'content-type': 'application/problem+json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', ...headers },
  body: Buffer.from(JSON.stringify({ type: 'about:blank', title, status })),
});

/**
 * 게이트웨이 대역을 띄운다
 * @param {{ port?: number, identityUrl: string, webOrigin: string, jwks?: import('jose').JSONWebKeySet, jwksUrl?: string, issuer: string, env?: Record<string, string | undefined>, purchaseUrl?: string, queueUrl?: string, fallbackUrl?: string, localAdmissionUrl?: string, devIdentity?: Record<string, string> }} o
 * @returns {Promise<{ url: string, close: () => Promise<void> }>}
 */
export async function startLocalFanGateway(o) {
  const peaketEnv = o.env?.PEAKET_ENV;
  if (peaketEnv !== 'local' && peaketEnv !== 'ci') throw new Error(`게이트웨이 대역은 PEAKET_ENV가 local·ci일 때만 돈다(지금 ${peaketEnv ?? '없음'})`);
  const webOrigin = new URL(o.webOrigin).origin;
  const identity = new URL(o.identityUrl);
  if (!o.jwks && !o.jwksUrl) throw new Error('팬 토큰 공개키 묶음(jwks 또는 jwksUrl)이 없다');
  /** @param {string} pathname */
  const targetOf = (pathname) =>
    (pathname === LOCAL_ADMISSION || LOCAL_LAYOUT.test(pathname)) && o.localAdmissionUrl
      ? new URL(o.localAdmissionUrl)
      : pathname.startsWith(ROUTE)
        ? identity
        : o.purchaseUrl && PURCHASE_ROUTE.test(pathname)
          ? new URL(o.purchaseUrl)
          : o.queueUrl && QUEUE_ROUTE.test(pathname)
            ? new URL(o.queueUrl)
            : o.fallbackUrl
              ? new URL(o.fallbackUrl)
              : undefined;
  const keys = o.jwks ? createLocalJWKSet(o.jwks) : createRemoteJWKSet(new URL(/** @type {string} */ (o.jwksUrl)), { cacheMaxAge: 5 * 60_000, cooldownDuration: 30_000 });

  /** @param {string | undefined} token */
  async function identityOf(token) {
    if (!token) return undefined;
    try {
      const { payload } = await jwtVerify(token, keys, { issuer: o.issuer, audience: 'fan', typ: 'at+jwt', algorithms: ['ES256'] });
      const { sub, sid, scope, pid, pid_prev: pidPrev } = /** @type {Record<string, unknown>} */ (payload);
      if (typeof sub !== 'string' || !ID_VALUE.test(sub) || typeof sid !== 'string' || !ID_VALUE.test(sid)) return undefined;
      if (scope !== undefined && (typeof scope !== 'string' || !SCOPE_VALUE.test(scope))) return undefined;
      if (pid !== undefined && (typeof pid !== 'string' || !ID_VALUE.test(pid))) return undefined;
      if (pidPrev !== undefined && (typeof pidPrev !== 'string' || !ID_VALUE.test(pidPrev))) return undefined;
      /** @type {Record<string, string>} */
      const h = { 'x-user-id': sub, 'x-session-id': sid, 'x-user-aud': 'fan', 'x-user-scope': typeof scope === 'string' ? scope : '' };
      if (typeof pid === 'string') h['x-user-pid'] = pid;
      if (typeof pidPrev === 'string') h['x-user-pid-prev'] = pidPrev;
      return h;
    } catch {
      return undefined;
    }
  }

  /** @param {import('node:http').IncomingMessage} req @param {number} port */
  async function handle(req, port) {
    const host = (req.headers.host ?? '').toLowerCase();
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return problem(421, 'Misdirected Request');
    const url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`);
    const origin = req.headers.origin;
    const allowed = origin === webOrigin;
    /** @type {Record<string, string>} */
    // Date는 gw-fan처럼 노출한다(화면의 보정 시계가 캐시하지 않는 응답의 Date를 표본으로 쓴다, docs/frontend.md §3.3)
    const cors = allowed
      ? { 'access-control-allow-origin': webOrigin, 'access-control-allow-credentials': 'true', 'access-control-expose-headers': 'Date, Retry-After', vary: 'Origin' }
      : { vary: 'Origin' };
    const method = req.method ?? 'GET';
    if (method === 'OPTIONS') {
      if (!allowed) return problem(403, 'Forbidden', cors);
      return {
        status: 204,
        headers: { ...cors, 'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE', 'access-control-allow-headers': 'content-type, idempotency-key, x-reauth-token, x-admission-token, x-purchase-seq, x-purchase-mac, x-client-ephemeral-key', 'access-control-max-age': '600', 'cache-control': 'no-store' },
        body: Buffer.alloc(0),
      };
    }
    if (UNSAFE.has(method) && !allowed) return problem(403, 'Forbidden', cors);
    const upstream = targetOf(url.pathname);
    if (!upstream) return problem(404, 'Not Found', cors);
    // 넘길 곳은 설정한 원본 하나뿐이다. 경로만 바꿔 그 원본 안에 머물게 하고, 다른 출처·사용자 정보가 붙은 주소는 받지 않는다(CodeQL js/request-forgery)
    if ((upstream.protocol !== 'http:' && upstream.protocol !== 'https:') || upstream.username || upstream.password) return problem(400, 'Bad Request', cors);
    const target = new URL(`${url.pathname}${url.search}`, upstream.origin);
    if (target.origin !== upstream.origin) return problem(400, 'Bad Request', cors);
    /** @type {Buffer[]} */
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > MAX_BODY) return problem(413, 'Content Too Large', cors);
      chunks.push(c);
    }
    /** @type {Record<string, string>} */
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined || HOP.has(k) || IDENTITY_HEADER.test(k) || GATEWAY_OWNED.test(k) || k === 'cookie') continue;
      headers[k] = Array.isArray(v) ? v.join(', ') : v;
    }
    if (url.pathname === REFRESH_PATH && req.headers.cookie) headers.cookie = req.headers.cookie;
    // 신원 머리는 위에서 지웠다. 쿠키가 없고 대역 신원을 켰으면 그 값을 싣는다(local·ci 전용)
    Object.assign(headers, (await identityOf(cookieOf(req.headers.cookie, ACCESS_COOKIE))) ?? o.devIdentity ?? {});
    let res;
    try {
      res = await fetch(target, { method, headers, body: ['GET', 'HEAD'].includes(method) ? undefined : Buffer.concat(chunks), redirect: 'manual' });
    } catch {
      return problem(502, 'Bad Gateway', cors);
    }
    /** @type {Record<string, string | string[]>} */
    const out = { ...cors, 'x-content-type-options': 'nosniff' };
    res.headers.forEach((v, k) => {
      if (k !== 'set-cookie' && !HOP.has(k) && !DECODED.has(k) && !k.startsWith('access-control-')) out[k] = v;
    });
    const setCookies = res.headers.getSetCookie();
    if (setCookies.length) out['set-cookie'] = setCookies;
    if (!res.headers.has('cache-control')) out['cache-control'] = 'no-store';
    return { status: res.status, headers: out, body: Buffer.from(await res.arrayBuffer()) };
  }

  /** @type {number} */
  let boundPort = 0;
  const server = createServer((req, res) => {
    handle(req, boundPort).then(
      (r) => {
        res.writeHead(r.status, r.headers);
        res.end(r.body);
      },
      () => {
        const p = problem(500, 'Internal Server Error');
        res.writeHead(p.status, p.headers);
        res.end(p.body);
      },
    );
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(o.port ?? 0, '127.0.0.1', () => resolve(undefined));
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('주소를 얻지 못했다');
  boundPort = addr.port;
  return {
    url: `http://127.0.0.1:${addr.port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const need = (/** @type {string} */ k) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k}이(가) 없다`);
    return v;
  };
  const started = await startLocalFanGateway({
    port: Number(process.argv[2] ?? 18930),
    identityUrl: need('PEAKET_IDENTITY_HTTP'),
    webOrigin: need('PEAKET_WEB_ORIGIN'),
    ...(process.env.PEAKET_LOCAL_DEV_IDENTITY ? { jwks: { keys: [] } } : { jwksUrl: need('PEAKET_FAN_TOKEN_JWKS_URL') }),
    issuer: need('PEAKET_TOKEN_ISSUER'),
    env: process.env,
    ...(process.env.PEAKET_PURCHASE_HTTP ? { purchaseUrl: process.env.PEAKET_PURCHASE_HTTP } : {}),
    ...(process.env.PEAKET_QUEUE_HTTP ? { queueUrl: process.env.PEAKET_QUEUE_HTTP } : {}),
    ...(process.env.PEAKET_MOCK_HTTP ? { fallbackUrl: process.env.PEAKET_MOCK_HTTP } : {}),
    ...(process.env.PEAKET_LOCAL_ADMISSION_HTTP ? { localAdmissionUrl: process.env.PEAKET_LOCAL_ADMISSION_HTTP } : {}),
    ...(process.env.PEAKET_LOCAL_DEV_IDENTITY ? { devIdentity: JSON.parse(process.env.PEAKET_LOCAL_DEV_IDENTITY) } : {}),
  });
  // 소비자 웹의 NEXT_PUBLIC_API_ORIGIN(대기열을 넘기면 NEXT_PUBLIC_QUEUE_ORIGIN·NEXT_PUBLIC_QUEUE_FILES_ORIGIN도)에 이 값을 넣는다(빌드 때 들어간다)
  console.log(`게이트웨이 대역: ${started.url} → ${process.env.PEAKET_IDENTITY_HTTP}`);
}
