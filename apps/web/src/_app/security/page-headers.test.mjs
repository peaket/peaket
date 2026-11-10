// 소비자 웹 화면 묶음별 보안 헤더 시험(docs/frontend.md §2.5·§5.14.1, ADR-0065 결정 4, BUILD_ORDER HOT-290).
// 실행: pnpm --filter @peaket/web test. 타입 지우기로 .ts를 그대로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_HEADERS, REPORTING_ENDPOINTS, renderCsp } from '@peaket/config/headers/security-headers.mjs';
import { NONCE_HEADER, ROUTES, cachedCsp, matchRoute, newNonce, pageHeaders, socialAuthOrigins } from './page-headers.ts';
import { CSP_TEMPLATE_HEADER, HASH_SENTINEL } from '../../../server/csp-template.mjs';
import * as headersModule from './page-headers.ts';

const appDir = fileURLToPath(new URL('../../../app', import.meta.url));

/** app/(묶음)/…/page.tsx·route.ts → { group, kind, pattern } */
function fsRoutes() {
  const out = [];
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (/^(page|route)\.(tsx|ts|jsx|js)$/.test(name)) {
        const rel = relative(appDir, dir).split('\\').join('/');
        const [groupDir, ...rest] = rel.split('/');
        const group = groupDir === '(request)' ? 'request' : groupDir === '(cached)' ? 'cached' : null;
        if (!group) continue;
        out.push({ group, kind: name.startsWith('page.') ? 'page' : 'route', pattern: `/${rest.join('/')}` });
      }
    }
  };
  walk(appDir);
  return out.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** 패턴의 [값] 자리를 예시 값으로 채운 주소 */
const sample = (pattern) => (pattern === '/' ? '/' : pattern.replace(/\[([^\]]+)\]/g, (_, n) => `${n}-1`));

test('[ASVS v5.0.0-3.4.3] 경로 표가 app/ 폴더의 화면·처리기와 같다(묶음·종류). 새 화면을 더하면 표도 함께 고친다', () => {
  const fs = fsRoutes().map((r) => `${r.group} ${r.kind} ${r.pattern}`);
  const table = ROUTES.map((r) => `${r.group} ${r.kind} ${r.pattern}`).sort((a, b) => a.split(' ')[2].localeCompare(b.split(' ')[2]));
  assert.deepEqual([...table].sort(), [...fs].sort());
});

test('[ASVS v5.0.0-3.4.3] 주소마다 그 화면의 규칙을 고른다(같은 앞머리의 다른 묶음 화면을 헷갈리지 않는다)', () => {
  for (const r of fsRoutes()) {
    const m = matchRoute(sample(r.pattern));
    assert.ok(m, `${r.pattern}에 맞는 규칙이 없다`);
    assert.equal(`${m.group} ${m.pattern}`, `${r.group} ${r.pattern}`, sample(r.pattern));
  }
  assert.equal(matchRoute('/booking/evt-1/checkout').group, 'request');
  assert.equal(matchRoute('/booking/evt-1/checkout/return').group, 'cached');
  assert.equal(matchRoute('/my/tickets').group, 'cached');
  assert.equal(matchRoute('/my/tickets/t-1/transfer').group, 'request');
  assert.equal(matchRoute('/no/such/page'), undefined);
  assert.equal(matchRoute('/events/a/b/c'), undefined, '[id]는 조각 하나만 받는다');
});

