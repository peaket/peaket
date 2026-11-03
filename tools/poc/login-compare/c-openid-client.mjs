// 대안 C1: openid-client 6으로 짠 얇은 OIDC 클라이언트(ADR-0119 결정 2, I-T51).
import * as client from 'openid-client';
import * as C from './app-common.mjs';
import * as P from './c-progress.mjs';

const PROVIDERS = new Set(['kakao', 'naver', 'google']);

export async function createApp({ issuer, client: creds, identityUrl, origin, insecure = false, onError = (where, e) => console.error(`로그인 ${where}:`, e) }) {
  const keys = C.appKeys();
  const configs = new Map();
  const config = (p) => {
    if (!configs.has(p)) {
      configs.set(p, (async () => {
        // 시험의 모의 제공자는 http라 PoC에서만 허용한다(운영 제공자는 모두 https)
        const c = await client.discovery(new URL(issuer(p)), creds[p].id, creds[p].secret, undefined, insecure ? { execute: [client.allowInsecureRequests] } : undefined);
        // TLS로 받은 ID 토큰도 서명을 확인한다(ASVS v5.0.0-6.8.2. 라이브러리 기본은 보지 않는다)
        client.enableNonRepudiationChecks(c);
        return c;
      })());
      // 실패한 발견 문서 읽기는 기억하지 않는다(일시 장애 한 번으로 그 제공자 로그인이 계속 막히지 않게)
      configs.get(p).catch(() => configs.delete(p));
    }
    return configs.get(p);
  };

  return async (req) => {
    const u = new URL(req.url);
    const [, action, p] = u.pathname.split('/');
    if (u.pathname === '/') return C.home();
    if (action === 'logout' && req.method === 'POST') return C.logout(req, identityUrl, origin(), onError);
    if (!PROVIDERS.has(p)) return new Response('없음', { status: 404 });

    if (action === 'login' && req.method === 'POST') {
      if (!C.sameOrigin(req, origin())) return new Response('출처가 다르다', { status: 403 });
      let c;
      try {
        c = await config(p);
      } catch (e) {
        onError('discovery', e);
        return new Response('지금은 로그인할 수 없다. 잠시 뒤 다시 시도한다', { status: 503 });
      }
      const verifier = client.randomPKCECodeVerifier();
      const state = client.randomState();
      const nonce = client.randomNonce();
      const url = client.buildAuthorizationUrl(c, {
        redirect_uri: `${origin()}/callback/${p}`, scope: 'openid email', state, nonce,
        code_challenge: await client.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256',
      });
      const returnTo = await C.returnToOf(req);
      return C.redirect(url.toString(), [P.progressCookie(P.seal(keys.progress, { p, state, nonce, verifier, returnTo }))]);
    }

    if (action === 'callback' && req.method === 'GET') {
      // 진행 쿠키는 한 번만 쓴다: 성공·실패 모두 지운다
      const prog = P.unseal(keys.progress, C.cookieOf(req, P.PROGRESS));
      if (!prog || prog.p !== p) return P.failed(onError, '로그인 진행 상태가 없다');
      // 콜백 주소는 공개 출처로 다시 만든다(프록시 뒤에서 요청 호스트가 내부 주소여도 인가 때의 redirect_uri와 같게)
      const here = new URL(`${u.pathname}${u.search}`, origin());
      try {
        const c = await config(p);
        const tokens = await client.authorizationCodeGrant(c, here, { pkceCodeVerifier: prog.verifier, expectedState: prog.state, expectedNonce: prog.nonce, idTokenExpected: true });
        const claims = tokens.claims();
        let profile = { email: claims.email ?? null, emailVerified: claims.email_verified === true };
        if (p === 'naver') {
          const r = await client.fetchProtectedResource(c, tokens.access_token, new URL(c.serverMetadata().userinfo_endpoint), 'GET');
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
