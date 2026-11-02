// 소비자 웹 앱 서버의 로그인 경로(docs/features/identity.md §2 '웹 앱 서버 경로', §3, §7.1, ADR-0119, I-T71·I-T72·I-T54).
// 모의 OIDC 제공자(scripts/mock-oidc.mjs)와 identity SessionService 대역(gRPC)을 띄우고, 쿠키 모음을 가진 브라우저 흉내로 누른다.
import { after, before, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { CLIENT, serve, startMockOP } from '../../../../scripts/mock-oidc.mjs';
import { createSocialLogin, LOGIN_ROUTES } from './index.ts';
import { Browser, formPost, startIdentityStub, TOKEN_ISSUER } from './testing.mjs';

let op;
let identity;
let web;
let app;
let clock;
const logs = [];
const SECRET = Buffer.alloc(32, 9);
const AT = '__Secure-peaket_at';
const RT = '__Secure-peaket_rt';
const OIDC = '__Host-peaket_oidc';
const REAUTH = '__Host-peaket_reauth';
const PROVIDER = { kakao: 'PROVIDER_KAKAO', naver: 'PROVIDER_NAVER', google: 'PROVIDER_GOOGLE' };

const config = (origin) => ({
  env: 'ci',
  origin,
  secret: SECRET,
  cookieDomain: undefined,
  providers: Object.fromEntries(['kakao', 'naver', 'google'].map((p) => [p, { issuer: op.issuer(p), clientId: CLIENT[p].id, clientSecret: CLIENT[p].secret }])),
  identityAddress: identity.address,
  fanJwks: identity.jwks,
  tokenIssuer: TOKEN_ISSUER,
});

before(async () => {
  op = await startMockOP();
  identity = await startIdentityStub();
  web = await serve((req) => app.dispatch(req));
  clock = { offset: 0 };
  app = createSocialLogin(config(web.url), { now: () => Date.now() + clock.offset, log: (event, fields) => logs.push({ event, ...fields }) });
});

after(async () => {
  app?.close();
  await Promise.all([op?.close(), identity?.close(), web?.close()]);
});

beforeEach(() => {
  Object.assign(op.mode, { wrongIss: false, wrongAud: false, naverIdMismatch: false, badSignature: false, otherNonce: false, expired: false, discoveryIssuer: false, staleAuthTime: false, googleAuthTime: true });
  Object.assign(identity.mode, { endFails: false, createFails: false });
  op.users.kakao.sub = '4000001';
  clock.offset = 0;
  logs.length = 0;
  identity.calls.length = 0;
});

const login = (b, provider = 'kakao', fields = {}, origin = web.url) => b.go(`${web.url}/login/${provider}`, formPost(origin, { returnTo: '/my/tickets', ...fields }));
/** 실패 사건만(성공 사건 login.completed 등은 뺀다) */
const failures = () => logs.filter((l) => l.event.endsWith('.failed'));
const lastCall = (method) => identity.calls.filter((c) => c.method === method).at(-1)?.request;
const GENERIC = '로그인하지 못했습니다. 처음부터 다시 시도해 주세요';

/** 콜백 직전에서 멈춘 로그인(코드·state를 손에 쥔다) */
async function stopAtCallback(b, provider = 'kakao') {
  const start = await b.go(`${web.url}/login/${provider}`, { ...formPost(web.url, { returnTo: '/' }), follow: false });
  const toOp = start.res.headers.get('location');
  const back = await fetch(toOp, { redirect: 'manual' });
  return new URL(back.headers.get('location'));
}

test('I-T71_① FR-001 세 제공자 로그인은 identity 세션 쿠키 둘만 주고 돌아갈 주소로 보낸다 [ASVS v5.0.0-3.3.1] [ASVS v5.0.0-3.3.4] [ASVS v5.0.0-10.1.1]', async () => {
  for (const p of ['kakao', 'naver', 'google']) {
    const b = new Browser();
    const r = await login(b, p, { deviceId: 'dev-AAAAAAAAAAAAAAAAAA' });
    const final = r.trail.at(-1);
    assert.equal(r.trail[0].status, 303);
    assert.match(final.url, /\/signup\/consent\?next=%2Fmy%2Ftickets$/, `${p}: 처음 로그인은 가입 화면(SCR-005)으로`);
    assert.deepEqual(b.names(), [AT, RT], `${p}: identity 밖 쿠키가 없다`);
    const at = b.get(AT).attrs;
    assert.equal(at.path, '/');
    assert.equal(at.samesite, 'Strict');
    assert.ok(at.httponly && at.secure);
    assert.equal(b.get(RT).attrs.path, '/v1/identity/access-tokens');
    const req = lastCall('CreateSession');
    assert.equal(req.provider, PROVIDER[p]);
    assert.equal(req.provider_user_id, op.users[p].sub);
    assert.equal(req.device_id, 'dev-AAAAAAAAAAAAAAAAAA');
    // 멱등 키는 state를 앱 서버 키로 HMAC한 값이다(state 원문을 보내지 않는다)
    assert.match(req.idempotency_key, /^[A-Za-z0-9_-]{43}$/);
    const state = new URL(r.trail[1].url).searchParams.get('state');
    assert.notEqual(req.idempotency_key, state);
    // 제공자 토큰은 보내지 않는다(asvs 10.1.1)
    assert.ok(!JSON.stringify(req).includes('eyJ'));
    if (p === 'naver') assert.deepEqual([req.email, req.email_verified], ['fan@naver.test', false]);
    else assert.deepEqual([req.email, req.email_verified], [op.users[p].email, true]);
  }
  // 두 번째 로그인은 가입 화면을 건너뛰고 돌아갈 주소로 간다
  const again = await login(new Browser(), 'kakao');
  assert.equal(new URL(again.trail.at(-1).url).pathname, '/my/tickets');
});

test('I-T71_① 돌아갈 주소는 같은 출처 경로만 받는다 [ASVS v5.0.0-3.7.2]', async () => {
  for (const bad of ['//evil.example/x', 'https://evil.example/', '/\\evil.example', 'javascript:alert(1)']) {
    const r = await login(new Browser(), 'kakao', { returnTo: bad });
    assert.equal(new URL(r.trail.at(-1).url).pathname, '/', bad);
    assert.equal(new URL(r.trail.at(-1).url).host, new URL(web.url).host, bad);
  }
});

test('I-T71_① 다른 출처의 로그인 시작은 거절하고 진행 쿠키를 주지 않는다', async () => {
  const b = new Browser();
  const r = await login(b, 'kakao', {}, 'https://evil.example');
  assert.equal(r.res.status, 403);
  assert.deepEqual(b.names(), []);
  const none = await b.go(`${web.url}/login/kakao`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'returnTo=/' });
  assert.equal(none.res.status, 403);
});

