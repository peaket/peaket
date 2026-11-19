// BAT-177: Lighthouse 13.5 lcp-breakdown-insight에서 LCP 요소(selector·snippet·boundingRect)와
// 네 구간(TTFB·불러오기 지연·불러오기·그리기 지연)을 기록 모양으로 읽고, 다섯 회 가운데 값 회차를 요약한다
// (docs/frontend.md §5.8 'Lighthouse CI', 계획 docs/review/plans/BAT-177.md 4·5의 T1~T3).
// 단언 값은 계획 5의 대역 값(1,200·300·200·400ms, 312×156, LCP 5,400/5,800/6,990/7,290/8,040)이다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { lcpSummary, readLcp } from './lcp.mjs';

// lcp-breakdown-insight의 details.items는 목록이고, 그 안에 구간 표(type 'table')와 요소(type 'node')가 들어 있다.
const PHASES = { ttfbMs: 1200, loadDelayMs: 300, loadDurationMs: 200, renderDelayMs: 400 };
const TABLE = {
  type: 'table',
  items: [
    { subpart: 'timeToFirstByte', duration: 1200 },
    { subpart: 'resourceLoadDelay', duration: 300 },
    { subpart: 'resourceLoadDuration', duration: 200 },
    { subpart: 'elementRenderDelay', duration: 400 },
  ],
};
const NODE = {
  type: 'node',
  selector: 'img.wallet-qr-skeleton',
  nodeLabel: 'img',
  snippet: `<img alt="" src="data:image/png;base64,${'A'.repeat(4000)}" class="wallet-qr-skeleton">`,
  boundingRect: { top: 100, left: 20, width: 312, height: 156 },
};
const breakdown = (items) => ({ 'lcp-breakdown-insight': { id: 'lcp-breakdown-insight', details: { type: 'list', items } } });
const run = (lcpMs, selector, phases = PHASES) => ({ lcpMs, lcp: { element: { selector }, phases } });

test('BAT-177 T1 ① LCP 요소와 네 구간을 기록 모양으로 읽는다', () => {
  const lcp = readLcp(breakdown([TABLE, NODE]));
  assert.ok(lcp, '구간 표와 요소가 있으면 기록을 돌려준다');
  assert.equal(lcp.element.selector, 'img.wallet-qr-skeleton');
  assert.equal(lcp.element.nodeLabel, 'img');
  assert.deepEqual(lcp.element.boundingRect, { width: 312, height: 156 }, 'LCP 요소의 크기는 312×156이다');
  assert.deepEqual(lcp.phases, PHASES, '구간은 초가 아니라 ms로 읽는다(1,200·300·200·400)');
  assert.ok(lcp.element.snippet.length <= 300, `snippet이 ${lcp.element.snippet.length}자다`);
  assert.match(lcp.element.snippet, /data:image\/png;base64,…/, 'data URI 본문은 줄인다');
  assert.ok(!lcp.element.snippet.includes('A'.repeat(100)), 'base64 본문을 산출물에 그대로 싣지 않는다');
});

test('BAT-177 T1 ② 표와 node의 차례를 뒤집어도 같은 값을 읽는다', () => {
  assert.deepEqual(readLcp(breakdown([NODE, TABLE])), readLcp(breakdown([TABLE, NODE])));
});

test('BAT-177 T2 ① LCP 분해가 없거나 오류면 null을 돌려주고 던지지 않는다', () => {
  const cases = [
    undefined,
    null,
    {},
    { 'lcp-breakdown-insight': { errorMessage: 'Lighthouse가 LCP를 찾지 못했습니다' } },
    breakdown([]),
    { 'lcp-breakdown-insight': { details: {} } },
  ];
  for (const audits of cases) assert.equal(readLcp(audits), null, JSON.stringify(audits));
});

test('BAT-177 T2 ② 요소가 없어도 구간만 있으면 구간을, 구간이 없어도 요소만 있으면 요소를 돌려준다', () => {
  const phasesOnly = readLcp(breakdown([TABLE]));
  assert.equal(phasesOnly.element, null);
  assert.deepEqual(phasesOnly.phases, PHASES);

  const elementOnly = readLcp(breakdown([NODE]));
  assert.equal(elementOnly.element.selector, 'img.wallet-qr-skeleton');
  assert.equal(elementOnly.phases, null);
});

