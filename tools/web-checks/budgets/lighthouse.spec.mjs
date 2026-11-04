// Lighthouse 적재 지표 회귀 검사(docs/frontend.md §5.8 'Lighthouse CI'·'회귀 방지와 판정의 도구가 다르다', BUILD_ORDER BAS-220).
// 대표 주소(budgets/pages.mjs)마다 Lighthouse 모바일 기본값(화면 412×823, CPU 4배 느림, 왕복 150ms·1.6Mbps, 모의 느리게 하기)으로
// 세 번 [가정] 재고 가운데 값의 LCP·CLS·총 차단 시간(TBT)을 본다. 한도는 §5.8 그 행의 체감 목표(LCP·CLS)와 §5.8 'Lighthouse CI'의
// 총 차단 시간이다. 행에 LCP가 없으면(좌석·결제·월렛·콘솔) 잰 값(lighthouse-baseline.json) + 여유로 회귀만 막고, CLS가 없으면 NFR-012의 0.1을 쓴다.
// INP는 재지 않는다(탐색 모드는 조작이 없어 INP를 내지 못한다, §5.8). 랩 값이라 '랩 판정'이 아니라 회귀 방지다.
// 목표를 넘은 주소는 wbs 7.5.2까지 기준선 + 여유를 넘지 않게만 막는다.
import { test, expect, chromium } from '@playwright/test';
import lighthouse from 'lighthouse';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { HOST } from '../seed-css/apps.mjs';
import { loadLoadTargets, loadTbtLimitMs } from '../lib/canon.mjs';
import { lighthousePages } from './pages.mjs';
import { RUNS, loadLimit, median } from './limits.mjs';

const targets = loadLoadTargets();
const tbtMs = loadTbtLimitMs();
const baseline = JSON.parse(readFileSync(new URL('./lighthouse-baseline.json', import.meta.url), 'utf8')).pages ?? {};
const outDir = new URL('../reports/lighthouse/', import.meta.url);
const DEBUG_PORT = 9333;

/** NFR-012의 CLS 0.1(행에 CLS가 없을 때) */
const NFR_012_CLS = 0.1;

let browser;
test.beforeAll(async () => {
  browser = await chromium.launch({ args: [`--remote-debugging-port=${DEBUG_PORT}`] });
});
test.afterAll(async () => {
  await browser?.close();
});

for (const page of lighthousePages(HOST)) {
  test(`§5.8 Lighthouse ${page.name}: 가운데 값의 LCP·CLS·총 차단 시간이 한도 안이다`, async () => {
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const r = await lighthouse(page.url, { port: DEBUG_PORT, output: 'json', logLevel: 'error', onlyCategories: ['performance'] });
      expect(r?.lhr.runtimeError, `${page.url}: ${r?.lhr.runtimeError?.message}`).toBeUndefined();
      const a = r.lhr.audits;
      runs.push({ lcpMs: a['largest-contentful-paint'].numericValue, cls: a['cumulative-layout-shift'].numericValue, tbtMs: a['total-blocking-time'].numericValue });
    }
    const got = { lcpMs: median(runs.map((x) => x.lcpMs)), cls: median(runs.map((x) => x.cls)), tbtMs: median(runs.map((x) => x.tbtMs)) };
    const row = { cls: NFR_012_CLS, ...targets.get(page.row) };
    const base = baseline[page.name] ?? {};
    const limit = { lcpMs: loadLimit(row.lcpMs, base.lcpMs, 'lcpMs'), cls: loadLimit(row.cls, base.cls, 'cls'), tbtMs: loadLimit(tbtMs, base.tbtMs, 'tbtMs') };
    mkdirSync(outDir, { recursive: true });
    const record = { name: page.name, url: page.url, row: page.row, runs, median: got, target: { ...row, tbtMs }, limit };
    writeFileSync(new URL(`${page.name.replace(/\s+/g, '_')}.json`, outDir), `${JSON.stringify(record)}\n`);
    expect.soft(got.lcpMs, `${page.name} LCP ${Math.round(got.lcpMs)}ms > 한도 ${limit.lcpMs}ms`).toBeLessThanOrEqual(limit.lcpMs);
    expect.soft(got.cls, `${page.name} CLS ${got.cls.toFixed(3)} > 한도 ${limit.cls}`).toBeLessThanOrEqual(limit.cls);
    expect.soft(got.tbtMs, `${page.name} 총 차단 시간 ${Math.round(got.tbtMs)}ms > 한도 ${limit.tbtMs}ms`).toBeLessThanOrEqual(limit.tbtMs);
  });
}