test('I-T71_② 진행 쿠키 없는 다른 브라우저의 콜백은 거절한다 [ASVS v5.0.0-10.1.2]', async () => {
  const cb = await stopAtCallback(new Browser());
  const other = new Browser();
  const r = await other.go(cb.toString());
  assert.equal(r.res.status, 400);
  assert.equal(r.text, GENERIC);
  assert.deepEqual(other.names(), []);
  assert.equal(lastCall('CreateSession'), undefined);
  assert.deepEqual(logs.map((l) => [l.event, l.reason]), [['login.failed', 'progress']]);
});

test('I-T71_③ state를 바꾸거나 진행 쿠키를 고치거나 다시 쓴 콜백은 거절한다 [ASVS v5.0.0-10.1.2] [ASVS v5.0.0-10.2.1]', async () => {
  const b = new Browser();
  const cb = await stopAtCallback(b);
  const changed = new URL(cb);
  changed.searchParams.set('state', 'other-state');
  const saved = b.get(OIDC).value;
  const r1 = await b.go(changed.toString());
  assert.equal(r1.res.status, 400);
  // 실패해도 진행 쿠키는 지운다(한 번만 쓴다)
  assert.equal(b.get(OIDC), undefined);

  // 떠 둔 쿠키를 한 글자 바꿔 다시 넣는다
  const tampered = new Browser();
  tampered.store(web.url, [`${OIDC}=${saved.slice(0, -2)}${saved.at(-2) === 'A' ? 'B' : 'A'}${saved.at(-1)}; Path=/`]);
  assert.equal((await tampered.go(cb.toString())).res.status, 400);

  // 정상 콜백 뒤 떠 둔 쿠키로 같은 콜백을 다시 보낸다(코드는 이미 쓰였다)
  const ok = new Browser();
  const cb2 = await stopAtCallback(ok);
  const kept = ok.get(OIDC).value;
  assert.equal((await ok.go(cb2.toString())).trail[0].status, 303);
  const replay = new Browser();
  replay.store(web.url, [`${OIDC}=${kept}; Path=/`]);
  assert.equal((await replay.go(cb2.toString())).res.status, 400);
  assert.deepEqual(failures().map((l) => l.reason), ['state', 'progress', 'id_token']);
});