test('[ASVS v5.0.0-3.4.3] 요청마다 그리는 화면의 묶음: 좌석 F, 주문·결제 E, 나머지 B(사람 확인 화면은 Turnstile 변형, 본인확인을 여는 화면은 identityForm)', () => {
  assert.equal(matchRoute('/booking/e-1/seats').bundle, 'F');
  assert.equal(matchRoute('/booking/e-1/checkout').bundle, 'E');
  assert.equal(matchRoute('/shop/checkout').bundle, 'E');
  assert.equal(matchRoute('/my/settings').bundle, 'B');
  assert.equal(matchRoute('/login').bundle, 'B');
  assert.deepEqual(matchRoute('/queue/e-1/verify').variants, ['humanCheck', 'identityForm']);
  // 로그인 시작·재인증·로그인 수단 추가 양식이 제공자로 303하는 화면(ADR-0215, 갈래 3 BOT-044 재현). 계정 설정은 본인확인도 연다
  for (const p of ['/login', '/login/link', '/my/settings/providers']) assert.deepEqual(matchRoute(p).variants, ['socialLogin'], p);
  assert.deepEqual(matchRoute('/my/settings').variants, ['socialLogin', 'identityForm']);
  assert.deepEqual(matchRoute('/signup/consent').variants, ['identityForm']);
  for (const p of ['/my/likes', '/my/orders']) assert.equal(matchRoute(p).variants, undefined, p);
  assert.ok(pageHeaders('/login', { nonce: newNonce() })['Content-Security-Policy'].includes("form-action 'self' https://kauth.kakao.com https://accounts.kakao.com https://nid.naver.com https://accounts.google.com;"));
  for (const r of ROUTES.filter((x) => x.group === 'cached' && x.kind === 'page')) assert.equal(r.bundle, 'A', r.pattern);
});

test('[ASVS v5.0.0-3.4.3] nonce는 요청마다 새 128비트 값이다(base64, 22자 이상)', () => {
  const a = newNonce();
  const b = newNonce();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9+/]{22,}={0,2}$/);
  assert.ok(Buffer.from(a, 'base64').length >= 16);
});

test('[ASVS v5.0.0-3.4.3] [ASVS v5.0.0-3.4.6] 요청 화면 헤더: 그 묶음의 CSP(이 nonce), 보고 엔드포인트, 화면 종류별 Referrer·COOP·Permissions', () => {
  const nonce = newNonce();
  const seats = pageHeaders('/booking/e-1/seats', { nonce });
  assert.equal(seats['Content-Security-Policy'], renderCsp('F', { nonce }));
  assert.match(seats['Content-Security-Policy'], new RegExp(`'nonce-${nonce.replace(/[+/=]/g, '\\$&')}' 'strict-dynamic'`));
  assert.equal(seats['Reporting-Endpoints'], REPORTING_ENDPOINTS);
  assert.equal(seats['Cross-Origin-Opener-Policy'], PAGE_HEADERS.seats['Cross-Origin-Opener-Policy']);
  const pay = pageHeaders('/booking/e-1/checkout', { nonce });
  assert.equal(pay['Content-Security-Policy'], renderCsp('E', { nonce, variants: ['identityForm'], origins: { identity: headersModule.IDENTITY_AGENCY_PLACEHOLDER } }));
  assert.equal(pay['Referrer-Policy'], 'no-referrer');
  const verify = pageHeaders('/queue/e-1/verify', { nonce });
  assert.equal(verify['Content-Security-Policy'], renderCsp('B', { nonce, variants: ['humanCheck', 'identityForm'], origins: { identity: headersModule.IDENTITY_AGENCY_PLACEHOLDER } }));
  const my = pageHeaders('/my/settings', { nonce });
  assert.deepEqual(
    Object.fromEntries(Object.entries(my).filter(([k]) => k !== 'Content-Security-Policy' && k !== 'Reporting-Endpoints')),
    PAGE_HEADERS.web,
  );
  assert.equal(pageHeaders('/staff', { nonce })['Referrer-Policy'], 'no-referrer', '스태프 화면은 no-referrer(§5.14.1 헤더 표)');
});

test('[ASVS v5.0.0-3.4.3] 요청 화면에 nonce가 없으면 헤더를 만들지 않는다(빈 nonce로 정책을 열지 않는다)', () => {
  assert.throws(() => pageHeaders('/my/settings', {}), /nonce/);
});

