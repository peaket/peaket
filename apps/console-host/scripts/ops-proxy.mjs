// 관제 API 로컬 넘김(local·ci 전용 시험 도구, ADR-0360 결정 12). 로컬에는 gw-ops(Envoy)가 없어, 콘솔 개발·미리보기 서버가
// 같은 출처의 /v1/ops/ 요청을 실제 서비스 앱 포트로 넘긴다. SSE 흐름 둘도 그대로 흘려보낸다(버퍼에 모으지 않는다).
// - PEAKET_OPS_PROXY_TARGET(예: http://127.0.0.1:3000)이 없으면 켜지 않는다. PEAKET_ENV가 local·ci가 아니면 켜지 않는다
// - 바깥 요청의 신원 머리(x-user-*·x-session-id, 밑줄 이름 포함)와 게이트웨이가 정하는 머리(x-peaket-*·x-forwarded-*)는 늘 지운다
// - PEAKET_IDENTITY_PROXY_TARGET(예: http://127.0.0.1:3001)을 주면 gw-ops 라우트처럼 /v1/ops/auth/* 는 identity-svc로 보내고,
//   GET /v1/ops/auth/sessions/me만 ops-svc로 보낸다(deploy/gateways/routes/gw-ops.yaml의 gw-ops-public·gw-ops-api, F-03-4 계획 '감독에게' 5).
//   그리고 gw-ops의 JWT → 신원 머리 바꾸기를 흉내 낸다(deploy/gateways/gw-ops.yaml SecurityPolicy jwt): 쿠키 __Host-peaket_ops_at 또는
//   Authorization: Bearer의 관리 액세스 토큰(typ at+jwt, ES256)을 identity-svc 공개키 묶음(/internal/jwks/admin.json)으로 확인하고,
//   iss(PEAKET_IDENTITY_ISSUER, 기본 https://identity.peaket.example)·aud ops·exp를 본 뒤 sub·sid·aud·scope·exp를 X-User-Id·X-Session-Id·
//   X-User-Aud·X-User-Scope·X-User-Token-Exp로 싣는다. 토큰 경로에 맞는 토큰이 없으면 gw-ops처럼 401이다(공개 경로는 신원 머리 없이 넘긴다)
// - PEAKET_OPS_DEV_IDENTITY=<관리 계정 ID>:<세션 ID>를 주면 토큰이 없는 요청에 그 신원 머리를 싣는다(로그인 없이 붙여 보는 옛 길, ops-svc가 identity에 역할을 묻는다)
// 운영의 인증·CORS·Origin 확인은 gw-ops가 한다(deploy/gateways/gw-ops.yaml). 이 대역은 그 가운데 경로 나누기와 JWT 머리 바꾸기만 흉내 낸다.
import { request as httpRequest } from 'node:http';
import { createPublicKey, verify as verifySignature } from 'node:crypto';

const IDENTITY_HEADER = /^x[-_]user[-_]|^x[-_]session[-_]id$/i;
const GATEWAY_OWNED = /^(x[-_]peaket[-_]|x[-_]forwarded[-_]|forwarded$|x[-_]real[-_]ip$)/i;
const HOP = new Set(['connection', 'keep-alive', 'proxy-connection', 'transfer-encoding', 'upgrade', 'te', 'trailer', 'host']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** gw-ops가 액세스 토큰을 읽는 쿠키(deploy/gateways/gw-ops.yaml extractFrom.cookies) */
const ACCESS_COOKIE = '__Host-peaket_ops_at';
/** 공개키 묶음 보관 시간(gw-ops remoteJWKS cacheDuration 300s) */
const JWKS_CACHE_MS = 300_000;
/**
 * 토큰 없이 부르는 관제 경로(gw-ops-public 라우트). sessions는 그 경로 하나(Exact), 나머지는 그 경로와 그 아래다.
 * 라우트 원천이 바뀌면 이 목록도 바꾼다(local·ci 대역이라 원천을 읽어 오지 않는다)
 */
const PUBLIC_EXACT = new Set(['/v1/ops/auth/sessions']);
const PUBLIC_PREFIX = [
  '/v1/ops/auth/access-tokens',
  '/v1/ops/auth/unlock-links',
  '/v1/ops/auth/unlocks',
  '/v1/ops/auth/invitation-acceptances',
  '/v1/ops/auth/invitation-completions',
  '/v1/ops/auth/invitation-passkey-registrations',
  '/v1/ops/auth/invitation-passkeys',
  '/v1/ops/auth/invitation-passwords',
  '/v1/ops/auth/invitation-totp-confirmations',
  '/v1/ops/auth/invitation-totp-enrollments',
  '/v1/ops/audit-anchors',
];

const under = (path, prefix) => path === prefix || path.startsWith(`${prefix}/`);

/** 토큰 없이 넘기는 경로인가 */
export function isPublicOpsPath(path) {
  return PUBLIC_EXACT.has(path) || PUBLIC_PREFIX.some((p) => under(path, p));
}

/** identity-svc가 처리하는 경로인가: /v1/ops/auth/* 가운데 GET /v1/ops/auth/sessions/me(ops-svc)만 뺀다(gw-ops 라우트, BAT-045 리뷰 W-03) */
export function isIdentityOpsPath(method, path) {
  if (!under(path, '/v1/ops/auth')) return false;
  return !(path === '/v1/ops/auth/sessions/me' && (method === 'GET' || method === 'HEAD'));
}

function loopbackBase(target, name) {
  const base = new URL(target);
  if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) throw new Error(`${name}은(는) 루프백 http 주소여야 한다: ${target}`);
  return base;
}