test('BAT-177 T2 ③ lighthouse.spec.mjs는 회차마다 LCP를 읽어 기록하고, 기록 파일을 쓴 뒤에 월렛 lcpSummary를 soft로 본다', () => {
  const src = readFileSync(new URL('./lighthouse.spec.mjs', import.meta.url), 'utf8');
  assert.match(src, /lcp: readLcp\(audits\)/, '회차마다 LCP 요소·분해를 runs[]에 남긴다');
  assert.match(src, /lcpSummary: lcpSummary\(runs\)/, '가운데 값 회차 요약을 기록에 남긴다');
  const write = src.indexOf('writeFileSync(');
  const walletCheck = src.indexOf("page.name === '월렛'");
  assert.ok(write >= 0, '기록 파일을 쓴다');
  assert.ok(walletCheck > write, '월렛 LCP 기록 확인은 기록 파일을 쓴 뒤에 한다(기록을 잃지 않는다)');
  assert.match(src.slice(write), /expect\.soft\([^)]*lcpSummary/, '월렛 기록 실패는 expect.soft로 남긴다');
  assert.doesNotMatch(src.slice(write, walletCheck), /lcpSummary/, '다른 화면은 lcpSummary로 실패하지 않는다');
});

test('BAT-177 T3 ① 다섯 회 가운데 값 회차의 요소·분해를 요약한다', () => {
  // 넣은 차례의 셋째(8,040)도, 첫 회차도, 평균(6,704)도 아니다. 작은 차례로 늘어놓은 셋째 회차(6,990)다.
  const runs = [
    run(7290, 'div.fallback', { ttfbMs: 6100, loadDelayMs: 190, loadDurationMs: 200, renderDelayMs: 800 }),
    run(5400, 'img.wallet-qr-skeleton', { ttfbMs: 4100, loadDelayMs: 100, loadDurationMs: 100, renderDelayMs: 1100 }),
    run(8040, 'span.hero-title', { ttfbMs: 7100, loadDelayMs: 100, loadDurationMs: 100, renderDelayMs: 740 }),
    run(5800, 'img.wallet-qr-skeleton', { ttfbMs: 4300, loadDelayMs: 300, loadDurationMs: 200, renderDelayMs: 1000 }),
    run(6990, 'img.wallet-qr-skeleton', { ttfbMs: 5000, loadDelayMs: 300, loadDurationMs: 200, renderDelayMs: 1490 }),
  ];
  const summary = lcpSummary(runs);
  assert.equal(summary.run, 3, '작은 차례로 셋째 회차');
  assert.equal(summary.lcpMs, 6990);
  assert.equal(summary.element.selector, 'img.wallet-qr-skeleton');
  assert.deepEqual(summary.phases, { ttfbMs: 5000, loadDelayMs: 300, loadDurationMs: 200, renderDelayMs: 1490 }, '고른 회차의 구간을 쓴다(평균이 아니다)');
  assert.deepEqual([...summary.elements].sort(), ['div.fallback', 'img.wallet-qr-skeleton', 'span.hero-title'], '요소를 중복 없이 모은다');
});

test('BAT-177 T3 ② 짝수 회차는 가운데 둘 중 아래 회차를 고르고, 입력 배열을 바꾸지 않는다', () => {
  const runs = [run(5000, 'a'), run(8000, 'b'), run(6000, 'c'), run(7000, 'd')];
  const before = JSON.stringify(runs);
  const summary = lcpSummary(runs);
  assert.equal(summary.run, 2);
  assert.equal(summary.lcpMs, 6000);
  assert.equal(summary.element.selector, 'c');
  assert.equal(JSON.stringify(runs), before, 'lcpSummary는 받은 배열을 바꾸지 않는다');
});

test('BAT-177 T3 ③ 모든 회차에 LCP 분해가 없으면 null이다', () => {
  assert.equal(lcpSummary([]), null);
  assert.equal(lcpSummary([{ lcpMs: 5400, lcp: null }, { lcpMs: 6990, lcp: null }]), null);
});
