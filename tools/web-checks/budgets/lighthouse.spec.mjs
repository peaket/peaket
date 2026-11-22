// Lighthouse 적재 지표 회귀 검사(docs/frontend.md §5.8 'Lighthouse CI'·'회귀 방지와 판정의 도구가 다르다', BUILD_ORDER BAS-220).
// 대표 주소(budgets/pages.mjs)마다 Lighthouse 모바일 기본값(화면 412×823, CPU 4배 느림, 왕복 150ms·1.6Mbps, 모의 느리게 하기)으로
// 다섯 번 [가정] 재고 가운데 값의 LCP·CLS·총 차단 시간(TBT)을 본다. 한도는 §5.8 그 행의 체감 목표(LCP·CLS)와 §5.8 'Lighthouse CI'의
// 총 차단 시간이다. 행에 LCP가 없으면(좌석·결제·월렛·콘솔) 잰 값(lighthouse-baseline.json) + 여유로 회귀만 막고, CLS가 없으면 NFR-012의 0.1을 쓴다.
// INP는 재지 않는다(탐색 모드는 조작이 없어 INP를 내지 못한다, §5.8). 랩 값이라 '랩 판정'이 아니라 회귀 방지다.
// 목표를 넘은 주소는 wbs 7.5.2까지 기준선 + 여유를 넘지 않게만 막는다.
// 회차마다 LCP 요소·네 구간(TTFB·불러오기 지연·불러오기·그리기 지연)을 runs[].lcp에 남기고, 가운데 값 회차를 lcpSummary로 요약한다(BAT-177).
// 월렛 LCP 임시 알림(OPEN[52] (다), BAT-176)은 BAT-177-r2에서 되돌렸다: 모든 화면의 세 지표가 한도를 넘으면 그대로 실패다.
// 앞 서버가 /_next/static/에 압축을 넘긴 뒤(ADR-0359) 초안 PR #65 CI에서 월렛 LCP 가운데 값 3,850ms ≤ 한도 7,255ms. 한도·기준선은 그대로다.
// 기록 파일을 먼저 쓴 뒤에 판정한다. 월렛만 lcpSummary가 비면 expect.soft로 실패하고, 다른 화면은 기록만 한다.
import { test, expect, chromium } from '@playwright/test';
import lighthouse from 'lighthouse';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HOST } from '../seed-css/apps.mjs';
import { loadLoadTargets, loadTbtLimitMs } from '../lib/canon.mjs';
import { lighthousePages } from './pages.mjs';
import { RUNS, loadLimit, median } from './limits.mjs';
import { lcpSummary, readLcp } from './lcp.mjs';

const targets = loadLoadTargets();
const tbtMs = loadTbtLimitMs();
const baseline = JSON.parse(readFileSync(new URL('./lighthouse-baseline.json', import.meta.url), 'utf8')).pages ?? {};
const outDir = new URL('../reports/lighthouse/', import.meta.url);
const DEBUG_PORT = 9333;

/** NFR-012의 CLS 0.1(행에 CLS가 없을 때) */
const NFR_012_CLS = 0.1;

/** 판정하는 세 지표: 기록 칸 이름, 메시지 이름, 값 글, 단위 */
const METRICS = [
  ['lcpMs', 'LCP', (v) => `${Math.round(v)}`, 'ms'],
  ['cls', 'CLS', (v) => v.toFixed(3), ''],
  ['tbtMs', '총 차단 시간', (v) => `${Math.round(v)}`, 'ms'],
];

/** Lighthouse가 쓰는 그 puppeteer-core(새 패키지를 들이지 않는다). 탭 저장소는 탭마다 따로라 Lighthouse에 넘길 탭을 먼저 만들어 넣는다 */
const puppeteer = createRequire(realpathSync(fileURLToPath(new URL('../node_modules/lighthouse/package.json', import.meta.url))))('puppeteer-core');

/** 문서가 새로 열릴 때마다 탭 저장소를 채운 탭(Lighthouse가 저장소를 비우고 about:blank를 거쳐도 남는다) */
async function tabWithSessionStorage(entries) {
  const remote = await puppeteer.connect({ browserURL: `http://127.0.0.1:${DEBUG_PORT}`, defaultViewport: null });
  const tab = await remote.newPage();
  await tab.evaluateOnNewDocument((e) => {
    try {
      for (const [k, v] of Object.entries(e)) sessionStorage.setItem(k, v);
    } catch {
      /* about:blank에는 저장소가 없다 */
    }
  }, entries);
  return {
    tab,
    async close() {
      await tab.close();
      await remote.disconnect();
    },
  };
}

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
      const seeded = page.sessionStorage ? await tabWithSessionStorage(page.sessionStorage) : null;
      const r = await lighthouse(page.url, { port: DEBUG_PORT, output: 'json', logLevel: 'error', onlyCategories: ['performance'] }, undefined, seeded?.tab);
      await seeded?.close();
      expect(r?.lhr.runtimeError, `${page.url}: ${r?.lhr.runtimeError?.message}`).toBeUndefined();
      const audits = r.lhr.audits;
      runs.push({
        lcpMs: audits['largest-contentful-paint'].numericValue,
        cls: audits['cumulative-layout-shift'].numericValue,
        tbtMs: audits['total-blocking-time'].numericValue,
        lcp: readLcp(audits),
      });
    }
    const got = { lcpMs: median(runs.map((x) => x.lcpMs)), cls: median(runs.map((x) => x.cls)), tbtMs: median(runs.map((x) => x.tbtMs)) };
    const row = { cls: NFR_012_CLS, ...targets.get(page.row) };
    const base = baseline[page.name] ?? {};
    const limit = { lcpMs: loadLimit(row.lcpMs, base.lcpMs, 'lcpMs'), cls: loadLimit(row.cls, base.cls, 'cls'), tbtMs: loadLimit(tbtMs, base.tbtMs, 'tbtMs') };
    mkdirSync(outDir, { recursive: true });
    const record = { name: page.name, url: page.url, row: page.row, runs, median: got, target: { ...row, tbtMs }, limit, lcpSummary: lcpSummary(runs) };
    // 기록 파일을 먼저 쓴다. LCP 분해를 읽지 못해도 기록(값·판정 근거)을 잃지 않는다(BAT-177).
    writeFileSync(new URL(`${page.name.replace(/\s+/g, '_')}.json`, outDir), `${JSON.stringify(record)}\n`);
    // 월렛만 LCP 요소·분해가 기록됐는지 본다. 다른 화면은 기록만 하고 실패하지 않는다.
    if (page.name === '월렛') {
      expect.soft(record.lcpSummary, `${page.name}: LCP 요소·분해(lcp-breakdown-insight)를 기록하지 못했다`).not.toBeNull();
    }
    for (const [k, ko, fmt, unit] of METRICS) {
      const msg = `${page.name} ${ko} ${fmt(got[k])}${unit} > 한도 ${limit[k]}${unit}`;
      expect.soft(got[k], msg).toBeLessThanOrEqual(limit[k]);
    }
  });
}
