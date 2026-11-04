// 모의 OIDC 제공자(docs/features/identity.md §12.1 '대역', BUILD_ORDER PRF-020). 로그인 구현 비교 PoC(tools/poc/login-compare/harness.mjs)의 것을 옮기고
// 재인증 흉내(prompt·claims·auth_time)를 더했다. 실제 제공자 앱 등록 없이 로그인 경로를 시험하고 로컬에서 눌러 본다. 로컬·CI 전용이다.
// - 세 제공자를 경로로 나눈다: `${base}/kakao`·`/naver`·`/google`. 발견 문서·JWKS(RS256)·인가(시험 사용자로 바로 동의)·토큰(PKCE S256 확인)·사용자 정보.
// - 네이버 흉내는 ID 토큰에 이메일·auth_time을 싣지 않고, 사용자 정보를 {"resultcode":"00","response":{"id","email"}} 꼴로 준다.
// - auth_time: 카카오는 늘 싣는다(prompt=login이면 지금, 아니면 1시간 전 로그인). 구글은 claims로 요청하고 mode.googleAuthTime이면 1분 전 값을 싣는다.
//   mode.staleAuthTime이면 다시 묻지 않고 통과시킨 것처럼 10분 전 값을 싣는다.
// 실행: node scripts/mock-oidc.mjs [포트]  → 발급자 주소를 출력한다
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const PROVIDERS = ['kakao', 'naver', 'google'];
export const CLIENT = Object.fromEntries(PROVIDERS.map((p) => [p, { id: `peaket-${p}-client`, secret: `${p}-secret-${'x'.repeat(16)}` }]));
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const nowS = () => Math.floor(Date.now() / 1000);

/** 웹 표준 처리기를 Node http 서버로 */
export async function serve(handler, port = 0) {
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) for (const x of [v].flat()) headers.append(k, x);
    const body = ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks);
    let out;
    try {
      out = await handler(new Request(`http://${req.headers.host}${req.url}`, { method: req.method, headers, body }));
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
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((r) => server.close(r)) };
}

