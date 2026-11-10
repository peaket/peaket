// 첫 화면 JS 예산(docs/frontend.md §5.8 '첫 JS' 열, BUILD_ORDER BAS-220): 앱 다섯의 운영 빌드에서 첫 화면 HTML이 싣는 스크립트
// (`<script src>`·modulepreload·script preload)를 받아 gzip 크기를 경로 묶음 예산과 견준다. 브라우저를 띄우지 않는다.
// Next.js 경로마다 실리는 덩어리 이름이 빌드마다 바뀌는 해시라 파일 경로로 고르는 size-limit 대신 HTML에서 모은다(CSS 열과 같은 까닭).
// 대기실 경량 페이지(FE-T1)는 파일 이름이 정해져 있어 size-limit이 본다(apps/web/queue-room/.size-limit.json).
// 예산을 넘은 경로는 이 숫자를 다시 정하는 wbs 7.5.2까지 기준선 + 1kB [가정]를 넘지 않게만 막는다(js-baseline.json).
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { APPS, HOST, portOf, scriptSrcs } from '../seed-css/apps.mjs';
import { gzipKB } from '../seed-css/check-css.mjs';
import { loadJsBudgets } from '../lib/canon.mjs';
import { JS_OVER_BUDGET_MARGIN, jsLimit } from './limits.mjs';

const budgets = loadJsBudgets();
const baseline = JSON.parse(readFileSync(new URL('./js-baseline.json', import.meta.url), 'utf8')).pages ?? {};
const sizesDir = new URL('../reports/sizes-js/', import.meta.url);

for (const app of APPS) {
  const origin = `http://${HOST}:${portOf(app, 'prod')}`;
  for (const page of app.pages) {
    const key = `${app.name} ${page.path}`;
    test(`§5.8 첫 JS ${key}: 첫 화면 JS(gzip)가 '${page.row}' 예산(넘은 경로는 기준선 + ${JS_OVER_BUDGET_MARGIN}kB) 안이다`, async ({ request }) => {
      const res = await request.get(origin + page.path, { maxRedirects: 0 });
      expect(res.status(), `${origin}${page.path} HTML`).toBe(200);
      const srcs = scriptSrcs(await res.text());
      expect(srcs.length, '스크립트가 없다').toBeGreaterThan(0);
      const files = [];
      for (const src of srcs) {
        const js = await request.get(new URL(src, origin + page.path).href);
        expect(js.status(), src).toBe(200);
        files.push(await js.text());
      }
      const kb = gzipKB(files);
      const budget = budgets.get(page.row);
      expect(budget, `§5.8에 '${page.row}' 행이 없다`).toBeDefined();
      const limit = jsLimit(budget, baseline[key]);
      mkdirSync(sizesDir, { recursive: true });
      const record = { key, row: page.row, kB: kb, budget, limit, overBudget: kb > budget, files: files.length };
      writeFileSync(new URL(`${key.replace(/[^A-Za-z0-9-]+/g, '_')}.json`, sizesDir), `${JSON.stringify(record)}\n`);
      expect(kb, `${key}: ${kb}kB > 한도 ${limit}kB(§5.8 '${page.row}' 첫 JS ${budget}kB)`).toBeLessThanOrEqual(limit);
    });
  }
}

/** 좌석맵 에디터의 늦게 싣는 덩어리 예산(gzip KB, docs/frontend.md §5.6 표 300KB [가정]) */
const EDITOR_LAZY_KB = 300;
const EDITOR_PATH = '/events/0b8f1f2e-4a1d-4c1e-9b5a-1f0a2b3c4e01/seatmap';
/** Konva 배포 파일에만 있는 글자(Stage를 만들 때 붙이는 클래스 이름) */
const KONVA_MARK = 'konvajs-content';

test('FE-T46 ⑬ 에디터 경로 첫 JS에 Konva가 없고 늦게 싣는 에디터 덩어리 합이 300KB 이하다', async ({ page, request }) => {
  const partner = APPS.find((a) => a.name === 'partner');
  const origin = `http://${HOST}:${portOf(partner, 'prod')}`;
  const res = await request.get(origin + EDITOR_PATH, { maxRedirects: 0 });
  expect(res.status()).toBe(200);
  const initial = scriptSrcs(await res.text()).map((s) => new URL(s, origin + EDITOR_PATH).pathname);
  const initialText = [];
  for (const p of initial) initialText.push(await (await request.get(origin + p)).text());
  expect(initialText.some((t) => t.includes(KONVA_MARK)), '첫 화면 JS에 Konva가 들었다').toBe(false);
  // 브라우저로 열어 늦게 받은 덩어리를 잰다. 파트너 API는 배치본 없음(404)으로 답한다(시작 화면까지 그린다)
  await page.route('https://partner-api.peaket.example/**', (r) => r.fulfill({ status: 404, headers: { 'access-control-allow-origin': origin, 'access-control-allow-credentials': 'true', 'content-type': 'application/problem+json' }, body: '{"type":"https://peaket.example/problems/not-found","status":404}' }));
  const lazy = [];
  page.on('response', async (r) => {
    if (r.request().resourceType() !== 'script') return;
    const path = new URL(r.url()).pathname;
    if (initial.includes(path)) return;
    try {
      lazy.push({ path, text: (await r.body()).toString('utf8') });
    } catch {
      // 본문을 못 읽는 응답은 건너뛴다
    }
  });
  // 시작 화면 → 빈 캔버스 → JSON 내보내기(에디터 Worker를 띄운다): 캔버스·도구·Worker 덩어리를 모두 받는다
  page.on('worker', (w) => w.url() && lazy.push({ path: new URL(w.url()).pathname, text: '' }));
  await page.goto(origin + EDITOR_PATH);
  await expect(page.getByRole('heading', { name: '어떻게 시작할까요?' })).toBeVisible();
  await page.getByRole('button', { name: /빈 캔버스에서 그리기/ }).click();
  await page.getByRole('button', { name: '내보내기', exact: true }).click();
  await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'JSON으로 내보내기' }).click()]);
  await page.waitForLoadState('networkidle');
  // Worker 안에서 받은 덩어리(부트스트랩과 모듈)는 같은 출처 파일이라 주소로 다시 받아 잰다
  for (const x of lazy.filter((l) => l.text === '')) x.text = await (await request.get(origin + x.path)).text();
  const kb = gzipKB(lazy.map((x) => x.text));
  mkdirSync(sizesDir, { recursive: true });
  writeFileSync(new URL('partner_editor_lazy.json', sizesDir), `${JSON.stringify({ key: `partner ${EDITOR_PATH} lazy`, kB: kb, budget: EDITOR_LAZY_KB, files: lazy.length })}\n`);
  // 늦게 받은 덩어리가 없거나 Konva가 없으면 가르기가 틀렸다
  expect(lazy.length, '늦게 받은 덩어리가 없다').toBeGreaterThan(0);
  expect(lazy.some((x) => x.text.includes(KONVA_MARK)), '늦게 받은 덩어리에 Konva가 없다').toBe(true);
  expect(kb, `늦게 싣는 에디터 덩어리 ${kb}kB > ${EDITOR_LAZY_KB}kB`).toBeLessThanOrEqual(EDITOR_LAZY_KB);
});