test('I-T71_③ 다른 제공자의 콜백 주소로 보낸 콜백은 코드를 교환하지 않고 거절한다(혼동 공격, ASVS v5.0.0-10.2.2)', async () => {
  const b = new Browser();
  const cb = await stopAtCallback(b, 'kakao');
  const mixed = new URL(`/login/callback/google${cb.search}`, web.url);
  const r = await b.go(mixed.toString());
  assert.equal(r.res.status, 400);
  assert.deepEqual(failures().map((l) => [l.provider, l.reason]), [['google', 'progress']]);
  assert.equal(b.get(OIDC), undefined);
});

test('I-T71_③④ 다른 nonce·만료·다른 issuer·다른 aud·JWKS에 없는 키의 ID 토큰은 거절한다 [ASVS v5.0.0-6.8.2] [ASVS v5.0.0-10.5.1] [ASVS v5.0.0-10.5.4]', async () => {
  for (const m of ['otherNonce', 'expired', 'wrongIss', 'wrongAud', 'badSignature']) {
    op.mode[m] = true;
    const b = new Browser();
    const r = await login(b);
    op.mode[m] = false;
    assert.equal(r.res.status, 400, m);
    assert.equal(r.text, GENERIC, m);
    assert.deepEqual(b.names(), [], m);
  }
  assert.equal(lastCall('CreateSession'), undefined);
  assert.ok(logs.every((l) => l.event === 'login.failed' && l.reason === 'id_token'));
});

test('I-T71_④ 발견 문서의 issuer가 다르면 로그인 시작에서 막는다 [ASVS v5.0.0-10.5.3]', async () => {
  // 발견 문서는 처리기마다 한 번 읽어 기억하므로, 아직 읽지 않은 새 처리기로 본다
  const fresh = createSocialLogin(config(web.url), { log: (event, fields) => logs.push({ event, ...fields }) });
  const start = () => fresh.dispatch(new Request(`${web.url}/login/google`, formPost(web.url, { returnTo: '/' })));
  try {
    op.mode.discoveryIssuer = true;
    const r = await start();
    assert.equal(r.status, 503);
    assert.deepEqual(r.headers.getSetCookie(), []);
    assert.deepEqual(logs.map((l) => [l.event, l.reason]), [['login.failed', 'discovery']]);
    // 실패한 발견 문서는 기억하지 않는다: 고쳐지면 바로 된다
    op.mode.discoveryIssuer = false;
    assert.equal((await start()).status, 303);
  } finally {
    fresh.close();
  }
});

test('I-T71_⑤ 로그아웃은 identity 세션을 끝내고 쿠키를 지워 identity 밖 쿠키가 0이다 [ASVS v5.0.0-7.4.1]', async () => {
  const b = new Browser();
  await login(b);
  const created = lastCall('CreateSession');
  const r = await b.go(`${web.url}/logout`, { method: 'POST', headers: { origin: web.url } });
  assert.equal(r.trail[0].status, 303);
  assert.deepEqual(b.names(), []);
  const end = lastCall('EndSession');
  assert.ok(end.session_id && end.account_id);
  assert.ok(identity.sessions.get(end.session_id).ended);
  assert.ok(created);
});

test('I-T71_⑤ 만료된 액세스 토큰으로도 로그아웃은 그 세션을 끝낸다', async () => {
  const b = new Browser();
  await login(b);
  clock.offset = 16 * 60_000;
  const r = await b.go(`${web.url}/logout`, { method: 'POST', headers: { origin: web.url } });
  assert.equal(r.trail[0].status, 303);
  assert.ok(identity.sessions.get(lastCall('EndSession').session_id).ended);
});

test('I-T71_⑤ 서명이 맞지 않는 액세스 토큰으로는 identity를 부르지 않고 쿠키만 지운다', async () => {
  const b = new Browser();
  await login(b);
  const forged = `${b.get(AT).value.slice(0, -4)}AAAA`;
  b.store(web.url, [`${AT}=${forged}; Path=/`]);
  const r = await b.go(`${web.url}/logout`, { method: 'POST', headers: { origin: web.url } });
  assert.equal(r.trail[0].status, 303);
  assert.equal(lastCall('EndSession'), undefined);
  assert.deepEqual(b.names(), []);
});

