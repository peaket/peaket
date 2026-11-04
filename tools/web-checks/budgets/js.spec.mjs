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