test('[ASVS v5.0.0-3.4.3] 경로 표에 없는 주소(없는 화면의 404 등)는 캐시 화면과 같은 헤더와 CSP 틀을 받는다(빠진 화면이 헤더 없이 나가지 않는다)', () => {
  assert.deepEqual(pageHeaders('/no/such/page'), pageHeaders('/search'));
  assert.equal(cachedCsp('/no/such/page')[CSP_TEMPLATE_HEADER], renderCsp('A', { hashes: [HASH_SENTINEL] }));
});

test('경로 처리기(route.ts)에는 화면 헤더를 붙이지 않는다', () => {
  assert.equal(pageHeaders('/logout', { nonce: newNonce() }), null);
  assert.equal(pageHeaders('/v1/identity/link-proposals/p-1', { nonce: newNonce() }), null);
});

test('[ASVS v5.0.0-3.4.6] 캐시 화면의 Referrer: 결제 복귀·본인확인 복귀·스태프 화면은 no-referrer, 본인확인 복귀는 COOP unsafe-none', () => {
  assert.equal(pageHeaders('/booking/e-1/checkout/return')['Referrer-Policy'], 'no-referrer');
  assert.equal(pageHeaders('/staff/approve')['Referrer-Policy'], 'no-referrer');
  const vr = pageHeaders('/verify/return');
  assert.equal(vr['Referrer-Policy'], 'no-referrer');
  assert.equal(vr['Cross-Origin-Opener-Policy'], 'unsafe-none');
  assert.equal(pageHeaders('/events/e-1')['Referrer-Policy'], 'strict-origin-when-cross-origin');
});

test('nonce 요청 헤더 이름은 x-nonce다(레이아웃이 읽는다)', () => {
  assert.equal(NONCE_HEADER, 'x-nonce');
});

test('[ASVS v5.0.0-3.4.3] 캐시 화면(A)은 해시 자리를 넣은 막는 CSP 틀을 안쪽 머리로 싣고(앞 서버가 응답 때 해시를 채운다, ADR-0193), 앞 서버 없이 뜬 때를 위해 보고 모드도 싣는다. 공연 상세는 사람 확인·본인확인 변형', () => {
  const home = cachedCsp('/');
  assert.equal(home['Content-Security-Policy'], undefined, '막는 CSP는 앞 서버가 해시를 채워 단다');
  assert.equal(home[CSP_TEMPLATE_HEADER], renderCsp('A', { hashes: [HASH_SENTINEL] }));
  assert.equal(home['Content-Security-Policy-Report-Only'], renderCsp('A', {}));
  assert.equal(home['Reporting-Endpoints'], REPORTING_ENDPOINTS);
  assert.equal(cachedCsp('/events/e-1')[CSP_TEMPLATE_HEADER], renderCsp('A', { variants: ['humanCheck', 'identityForm'], origins: { identity: headersModule.IDENTITY_AGENCY_PLACEHOLDER }, hashes: [HASH_SENTINEL] }));
  assert.deepEqual(cachedCsp('/my/settings'), {}, '요청 화면에는 주지 않는다');
  assert.deepEqual(cachedCsp('/logout'), {});
});

test('[ASVS v5.0.0-3.4.3] 로컬·CI에서 바꾼 제공자 issuer(PEAKET_OIDC_*_ISSUER)는 그 출처를 form-action에 넣고, 없으면 운영 출처(ADR-0215)', () => {
  assert.deepEqual(socialAuthOrigins({}), {});
  assert.deepEqual(socialAuthOrigins({ PEAKET_OIDC_KAKAO_ISSUER: 'http://127.0.0.1:18911/kakao', PEAKET_OIDC_GOOGLE_ISSUER: 'http://127.0.0.1:18911/google/' }), {
    kakaoAuth: 'http://127.0.0.1:18911',
    kakaoAccounts: 'http://127.0.0.1:18911',
    googleAuth: 'http://127.0.0.1:18911',
  });
  assert.deepEqual(socialAuthOrigins({ PEAKET_OIDC_NAVER_ISSUER: 'not a url' }), {}, '꼴이 틀리면 넣지 않는다(운영 출처 그대로)');
  const csp = pageHeaders('/login', { nonce: newNonce(), origins: socialAuthOrigins({ PEAKET_OIDC_NAVER_ISSUER: 'http://localhost:4030' }) })['Content-Security-Policy'];
  assert.ok(csp.includes("form-action 'self' https://kauth.kakao.com https://accounts.kakao.com http://localhost:4030 https://accounts.google.com;"), csp);
});