test('I-T71_⑥ 네이버 사용자 정보 id가 ID 토큰 sub와 다르면 막는다', async () => {
  op.mode.naverIdMismatch = true;
  const b = new Browser();
  const r = await login(b, 'naver');
  assert.equal(r.res.status, 400);
  assert.deepEqual(b.names(), []);
  assert.deepEqual(logs.map((l) => l.reason), ['userinfo']);
});

test('I-T71_⑦ 요청 호스트가 내부 주소여도 공개 출처의 콜백 주소로 코드를 교환한다', async () => {
  const b = new Browser();
  const cb = await stopAtCallback(b);
  // 프록시가 내부 주소로 넘긴 요청처럼 호스트만 바꿔 처리기에 바로 넣는다
  const internal = new URL(`${cb.pathname}${cb.search}`, 'http://10.0.3.7:3000');
  const res = await app.dispatch(new Request(internal, { headers: { cookie: b.cookieHeader(web.url) } }));
  assert.equal(res.status, 303);
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith(`${AT}=`)));
});

test('I-T71_⑧ identity가 답하지 않으면 로그아웃은 쿠키를 지우고 503이다', async () => {
  const b = new Browser();
  await login(b);
  identity.mode.endFails = true;
  const r = await b.go(`${web.url}/logout`, { method: 'POST', headers: { origin: web.url } });
  assert.equal(r.res.status, 503);
  assert.deepEqual(b.names(), []);
  assert.deepEqual(failures().map((l) => [l.event, l.reason]), [['logout.failed', 'identity']]);
});

test('I-T71_⑨ 다른 출처의 로그아웃은 거절되고 세션이 그대로다', async () => {
  const b = new Browser();
  await login(b);
  const r = await b.go(`${web.url}/logout`, { method: 'POST', headers: { origin: 'https://evil.example' } });
  assert.equal(r.res.status, 403);
  assert.deepEqual(b.names(), [AT, RT]);
  assert.equal(lastCall('EndSession'), undefined);
});

test('I-T71_identity 세션 생성이 실패하면 이유 없이 실패하고 쿠키를 주지 않는다', async () => {
  identity.mode.createFails = true;
  const b = new Browser();
  const r = await login(b);
  assert.equal(r.res.status, 503);
  assert.deepEqual(b.names(), []);
  assert.ok(!r.text.includes('대역'));
  assert.deepEqual(logs.map((l) => [l.event, l.reason]), [['login.failed', 'identity']]);
});

test('ADR0119_모든 로그인 경로 응답은 캐시하지 않는다', async () => {
  const r = await login(new Browser());
  for (const step of r.trail.filter((t) => new URL(t.url).host === new URL(web.url).host && !t.url.includes('/my/'))) {
    // 대역 서버 너머 화면(돌아갈 주소)은 이 처리기가 아니다
    if (step.url.includes('/signup/') || step.url.endsWith('/my/tickets')) continue;
    assert.ok(step.status === 303 || step.status === 400, step.url);
  }
  const logout = await new Browser().go(`${web.url}/logout`, { method: 'POST', headers: { origin: web.url } });
  assert.equal(logout.trail[0].status, 303);
  const res = await app.dispatch(new Request(`${web.url}/login/kakao`, { method: 'POST', headers: { origin: web.url } }));
  assert.equal(res.headers.get('cache-control'), 'no-store');
});

// ---- 재인증(identity §7.1, I-T54·I-T72) ----

async function reauth(b, provider = 'kakao', origin = web.url) {
  return b.go(`${web.url}/reauth/${provider}`, formPost(origin, { returnTo: '/my/settings' }));
}
const pickup = (b, origin = web.url) => b.go(`${web.url}/reauth/token`, { method: 'POST', headers: { origin } });