export async function startMockOP(port = 0) {
  const keys = {};
  for (const p of PROVIDERS) {
    const { privateKey, publicKey } = await generateKeyPair('RS256');
    keys[p] = { privateKey, jwk: { ...(await exportJWK(publicKey)), kid: `${p}-1`, alg: 'RS256', use: 'sig' } };
  }
  const codes = new Map();
  const tokens = new Map();
  // 시험이 사용자를 바꿀 수 있다(다른 제공자 계정으로 다시 로그인하는 경우)
  const users = { kakao: { sub: '4000001', email: 'fan@kakao.test' }, naver: { sub: 'nv-SUB-77', email: 'fan@naver.test' }, google: { sub: '1100223344', email: 'fan@gmail.test' } };
  // 시험이 바꾸는 동작: wrongIss·wrongAud·badSignature·otherNonce·expired(ID 토큰), naverIdMismatch(사용자 정보 id가 sub와 다름),
  // discoveryIssuer(발견 문서 issuer가 다름), staleAuthTime(다시 묻지 않고 통과), googleAuthTime(구글 콘솔에서 auth_time을 켬)
  const mode = { wrongIss: false, wrongAud: false, naverIdMismatch: false, badSignature: false, otherNonce: false, expired: false, discoveryIssuer: false, staleAuthTime: false, googleAuthTime: true, kakaoUnverified: false, kakaoUserinfoFails: false };
  /** 제공자마다 마지막 인가 요청의 매개변수(시험이 prompt·claims를 본다) */
  const lastAuthorize = {};
  const rogue = await generateKeyPair('RS256');
  let base = '';
  const json = (v, status = 200) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

  const srv = await serve(async (req) => {
    const u = new URL(req.url);
    const [, p, ...rest] = u.pathname.split('/');
    const path = rest.join('/');
    if (!PROVIDERS.includes(p)) return new Response('없음', { status: 404 });
    const iss = `${base}/${p}`;
    if (path === '.well-known/openid-configuration') {
      return json({
        issuer: mode.discoveryIssuer ? `${iss}-other` : iss,
        authorization_endpoint: `${iss}/authorize`,
        token_endpoint: `${iss}/token`,
        jwks_uri: `${iss}/jwks`,
        userinfo_endpoint: `${iss}/userinfo`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
        scopes_supported: ['openid', 'email', 'profile'],
        prompt_values_supported: p === 'google' ? ['none', 'consent', 'select_account'] : ['login', 'none'],
        claims_supported: p === 'naver' ? ['sub', 'nonce', 'iat'] : ['sub', 'email', 'email_verified', 'nonce', 'auth_time'],
      });
    }
    if (path === 'jwks') return json({ keys: [keys[p].jwk] });
    if (path === 'authorize') {
      const q = u.searchParams;
      lastAuthorize[p] = Object.fromEntries(q);
      if (q.get('client_id') !== CLIENT[p].id) return new Response('client_id', { status: 400 });
      if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return new Response('PKCE S256 필요', { status: 400 });
      const code = b64u(randomBytes(24));
      codes.set(code, { p, redirect: q.get('redirect_uri'), nonce: q.get('nonce'), challenge: q.get('code_challenge'), prompt: q.get('prompt'), claims: q.get('claims'), user: { ...users[p] } });
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
      const authTime = (() => {
        if (mode.staleAuthTime) return nowS() - 600;
        if (p === 'kakao') return c.prompt === 'login' ? nowS() : nowS() - 3600;
        if (p === 'google' && mode.googleAuthTime && (c.claims ?? '').includes('auth_time')) return nowS() - 60;
        return undefined;
      })();
      const claims = {
        sub: c.user.sub,
        ...(c.nonce ? { nonce: mode.otherNonce ? `${c.nonce}x` : c.nonce } : {}),
        // 카카오 ID 토큰에는 이메일 검증 여부가 없다(사용자 정보로 준다, identity §2.1 [확인 필요]). 구글은 ID 토큰에 싣는다
        ...(p === 'naver' ? {} : p === 'kakao' ? { email: c.user.email } : { email: c.user.email, email_verified: true }),
        ...(p === 'naver' || authTime === undefined ? {} : { auth_time: authTime }),
      };
      const idToken = await new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: keys[p].jwk.kid })
        .setIssuer(mode.wrongIss ? `${base}/${p === 'kakao' ? 'google' : 'kakao'}` : mode.discoveryIssuer ? `${iss}-other` : iss)
        .setAudience(mode.wrongAud ? 'someone-else' : cid)
        .setIssuedAt(mode.expired ? nowS() - 3600 : undefined)
        .setExpirationTime(mode.expired ? nowS() - 1800 : '5m')
        .sign(mode.badSignature ? rogue.privateKey : keys[p].privateKey);
      const at = b64u(randomBytes(24));
      tokens.set(at, { p, user: c.user });
      return json({ access_token: at, token_type: 'Bearer', expires_in: 600, id_token: idToken, scope: 'openid email' });
    }
    if (path === 'userinfo') {
      const t = tokens.get((req.headers.get('authorization') ?? '').replace(/^Bearer /, ''));
      if (!t || t.p !== p) return json({ error: 'invalid_token' }, 401);
      if (p === 'naver') return json({ resultcode: '00', message: 'success', response: { id: mode.naverIdMismatch ? 'nv-OTHER-1' : t.user.sub, email: t.user.email } });
      if (p === 'kakao' && mode.kakaoUserinfoFails) return json({ error: 'server_error' }, 500);
      return json({ sub: t.user.sub, email: t.user.email, email_verified: !(p === 'kakao' && mode.kakaoUnverified) });
    }
    return new Response('없음', { status: 404 });
  }, port);
  base = srv.url;
  return { ...srv, issuer: (p) => `${base}/${p}`, users, mode, lastAuthorize };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const op = await startMockOP(Number(process.argv[2] ?? 0));
  console.log(`모의 OIDC 제공자: ${PROVIDERS.map((p) => op.issuer(p)).join(' ')}`);
  console.log(`클라이언트: ${JSON.stringify(CLIENT)}`);
}
