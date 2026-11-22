// 성능 예산 기록을 Markdown 표로 바꾸는 report.mjs 시험(BUILD_ORDER BAS-220, docs/frontend.md §5.8)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { loadLoadTargets, loadTbtLimitMs } from '../lib/canon.mjs';
import { jsTable, lighthouseTable, renderReport } from './report.mjs';
import { loadLimit } from './limits.mjs';
import { lighthousePages } from './pages.mjs';

const JS = [
  { key: 'web /my/tickets', row: '월렛', kB: 158.2, budget: 120, limit: 159.2, overBudget: true, files: 10 },
  { key: 'console /', row: '관제 콘솔', kB: 111.1, budget: 250, limit: 250, overBudget: false, files: 1 },
  { key: 'web /events/evt-1', row: '홈·공연 상세·굿즈(ISR)', kB: 190.1, budget: 170, limit: 187.5, overBudget: true, files: 11 },
];
const LH = [
  {
    name: '홈',
    url: 'http://127.0.0.1:4101/',
    row: '홈·공연 상세·굿즈(ISR)',
    runs: [],
    median: { lcpMs: 2100.4, cls: 0.01234, tbtMs: 180 },
    target: { lcpMs: 2500, cls: 0.1, tbtMs: 200 },
    limit: { lcpMs: 2500, cls: 0.1, tbtMs: 200 },
  },
  {
    name: '결제 데모',
    url: 'http://127.0.0.1:4101/booking/x/checkout',
    row: '결제 화면',
    runs: [],
    median: { lcpMs: 12539.2062, cls: 0, tbtMs: 245 },
    target: { lcpMs: 2500, cls: 0.1, tbtMs: 200 },
    limit: { lcpMs: 2750, cls: 0.1, tbtMs: 200 },
  },
];

test('도구 첫 JS 기록을 경로 차례로 표로 만들고 예산·한도를 넘었는지 적는다', () => {
  const lines = jsTable(JS);
  assert.equal(lines[0], '| 앱·경로 | §5.8 경로 묶음 | 첫 JS(gzip, kB) | 예산(kB) | 한도(kB) | 판정 |');
  assert.equal(lines[1], '| --- | --- | --- | --- | --- | --- |');
  assert.deepEqual(lines.slice(2), [
    '| console / | 관제 콘솔 | 111.1 | 250 | 250 | 예산 안 |',
    '| web /events/evt-1 | 홈·공연 상세·굿즈(ISR) | 190.1 | 170 | 187.5 | 한도 초과(+2.6) |',
    '| web /my/tickets | 월렛 | 158.2 | 120 | 159.2 | 예산 초과(+38.2), 기준선 한도 안 |',
  ]);
});

test('도구 Lighthouse 기록을 이름 차례로 가운데 값과 한도를 견준 표로 만든다', () => {
  const lines = lighthouseTable(LH);
  assert.equal(lines[0], '| 화면 | §5.8 경로 묶음 | LCP 가운데 / 한도(ms) | CLS 가운데 / 한도 | 총 차단 시간 가운데 / 한도(ms) | 판정 |');
  assert.deepEqual(lines.slice(2), [
    '| 결제 데모 | 결제 화면 | 12539 / 2750 | 0.000 / 0.1 | 245 / 200 | 한도 초과: LCP·총 차단 시간 |',
    '| 홈 | 홈·공연 상세·굿즈(ISR) | 2100 / 2500 | 0.012 / 0.1 | 180 / 200 | 한도 안 |',
  ]);
  // 표 칸의 세로 막대는 이스케이프한다
  assert.match(lighthouseTable([{ ...LH[0], name: 'a|b' }])[2], /^\| a\\\|b \|/);
});