/** 요청의 관리 액세스 토큰(쿠키 → Bearer 차례, gw-ops extractFrom) */
function accessTokenOf(req) {
  const cookie = req.headers.cookie;
  if (typeof cookie === 'string') {
    for (const part of cookie.split(';')) {
      const i = part.indexOf('=');
      if (i > 0 && part.slice(0, i).trim() === ACCESS_COOKIE) return part.slice(i + 1).trim();
    }
  }
  const auth = req.headers.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return undefined;
}

const b64json = (s) => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

/**
 * 관리 액세스 토큰을 확인하고 신원 머리를 돌려준다. 맞지 않으면 undefined
 * @param {string} token
 * @param {(kid: string) => Promise<import('node:crypto').JsonWebKey | undefined>} keyOf
 * @param {{ issuer: string; nowMs: number }} o
 */
export async function identityHeadersOf(token, keyOf, o) {
  const parts = token.split('.');
  if (parts.length !== 3) return undefined;
  let header;
  let claims;
  try {
    header = b64json(parts[0]);
    claims = b64json(parts[1]);
  } catch {
    return undefined;
  }
  // 재인증 토큰(reauth+jwt)은 액세스 토큰 자리에 쓰지 않는다(gw-ops 토큰 유형 확인)
  if (header?.alg !== 'ES256' || header.typ !== 'at+jwt' || typeof header.kid !== 'string') return undefined;
  const jwk = await keyOf(header.kid);
  if (!jwk) return undefined;
  let ok = false;
  try {
    ok = verifySignature('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: createPublicKey({ key: jwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' }, Buffer.from(parts[2], 'base64url'));
  } catch {
    return undefined;
  }
  if (!ok || !claims || typeof claims !== 'object') return undefined;
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== o.issuer || !aud.includes('ops')) return undefined;
  if (typeof claims.exp !== 'number' || claims.exp * 1000 <= o.nowMs) return undefined;
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 > o.nowMs) return undefined;
  if (typeof claims.sub !== 'string' || typeof claims.sid !== 'string' || !UUID.test(claims.sub) || !UUID.test(claims.sid)) return undefined;
  return {
    'x-user-id': claims.sub,
    'x-session-id': claims.sid,
    'x-user-aud': 'ops',
    'x-user-scope': typeof claims.scope === 'string' ? claims.scope : '',
    'x-user-token-exp': String(claims.exp),
  };
}

/** identity-svc 관리 공개키 묶음을 읽어 kid로 찾는다(5분 보관, 모르는 kid면 한 번 다시 읽는다) */
function jwksReader(base) {
  let cache = { at: 0, keys: [] };
  const load = async () => {
    const r = await fetch(new URL('/internal/jwks/admin.json', base), { redirect: 'error' });
    if (!r.ok) throw new Error(`관리 공개키 묶음을 읽지 못했다(${r.status})`);
    const body = await r.json();
    cache = { at: Date.now(), keys: Array.isArray(body?.keys) ? body.keys : [] };
  };
  return async (kid) => {
    try {
      if (Date.now() - cache.at > JWKS_CACHE_MS) await load();
      let k = cache.keys.find((x) => x.kid === kid);
      if (!k) {
        await load();
        k = cache.keys.find((x) => x.kid === kid);
      }
      return k;
    } catch {
      return undefined;
    }
  };
}

const UNAUTHORIZED = '{"type":"https://peaket.example/problems/unauthorized","title":"로그인이 필요합니다","status":401}';

