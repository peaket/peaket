// FE-T25 콘솔 덩어리 나눔(F-03-2 OPS-360 T11). 운영 빌드(관제 4103·파트너 4102, seed-css/apps.mjs)에서 본다.
// 정본: docs/frontend.md §5.17 FE-T25(관제 첫 화면 묶음에 다른 화면 덩어리가 있는지, 화면 덩어리 크기, 파트너 첫 화면 묶음에 에디터·시뮬레이터·그래프가 있는지,
// 파트너·관제 묶음에 끌어 놓기 라이브러리가 있는지 → 관제 화면 덩어리 80KB 이하 [가정], 첫 화면 묶음에 늦게 싣는 부분 0), §5.8 관제 콘솔 '화면으로 처음 이동할 때
// 더 받는 덩어리마다 80KB [가정]', ADR-0091 결정 1·2(화면별 lazy, 늦게 싣는 부분은 에디터·시뮬레이터·그래프·서식 글 편집기, 끌어 놓기 목록은 없앰), ADR-0361 결정 10.
// 상한은 정본 표에서 읽는다. 늦게 싣는 부분의 표지는 같은 빌드의 늦게 싣는 덩어리 하나에서 실제로 찾아져야 한다(짝 확인, 아무것도 못 찾는 검사가 늘 통과하지 않게).
// '화면으로 처음 이동할 때 더 받는 JS'는 그 화면으로 바로 들어갈 때 받은 스크립트에서 첫 HTML 스크립트와 셸 덩어리(셸 안 모든 화면이 함께 받는 덩어리)를 뺀 것이다
// (다른 화면에서 옮겨 올 때 더 받는 양의 위 끝). 대시보드 2초 뒤 미리 받기(ADR-0091 결정 1)가 섞이지 않게 화면이 그려진 순간까지만 센다.
import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { APPS, HOST, portOf, scriptSrcs } from '../seed-css/apps.mjs';
import { gzipKB } from '../seed-css/check-css.mjs';
import { parseBudgetRows, repoRoot } from '../lib/canon.mjs';

test.use({ viewport: { width: 1600, height: 1000 } });

const consoleRow = parseBudgetRows(readFileSync(path.join(repoRoot, 'docs/frontend.md'), 'utf8')).find((r) => r['경로 묶음'] === '관제 콘솔');
/** §5.8 관제 콘솔 '화면으로 처음 이동할 때 더 받는 덩어리마다 nKB [가정]'·'호스트 nKB [가정]'(첫 화면) */
const SCREEN_KB = Number(/더 받는 덩어리마다 (\d+)KB/.exec(consoleRow?.['첫 JS'] ?? '')?.[1]);
const HOST_KB = Number(/호스트 (\d+)KB/.exec(consoleRow?.['첫 JS'] ?? '')?.[1]);
const UUID = '0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01';
/** 관제 화면(주소 → 그 화면의 경로 덩어리 이름, apps/console-host/src/app/router.tsx webpackChunkName). 로그인은 셸 밖이다 */
const SCREENS = [
  ['/login', 'scr-028'],
  ['/dashboard?tab=live', 'scr-029'],
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
const chunkName = (p) => /^\/assets\/(scr-\d+(?:-[a-z]+)?)\.[0-9a-f]+\.chunk\.js$/.exec(p)?.[1];

/** 한 화면으로 바로 들어가 그 화면이 그려질 때까지 받은 같은 출처 스크립트 경로 */
async function scriptsOf(browser, origin, url, chunk) {
  const ctx = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
  const page = await ctx.newPage();
  const got = [];
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.origin === origin && r.request().resourceType() === 'script' && r.status() === 200) got.push(u.pathname);
  });
  try {
    const own = page.waitForResponse((r) => new URL(r.url()).pathname.startsWith(`/assets/${chunk}.`) && r.status() === 200);
    await page.goto(origin + url);
    await own;
    await expect(page.locator('#root')).not.toBeEmpty();
    // 대시보드는 배치별 보드 덩어리까지 그려야 화면이다
    if (chunk === 'scr-029') await expect(page.getByRole('tab', { name: /판매 중/ })).toBeVisible();
    return [...new Set(got)];
  } finally {
    await ctx.close();
  }
}

