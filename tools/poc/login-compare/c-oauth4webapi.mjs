// 대안 C2: oauth4webapi 3으로 짠 얇은 OIDC 클라이언트(ADR-0119 결정 2, I-T51).
import * as o from 'oauth4webapi';
import * as C from './app-common.mjs';
import * as P from './c-progress.mjs';

const PROVIDERS = new Set(['kakao', 'naver', 'google']);

export async function createApp({ issuer, client: creds, identityUrl, origin, insecure = false, onError = (where, e) => console.error(`로그인 ${where}:`, e) }) {
  const keys = C.appKeys();
  // 시험의 모의 제공자는 http라 PoC에서만 허용한다(운영 제공자는 모두 https)
  const opt = { [o.allowInsecureRequests]: insecure };
  const servers = new Map();
  const server = (p) => {
    if (!servers.has(p)) {
      const iss = new URL(issuer(p));
      servers.set(p, o.discoveryRequest(iss, { algorithm: 'oidc', ...opt }).then((r) => o.processDiscoveryResponse(iss, r)));
      // 실패한 발견 문서 읽기는 기억하지 않는다(일시 장애 한 번으로 그 제공자 로그인이 계속 막히지 않게)
      servers.get(p).catch(() => servers.delete(p));
    }
    return servers.get(p);
  };

  return async (req) => {
    const u = new URL(req.url);
    const [, action, p] = u.pathname.split('/');
    if (u.pathname === '/') return C.home();
    if (action === 'logout' && req.method === 'POST') return C.logout(req, identityUrl, origin(), onError);
    if (!PROVIDERS.has(p)) return new Response('없음', { status: 404 });
    const redirectUri = `${origin()}/callback/${p}`;

    if (action === 'login' && req.method === 'POST') {
      if (!C.sameOrigin(req, origin())) return new Response('출처가 다르다', { status: 403 });
      let as;
      try {
        as = await server(p);
      } catch (e) {
        onError('discovery', e);
        return new Response('지금은 로그인할 수 없다. 잠시 뒤 다시 시도한다', { status: 503 });
      }
      const verifier = o.generateRandomCodeVerifier();
      const state = o.generateRandomState();
      const nonce = o.generateRandomNonce();
      const url = new URL(as.authorization_endpoint);
      for (const [k, v] of Object.entries({
        response_type: 'code', client_id: creds[p].id, redirect_uri: redirectUri, scope: 'openid email', state, nonce,
        code_challenge: await o.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      })) url.searchParams.set(k, v);
      const returnTo = await C.returnToOf(req);
      return C.redirect(url.toString(), [P.progressCookie(P.seal(keys.progress, { p, state, nonce, verifier, returnTo }))]);
    }

    if (action === 'callback' && req.method === 'GET') {
      const prog = P.unseal(keys.progress, C.cookieOf(req, P.PROGRESS));
      if (!prog || prog.p !== p) return P.failed(onError, '로그인 진행 상태가 없다');
      // 콜백 주소는 공개 출처로 다시 만든다(프록시 뒤에서 요청 호스트가 내부 주소여도 인가 때의 redirect_uri와 같게)
      const here = new URL(`${u.pathname}${u.search}`, origin());
      try {
        const as = await server(p);
        const cl = { client_id: creds[p].id };
        const params = o.validateAuthResponse(as, cl, here, prog.state);
        const resp = await o.authorizationCodeGrantRequest(as, cl, o.ClientSecretPost(creds[p].secret), params, redirectUri, prog.verifier, opt);
        const result = await o.processAuthorizationCodeResponse(as, cl, resp, { expectedNonce: prog.nonce, requireIdToken: true });
        // TLS로 받은 ID 토큰도 서명을 확인한다(ASVS v5.0.0-6.8.2. 라이브러리 기본은 보지 않는다)
        await o.validateApplicationLevelSignature(as, resp, opt);
        const claims = o.getValidatedIdTokenClaims(result);
        let profile = { email: claims.email ?? null, emailVerified: claims.email_verified === true };
        if (p === 'naver') {
          const r = await o.protectedResourceRequest(result.access_token, 'GET', new URL(as.userinfo_endpoint), undefined, undefined, opt);
          if (!r.ok) throw new Error(`네이버 사용자 정보 ${r.status}`);
          profile = C.naverProfile(await r.json(), claims.sub);
        }
        const cookies = await C.createSession(identityUrl, keys.idempotency, { provider: p, sub: claims.sub, ...profile, state: prog.state });
        return C.redirect(C.safeReturnTo(prog.returnTo), [P.clearProgress(), ...cookies]);
      } catch (e) {
        return P.failed(onError, e);
      }
    }
    return new Response('없음', { status: 404 });
  };
}