test('도구 명령줄은 reports/sizes-js·reports/lighthouse를 읽어 표 둘을 내고, 둘 다 없으면 멈춘다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-checks-budgets-'));
  try {
    const script = fileURLToPath(new URL('./report.mjs', import.meta.url));
    const empty = spawnSync(process.execPath, [script, '--reports', dir], { encoding: 'utf8' });
    assert.equal(empty.status, 2);
    assert.match(empty.stderr, /sizes-js/);
    mkdirSync(join(dir, 'sizes-js'));
    for (const r of JS) writeFileSync(join(dir, 'sizes-js', `${r.key.replace(/[^A-Za-z0-9-]+/g, '_')}.json`), `${JSON.stringify(r)}\n`);
    writeFileSync(join(dir, 'sizes-js', 'note.txt'), '표에 넣지 않는다');
    const onlyJs = spawnSync(process.execPath, [script, '--reports', dir], { encoding: 'utf8' });
    assert.equal(onlyJs.status, 0, onlyJs.stderr);
    assert.match(onlyJs.stdout, /### 첫 JS/);
    assert.match(onlyJs.stdout, /Lighthouse 기록이 없다/);
    mkdirSync(join(dir, 'lighthouse'));
    for (const r of LH) writeFileSync(join(dir, 'lighthouse', `${r.name.replace(/\s+/g, '_')}.json`), `${JSON.stringify(r)}\n`);
    const both = spawnSync(process.execPath, [script, '--reports', dir], { encoding: 'utf8' });
    assert.equal(both.status, 0, both.stderr);
    assert.equal(both.stdout, `${renderReport({ js: JS, lighthouse: LH })}\n`);
    assert.match(both.stdout, /### Lighthouse/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// BAT-177: LCP 분해 표와 한도 초과 판정(docs/frontend.md §5.8 'Lighthouse CI',
// 계획 docs/review/plans/BAT-177.md 5의 T4·T7·T9). 단언 값은 계획 5의 대역(요소 img.wallet-qr-skeleton,
// 1,200·300·200·400ms, 가운데 회차 6,990ms, 한도 7,255ms)이다.
const cellsOf = (line) => line.slice(2, -2).split(' | ');
const WALLET = {
  name: '월렛',
  url: 'http://127.0.0.1:4101/my/tickets',
  row: '월렛',
  runs: [],
  median: { lcpMs: 6990, cls: 0.02, tbtMs: 90 },
  target: { cls: 0.1, tbtMs: 200 },
  limit: { lcpMs: 7255, cls: 0.1, tbtMs: 200 },
  lcpSummary: {
    run: 3,
    lcpMs: 6990,
    element: { selector: 'img.wallet-qr-skeleton', snippet: 'data:image/png;base64,…', nodeLabel: 'img', boundingRect: { width: 312, height: 156 } },
    phases: { ttfbMs: 1200, loadDelayMs: 300, loadDurationMs: 200, renderDelayMs: 400 },
    elements: ['img.wallet-qr-skeleton'],
  },
};

test('BAT-177 T4 ① LCP 분해 표가 화면별 가운데 값 회차의 요소·네 구간을 보인다', async () => {
  const { lcpTable } = await import('./report.mjs');
  assert.equal(typeof lcpTable, 'function', 'report.mjs가 lcpTable을 내놓는다');
  const lines = lcpTable([WALLET, LH[0]]);
  assert.equal(lines[0], '| 화면 | 가운데 회차 | LCP(ms) | 요소 | TTFB(ms) | 불러오기 지연(ms) | 불러오기(ms) | 그리기 지연(ms) |');
  assert.equal(lines[1], '| --- | --- | --- | --- | --- | --- | --- | --- |');
  assert.deepEqual(lines.slice(2), ['| 월렛 | 3 | 6990 | img.wallet-qr-skeleton | 1200 | 300 | 200 | 400 |']);
});

test('BAT-177 T4 ② LCP 분해가 없는 옛 기록은 표에서 빼고, 모두 없으면 한 줄로 알리며 기본 표는 그대로다', async () => {
  const { lcpTable } = await import('./report.mjs');
  assert.deepEqual(lcpTable(LH), ['(LCP 분해 기록이 없다)']);
  const report = renderReport({ js: JS, lighthouse: [WALLET] });
  assert.match(report, /### Lighthouse LCP 분해\(가운데 값 회차\)/);
  assert.match(report, /\| 월렛 \| 3 \| 6990 \| img\.wallet-qr-skeleton \| 1200 \| 300 \| 200 \| 400 \|/);
  assert.match(report, /### Lighthouse\(§5\.8 체감 목표, 가운데 값\)/, '기본 Lighthouse 표도 그대로 낸다');
  assert.match(report, /\| 월렛 \| 월렛 \| 6990 \/ 7255 \| 0\.020 \/ 0\.1 \| 90 \/ 200 \| 한도 안 \|/);
});

test('BAT-177 T4 ③ LCP 분해 표는 기록을 화면 이름 차례로 늘어놓는다', async () => {
  const { lcpTable } = await import('./report.mjs');
  const home = {
    ...WALLET,
    name: '홈',
    row: '홈·공연 상세·굿즈(ISR)',
    lcpSummary: { ...WALLET.lcpSummary, run: 4, lcpMs: 5800, element: { ...WALLET.lcpSummary.element, selector: 'h1.hero' } },
  };
  // 이름 차례([월렛, 홈])와 반대로 넣어 정렬을 본다
  const input = [home, WALLET];
  const expected = input.map((r) => r.name).sort((a, b) => a.localeCompare(b));
  assert.notDeepEqual(input.map((r) => r.name), expected, '넣은 차례와 이름 차례가 다르다');
  const got = lcpTable(input)
    .slice(2)
    .map((line) => cellsOf(line)[0]);
  assert.deepEqual(got, expected, '화면 이름 차례로 늘어놓는다');
});

// BAT-177-r2(OPEN[52] (나)): 월렛 LCP 임시 알림을 되돌린다. 표 판정은 기록의 값과 한도로만 정하고, 옛 기록에 남은 판정 칸
// (verdict·warnOnly, BAT-176 시절 lighthouse.spec.mjs가 썼다)은 읽지 않는다(계획 docs/review/plans/BAT-177-r2.md 3·5의 T6 ②·T7).
const WALLET_OLD_WARN = {
  ...WALLET,
  lcpSummary: null,
  median: { ...WALLET.median, lcpMs: 8040 },
  verdict: { lcpMs: 'warn', cls: 'pass', tbtMs: 'pass' },
  warnOnly: [{ metric: 'lcpMs', until: '2026-11-30', reason: '임시, 되돌릴 날: (나)를 합치는 날, 늦어도 2026-11-30 [가정], OPEN[52]' }],
};

test("BAT-177-r2 T6 ② 옛 기록에 verdict·warnOnly 칸이 있어도 월렛 LCP 8,040/7,255는 '한도 초과: LCP'이고 '알림만'이 없다", () => {
  const wallet = cellsOf(lighthouseTable([WALLET_OLD_WARN])[2]);
  assert.equal(wallet[2], '8040 / 7255', 'LCP 칸은 한도 7,255ms를 그대로 보인다');
  assert.equal(wallet[5], '한도 초과: LCP');
  assert.ok(!lighthouseTable([WALLET_OLD_WARN]).join('\n').includes('알림만'), '표 어디에도 알림만이 없다');
});

test('BAT-177-r2 T7 ① 월렛 LCP 한도 7,255ms는 넘으면 다른 지표처럼 실패다: 7,256은 한도 초과, 7,255는 한도 안', () => {
  const at = (lcpMs, extra = {}) => cellsOf(lighthouseTable([{ ...WALLET, median: { ...WALLET.median, lcpMs }, limit: { ...WALLET.limit, lcpMs: 7255 }, ...extra }])[2])[5];
  assert.equal(at(7256), '한도 초과: LCP');
  assert.equal(at(7255), '한도 안');
  // 기록의 판정 칸이 값과 어긋나도 값과 한도로만 판정한다(옛 'warn'·'pass'가 초과를 덮지 않고, 옛 'fail'이 한도 안을 실패로 만들지 않는다)
  assert.equal(at(7256, { verdict: { lcpMs: 'warn', cls: 'pass', tbtMs: 'pass' } }), '한도 초과: LCP');
  assert.equal(at(7256, { verdict: { lcpMs: 'pass', cls: 'pass', tbtMs: 'pass' } }), '한도 초과: LCP');
  assert.equal(at(7255, { verdict: { lcpMs: 'fail', cls: 'pass', tbtMs: 'pass' } }), '한도 안');
});

const baselinePages = JSON.parse(readFileSync(new URL('./lighthouse-baseline.json', import.meta.url), 'utf8')).pages;
const limitsOf = (page) => {
  const target = { cls: 0.1, ...loadLoadTargets().get(page.row) };
  const base = baselinePages[page.name] ?? {};
  return {
    lcpMs: loadLimit(target.lcpMs, base.lcpMs, 'lcpMs'),
    cls: loadLimit(target.cls, base.cls, 'cls'),
    tbtMs: loadLimit(loadTbtLimitMs(), base.tbtMs, 'tbtMs'),
  };
};

test('BAT-177 T9 ② 화면마다 실제 한도에서 한 지표만 넘으면 그 지표만 한도 초과다', () => {
  const pages = lighthousePages('h');
  assert.equal(pages.length, 8, '대표 주소는 여덟이다');
  for (const page of pages) {
    const limit = limitsOf(page);
    // 월렛도 세 지표 모두 같은 경계다(BAT-177-r2에서 월렛 LCP 알림을 되돌렸다)
    const metrics = [['lcpMs', 'LCP'], ['cls', 'CLS'], ['tbtMs', '총 차단 시간']];
    for (const [key, ko] of metrics) {
      const record = { name: page.name, row: page.row, runs: [], median: { lcpMs: 0, cls: 0, tbtMs: 0 }, limit };
      record.median[key] = Math.round((limit[key] + (key === 'cls' ? 0.01 : 1)) * 1000) / 1000;
      assert.equal(cellsOf(lighthouseTable([record])[2])[5], `한도 초과: ${ko}`, `${page.name} ${ko}: 한도 + 1은 실패다`);
      record.median[key] = limit[key];
      assert.equal(cellsOf(lighthouseTable([record])[2])[5], '한도 안', `${page.name} ${ko}: 한도 그대로는 통과다`);
    }
  }
});
