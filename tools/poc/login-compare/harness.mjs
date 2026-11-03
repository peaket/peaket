// I-T51 PoC 공용 대역(docs/features/identity.md §12.1): 웹 표준 요청·응답을 Node http에 잇는 서버, 쿠키 모음을 가진 브라우저 흉내,
// 세 제공자를 흉내 내는 모의 OIDC 제공자, identity-svc 세션 대역. 네 구현(A1·A2·C1·C2)이 같이 쓰고 코드 줄 수(기준 ③)에는 넣지 않는다.
import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

// ---- 웹 표준 처리기를 Node http 서버로 ----
export async function serve(handler) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const url = `http://${req.headers.host}${req.url}`;
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) for (const x of [v].flat()) headers.append(k, x);
    let out;
    try {
      out = await handler(new Request(url, { method: req.method, headers, body }));
    } catch (e) {
      out = new Response(`처리기 오류: ${e?.message}`, { status: 500 });
    }
    const h = {};
    out.headers.forEach((v, k) => {
      if (k !== 'set-cookie') h[k] = v;
    });
    const cookies = out.headers.getSetCookie();
    if (cookies.length) h['set-cookie'] = cookies;
    res.writeHead(out.status, h);
    res.end(Buffer.from(await out.arrayBuffer()));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

// ---- 브라우저 흉내: 쿠키 모음(이름·경로·만료만 본다. 시험은 http라 Secure는 보지 않는다) ----
export class Browser {
  constructor() {
    this.jar = new Map(); // `${host}|${path}|${name}` → { name, value, host, path }
  }
  store(url, setCookies) {
    const host = new URL(url).host;
    for (const sc of setCookies) {
      const [pair, ...attrs] = sc.split(';').map((s) => s.trim());
      const i = pair.indexOf('=');
      const name = pair.slice(0, i);
      const value = pair.slice(i + 1);
      const a = Object.fromEntries(attrs.map((x) => { const j = x.indexOf('='); return j < 0 ? [x.toLowerCase(), true] : [x.slice(0, j).toLowerCase(), x.slice(j + 1)]; }));
      const path = a.path ?? '/';
      const key = `${host}|${path}|${name}`;
      const expired = a['max-age'] !== undefined ? Number(a['max-age']) <= 0 : a.expires && Date.parse(a.expires) <= Date.now();
      if (expired || value === '') this.jar.delete(key);
      else this.jar.set(key, { name, value, host, path, attrs: a });
    }
  }
  cookieHeader(url) {
    const u = new URL(url);
    return [...this.jar.values()].filter((c) => c.host === u.host && u.pathname.startsWith(c.path)).map((c) => `${c.name}=${c.value}`).join('; ');
  }
  /** 쿠키 모음과 함께 요청하고, follow면 같은 브라우저로 리디렉션을 따라간다. 지나간 주소를 돌려준다 */
  async go(url, { method = 'GET', headers = {}, body, follow = true, max = 10 } = {}) {
    const trail = [];
    for (let n = 0; n < max; n++) {
      const h = new Headers(headers);
      const ck = this.cookieHeader(url);
      if (ck) h.set('cookie', ck);
      const r = await fetch(url, { method, headers: h, body, redirect: 'manual' });
      this.store(url, r.headers.getSetCookie());
      trail.push({ url, status: r.status });
      const loc = r.headers.get('location');
      if (!follow || !loc || ![301, 302, 303, 307, 308].includes(r.status)) return { res: r, text: await r.text(), trail, url };
      url = new URL(loc, url).toString();
      method = 'GET';
      body = undefined;
      headers = {};
    }
    throw new Error('리디렉션이 너무 많다');
  }
  names(host) {
    return [...this.jar.values()].filter((c) => !host || c.host === host).map((c) => c.name).sort();
  }
}