test('[ASVS v5.0.0-3.4.3] 추가 검증(SCR-009) 화면의 CSP: 이 응답의 nonce와 strict-dynamic, Turnstile 출처는 script-src·frame-src에만, object-src·base-uri·frame-ancestors none. 위젯이 없는 요청 화면에는 Turnstile 출처가 없다', () => {
  const nonce = newNonce();
  const csp = pageHeaders('/queue/evt-1/verify', { nonce })['Content-Security-Policy'];
  const dir = Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1)]));
  assert.ok(dir['script-src'].includes(`'nonce-${nonce}'`), csp);
  assert.ok(dir['script-src'].includes("'strict-dynamic'"), csp);
  assert.ok(!dir['script-src'].includes("'unsafe-inline'") && !dir['script-src'].includes("'unsafe-eval'"), csp);
  assert.ok(dir['script-src'].includes('https://challenges.cloudflare.com'), csp);
  assert.ok(dir['frame-src'].includes('https://challenges.cloudflare.com'), csp);
  for (const [k, v] of Object.entries(dir)) if (k !== 'script-src' && k !== 'frame-src') assert.ok(!v.includes('https://challenges.cloudflare.com'), k);
  assert.deepEqual([dir['object-src'], dir['base-uri'], dir['frame-ancestors']], [["'none'"], ["'none'"], ["'none'"]]);
  // 두 요청의 nonce는 다르다
  const other = newNonce();
  assert.notEqual(pageHeaders('/queue/evt-1/verify', { nonce: other })['Content-Security-Policy'], csp);
  for (const p of ['/my/settings', '/booking/evt-1/checkout', '/booking/evt-1/seats']) assert.doesNotMatch(pageHeaders(p, { nonce })['Content-Security-Policy'], /challenges\.cloudflare\.com/, p);
});

/** 정책 글 → 지시어 표 */
const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1)]));
/** 그 화면이 실제로 받는 막는 정책(요청 화면은 응답 머리, 캐시 화면은 앞 서버가 채울 틀) */
const effectiveCsp = (path, origins) => {
  const r = matchRoute(path);
  return r.group === 'cached' ? cachedCsp(path, { origins })[CSP_TEMPLATE_HEADER] : pageHeaders(path, { nonce: newNonce(), origins })['Content-Security-Policy'];
};
/** 본인확인기관 창(SCR-006)을 여는 화면(docs/frontend.md §5.14.1 '변형은 실제 화면에 걸려야 한다': 공연 상세·월렛·스태프 초대 수락·추가 검증, 그리고 그 버튼이 있는 주문·결제·계정 설정·가입 완료) */
const IDENTITY_PAGES = ['/events/e-1', '/my/tickets', '/my/tickets/t-1', '/staff/invitations', '/queue/e-1/verify', '/booking/e-1/checkout', '/my/settings', '/signup/consent'];

