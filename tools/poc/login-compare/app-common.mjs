// 네 구현(A1·A2·C1·C2)이 함께 쓰는 앱 서버 코드(ADR-0119, docs/features/identity.md §2·§3): Origin 대조, identity 세션 생성·끝내기,
// PEAKET 쿠키, 네이버 사용자 정보. 기준 ③(코드 양)은 이 파일을 네 구현에 모두 센다.
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';

const AT = '__Secure-peaket_at';
const RT = '__Secure-peaket_rt';
const RT_PATH = '/v1/identity/access-tokens';

/** 앱 서버 비밀 하나에서 용도별 키를 나눈다(진행 쿠키 암호화, 멱등 키 HMAC). 한 키를 두 용도로 쓰지 않는다 */
export function appKeys(secret = randomBytes(32)) {
  const k = (info) => Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32));
  return { progress: k('peaket-oidc-progress'), idempotency: k('peaket-login-idempotency') };
}

/** 돌아갈 주소는 같은 출처의 경로만(다른 사이트로 보내지 않는다). 아니면 '/' */
export function safeReturnTo(v) {
  if (typeof v !== 'string' || v.length > 512 || !v.startsWith('/') || /[\u0000-\u001f\u007f\\]/.test(v)) return '/';
  // URL로 풀어 같은 출처인지 보고, 정규화한 경로가 //로 시작하면 막는다(/..//evil 같은 것). 돌려주는 값은 퍼센트 인코딩돼 응답 머리에 넣을 수 있다
  const base = 'http://return-to.invalid';
  let u;
  try {
    u = new URL(v, base);
  } catch {
    return '/';
  }
  return u.origin === base && !u.pathname.startsWith('//') ? `${u.pathname}${u.search}` : '/';
}

export async function returnToOf(req) {
  if (!(req.headers.get('content-type') ?? '').startsWith('application/x-www-form-urlencoded')) return '/';
  return safeReturnTo(new URLSearchParams(await req.text()).get('returnTo'));
}

export const cookieOf = (req, name) =>
  (req.headers.get('cookie') ?? '').split(';').map((s) => s.trim()).find((s) => s.startsWith(`${name}=`))?.slice(name.length + 1);

const attrs = 'HttpOnly; Secure';
const sessionCookies = (s) => [`${AT}=${s.accessToken}; Path=/; ${attrs}; SameSite=Strict`, `${RT}=${s.refreshToken}; Path=${RT_PATH}; ${attrs}; SameSite=Strict`];
const clearSession = () => [`${AT}=; Path=/; ${attrs}; SameSite=Strict; Max-Age=0`, `${RT}=; Path=${RT_PATH}; ${attrs}; SameSite=Strict; Max-Age=0`];

export function redirect(to, cookies = []) {
  const h = new Headers({ location: to, 'cache-control': 'no-store' });
  for (const c of cookies) h.append('set-cookie', c);
  return new Response(null, { status: 303, headers: h });
}

/** 로그인 시작·로그아웃은 소비자 웹 출처에서 온 POST만(ADR-0065 결정 5) */
export const sameOrigin = (req, origin) => req.headers.get('origin') === origin;


/** identity 세션 생성(CreateSession과 같은 입력). 멱등 키는 state를 앱 서버 키로 HMAC한 값이다(identity §2). 제공자 토큰은 보내지 않는다 */
export async function createSession(identityUrl, key, { provider, sub, email, emailVerified, state }) {
  const idempotencyKey = createHmac('sha256', key).update(`login:${state}`).digest('base64url');
  const r = await fetch(`${identityUrl}/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ provider, providerUserId: sub, email, emailVerified, idempotencyKey }),
  });
  if (!r.ok) throw new Error(`identity 세션 생성 ${r.status}`);
  return sessionCookies(await r.json());
}

/** 로그아웃: identity 세션을 끝내고 PEAKET 쿠키를 지운다. identity가 실패해도 쿠키는 지우고, 그 사실을 상태 코드로 알린다 */
export async function logout(req, identityUrl, origin, onError = () => {}) {
  if (!sameOrigin(req, origin)) return new Response('출처가 다르다', { status: 403 });
  const at = cookieOf(req, AT);
  let ok = true;
  if (at) {
    try {
      const r = await fetch(`${identityUrl}/sessions/end`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accessToken: at }) });
      ok = r.ok;
    } catch (e) {
      ok = false;
      onError('logout', e);
    }
  }
  if (ok) return redirect('/', clearSession());
  const h = new Headers({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
  for (const c of clearSession()) h.append('set-cookie', c);
  return new Response('로그아웃을 마치지 못했다. 다시 시도한다', { status: 503, headers: h });
}

/** 네이버: ID 토큰에 이메일이 없어 사용자 정보 API로 받는다. 응답의 id가 ID 토큰 sub와 다르면 막는다(identity §2, [확인 필요]) */
export function naverProfile(body, sub) {
  const r = body?.response;
  if (body?.resultcode !== '00' || !r) throw new Error('네이버 사용자 정보 응답이 아니다');
  if (r.id !== sub) throw new Error('네이버 사용자 정보 id가 ID 토큰 sub와 다르다');
  return { email: r.email ?? null, emailVerified: false };
}

export const home = () => new Response('home', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
