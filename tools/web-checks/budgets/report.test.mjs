// 성능 예산 기록을 Markdown 표로 바꾸는 report.mjs 시험(BUILD_ORDER BAS-220, docs/frontend.md §5.8)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { jsTable, lighthouseTable, renderReport } from './report.mjs';

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

test('BAT-177 T7 ① 한도를 넘는 기록은 실패로 적고 알림만을 쓰지 않는다', () => {
  const over = { ...WALLET, lcpSummary: null, median: { ...WALLET.median, lcpMs: 8040 } };
  const line = lighthouseTable([over])[2];
  assert.equal(cellsOf(line)[5], '한도 초과: LCP');
  assert.ok(!line.includes('알림만'), line);
  // 한도와 같으면 통과(여유를 더하지 않는다)
  const atLimit = { ...over, median: { ...over.median, lcpMs: 7255 } };
  assert.equal(cellsOf(lighthouseTable([atLimit])[2])[5], '한도 안');
});

test('BAT-177 T9 ① 월렛의 CLS·총 차단 시간만 넘으면 그 둘만 한도 초과로 적는다', () => {
  const record = { ...WALLET, lcpSummary: null, median: { lcpMs: 6990, cls: 0.2, tbtMs: 300 } };
  const cells = cellsOf(lighthouseTable([record])[2]);
  assert.equal(cells[3], '0.200 / 0.1');
  assert.equal(cells[4], '300 / 200');
  assert.equal(cells[5], '한도 초과: CLS·총 차단 시간');
});