test('[ASVS v5.0.0-3.4.3] 본인확인기관 창을 여는 화면은 form-action에 본인확인기관 출처가 들고(로컬 모의 기관 출처를 넘기면 그 값), 그렇지 않은 화면에는 없다', () => {
  const MOCK_IDV = 'http://127.0.0.1:18920';
  for (const path of IDENTITY_PAGES) {
    assert.ok(matchRoute(path).variants?.includes('identityForm'), `${path}: identityForm 변형`);
    const local = directives(effectiveCsp(path, { identity: MOCK_IDV }))['form-action'];
    assert.ok(local?.includes(MOCK_IDV), `${path}: ${local}`);
    // 운영(값을 넘기지 않음): 연동 계약 전 자리 값. 예약 이름(.example)이라 누구의 출처도 아니다
    const prod = directives(effectiveCsp(path))['form-action'];
    assert.ok(prod?.includes(headersModule.IDENTITY_AGENCY_PLACEHOLDER), `${path}: ${prod}`);
    assert.match(String(headersModule.IDENTITY_AGENCY_PLACEHOLDER), /^https:\/\/[a-z0-9.-]+\.example$/);
  }
  // 기존 변형은 그대로 함께 실린다(사람 확인·소셜 로그인)
  assert.ok(directives(effectiveCsp('/queue/e-1/verify'))['script-src'].includes('https://challenges.cloudflare.com'));
  assert.ok(directives(effectiveCsp('/my/settings'))['form-action'].includes('https://kauth.kakao.com'));
  for (const path of ['/', '/search', '/my/likes', '/my/orders', '/login', '/booking/e-1/seats', '/booking/e-1/result', '/help/inquiries/new']) {
    const fa = directives(effectiveCsp(path, { identity: MOCK_IDV }))['form-action'] ?? [];
    assert.ok(!fa.includes(MOCK_IDV) && !fa.includes(String(headersModule.IDENTITY_AGENCY_PLACEHOLDER)), `${path}: ${fa}`);
  }
});

test('[ASVS v5.0.0-3.4.3] 본인확인기관 출처는 local·ci에서만 모의 기관 주소(PEAKET_TEST_VERIFICATION_URL)의 출처로 바꾸고, 그 밖에는 바꾸지 않는다', () => {
  const of = headersModule.identityAgencyOrigins;
  assert.equal(typeof of, 'function');
  assert.deepEqual(of({ PEAKET_ENV: 'local', PEAKET_TEST_VERIFICATION_URL: 'http://127.0.0.1:18920/verify' }), { identity: 'http://127.0.0.1:18920' });
  assert.deepEqual(of({ PEAKET_ENV: 'ci', PEAKET_TEST_VERIFICATION_URL: 'http://localhost:4020/verify?x=1' }), { identity: 'http://localhost:4020' });
  for (const env of [{ PEAKET_ENV: 'prod', PEAKET_TEST_VERIFICATION_URL: 'http://127.0.0.1:18920/verify' }, { PEAKET_ENV: 'staging', PEAKET_TEST_VERIFICATION_URL: 'https://idv.example/verify' }, { PEAKET_ENV: 'local' }, { PEAKET_ENV: 'local', PEAKET_TEST_VERIFICATION_URL: 'not a url' }, {}]) {
    assert.deepEqual(of(env), {}, JSON.stringify(env));
  }
});