test('F-03-2 T11 FE-T25 ① 관제: 로그인·대시보드 첫 화면에 다른 화면 덩어리가 없고(첫 화면 전체가 호스트 예산 안), 화면으로 처음 이동할 때 더 받는 JS가 화면마다 정본 상한(gzip) 안이다', async ({ browser, request }) => {
  expect(SCREEN_KB, '§5.8 관제 콘솔 화면 덩어리 예산').toBeGreaterThan(0);
  expect(HOST_KB, '§5.8 관제 콘솔 호스트 예산').toBeGreaterThan(SCREEN_KB);
  const app = APPS.find((a) => a.name === 'console');
  const origin = `http://${HOST}:${portOf(app, 'prod')}`;
  const html = await (await request.get(`${origin}/login`)).text();
  const initial = new Set(scriptSrcs(html).map((s) => new URL(s, origin).pathname));
  expect(initial.size).toBeGreaterThan(0);
  const loaded = new Map();
  for (const [url, chunk] of SCREENS) loaded.set(url, await scriptsOf(browser, origin, url, chunk));
  // 첫 화면(로그인·대시보드)에는 자기 화면 덩어리만(대시보드는 배치별 보드 scr-029-d 포함)
  expect(loaded.get('/login').map(chunkName).filter(Boolean)).toEqual(['scr-028']);
  expect(loaded.get('/dashboard?tab=live').map(chunkName).filter(Boolean).sort()).toEqual(['scr-029', 'scr-029-d']);
  // 셸 덩어리: 셸 안 모든 화면이 함께 받는 것(첫 HTML 스크립트 빼고)
  const inShell = SCREENS.filter(([u]) => u !== '/login').map(([u]) => loaded.get(u));
  const shell = new Set(inShell[0].filter((p) => !initial.has(p) && inShell.every((l) => l.includes(p))));
  // 짝 확인: 셸 덩어리에 화면 덩어리가 섞이지 않았다
  expect([...shell].map(chunkName).filter(Boolean)).toEqual([]);
  const kbOf = async (paths) => {
    const texts = [];
    for (const p of paths) texts.push(await (await request.get(origin + p)).text());
    return gzipKB(texts);
  };
  // 첫 화면 묶음(로그인으로 들어온 첫 화면·대시보드로 바로 들어온 첫 화면)은 받은 스크립트 전체가 호스트 예산 안
  const first = { '/login': await kbOf(loaded.get('/login')), '/dashboard?tab=live': await kbOf(loaded.get('/dashboard?tab=live')) };
  expect(Object.entries(first).filter(([, kb]) => kb > HOST_KB), `첫 화면 ${HOST_KB}kB 넘음: ${JSON.stringify(first)}`).toEqual([]);
  const sizes = {};
  for (const [url, chunk] of SCREENS.filter(([u]) => u !== '/login')) {
    const extra = loaded.get(url).filter((p) => !initial.has(p) && !shell.has(p));
    // 그 화면 덩어리가 그 안에 있다(가르기 짝 확인)
    expect(extra.map(chunkName), url).toContain(chunk);
    // 다른 화면의 경로 덩어리를 함께 받지 않는다
    expect(extra.map(chunkName).filter((n) => n && !n.startsWith(chunk)), `${url}이 다른 화면 덩어리를 받는다`).toEqual([]);
    sizes[url] = await kbOf(extra);
  }
  const over = Object.entries(sizes).filter(([, kb]) => kb > SCREEN_KB);
  expect(over, `화면 덩어리 ${SCREEN_KB}kB 넘음: ${JSON.stringify(sizes)}`).toEqual([]);
});

/** 파트너 운영 빌드의 모든 덩어리(.next/static) */
function partnerChunks() {
  const root = path.join(repoRoot, 'apps/partner/.next/static');
  const out = [];
  const walk = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n);
      if (statSync(p).isDirectory()) walk(p);
      else if (n.endsWith('.js')) out.push({ path: `/_next/static/${path.relative(root, p).split(path.sep).join('/')}`, text: readFileSync(p, 'utf8') });
    }
  };
  walk(root);
  return out;
}