/**
 * 환경 값으로 넘김 처리기를 만든다. 켜지 않으면 undefined
 * @param {Record<string, string | undefined>} env
 * @returns {((req: import('node:http').IncomingMessage & { originalUrl?: string }, res: import('node:http').ServerResponse, next?: () => void) => void) | undefined}
 */
export function opsProxyMiddleware(env) {
  const target = env.PEAKET_OPS_PROXY_TARGET?.trim();
  if (!target) return undefined;
  const peaketEnv = env.PEAKET_ENV ?? 'local';
  if (peaketEnv !== 'local' && peaketEnv !== 'ci') throw new Error(`관제 API 로컬 넘김은 local·ci 전용이다(PEAKET_ENV=${peaketEnv})`);
  const opsBase = loopbackBase(target, 'PEAKET_OPS_PROXY_TARGET');
  const identityTarget = env.PEAKET_IDENTITY_PROXY_TARGET?.trim();
  const identityBase = identityTarget ? loopbackBase(identityTarget, 'PEAKET_IDENTITY_PROXY_TARGET') : undefined;
  const issuer = env.PEAKET_IDENTITY_ISSUER?.trim() || 'https://identity.peaket.example';
  const keyOf = identityBase ? jwksReader(identityBase) : undefined;
  let devIdentity;
  if (env.PEAKET_OPS_DEV_IDENTITY) {
    const [accountId, sessionId] = env.PEAKET_OPS_DEV_IDENTITY.split(':');
    if (!UUID.test(accountId ?? '') || !UUID.test(sessionId ?? '')) throw new Error('PEAKET_OPS_DEV_IDENTITY는 <관리 계정 UUID>:<세션 UUID>다');
    devIdentity = { 'x-user-id': accountId, 'x-session-id': sessionId, 'x-user-aud': 'ops', 'x-user-scope': '' };
  }

  /** 이 요청에 실을 신원 머리. null이면 401로 끝낸다 */
  async function identityFor(req, path) {
    if (isPublicOpsPath(path)) return {};
    const token = keyOf ? accessTokenOf(req) : undefined;
    if (token) {
      const h = await identityHeadersOf(token, keyOf, { issuer, nowMs: Date.now() });
      // 실린 토큰이 틀리면 옛 개발 신원으로 바꾸지 않는다(gw-ops는 401)
      return h ?? null;
    }
    if (devIdentity) return devIdentity;
    // identity 갈래를 켰으면 gw-ops처럼 토큰 없는 토큰 경로는 막는다. 켜지 않았으면 옛 동작 그대로(서비스가 401을 준다)
    return identityBase ? null : {};
  }

  return (req, res) => {
    const url = req.originalUrl ?? req.url ?? '/';
    if (!url.startsWith('/v1/ops/') && url !== '/v1/ops') {
      res.statusCode = 404;
      res.end();
      return;
    }
    const path = url.split('?')[0];
    const method = (req.method ?? 'GET').toUpperCase();
    const base = identityBase && isIdentityOpsPath(method, path) ? identityBase : opsBase;
    // 본문은 신원 확인(비동기)이 끝날 때까지 멈춰 둔다
    req.pause();
    void identityFor(req, path).then((identity) => {
      if (identity === null) {
        res.writeHead(401, { 'content-type': 'application/problem+json', 'www-authenticate': 'Bearer' });
        res.end(UNAUTHORIZED);
        req.resume();
        return;
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (v === undefined || HOP.has(k) || IDENTITY_HEADER.test(k) || GATEWAY_OWNED.test(k)) continue;
        headers[k] = v;
      }
      // gw-ops처럼 x-peaket-app·x-forwarded-for를 정한다(deploy/gateways/routes/gw-ops.yaml RequestHeaderModifier)
      Object.assign(headers, identity, { 'x-peaket-app': 'console', 'x-forwarded-for': (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, '') });
      const up = httpRequest({ host: base.hostname.replace(/^\[|\]$/g, ''), port: base.port || 80, method: req.method, path: url, headers }, (r) => {
        const out = {};
        for (const [k, v] of Object.entries(r.headers)) if (v !== undefined && !HOP.has(k)) out[k] = v;
        res.writeHead(r.statusCode ?? 502, out);
        // SSE는 조각마다 바로 내보낸다
        r.on('data', (c) => res.write(c));
        r.on('end', () => res.end());
      });
      up.on('error', () => {
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/problem+json' });
        res.end('{"type":"https://peaket.example/problems/upstream-unavailable","title":"관제 API에 닿지 못했습니다","status":502}');
      });
      // 브라우저가 끊으면 위로도 끊는다(SSE 흐름 닫힘)
      res.on('close', () => up.destroy());
      req.pipe(up);
    });
  };
}
