// 관제 콘솔 운영 빌드의 보안 헤더와 Trusted Types(F-03-1 OPS-340 T11·T12, docs/frontend.md §5.14.1 '[C 관제 콘솔]'·'Trusted Types', ADR-0360 결정 6·8).
// 미리보기 서버가 운영 빌드(호스트 + 원격 둘)를 운영 배포 응답 헤더와 같은 헤더로 낸다. 화면마다 늦게 싣는 덩어리를 받고, 대시보드에서 원격 둘의
// 진입 파일·위젯 덩어리를 실을 때 CSP 위반(막는 모드)과 Trusted Types 위반(보고 모드)이 0이고, 페이지가 만든 정책 이름이 정본 목록 안이며 겹치지 않는지 본다.
// 목록에 없는 원격 주소의 거절(FE-T39 셋째 판정)은 remotes.json과 함께 F-03-2가 본다.
import { test, expect } from '@playwright/test';
import { PAGE_HEADERS, REPORTING_ENDPOINTS, staticAppHeaders } from '../../../packages/config/headers/security-headers.mjs';
import { HOST } from '../seed-css/apps.mjs';
import { CONSOLE_PORT } from '../playwright.console-csp.config.mjs';

const BASE = `http://${HOST}:${CONSOLE_PORT}`;
const UUID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
/** 정본 §5.14.1 [C 관제 콘솔]의 Trusted Types 이름 목록(원격 이름은 queue·purchase) */
const CONSOLE_POLICIES = ['peaket', 'peaket-webpack-host', 'peaket-webpack-queue', 'peaket-webpack-purchase', 'peaket-remote', 'default'];
/** 화면(주소 → 늦게 싣는 화면 덩어리 이름, apps/console-host/src/app/router.tsx의 webpackChunkName) */
const SCREENS = [
  ['/login', 'scr-028'],
  ['/dashboard', 'scr-029'],
  ['/commands', 'scr-030'],
  ['/audit', 'scr-031'],
  ['/compliance', 'scr-032'],
  ['/cs/inbox', 'scr-045'],
  ['/cs/approvals', 'scr-046'],
  [`/cancellations/${UUID}`, 'scr-047'],
  [`/sale-reviews/${UUID}`, 'scr-048'],
  ['/settlements', 'scr-049'],
  ['/scanner-devices', 'scr-053'],
  ['/investigations', 'scr-070'],
  [`/investigations/${UUID}`, 'scr-071'],
  ['/accounts', 'scr-064'],
  ['/partners', 'scr-065'],
  ['/customers', 'scr-066'],
  ['/bot-review', 'scr-067'],
  ['/notices', 'scr-068'],
  ['/no-such-screen', 'scr-059'],
];

/** 위반 보고(securitypolicyviolation)와 만든 정책 이름을 적는다. 페이지를 새로 열 때마다 비워진다 */
async function track(page) {
  await page.addInitScript(() => {
    window.__csp = [];
    window.__ttNames = [];
    document.addEventListener('securitypolicyviolation', (e) => window.__csp.push({ directive: e.effectiveDirective, disposition: e.disposition, blocked: e.blockedURI, sample: (e.sample || '').slice(0, 80) }));
    const tt = window.trustedTypes;
    if (tt?.createPolicy) {
      const create = tt.createPolicy.bind(tt);
      tt.createPolicy = (name, rules) => {
        window.__ttNames.push(name);
        return create(name, rules);
      };
    }
  });
  return () => page.evaluate(() => ({ violations: window.__csp, names: window.__ttNames }));
}

const directives = (csp) => Object.fromEntries(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(/\s+/)[0], d.split(/\s+/).slice(1)]));