test('I-T54_① 카카오 재인증은 prompt=login이고 auth_time이 시작 뒤라 확인됨 토큰이다 [ASVS v5.0.0-6.8.4]', async () => {
  const b = new Browser();
  await login(b);
  const r = await reauth(b);
  assert.equal(op.lastAuthorize.kakao.prompt, 'login');
  assert.equal(new URL(r.trail.at(-1).url).pathname, '/my/settings');
  const req = lastCall('IssueReauthToken');
  assert.equal(req.strength, 'REAUTH_STRENGTH_VERIFIED');
  assert.equal(req.provider, 'PROVIDER_KAKAO');
  assert.equal(req.provider_user_id, '4000001');
  const p = await pickup(b);
  assert.equal(p.res.status, 200);
  const body = JSON.parse(p.text);
  assert.equal(body.provider, 'kakao');
  assert.equal(body.strength, 'verified');
  assert.match(body.reauthToken, /^reauth\.REAUTH_STRENGTH_VERIFIED\.PROVIDER_KAKAO\./);
  assert.equal(p.res.headers.get('cache-control'), 'no-store');
  assert.deepEqual(logs.filter((l) => l.event.startsWith('reauth')).map((l) => [l.event, l.provider, l.strength]), [['reauth.completed', 'kakao', 'verified']]);
});

test('I-T54_② auth_time이 요청보다 이르면 거부하고 제공자 로그아웃 뒤 다시 시도를 안내한다 [ASVS v5.0.0-6.8.4]', async () => {
  const b = new Browser();
  await login(b);
  op.mode.staleAuthTime = true;
  await reauth(b);
  assert.equal(lastCall('IssueReauthToken'), undefined);
  const p = await pickup(b);
  assert.equal(p.res.status, 409);
  assert.deepEqual(JSON.parse(p.text), { type: 'reauth-stale', title: '제공자 계정에서 로그아웃한 뒤 다시 시도해 주세요' });
  assert.equal(p.res.headers.get('content-type'), 'application/problem+json');
  assert.deepEqual(logs.filter((l) => l.event === 'reauth.rejected').map((l) => [l.provider, l.reason]), [['kakao', 'stale']]);
});

test('I-T54_③ 네이버는 요청만 함, 구글은 auth_time이 있으면 확인됨·없으면 요청만 함이다', async () => {
  const cases = [
    ['naver', true, 'REAUTH_STRENGTH_REQUESTED'],
    ['google', true, 'REAUTH_STRENGTH_VERIFIED'],
    ['google', false, 'REAUTH_STRENGTH_REQUESTED'],
  ];
  for (const [p, googleAuthTime, strength] of cases) {
    op.mode.googleAuthTime = googleAuthTime;
    const b = new Browser();
    await login(b, p);
    await reauth(b, p);
    assert.equal(lastCall('IssueReauthToken').strength, strength, `${p} ${googleAuthTime}`);
    assert.equal((await pickup(b)).res.status, 200);
  }
  assert.equal(op.lastAuthorize.naver.prompt, 'login');
  assert.equal(op.lastAuthorize.google.prompt, 'select_account');
  assert.deepEqual(JSON.parse(op.lastAuthorize.google.claims), { id_token: { auth_time: { essential: true } } });
});

test('I-T54_다른 제공자 계정으로 다시 로그인하면 토큰 없이 계정 불일치다', async () => {
  const b = new Browser();
  await login(b);
  op.users.kakao.sub = '4000999';
  await reauth(b);
  const p = await pickup(b);
  assert.equal(p.res.status, 409);
  assert.equal(JSON.parse(p.text).type, 'reauth-account-mismatch');
});

test('I-T54_로그인하지 않았거나 액세스 토큰이 만료됐으면 재인증을 시작하지 않는다', async () => {
  const none = await reauth(new Browser());
  assert.equal(none.res.status, 401);
  const b = new Browser();
  await login(b);
  clock.offset = 16 * 60_000;
  const expired = await reauth(b);
  assert.equal(expired.res.status, 401);
  assert.equal(b.get(OIDC), undefined);
  assert.equal((await reauth(b, 'kakao', 'https://evil.example')).res.status, 403);
});

test('I-T72_① 재인증 토큰은 Location·주소·Referer가 될 값에 실리지 않는다', async () => {
  const b = new Browser();
  await login(b);
  const r = await reauth(b);
  const token = (await (async () => {
    const c = b.get(REAUTH);
    assert.ok(c, '결과 쿠키가 있다');
    assert.equal(c.attrs.path, '/');
    assert.equal(c.attrs.samesite, 'Strict');
    assert.equal(c.attrs['max-age'], '60');
    assert.ok(c.attrs.httponly && c.attrs.secure && !c.attrs.domain);
    return JSON.parse((await pickup(b)).text).reauthToken;
  })());
  for (const t of r.trail) {
    assert.ok(!t.url.includes(token) && !(t.location ?? '').includes(token), t.url);
    assert.ok(!t.url.includes('reauth.'), t.url);
  }
});