// ---- 모의 OIDC 제공자: 세 제공자를 경로로 나눈다 ----
export const PROVIDERS = ['kakao', 'naver', 'google'];
export const CLIENT = Object.fromEntries(PROVIDERS.map((p) => [p, { id: `peaket-${p}-client`, secret: `${p}-secret-${'x'.repeat(16)}` }]));
const b64u = (buf) => Buffer.from(buf).toString('base64url');

export async function startMockOP() {
  const keys = {};
  for (const p of PROVIDERS) {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    keys[p] = { privateKey, jwk: { ...(await exportJWK(publicKey)), kid: `${p}-1`, alg: 'RS256', use: 'sig' } };
  }
  const codes = new Map();
  const tokens = new Map();
  const users = { kakao: { sub: '4000001', email: 'fan@kakao.test' }, naver: { sub: 'nv-SUB-77', email: 'fan@naver.test' }, google: { sub: '1100223344', email: 'fan@gmail.test' } };
  // 시험이 바꾸는 동작: wrongIss·wrongAud·badSignature(ID 토큰), naverIdMismatch(사용자 정보 id가 sub와 다름)
  // badSignature: 제공자 JWKS에 없는 키로 서명(같은 kid). otherNonce: 받은 것과 다른 nonce. expired: 이미 만료된 ID 토큰.
  // discoveryIssuer: 발견 문서의 issuer가 설정한 issuer와 다름
  const mode = { wrongIss: false, wrongAud: false, naverIdMismatch: false, badSignature: false, otherNonce: false, expired: false, discoveryIssuer: false };
  const rogue = await generateKeyPair('RS256');
  let base = '';
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const srv = await serve(async (req) => {
    const u = new URL(req.url);
    const [, p, ...rest] = u.pathname.split('/');
    const path = rest.join('/');
    if (!PROVIDERS.includes(p)) return new Response('없음', { status: 404 });
    const iss = `${base}/${p}`;
    if (path === '.well-known/openid-configuration') {
      return json({
        issuer: mode.discoveryIssuer ? `${iss}-other` : iss, authorization_endpoint: `${iss}/authorize`, token_endpoint: `${iss}/token`, jwks_uri: `${iss}/jwks`, userinfo_endpoint: `${iss}/userinfo`,
        response_types_supported: ['code'], subject_types_supported: ['public'], id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'], token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'], claims_supported: p === 'naver' ? ['sub', 'nonce'] : ['sub', 'email', 'email_verified', 'nonce'],
      });
    }
    if (path === 'jwks') return json({ keys: [keys[p].jwk] });
    if (path === 'authorize') {
      const q = u.searchParams;
      if (q.get('client_id') !== CLIENT[p].id) return new Response('client_id', { status: 400 });
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return new Response('PKCE S256 필요', { status: 400 });
      const code = b64u(randomBytes(24));
      codes.set(code, { p, redirect: q.get('redirect_uri'), nonce: q.get('nonce'), challenge: q.get('code_challenge'), client: q.get('client_id') });
      const back = new URL(q.get('redirect_uri'));
      back.searchParams.set('code', code);
      if (q.get('state') !== null) back.searchParams.set('state', q.get('state'));
      return new Response(null, { status: 302, headers: { location: back.toString() } });
    }
    if (path === 'token' && req.method === 'POST') {
      const f = new URLSearchParams(await req.text());
      let cid = f.get('client_id');
      let secret = f.get('client_secret');
      const auth = req.headers.get('authorization');
      if (auth?.startsWith('Basic ')) [cid, secret] = Buffer.from(auth.slice(6), 'base64').toString().split(':').map(decodeURIComponent);
      if (cid !== CLIENT[p].id || secret !== CLIENT[p].secret) return json({ error: 'invalid_client' }, 401);
      const c = codes.get(f.get('code'));
      codes.delete(f.get('code'));
      if (!c || c.p !== p || c.redirect !== f.get('redirect_uri')) return json({ error: 'invalid_grant' }, 400);
      if (b64u(createHash('sha256').update(f.get('code_verifier') ?? '').digest()) !== c.challenge) return json({ error: 'invalid_grant', error_description: 'PKCE' }, 400);
      const user = users[p];
      const claims = { sub: user.sub, ...(c.nonce ? { nonce: mode.otherNonce ? `${c.nonce}x` : c.nonce } : {}), ...(p === 'naver' ? {} : { email: user.email, email_verified: true }) };
      const idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: keys[p].jwk.kid })
        // discoveryIssuer: ID 토큰도 발견 문서의 가짜 issuer로 낸다(발견 문서 issuer 대조를 빼면 받아들이게)
        .setIssuer(mode.wrongIss ? `${base}/${p === 'kakao' ? 'google' : 'kakao'}` : mode.discoveryIssuer ? `${iss}-other` : iss)
        .setAudience(mode.wrongAud ? 'someone-else' : cid)
        .setIssuedAt(mode.expired ? Math.floor(Date.now() / 1000) - 3600 : undefined)
        .setExpirationTime(mode.expired ? Math.floor(Date.now() / 1000) - 1800 : '5m')
        .sign(mode.badSignature ? rogue.privateKey : keys[p].privateKey);
      const at = b64u(randomBytes(24));
      tokens.set(at, { p, sub: user.sub });
      return json({ access_token: at, token_type: 'Bearer', expires_in: 600, id_token: idToken, scope: 'openid email' });
    }
    if (path === 'userinfo') {
      const t = tokens.get((req.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
      if (!t || t.p !== p) return json({ error: 'invalid_token' }, 401);
      const user = users[p];
      // 네이버 흉내: 실제 네이버 회원 프로필 API처럼 response 안에 id·email을 준다
      if (p === 'naver') return json({ resultcode: '00', message: 'success', response: { id: mode.naverIdMismatch ? 'nv-OTHER-1' : user.sub, email: user.email } });
      return json({ sub: user.sub, email: user.email, email_verified: true });
    }
    return new Response('없음', { status: 404 });
  });
  base = srv.url;
  return { ...srv, issuer: (p) => `${base}/${p}`, users, mode };
}

