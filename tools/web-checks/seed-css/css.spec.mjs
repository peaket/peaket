// FE-T36 ①②③와 크기: 앱 다섯의 운영 빌드에서 첫 화면 HTML이 싣는 CSS(문서 차례)를 받아 본다(docs/frontend.md §5.17·§5.8).
// 탐침 화면(SEED recipe를 쓰는 화면)은 PoC 빌드에서 본다(seed-css/apps.mjs BUILDS).
// 크기는 경로마다 reports/sizes/에도 남긴다(node seed-css/report.mjs가 표로 모은다. PoC 결과 seed-css/RESULT.md).
import { test, expect } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { APPS, HOST, portOf, stylesheetHrefs } from './apps.mjs';
import { checkLayerOrder, checkSeedRules, checkNoSeedAll, gzipKB, sizeLimit } from './check-css.mjs';
import { loadCssBudgets } from '../lib/canon.mjs';

const budgets = loadCssBudgets();
/** 예산을 넘은 경로의 기준선(kB). 넘은 경로는 이 값 + 0.5kB를 한도로 더 커지지만 않게 막는다(check-css.mjs sizeLimit) */
const baseline = JSON.parse(readFileSync(new URL('./css-baseline.json', import.meta.url), 'utf8')).pages ?? {};
const sizesDir = new URL('../reports/sizes/', import.meta.url);

/** 경로 하나의 첫 화면 CSS(문서에 나오는 차례) */
async function firstScreenCss(request, origin, path) {
  const res = await request.get(origin + path, { maxRedirects: 0 });
  expect(res.status(), `${origin}${path} HTML`).toBe(200);
  const hrefs = stylesheetHrefs(await res.text());
  const files = [];
  for (const href of hrefs) {
    const css = await request.get(new URL(href, origin + path).href);
    expect(css.status(), href).toBe(200);
    files.push(await css.text());
  }
  return { hrefs, files };
}

for (const app of APPS) {
  const origin = `http://${HOST}:${portOf(app, 'prod')}`;
  const pocOrigin = `http://${HOST}:${portOf(app, 'poc')}`;

  test(`FE-T36 ①②③ ${app.name} 탐침 화면: 층 차례가 정한 대로이고 SEED recipe가 seed-components 층에 있으며 전체 CSS가 없다`, async ({ request }) => {
    const { hrefs, files } = await firstScreenCss(request, pocOrigin, app.probe);
    expect(hrefs.length, '스타일시트가 없다').toBeGreaterThan(0);
    expect([...checkLayerOrder(files), ...checkSeedRules(files, { recipe: 'action-button' }), ...checkNoSeedAll(files)]).toEqual([]);
  });

  for (const page of app.pages) {
    const key = `${app.name} ${page.path}`;
    test(`FE-T36 ①②③ ${key}: 층 차례가 정한 대로이고 SEED 규칙이 SEED 층에만 있으며 전체 CSS가 없다`, async ({ request }) => {
      const { files } = await firstScreenCss(request, origin, page.path);
      expect([...checkLayerOrder(files), ...checkSeedRules(files), ...checkNoSeedAll(files)]).toEqual([]);
    });

    test(`FE-T36 크기 ${key}: 첫 화면 CSS(gzip)가 §5.8 예산(넘은 경로는 기준선 + 0.5kB) 안이다`, async ({ request }) => {
      const { files } = await firstScreenCss(request, origin, page.path);
      const kb = gzipKB(files);
      const budget = budgets.get(page.row);
      const limit = sizeLimit(budget, baseline[key]);
      // 시험이 실패하면 작업자가 새로 떠 모듈 상태가 사라지므로 경로마다 파일 하나로 남긴다
      mkdirSync(sizesDir, { recursive: true });
      const record = { key, row: page.row, kB: kb, budget, limit, overBudget: kb > budget, files: files.length };
      writeFileSync(new URL(`${key.replace(/[^A-Za-z0-9-]+/g, '_')}.json`, sizesDir), `${JSON.stringify(record)}\n`);
      expect(kb, `${key}: ${kb}kB > 한도 ${limit}kB(§5.8 '${page.row}' 예산 ${budget}kB)`).toBeLessThanOrEqual(limit);
    });
  }
}
