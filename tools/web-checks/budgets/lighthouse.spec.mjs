// Lighthouse 적재 지표 회귀 검사(docs/frontend.md §5.8 'Lighthouse CI'·'회귀 방지와 판정의 도구가 다르다', BUILD_ORDER BAS-220).
// 대표 주소(budgets/pages.mjs)마다 Lighthouse 모바일 기본값(화면 412×823, CPU 4배 느림, 왕복 150ms·1.6Mbps, 모의 느리게 하기)으로
// 다섯 번 [가정] 재고 가운데 값의 LCP·CLS·총 차단 시간(TBT)을 본다. 한도는 §5.8 그 행의 체감 목표(LCP·CLS)와 §5.8 'Lighthouse CI'의
// 총 차단 시간이다. 행에 LCP가 없으면(좌석·결제·월렛·콘솔) 잰 값(lighthouse-baseline.json) + 여유로 회귀만 막고, CLS가 없으면 NFR-012의 0.1을 쓴다.
// INP는 재지 않는다(탐색 모드는 조작이 없어 INP를 내지 못한다, §5.8). 랩 값이라 '랩 판정'이 아니라 회귀 방지다.
// 목표를 넘은 주소는 wbs 7.5.2까지 기준선 + 여유를 넘지 않게만 막는다.
// 월렛 LCP만 임시 알림(OPEN[52], BAT-176): 지표마다 limits.mjs loadVerdict로 판정하고, 알림이면 실패 대신 시험 주석·경고 줄·기록 파일의 verdict·warnOnly에 남긴다.
// 어느 화면·지표를 언제까지 알림으로 둘지는 이 파일에 박지 않는다(limits.mjs WARN_ONLY).
import { test, expect, chromium } from '@playwright/test';
import lighthouse from 'lighthouse';
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { HOST } from '../seed-css/apps.mjs';
import { loadLoadTargets, loadTbtLimitMs } from '../lib/canon.mjs';
import { lighthousePages } from './pages.mjs';
import { RUNS, loadLimit, loadVerdict, median } from './limits.mjs';

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

/** GitHub Actions 경고 줄(실행 화면에 노란 표시). 값의 %·줄바꿈은 워크플로 명령 규칙대로 바꾼다 */
const ghEscape = (t) => t.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
function warnLine(text) {
  console.log(process.env.GITHUB_ACTIONS === 'true' ? `::warning title=Lighthouse 알림만::${ghEscape(text)}` : `경고(Lighthouse 알림만): ${text}`);
}

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
    // 되돌릴 날 판정에 쓰는 시계는 시험마다 하나다(loadVerdict가 한국 시각 날짜로 바꿔 견준다)
    const now = new Date();
    const runs = [];
    for (let i = 0; i < RUNS; i++) {
      const seeded = page.sessionStorage ? await tabWithSessionStorage(page.sessionStorage) : null;
      const r = await lighthouse(page.url, { port: DEBUG_PORT, output: 'json', logLevel: 'error', onlyCategories: ['performance'] }, undefined, seeded?.tab);
      await seeded?.close();
      expect(r?.lhr.runtimeError, `${page.url}: ${r?.lhr.runtimeError?.message}`).toBeUndefined();
      const a = r.lhr.audits;
      runs.push({ lcpMs: a['largest-contentful-paint'].numericValue, cls: a['cumulative-layout-shift'].numericValue, tbtMs: a['total-blocking-time'].numericValue });
    }
    const got = { lcpMs: median(runs.map((x) => x.lcpMs)), cls: median(runs.map((x) => x.cls)), tbtMs: median(runs.map((x) => x.tbtMs)) };
    const row = { cls: NFR_012_CLS, ...targets.get(page.row) };
    const base = baseline[page.name] ?? {};
    const limit = { lcpMs: loadLimit(row.lcpMs, base.lcpMs, 'lcpMs'), cls: loadLimit(row.cls, base.cls, 'cls'), tbtMs: loadLimit(tbtMs, base.tbtMs, 'tbtMs') };
    // 지표마다 판정(pass·warn·fail). 한도 값은 그대로 두고, 알림만 항목(limits.mjs WARN_ONLY)에 맞고 되돌릴 날 안일 때만 warn이다
    const verdict = {};
    const warnOnly = [];
    for (const [k] of METRICS) {
      const v = loadVerdict({ page: page.name, metric: k, value: got[k], limit: limit[k], now });
      verdict[k] = v.verdict;
      if (v.verdict === 'warn') warnOnly.push({ metric: k, until: v.until, reason: v.reason });
    }
    mkdirSync(outDir, { recursive: true });
    const record = { name: page.name, url: page.url, row: page.row, runs, median: got, target: { ...row, tbtMs }, limit, verdict, warnOnly };
    writeFileSync(new URL(`${page.name.replace(/\s+/g, '_')}.json`, outDir), `${JSON.stringify(record)}\n`);
    for (const [k, ko, fmt, unit] of METRICS) {
      const msg = `${page.name} ${ko} ${fmt(got[k])}${unit} > 한도 ${limit[k]}${unit}`;
      if (verdict[k] === 'warn') {
        const w = warnOnly.find((e) => e.metric === k);
        const text = `${msg}: 실패 대신 알림만(${w.reason}, 되돌릴 날 ${w.until} 한국 시각 끝까지)`;
        test.info().annotations.push({ type: 'warning', description: text });
        warnLine(text);
        continue;
      }
      expect.soft(got[k], msg).toBeLessThanOrEqual(limit[k]);
    }
  });
}
