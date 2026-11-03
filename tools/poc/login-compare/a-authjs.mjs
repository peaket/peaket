// 대안 A1: Auth.js(next-auth 5.0.0-beta.32의 엔진 @auth/core 0.41.3)를 문서의 기본 사용법대로 쓴 소셜 로그인(ADR-0119 결정 3, I-T51).
// Next 연결층 없이 웹 표준 요청·응답으로 Auth()를 부른다. 로그인 시작·로그아웃은 Auth.js의 CSRF 토큰(이중 제출 쿠키)을 받아 넘긴다.
// signIn 콜백에서 identity 세션을 만들고 PEAKET 쿠키를 덧붙인다. Auth.js 세션 쿠키는 Auth.js 기본대로 따로 둔다.
// 세션 쿠키·CSRF 쿠키를 없애고 서명을 확인하도록 고친 판은 a-authjs-hardened.mjs(A2)다.
import { Auth } from '@auth/core';
import { randomBytes } from 'node:crypto';
import * as C from './app-common.mjs';

const PROVIDERS = ['kakao', 'naver', 'google'];

export async function createApp({ issuer, client: creds, identityUrl, origin, onError = (where, e) => console.error(`로그인 ${where}:`, e) }) {
  const secret = randomBytes(32).toString('base64url');
  const keys = C.appKeys();

  /** 요청마다 설정을 만든다: signIn 콜백이 만든 PEAKET 쿠키를 그 요청의 응답에 붙이려고 */
  const config = (out) => ({
    secret,
    trustHost: true,
    basePath: '/auth',
    useSecureCookies: false, // 시험은 http
    session: { strategy: 'jwt' },
    logger: { error: (e) => onError('callback', e), warn: () => {}, debug: () => {} },
    providers: PROVIDERS.map((p) => ({
      id: p, name: p, type: 'oidc', issuer: issuer(p), clientId: creds[p].id, clientSecret: creds[p].secret,
      checks: ['pkce', 'state', 'nonce'],
      authorization: { params: { scope: 'openid email' } },
      // 네이버: ID 토큰에 이메일이 없어 사용자 정보 API로 받고 id를 sub와 대조한다
      async profile(claims, tokens) {
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
        return true;
      },
    },
  });

  const call = async (path, init, out = {}) => ({ res: await Auth(new Request(`${origin()}${path}`, init), config(out)), out });
  const withCookies = (res, extra) => {
    const h = new Headers(res.headers);
    for (const c of extra) h.append('set-cookie', c);
    return new Response(res.body, { status: res.status, headers: h });
  };
  /** Auth.js CSRF 토큰: 브라우저의 csrf 쿠키가 있으면 그 값, 없으면 새로 받아 쿠키를 함께 넘긴다 */
  async function csrf(req) {
    const r = await call('/auth/csrf', { headers: { cookie: req.headers.get('cookie') ?? '' } });
    // CSRF 쿠키만 넘긴다(이 호출이 함께 내는 기본 돌아갈 주소 쿠키가 로그인 시작의 것을 덮지 않게)
    const set = r.res.headers.getSetCookie().filter((s) => s.startsWith('authjs.csrf-token='));
    const fromSet = set.map((s) => s.split(';')[0]).find((s) => s.startsWith('authjs.csrf-token='));
    const cookie = [req.headers.get('cookie'), fromSet].filter(Boolean).join('; ');
    return { token: (await r.res.json()).csrfToken, cookie, set };
  }
  const form = (o) => new URLSearchParams(o).toString();

  return async (req) => {
    const u = new URL(req.url);
    const [, action, p] = u.pathname.split('/');
    if (u.pathname === '/' || u.pathname.startsWith('/events/')) return C.home();
    if (action === 'auth') {
      const out = {};
      const res = await Auth(req, config(out));
      return out.cookies ? withCookies(res, out.cookies) : res;
    }
    if (action === 'login' && req.method === 'POST' && PROVIDERS.includes(p)) {
      if (!C.sameOrigin(req, origin())) return new Response('출처가 다르다', { status: 403 });
      const returnTo = await C.returnToOf(req);
      const t = await csrf(req);
      const r = await call(`/auth/signin/${p}`, {
        method: 'POST', headers: { cookie: t.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ csrfToken: t.token, callbackUrl: `${origin()}${returnTo}` }),
      });
      return withCookies(r.res, t.set);
    }
    if (action === 'logout' && req.method === 'POST') {
      if (!C.sameOrigin(req, origin())) return new Response('출처가 다르다', { status: 403 });
      const ended = await C.logout(req, identityUrl, origin(), onError);
      const t = await csrf(req);
      const r = await call('/auth/signout', {
        method: 'POST', headers: { cookie: t.cookie, 'content-type': 'application/x-www-form-urlencoded' },
        body: form({ csrfToken: t.token, callbackUrl: `${origin()}/` }),
      });
      return withCookies(r.res, [...t.set, ...ended.headers.getSetCookie()]);
    }
    return new Response('없음', { status: 404 });
  };
}
