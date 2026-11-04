// 소비자 웹 화면 묶음별 보안 헤더 시험(docs/frontend.md §2.5·§5.14.1, ADR-0065 결정 4, BUILD_ORDER HOT-290).
// 실행: pnpm --filter @peaket/web test. 타입 지우기로 .ts를 그대로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PAGE_HEADERS, REPORTING_ENDPOINTS, renderCsp } from '@peaket/config/headers/security-headers.mjs';
import { NONCE_HEADER, ROUTES, cachedCsp, matchRoute, newNonce, pageHeaders } from './page-headers.ts';
import { CSP_TEMPLATE_HEADER, HASH_SENTINEL } from '../../../server/csp-template.mjs';

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

test('[ASVS v5.0.0-3.4.3] 요청마다 그리는 화면의 묶음: 좌석 F, 주문·결제 E, 나머지 B(사람 확인 화면은 Turnstile 변형)', () => {
  assert.equal(matchRoute('/booking/e-1/seats').bundle, 'F');
  assert.equal(matchRoute('/booking/e-1/checkout').bundle, 'E');
  assert.equal(matchRoute('/shop/checkout').bundle, 'E');
  assert.equal(matchRoute('/my/settings').bundle, 'B');
  assert.equal(matchRoute('/login').bundle, 'B');
  assert.deepEqual(matchRoute('/queue/e-1/verify').variants, ['humanCheck']);
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
  assert.equal(pay['Content-Security-Policy'], renderCsp('E', { nonce }));
  assert.equal(pay['Referrer-Policy'], 'no-referrer');
  const verify = pageHeaders('/queue/e-1/verify', { nonce });
  assert.equal(verify['Content-Security-Policy'], renderCsp('B', { nonce, variants: ['humanCheck'] }));
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

test('[ASVS v5.0.0-3.4.3] 캐시 화면(A)은 해시 자리를 넣은 막는 CSP 틀을 안쪽 머리로 싣고(앞 서버가 응답 때 해시를 채운다, ADR-0193), 앞 서버 없이 뜬 때를 위해 보고 모드도 싣는다. 공연 상세는 사람 확인 변형', () => {
  const home = cachedCsp('/');
  assert.equal(home['Content-Security-Policy'], undefined, '막는 CSP는 앞 서버가 해시를 채워 단다');
  assert.equal(home[CSP_TEMPLATE_HEADER], renderCsp('A', { hashes: [HASH_SENTINEL] }));
  assert.equal(home['Content-Security-Policy-Report-Only'], renderCsp('A', {}));
  assert.equal(home['Reporting-Endpoints'], REPORTING_ENDPOINTS);
  assert.equal(cachedCsp('/events/e-1')[CSP_TEMPLATE_HEADER], renderCsp('A', { variants: ['humanCheck'], hashes: [HASH_SENTINEL] }));
  assert.deepEqual(cachedCsp('/my/settings'), {}, '요청 화면에는 주지 않는다');
  assert.deepEqual(cachedCsp('/logout'), {});
});