test('F-03-1 T11 [ASVS v5.0.0-3.4.3][ASVS v5.0.0-3.4.5][ASVS v5.0.0-3.4.6][ASVS v5.0.0-3.4.7][ASVS v5.0.0-3.4.8][ASVS v5.0.0-3.7.1] 관제 미리보기 서버의 화면·원격 진입 파일 응답 헤더가 staticAppHeaders(console)와 같고 정본 묶음 C 값이다', async ({ request }) => {
  const want = staticAppHeaders('console');
  for (const path of ['/login', '/dashboard', '/commands', `/investigations/${UUID}`, '/remotes/queue/remoteEntry.js']) {
    const res = await request.get(`${BASE}${path}`);
    expect(res.status(), path).toBe(200);
    const h = res.headers();
    for (const [k, v] of Object.entries(want)) expect(h[k.toLowerCase()], `${path} ${k}`).toBe(v);
    // 정본 글 상자 값(코드 값과 따로 본다)
    const d = directives(h['content-security-policy']);
    expect(d['default-src'], path).toEqual(["'none'"]);
    expect(d['object-src'], path).toEqual(["'none'"]);
    expect(d['base-uri'], path).toEqual(["'none'"]);
    expect(d['frame-ancestors'], path).toEqual(["'none'"]);
    expect(d['report-to'], path).toEqual(['csp']);
    expect(d['form-action'], path).toEqual(["'self'"]);
    expect(h['content-security-policy-report-only'], path).toBe(`require-trusted-types-for 'script'; trusted-types ${CONSOLE_POLICIES.join(' ')}; report-to csp`);
    expect(h['reporting-endpoints'], path).toBe(REPORTING_ENDPOINTS);
    expect(h['referrer-policy'], path).toBe(PAGE_HEADERS.console['Referrer-Policy']);
    expect(h['referrer-policy'], path).toBe('no-referrer');
    expect(h['cross-origin-opener-policy'], path).toBe('same-origin');
    expect(h['x-content-type-options'], path).toBe('nosniff');
  }
});

test('F-03-1 T12 [ASVS v5.0.0-3.2.2] 관제 운영 빌드를 묶음 C 헤더로 열어 화면 덩어리와 원격 둘을 실을 때 CSP·Trusted Types 위반 0이고 정책 이름이 목록 안이며 겹치지 않는다', async ({ page }) => {
  const read = await track(page);
  const names = new Set();
  const seen = new Set();
  for (const [path, chunk] of SCREENS) {
    const chunkLoaded = seen.has(chunk) ? Promise.resolve() : page.waitForResponse((r) => new RegExp(`/assets/${chunk}\\.[0-9a-f]+\\.chunk\\.js$`).test(new URL(r.url()).pathname) && r.status() === 200);
    await page.goto(`${BASE}${path}`);
    await chunkLoaded;
    seen.add(chunk);
    await expect(page.locator('#root')).not.toBeEmpty();
    const got = await read();
    expect(got.violations, `${path} 위반`).toEqual([]);
    // 한 페이지 안에서 같은 이름을 두 번 만들지 않는다(onPolicyCreationFailure 'stop'이면 적재가 멈춘다)
    expect(new Set(got.names).size, `${path} 정책 이름 겹침 ${JSON.stringify(got.names)}`).toBe(got.names.length);
    for (const n of got.names) names.add(n);
  }
  expect(seen.size).toBe(new Set(SCREENS.map(([, c]) => c)).size);

  // 대시보드 판매 중 탭: 원격 둘의 진입 파일과 위젯 덩어리를 실제로 싣는다(peaket-remote·peaket-webpack-<원격> 정책)
  const remoteLoads = ['queue', 'purchase'].flatMap((r) => [
    page.waitForResponse((x) => new URL(x.url()).pathname === `/remotes/${r}/remoteEntry.js` && x.status() === 200),
    page.waitForResponse((x) => new RegExp(`^/remotes/${r}/w-[a-z-]+\\.[0-9a-f]+\\.chunk\\.js$`).test(new URL(x.url()).pathname) && x.status() === 200),
  ]);
  await page.goto(`${BASE}/dashboard?tab=live`);
  await Promise.all(remoteLoads);
  await expect(page.locator('[data-remote="queue"]')).toHaveCount(1);
  await expect(page.locator('[data-remote="purchase"]')).toHaveCount(1);
  const dash = await read();
  expect(dash.violations, '대시보드(원격 둘) 위반').toEqual([]);
  expect(new Set(dash.names).size).toBe(dash.names.length);
  for (const n of dash.names) names.add(n);
  expect(dash.names).toEqual(expect.arrayContaining(['peaket-webpack-host', 'peaket-remote', 'peaket-webpack-queue', 'peaket-webpack-purchase']));
  expect([...names].filter((n) => !CONSOLE_POLICIES.includes(n)), `목록 밖 정책 이름: ${JSON.stringify([...names])}`).toEqual([]);
});