test('I-T72_② 결과는 한 번만 준다', async () => {
  const b = new Browser();
  await login(b);
  await reauth(b);
  assert.equal((await pickup(b)).res.status, 200);
  assert.equal(b.get(REAUTH), undefined);
  const second = await pickup(b);
  assert.equal(second.res.status, 404);
  assert.equal(JSON.parse(second.text).type, 'reauth-result-missing');
});

test('I-T72_③ 다른 출처는 결과를 받지 못하고 쿠키도 그대로다', async () => {
  const b = new Browser();
  await login(b);
  await reauth(b);
  assert.equal((await pickup(b, 'https://evil.example')).res.status, 403);
  assert.ok(b.get(REAUTH));
});

test('I-T72_④ 1분이 지난 결과는 없다', async () => {
  const b = new Browser();
  await login(b);
  await reauth(b);
  clock.offset = 61_000;
  assert.equal((await pickup(b)).res.status, 404);
});

test('경로표의 경로마다 app 아래 Next 경로 파일이 그 메서드를 내보낸다', async () => {
  const { readFile } = await import('node:fs/promises');
  for (const r of LOGIN_ROUTES) {
    const file = new URL(`../../../../app/(request)${r.file}/route.ts`, import.meta.url);
    const text = await readFile(file, 'utf8');
    assert.match(text, new RegExp(`export (async )?function ${r.method}\\b|export const ${r.method}\\b`), r.file);
    assert.match(text, new RegExp(`\\.${r.handler}\\(`), r.file);
  }
});

// ---- 새 맥락 리뷰가 찾은 것의 재현 시험(2026-11-03) ----

test('I-T71_① 돌아갈 주소는 정본 safeNext 규칙을 따른다(%2f%2f·%5c, FE-T12)', async () => {
  for (const bad of ['/%2f%2fevil.example', '/%5c%5cevil.example', '/a/../%2f%2fevil']) {
    const r = await login(new Browser(), 'kakao', { returnTo: bad });
    const final = new URL(r.trail.at(-1).url);
    assert.ok(final.pathname === '/' || final.searchParams.get('next') === '/', bad);
  }
});

test('I-T71_⑤ 액세스 토큰 쿠키는 리프레시 토큰과 같은 수명이라 쉬었다 와도 로그아웃이 그 세션을 끝낸다', async () => {
  const b = new Browser();
  await login(b);
  assert.equal(b.get(AT).attrs['max-age'], b.get(RT).attrs['max-age']);
  assert.ok(Number(b.get(AT).attrs['max-age']) > 15 * 60);
});

test('I-T71_⑤ 액세스 토큰 쿠키 없이 로그아웃하면 쿠키만 지우고 그 사실을 남긴다', async () => {
  const r = await new Browser().go(`${web.url}/logout`, { method: 'POST', headers: { origin: web.url } });
  assert.equal(r.trail[0].status, 303);
  assert.equal(lastCall('EndSession'), undefined);
  assert.deepEqual(logs.map((l) => l.event), ['logout.without-session']);
});

