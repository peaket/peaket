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

// BAT-176: 월렛 LCP만 임시 알림(docs/frontend.md §5.8 'Lighthouse CI', 소유자 결정 2026-11-19 OPEN[52]). 단언 값은 정본 문장과 계획 docs/review/plans/BAT-176.md 3의 숫자다.
// 판정 칸이 없는 옛 기록(계획 T9)은 위 '도구 Lighthouse 기록을 이름 차례로 …' 시험이 이미 본다(결제 데모 '한도 초과: LCP·총 차단 시간').
const WALLET_WARN = {
  name: '월렛',
  url: 'http://127.0.0.1:4101/my/tickets',
  row: '월렛',
  runs: [],
  median: { lcpMs: 8040, cls: 0.02, tbtMs: 90 },
  target: { cls: 0.1, tbtMs: 200 },
  limit: { lcpMs: 7255, cls: 0.1, tbtMs: 200 },
  verdict: { lcpMs: 'warn', cls: 'pass', tbtMs: 'pass' },
  warnOnly: [{ metric: 'lcpMs', until: '2026-11-30', reason: '임시, 되돌릴 날: (나)를 합치는 날, 늦어도 2026-11-30 [가정], OPEN[52]' }],
};
const cellsOf = (line) => line.slice(2, -2).split(' | ');

test("BAT-176 잡 요약 표는 알림만 지표를 '알림만'으로, 넘은 다른 지표는 '한도 초과'로 적는다", () => {
  const [, , line] = lighthouseTable([WALLET_WARN]);
  const cells = cellsOf(line);
  assert.equal(cells.length, 6);
  assert.equal(cells[0], '월렛');
  assert.equal(cells[2], '8040 / 7255', 'LCP 칸은 한도 7,255ms를 그대로 보인다');
  const verdict = cells[5];
  assert.ok(verdict.startsWith('알림만'), verdict);
  for (const s of ['LCP', 'OPEN[52]', '2026-11-30']) assert.ok(verdict.includes(s), `판정 칸에 '${s}'가 없다: ${verdict}`);
  assert.ok(!verdict.includes('한도 초과'), verdict);
  assert.ok(!verdict.includes('한도 안'), verdict);

  // 같은 기록에 CLS가 넘어 실패면 둘 다 적는다
  const both = { ...WALLET_WARN, median: { ...WALLET_WARN.median, cls: 0.2 }, verdict: { ...WALLET_WARN.verdict, cls: 'fail' } };
  const v2 = cellsOf(lighthouseTable([both])[2])[5];
  assert.ok(v2.includes('한도 초과: CLS'), v2);
  assert.ok(v2.includes('알림만'), v2);
  assert.ok(!/한도 초과: [^;]*LCP/.test(v2), `LCP는 한도 초과에 들지 않는다: ${v2}`);
  assert.equal(cellsOf(lighthouseTable([both])[2])[3], '0.200 / 0.1');

  // 기록의 판정 칸이 fail이면 '알림만'이 아니다(되돌릴 날이 지난 뒤의 월렛 기록)
  const after = { ...WALLET_WARN, verdict: { lcpMs: 'fail', cls: 'pass', tbtMs: 'pass' }, warnOnly: [] };
  assert.equal(cellsOf(lighthouseTable([after])[2])[5], '한도 초과: LCP');
});

test('BAT-176 명령줄도 기록 파일의 판정 칸을 읽어 알림만을 적고, 다른 화면의 한도 초과는 그대로 적는다', () => {
  const dir = mkdtempSync(join(tmpdir(), 'web-checks-budgets-176-'));
  try {
    mkdirSync(join(dir, 'sizes-js'));
    for (const r of JS) writeFileSync(join(dir, 'sizes-js', `${r.key.replace(/[^A-Za-z0-9-]+/g, '_')}.json`), `${JSON.stringify(r)}\n`);
    mkdirSync(join(dir, 'lighthouse'));
    for (const r of [...LH, WALLET_WARN]) writeFileSync(join(dir, 'lighthouse', `${r.name.replace(/\s+/g, '_')}.json`), `${JSON.stringify(r)}\n`);
    const script = fileURLToPath(new URL('./report.mjs', import.meta.url));
    const out = spawnSync(process.execPath, [script, '--reports', dir], { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    const wallet = out.stdout.split('\n').find((l) => l.startsWith('| 월렛 | 월렛 |'));
    assert.ok(wallet, out.stdout);
    assert.ok(cellsOf(wallet)[5].startsWith('알림만'), wallet);
    assert.match(out.stdout, /\| 결제 데모 \| 결제 화면 \| 12539 \/ 2750 \| 0\.000 \/ 0\.1 \| 245 \/ 200 \| 한도 초과: LCP·총 차단 시간 \|/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
