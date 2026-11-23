// FE-T39 관제 Trusted Types 보고 모드 시작 조건(F-03-2 OPS-350 T5)과 원격 실패 보안 사건(T7, ASVS 16.3.3). Chromium(그 기능을 아는 대표 엔진).
// 정본: docs/frontend.md §5.17 FE-T39(운영 빌드를 묶음 C 헤더로 열어 화면 덩어리와 remotes.json의 원격을 모두 싣고, 원격 하나의 주소를 목록에 없는 주소로
// 바꿔 싣는다 → 위반 보고 0, 만든 정책 이름이 모두 trusted-types 목록 안이고 겹치지 않는다, 목록에 없는 원격 주소는 peaket-remote가 거절한다),
// §5.14.1 [C 관제 콘솔] 'Trusted Types' 이름 목록과 '붙인 곳'(peaket-remote는 읽은 remotes.json의 정식 주소만, 원격 webpack 정책은 한 파일이라 만들지 않는다),
// §5.7 '원격 실패'·§5.16(remote_load_failed_total{remote, reason}을 같은 출처 /_t/rum counters로), §5.14.1 공통(report-to csp, Reporting-Endpoints csp="/_t/csp").
// 목록 밖 진입 주소는 항목 검사(parseRemoteList)가 먼저 거절해 정책까지 가지 않는다(정책 판정 자체는 remote-policy.test.mjs T5 ②가 본다).
import { test, expect } from '@playwright/test';
import { cpSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { countRequests, entryFile, entryOf, flipOneByte, stage, trackPolicies, trackRemoteScripts, writeList } from './forge.mjs';

const UUID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
/** 정본 §5.14.1 [C 관제 콘솔]의 Trusted Types 이름 목록(원격 이름은 queue·purchase) */
const CONSOLE_POLICIES = ['peaket', 'peaket-webpack-host', 'peaket-webpack-queue', 'peaket-webpack-purchase', 'peaket-remote', 'default'];
/** 화면(주소 → 늦게 싣는 화면 덩어리 이름, apps/console-host/src/app/router.tsx의 webpackChunkName). 화면 16개와 로그인·대시보드·없는 화면 */
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
const DASH = '/dashboard?tab=live';

let s;
test.afterEach(async () => {
  await s?.close();
  s = undefined;
});

test('F-03-2 T5 FE-T39 ① 운영 빌드의 화면 덩어리와 remotes.json의 원격 둘을 실을 때 Trusted Types·CSP 위반 0이고 정책 이름이 목록 안이며 겹치지 않는다', async ({ page }) => {
  s = await stage();
  const read = await trackPolicies(page);
  const names = new Set();
  const seen = new Set();
  for (const [p, chunk] of SCREENS) {
    const chunkLoaded = seen.has(chunk) ? Promise.resolve() : page.waitForResponse((r) => new RegExp(`/assets/${chunk}\\.[0-9a-f]+\\.chunk\\.js$`).test(new URL(r.url()).pathname) && r.status() === 200);
    await page.goto(`${s.origin}${p}`);
    await chunkLoaded;
    seen.add(chunk);
    await expect(page.locator('#root')).not.toBeEmpty();
    const got = await read();
    expect(got.violations, `${p} 위반`).toEqual([]);
    expect(new Set(got.names).size, `${p} 정책 이름 겹침 ${JSON.stringify(got.names)}`).toBe(got.names.length);
    for (const n of got.names) names.add(n);
  }
  expect(seen.size).toBe(new Set(SCREENS.map(([, c]) => c)).size);
  // 판매 중 탭: remotes.json의 정식 주소로 원격 둘을 싣는다(한 파일이라 위젯 덩어리를 따로 받지 않는다)
  const loads = s.list.map((e) => page.waitForResponse((x) => new URL(x.url()).pathname === e.entry && x.status() === 200));
  const req = countRequests(page, s.origin);
  await page.goto(s.origin + DASH);
  await Promise.all(loads);
  await expect(page.locator('[data-remote="queue"]')).toHaveCount(1);
  await expect(page.locator('[data-remote="purchase"]')).toHaveCount(1);
  expect(req.count(/^\/remotes\/[^/]+\/[0-9a-f]+\/(?!remoteEntry\.js$)/), '원격 덩어리를 따로 받지 않는다').toBe(0);
  const dash = await read();
  expect(dash.violations, '대시보드(원격 둘) 위반').toEqual([]);
  expect(dash.names.filter((n) => n === 'peaket-remote'), 'peaket-remote는 한 번만 만든다').toEqual(['peaket-remote']);
  expect(dash.names).toContain('peaket-webpack-host');
  expect(new Set(dash.names).size).toBe(dash.names.length);
  for (const n of dash.names) names.add(n);
  expect([...names].filter((n) => !CONSOLE_POLICIES.includes(n)), `목록 밖 정책 이름: ${JSON.stringify([...names])}`).toEqual([]);
});

test('F-03-2 T5 FE-T39 ② 원격 하나의 주소를 목록 정식 주소와 다르게 주면(서버에 있는 다른 sha 경로·쿼리) 그 주소로 요청이 없고 그 칸만 대체 카드이며 위반이 없다', async ({ page }) => {
  for (const variant of ['other-sha', 'query']) {
    const st = await stage((dir, list) => {
      const q = entryOf(list, 'queue');
      if (variant === 'other-sha') {
        // 같은 바이트를 다른 sha 폴더에 두고(서버가 실제로 내주는 주소) 목록의 entry만 그쪽으로 돌린다. sha 칸은 그대로라 정식 주소와 다르다
        const other = path.join(dir, 'remotes/queue/ffffffffffff');
        mkdirSync(other, { recursive: true });
        cpSync(entryFile(dir, q), path.join(other, 'remoteEntry.js'));
        q.entry = '/remotes/queue/ffffffffffff/remoteEntry.js';
      } else q.entry = `${q.entry}?v=2`;
      writeList(dir, list);
    });
    const ctx = await page.context().browser().newContext();
    const pg = await ctx.newPage();
    try {
      const read = await trackPolicies(pg);
      const tries = await trackRemoteScripts(pg);
      const req = countRequests(pg, st.origin);
      await pg.goto(st.origin + DASH);
      const card = pg.getByRole('region', { name: '입장 비율·빈자리' }).filter({ hasText: '이 위젯만 불러오지 못했습니다' });
      await expect(card, variant).toHaveAttribute('data-remote-fail', 'list');
      await expect(pg.locator('[data-remote="purchase"]'), variant).toHaveCount(1);
      expect(req.count(/^\/remotes\/queue\//), `${variant}: 목록 밖 주소로 요청이 없다`).toBe(0);
      expect(await tries.count(entryOf(st.list, 'queue').entry.split('?')[0]), variant).toBe(0);
      const got = await read();
      expect(got.violations, variant).toEqual([]);
      expect(await pg.evaluate(() => typeof window.peaket_widget_queue), variant).toBe('undefined');
    } finally {
      await ctx.close();
      await st.close();
    }
  }
});

test('F-03-2 T7 [ASVS v5.0.0-16.3.3] 무결성 실패는 같은 출처 /_t/rum counters에 remote_load_failed_total{queue, integrity} 1로 한 번 실리고 다른 값이 없으며, 관제 응답에 보고 머리가 있다', async ({ page }) => {
  s = await stage((dir, list) => void flipOneByte(dir, entryOf(list, 'queue')));
  const rum = [];
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (r.method() === 'POST' && u.pathname === '/_t/rum') rum.push(r);
  });
  const res = await page.goto(s.origin + DASH);
  await expect(page.getByRole('region', { name: '입장 비율·빈자리' }).filter({ hasText: '이 위젯만 불러오지 못했습니다' })).toHaveAttribute('data-remote-fail', 'integrity');
  await expect.poll(() => rum.length).toBe(1);
  const r = rum[0];
  expect(new URL(r.url()).origin, '같은 출처').toBe(s.origin);
  const body = r.postDataJSON();
  expect(Object.keys(body).sort()).toEqual(['app', 'counters', 'eventKey', 'route', 'schemaVersion']);
  expect(body).toEqual({
    schemaVersion: 2,
    eventKey: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
    app: 'console',
    route: '/dashboard',
    counters: [{ name: 'remote_load_failed_total', labels: { remote: 'queue', reason: 'integrity' }, value: 1 }],
  });
  // 주소·쿼리·쿠키·Referer를 싣지 않는다
  expect(r.postData()).not.toContain('tab=live');
  expect(r.postData()).not.toContain('/remotes/');
  const h = await r.allHeaders();
  expect(h.cookie).toBeUndefined();
  expect(h.referer).toBeUndefined();
  // 관제 응답 머리: 위반 보고 받는 곳(정본 §5.14.1 공통)
  const headers = res.headers();
  expect(headers['reporting-endpoints']).toBe('csp="/_t/csp"');
  expect(headers['content-security-policy']).toMatch(/(^|;\s*)report-to csp(;|$)/);
});