// ---- identity-svc 세션 대역(SessionService.CreateSession·EndSession과 같은 입력) ----
export async function startIdentityStub() {
  const sessions = new Map();
  const calls = [];
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });
  const srv = await serve(async (req) => {
    const u = new URL(req.url);
    const body = req.method === 'POST' ? await req.json() : {};
    calls.push({ path: u.pathname, body });
    if (u.pathname === '/sessions') {
      for (const k of ['provider', 'providerUserId', 'idempotencyKey']) if (!body[k]) return json({ error: `${k} 없음` }, 400);
      if (body.providerToken || body.idToken || body.accessToken) return json({ error: '제공자 토큰을 받지 않는다' }, 400);
      const id = randomUUID();
      const s = { id, provider: body.provider, sub: body.providerUserId, email: body.email ?? null, active: true, refresh: b64u(randomBytes(32)) };
      sessions.set(id, s);
      return json({ sessionId: id, accessToken: `at.${id}`, refreshToken: `${id}.${s.refresh}` });
    }
    if (u.pathname === '/sessions/end') {
      // 로그아웃: 액세스 토큰(at.<세션 ID>)이나 리프레시 토큰(<세션 ID>.<난수>)으로 그 세션을 끝낸다
      const id = body.accessToken ? String(body.accessToken).replace(/^at\./, '') : String(body.refreshToken ?? '').split('.')[0];
      const s = sessions.get(id);
      if (s) s.active = false;
      return json({ ended: Boolean(s) });
    }
    return json({ error: '없음' }, 404);
  });
  return { ...srv, sessions, calls };
}

/** PEAKET 쿠키(identity 세션 한 층) — 이것 밖의 쿠키가 기준 ①·⑤가 세는 것이다 */
export const PEAKET_COOKIES = ['__Secure-peaket_at', '__Secure-peaket_rt'];