test('[ASVS v5.0.0-3.4.3] 본인확인기관 출처가 틀린 꼴이면 그 출처만 빼고 경고하며 헤더 만들기를 던지지 않는다(웹 전체 500이 되지 않는다)', () => {
  const of = headersModule.identityAgencyOrigins;
  // PEAKET_TEST_VERIFICATION_URL: 자격 증명·와일드카드·http 바깥 호스트·다른 스킴·주소가 아님은 빠진다
  for (const raw of ['http://user:pw@127.0.0.1:18920/verify', 'http://*.idv.example/verify', 'http://idv.example/verify', 'ftp://127.0.0.1/verify', 'javascript:alert(1)', 'not a url']) {
    const warns = [];
    assert.deepEqual(of({ PEAKET_ENV: 'local', PEAKET_TEST_VERIFICATION_URL: raw }, (m) => warns.push(m)), {}, raw);
    assert.equal(warns.length, 1, `${raw}: 경고 한 줄`);
  }
  const build = headersModule.cspOriginsFromEnv;
  assert.equal(typeof build, 'function');
  // PEAKET_CSP_ORIGINS의 identity: 경로·자격 증명·와일드카드가 있거나 운영에서 http면 그 출처만 빠진다(다른 출처는 그대로)
  const cases = [
    [{ PEAKET_ENV: 'prod', PEAKET_CSP_ORIGINS: JSON.stringify({ identity: 'http://127.0.0.1:18920', img: 'https://img.cdn.example' }) }, 'http인데 운영'],
    [{ PEAKET_ENV: 'local', PEAKET_CSP_ORIGINS: JSON.stringify({ identity: 'https://idv.example/verify' }) }, '경로'],
    [{ PEAKET_ENV: 'staging', PEAKET_CSP_ORIGINS: JSON.stringify({ identity: 'https://*.idv.example' }) }, '와일드카드'],
    [{ PEAKET_ENV: 'local', PEAKET_CSP_ORIGINS: JSON.stringify({ identity: 'https://u:p@idv.example' }) }, '자격 증명'],
    [{ PEAKET_ENV: 'local', PEAKET_CSP_ORIGINS: JSON.stringify({ identity: 42 }) }, '글자가 아님'],
    [{ PEAKET_ENV: 'local', PEAKET_TEST_VERIFICATION_URL: 'http://idv.example/verify' }, '모의 기관 주소가 http 바깥 호스트'],
  ];
  for (const [env, why] of cases) {
    const warns = [];
    const origins = build(env, (m) => warns.push(m));
    assert.equal(origins?.identity, undefined, why);
    assert.equal(warns.length, 1, `${why}: 경고 한 줄`);
    // 웹 전체가 500이 아니다: 그 출처만 빠지고 자리 값으로 헤더를 만든다
    for (const path of ['/queue/e-1/verify', '/events/e-1', '/my/likes']) {
      const csp = effectiveCsp(path, origins);
      assert.ok(csp, `${why}: ${path}`);
      if (path !== '/my/likes') assert.ok(directives(csp)['form-action'].includes(headersModule.IDENTITY_AGENCY_PLACEHOLDER), `${why}: ${path}`);
    }
  }
  assert.equal(build(cases[0][0], () => undefined).img, 'https://img.cdn.example', '다른 출처는 그대로');
  // 맞는 꼴은 그대로 싣는다
  assert.equal(build({ PEAKET_ENV: 'prod', PEAKET_CSP_ORIGINS: JSON.stringify({ identity: 'https://idv.example:8443' }) }, () => assert.fail('경고 없음')).identity, 'https://idv.example:8443');
  assert.equal(build({ PEAKET_ENV: 'ci', PEAKET_TEST_VERIFICATION_URL: 'http://localhost:4020/verify' }, () => assert.fail('경고 없음')).identity, 'http://localhost:4020');
});

test('[ASVS v5.0.0-3.4.3] demo도 local·ci처럼 모의 기관 출처(PEAKET_TEST_VERIFICATION_URL)를 form-action에 싣는다(identity-svc 시험 어댑터의 ALLOWED_ENVS와 같다)', () => {
  assert.deepEqual(headersModule.identityAgencyOrigins({ PEAKET_ENV: 'demo', PEAKET_TEST_VERIFICATION_URL: 'http://127.0.0.1:4020/verify' }), { identity: 'http://127.0.0.1:4020' });
  const origins = headersModule.cspOriginsFromEnv({ PEAKET_ENV: 'demo', PEAKET_TEST_VERIFICATION_URL: 'http://127.0.0.1:4020/verify' }, () => assert.fail('경고 없음'));
  assert.ok(directives(effectiveCsp('/queue/e-1/verify', origins))['form-action'].includes('http://127.0.0.1:4020'));
  for (const env of ['prod', 'staging', undefined]) assert.deepEqual(headersModule.identityAgencyOrigins({ PEAKET_ENV: env, PEAKET_TEST_VERIFICATION_URL: 'http://127.0.0.1:4020/verify' }), {}, String(env));
});