/** 늦게 싣는 부분의 표지(그 라이브러리 배포 파일에만 있는 글자) */
const LAZY_PARTS = {
  '에디터(Konva)': 'konvajs-content',
  '서식 글 편집기(Lexical)': '__lexicalEditor',
};
/** 지금 파트너 빌드에 없는 늦게 싣는 부분: 첫 화면에 없음만 본다(그 부분을 만드는 기능이 위 표로 옮긴다) */
const NOT_YET = { '그래프(Chart.js)': 'Canvas is already in use' };
const PARTNER_PATHS = ['/events', '/events/new', `/events/${UUID}/seatmap`];

test('F-03-2 T11 FE-T25 ② 파트너: 에디터·서식 글 편집기 경로의 첫 화면 스크립트에 그 부분이 없고 같은 빌드의 늦게 싣는 덩어리에 있다(그래프는 첫 화면에 없다)', async ({ request }) => {
  const app = APPS.find((a) => a.name === 'partner');
  const origin = `http://${HOST}:${portOf(app, 'prod')}`;
  const all = partnerChunks();
  expect(all.length).toBeGreaterThan(10);
  const initialAll = new Set();
  for (const p of PARTNER_PATHS) {
    const res = await request.get(origin + p, { maxRedirects: 0 });
    expect(res.status(), p).toBe(200);
    const initial = scriptSrcs(await res.text()).map((s) => new URL(s, origin + p).pathname);
    expect(initial.length, p).toBeGreaterThan(0);
    for (const i of initial) initialAll.add(i);
    const texts = [];
    for (const i of initial) texts.push(await (await request.get(origin + i)).text());
    for (const [part, mark] of Object.entries({ ...LAZY_PARTS, ...NOT_YET })) expect(texts.some((t) => t.includes(mark)), `${p} 첫 화면에 ${part}`).toBe(false);
  }
  for (const [part, mark] of Object.entries(LAZY_PARTS)) {
    const holders = all.filter((c) => c.text.includes(mark)).map((c) => c.path);
    expect(holders.length, `짝 확인: 빌드에 ${part} 덩어리가 있다`).toBeGreaterThan(0);
    expect(holders.filter((h) => initialAll.has(h)), `${part} 덩어리가 첫 화면 묶음에 있다`).toEqual([]);
  }
});

/** 끌어 놓기 라이브러리 표지(@hello-pangea/dnd·react-beautiful-dnd의 data-rfd-·data-rbd- 속성, dnd-kit의 낭독기 자리 id) */
const DND_MARKS = ['data-rfd-drag-handle', 'data-rbd-drag-handle', 'DndDescribedBy', 'DndLiveRegion'];
const DND_PACKAGES = ['@hello-pangea/dnd', 'react-beautiful-dnd', '@dnd-kit/core', '@dnd-kit/sortable', 'react-dnd', 'sortablejs'];

test('F-03-2 T11 FE-T25 ③ 파트너·관제 어느 덩어리에도 끌어 놓기 라이브러리가 없고 두 앱 의존에도 없다(기술 검토 낮음-098)', () => {
  const consoleDir = path.join(repoRoot, 'apps/console-host/dist/assets');
  const consoleJs = readdirSync(consoleDir).filter((f) => f.endsWith('.js')).map((f) => readFileSync(path.join(consoleDir, f), 'utf8'));
  const partnerJs = partnerChunks().map((c) => c.text);
  expect(consoleJs.length).toBeGreaterThan(10);
  for (const mark of DND_MARKS) {
    expect(consoleJs.some((t) => t.includes(mark)), `관제에 ${mark}`).toBe(false);
    expect(partnerJs.some((t) => t.includes(mark)), `파트너에 ${mark}`).toBe(false);
  }
  for (const pkg of ['apps/partner', 'apps/console-host', 'apps/widgets/queue', 'apps/widgets/purchase', 'packages/ds']) {
    const json = JSON.parse(readFileSync(path.join(repoRoot, pkg, 'package.json'), 'utf8'));
    const deps = Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies });
    expect(deps.filter((d) => DND_PACKAGES.includes(d)), pkg).toEqual([]);
  }
});
