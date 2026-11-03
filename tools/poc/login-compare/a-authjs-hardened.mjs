// 대안 A2: Auth.js(@auth/core 0.41.3)를 문서에 있는 기능만으로 고친 판(I-T51 공정성, 새 맥락 리뷰 2026-11-03).
// A1과 다른 점은 셋이다. ① signIn 콜백이 주소 글을 돌려주면 Auth.js는 자기 세션을 만들지 않고 그 주소로 보낸다(세션 쿠키 없음)
// ② CSRF 토큰 대신 Origin 대조만 두고 skipCSRFCheck를 켠다(identity §3과 같은 규칙, CSRF 쿠키 없음)
// ③ profile 콜백에서 jose로 ID 토큰 서명을 제공자 JWKS에 대조한다(ASVS v5.0.0-6.8.2. Auth.js에는 이 설정이 없다)
import { Auth, skipCSRFCheck } from '@auth/core';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { randomBytes } from 'node:crypto';
import * as C from './app-common.mjs';

const PROVIDERS = ['kakao', 'naver', 'google'];

export async function createApp({ issuer, client: creds, identityUrl, origin, onError = (where, e) => console.error(`로그인 ${where}:`, e) }) {
  const secret = randomBytes(32).toString('base64url');
  const keys = C.appKeys();
  const jwks = Object.fromEntries(PROVIDERS.map((p) => [p, createRemoteJWKSet(new URL(`${issuer(p)}/jwks`))]));
  const config = (out) => ({
    secret, trustHost: true, basePath: '/auth', useSecureCookies: false, skipCSRFCheck,
    logger: { error: (e) => onError('callback', e), warn: () => {}, debug: () => {} },
    providers: PROVIDERS.map((p) => ({
      id: p, name: p, type: 'oidc', issuer: issuer(p), clientId: creds[p].id, clientSecret: creds[p].secret,
      checks: ['pkce', 'state', 'nonce'], authorization: { params: { scope: 'openid email' } },
      async profile(claims, tokens) {
        await jwtVerify(tokens.id_token, jwks[p], { issuer: issuer(p), audience: creds[p].id });
        if (p !== 'naver') return { id: claims.sub, email: claims.email ?? null, emailVerified: claims.email_verified === true };
        const r = await fetch(`${issuer(p)}/userinfo`, { headers: { authorization: `Bearer ${tokens.access_token}` } });
        return { id: claims.sub, ...C.naverProfile(await r.json(), claims.sub) };
      },
    })),
    callbacks: {
      async signIn({ account, user }) {
        out.cookies = await C.createSession(identityUrl, keys.idempotency, {
          provider: account.provider, sub: account.providerAccountId, email: user.email, emailVerified: user.emailVerified === true, state: `${account.providerAccountId}:${randomBytes(8).toString('hex')}`,
        });
        return `${origin()}${out.returnTo}`; // 주소 글: Auth.js는 자기 세션을 만들지 않고 이 주소로 보낸다
      },
    },
  });
  const withCookies = (res, extra) => {
    const h = new Headers(res.headers);
    for (const c of extra) h.append('set-cookie', c);
    return new Response(res.body, { status: res.status, headers: h });
  };
  return async (req) => {
    const u = new URL(req.url);
    const [, action, p] = u.pathname.split('/');
    if (u.pathname === '/' || u.pathname.startsWith('/events/')) return C.home();
    if (action === 'auth') {
      if (req.method !== 'GET' || !u.pathname.startsWith('/auth/callback/')) return new Response('없음', { status: 404 });
      // 돌아갈 주소: Auth.js가 시작 때 남긴 callback-url 쿠키의 경로(같은 출처만)
      const cb = C.cookieOf(req, 'authjs.callback-url');
      let returnTo = '/';
      try {
        const x = new URL(decodeURIComponent(cb ?? ''));
        if (x.origin === origin()) returnTo = C.safeReturnTo(`${x.pathname}${x.search}`);
      } catch {}
      const out = { returnTo };
      const res = await Auth(req, config(out));
      return out.cookies ? withCookies(res, out.cookies) : res;
    }
    if (action === 'login' && req.method === 'POST' && PROVIDERS.includes(p)) {
      if (!C.sameOrigin(req, origin())) return new Response('출처가 다르다', { status: 403 });
      const returnTo = await C.returnToOf(req);
      return Auth(new Request(`${origin()}/auth/signin/${p}`, {
        method: 'POST', headers: { cookie: req.headers.get('cookie') ?? '', 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ callbackUrl: `${origin()}${returnTo}` }),
      }), config({}));
    }
    if (action === 'logout' && req.method === 'POST') return C.logout(req, identityUrl, origin(), onError);
    return new Response('없음', { status: 404 });
  };
}