test('I-T71_양식 전송이 Origin null이어도 Sec-Fetch-Site가 same-origin이면 받는다(no-referrer 화면)', async () => {
  const nul = (site) => ({ method: 'POST', headers: { origin: 'null', ...(site ? { 'sec-fetch-site': site } : {}), 'content-type': 'application/x-www-form-urlencoded' }, body: 'returnTo=/' });
  assert.equal((await new Browser().go(`${web.url}/login/kakao`, { ...nul('same-origin'), follow: false })).res.status, 303);
  assert.equal((await new Browser().go(`${web.url}/login/kakao`, { ...nul('cross-site'), follow: false })).res.status, 403);
  assert.equal((await new Browser().go(`${web.url}/login/kakao`, { ...nul(undefined), follow: false })).res.status, 403);
  // 다른 사이트에서 Sec-Fetch-Site만 같은 출처라고 해도 Origin이 다른 사이트면 거절한다
  const other = await new Browser().go(`${web.url}/login/kakao`, { method: 'POST', headers: { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' }, follow: false });
  assert.equal(other.res.status, 403);
});

test('I-T54_고위험 재인증(양도·계좌 입력)은 요청만 함이고 판정이 UNKNOWN이면 본인확인 재통과를 요구한다', async () => {
  const b = new Browser();
  await login(b, 'naver');
  await b.go(`${web.url}/reauth/naver`, formPost(web.url, { returnTo: '/my/settings', purpose: 'high-risk' }));
  assert.equal(lastCall('IssueReauthToken').purpose, 'REAUTH_PURPOSE_HIGH_RISK');
  const p = await pickup(b);
  assert.equal(p.res.status, 409);
  assert.equal(JSON.parse(p.text).type, 'reauth-reverify-required');
  // 다른 민감 작업은 그대로 요청만 함 토큰을 받는다
  await reauth(b, 'naver');
  assert.equal(lastCall('IssueReauthToken').purpose, 'REAUTH_PURPOSE_SENSITIVE');
  assert.equal((await pickup(b)).res.status, 200);
});

test('I-T72_⑤ 제공자에서 취소한 재인증은 돌아갈 주소로 보내고 실패 종류만 준다', async () => {
  const b = new Browser();
  await login(b);
  const start = await b.go(`${web.url}/reauth/kakao`, { ...formPost(web.url, { returnTo: '/my/settings' }), follow: false });
  const state = new URL(start.res.headers.get('location')).searchParams.get('state');
  const r = await b.go(`${web.url}/login/callback/kakao?error=access_denied&state=${state}`);
  assert.equal(new URL(r.trail.at(-1).url).pathname, '/my/settings');
  assert.equal(JSON.parse((await pickup(b)).text).type, 'reauth-failed');
  assert.deepEqual(failures().map((l) => [l.event, l.reason, l.code]), [['reauth.failed', 'provider_error', 'access_denied']]);
});

test('I-T71_③ state가 다른 콜백은 state 범주로, 제공자 오류는 provider_error로 남긴다', async () => {
  const b = new Browser();
  const cb = await stopAtCallback(b);
  const changed = new URL(cb);
  changed.searchParams.set('state', 'x');
  await b.go(changed.toString());
  const c = new Browser();
  const cb2 = await stopAtCallback(c);
  await c.go(`${web.url}/login/callback/kakao?error=access_denied&state=${cb2.searchParams.get('state')}`);
  assert.deepEqual(failures().map((l) => l.reason), ['state', 'provider_error']);
});

test('secrets-and-keys_앱 서버 비밀을 바꾸면 옛 비밀로 봉인한 진행 쿠키를 쿠키 수명 동안 읽는다', async () => {
  const b = new Browser();
  const cb = await stopAtCallback(b);
  const cookie = b.cookieHeader(web.url);
  const req = () => new Request(new URL(`${cb.pathname}${cb.search}`, web.url), { headers: { cookie } });
  const rotated = createSocialLogin({ ...config(web.url), secret: Buffer.alloc(32, 1), previousSecret: SECRET }, { log: () => {} });
  const forgot = createSocialLogin({ ...config(web.url), secret: Buffer.alloc(32, 1) }, { log: () => {} });
  try {
    assert.equal((await forgot.dispatch(req())).status, 400);
    assert.equal((await rotated.dispatch(req())).status, 303);
  } finally {
    rotated.close();
    forgot.close();
  }
});

test('I-T20_웹앱서버는_공개키묶음주소(identity GET /internal/jwks/fan.json)에서팬공개키를읽는다', async () => {
  const jwks = await serve(() => new Response(JSON.stringify(identity.jwks), { headers: { 'content-type': 'application/jwk-set+json' } }));
  const { fanJwks: _drop, ...rest } = config(web.url);
  const remote = createSocialLogin({ ...rest, fanJwksUrl: `${jwks.url}/internal/jwks/fan.json` }, { log: (event, fields) => logs.push({ event, ...fields }) });
  try {
    const b = new Browser();
    await login(b);
    const r = await remote.dispatch(new Request(`${web.url}/logout`, { method: 'POST', headers: { origin: web.url, cookie: b.cookieHeader(web.url) } }));
    assert.equal(r.status, 303);
    assert.ok(identity.sessions.get(lastCall('EndSession').session_id).ended);
  } finally {
    remote.close();
    await jwks.close();
  }
});
