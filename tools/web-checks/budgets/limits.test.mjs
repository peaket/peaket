// 성능 예산 판정과 정본 읽기 시험(docs/frontend.md §5.8, BUILD_ORDER BAS-220)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JS_OVER_BUDGET_MARGIN, LOAD_MARGIN, RUNS, jsLimit, loadLimit, median } from './limits.mjs';
// 내보내기 목록을 보는 시험(BAT-177-r2 T6 ①)이 이름공간으로 읽는다
import * as limitsModule from './limits.mjs';
import { loadJsBudgets, loadLoadTargets, loadTbtLimitMs, parseJsBudgets, parseLoadTargets, parseTbtLimitMs } from '../lib/canon.mjs';
import { scriptSrcs } from '../seed-css/apps.mjs';
import { lighthousePages } from './pages.mjs';

const MD = `### 5.8 성능 예산 표

| 경로 묶음 | 첫 JS | CSS | 체감 목표 | 그 밖 | 강제 도구 |
| --- | --- | --- | --- | --- | --- |
| 대기실 경량 페이지 | 50KB 이하(정본), 목표 15KB [가정] | 10KB 미만(정본) | LCP 2.5초, CLS 0.1 | | size-limit |
| 좌석 화면 | 200KB [가정] + Worker 60KB [가정] | 20KB [가정] | 통과 뒤 첫 그림 1초 미만 | | size-limit |
| 홈 | 170KB [가정] | 25KB [가정] | LCP p75 2.5초, TBT 0.8초, CLS 0.1 | | size-limit |

- **Lighthouse CI**: 한도는 총 차단 시간 200ms [가정]이다.

### 5.9 다음`;

test('§5.8 첫 JS 열은 칸의 첫 KB 숫자이고, 숫자가 없으면 멈춘다', () => {
  assert.deepEqual([...parseJsBudgets(MD)], [['대기실 경량 페이지', 50], ['좌석 화면', 200], ['홈', 170]]);
  assert.throws(() => parseJsBudgets(MD.replace('170KB [가정]', '미정')), /홈 행의 첫 JS/);
  assert.equal(loadJsBudgets().get('대기실 경량 페이지'), 50);
});

test('§5.8 체감 목표에서 LCP(초)와 CLS를 읽고, 없는 행은 비운다', () => {
  assert.deepEqual([...parseLoadTargets(MD)], [
    ['대기실 경량 페이지', { lcpMs: 2500, cls: 0.1 }],
    ['좌석 화면', {}],
    ['홈', { lcpMs: 2500, cls: 0.1 }],
  ]);
  const real = loadLoadTargets();
  for (const p of lighthousePages('h')) assert.ok(real.has(p.row), `Lighthouse 주소 ${p.name}의 행 ${p.row}가 §5.8에 없다`);
});

test("§5.8 'Lighthouse CI' 항목에서 총 차단 시간 한도를 읽는다", () => {
  assert.equal(parseTbtLimitMs(MD), 200);
  assert.throws(() => parseTbtLimitMs('# 없음'), /총 차단 시간/);
  assert.equal(typeof loadTbtLimitMs(), 'number');
});

test('첫 JS 한도: 예산 안이면 예산, 넘은 경로는 기준선 + 1kB이고 기준선은 넘은 경로에만 둔다', () => {
  assert.equal(JS_OVER_BUDGET_MARGIN, 1);
  assert.equal(jsLimit(170, undefined), 170);
  assert.equal(jsLimit(170, 200.4), 201.4);
  assert.throws(() => jsLimit(170, 150), /넘은 경로/);
  assert.throws(() => jsLimit(undefined, 1), /예산/);
});

test('적재 지표 한도: 목표 안이면 목표, 넘거나 목표가 없으면 기준선 + 여유(시간 25%, CLS 0.02)', () => {
  assert.deepEqual(LOAD_MARGIN, { ms: 0.25, cls: 0.02 });
  assert.equal(loadLimit(2500, undefined, 'lcpMs'), 2500);
  assert.equal(loadLimit(2500, 12763, 'lcpMs'), 15954);
  assert.equal(loadLimit(undefined, 6796, 'lcpMs'), 8495);
  assert.equal(loadLimit(0.1, 0.15, 'cls'), 0.17);
  assert.throws(() => loadLimit(undefined, undefined, 'lcpMs'), /기준선이 있어야/);
  assert.throws(() => loadLimit(2500, 2000, 'lcpMs'), /넘은 주소/);
});

test('가운데 값은 정렬한 가운데(짝수면 가운데 둘의 평균)', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.throws(() => median([]), /값이 없다/);
});

test('첫 화면 스크립트는 script src·modulepreload·script preload를 차례대로 한 번씩 모은다', () => {
  const html = '<script src="/a.js" async></script><link rel="modulepreload" href="/b.js"><script>inline()</script><link rel=preload as=script href=/c.js><link rel="preload" as="font" href="/f.woff2"><script src="/a.js"></script>';
  assert.deepEqual(scriptSrcs(html), ['/a.js', '/b.js', '/c.js']);
});

test('옛 브라우저용 보충 스크립트(nomodule)는 요즘 브라우저가 받지 않아 첫 JS에 넣지 않는다(새 맥락 리뷰 재현)', () => {
  const html = '<script src="/p.js" noModule=""></script><script nomodule src="/q.js"></script><script src="/m.js" type="module"></script>';
  assert.deepEqual(scriptSrcs(html), ['/m.js']);
});

test('기준선 파일의 주소·경로 이름은 지금 검사 대상에 있는 것만 적는다', () => {
  const lh = JSON.parse(readFileSync(new URL('./lighthouse-baseline.json', import.meta.url), 'utf8')).pages;
  const names = new Set(lighthousePages('h').map((p) => p.name));
  for (const k of Object.keys(lh)) assert.ok(names.has(k), `Lighthouse 기준선의 ${k}가 대표 주소에 없다`);
  const targets = loadLoadTargets();
  for (const p of lighthousePages('h')) {
    if (targets.get(p.row)?.lcpMs === undefined) assert.ok(lh[p.name]?.lcpMs, `LCP 목표가 없는 ${p.name}에는 기준선이 있어야 한다`);
  }
});

// BAT-174: Lighthouse를 주소마다 다섯 번 재고 가운데 값(작은 차례로 늘어놓은 셋째 값)으로 판정한다(docs/frontend.md §5.8 'Lighthouse CI', NFR-012).
// 단언 값은 정본 문장(5번)과 계획 docs/review/plans/BAT-174.md 3의 숫자다. RUNS는 단언 대상으로만 가져온다.
test('BAT-174 Lighthouse는 주소마다 다섯 번 잰다', () => {
  assert.equal(RUNS, 5);
});

test('BAT-174 다섯 값의 가운데 값은 작은 차례로 늘어놓은 셋째 값이다', () => {
  // 평균 6,496.6, 최솟값 4,508, 넣은 차례의 셋째 7,893, 정렬한 둘째 5,804·넷째 7,893과 모두 다르다
  assert.equal(median([8042, 4508, 7893, 6236, 5804]), 6236);
  assert.equal(median([5, 4, 3, 2, 1]), 3);
});

test('BAT-174 가운데 값은 글자 차례가 아니라 숫자 차례로 늘어놓는다', () => {
  // 글자 차례면 [10000, 6000, 70000, 800, 9000]이라 셋째가 70000이다
  assert.equal(median([10000, 9000, 800, 70000, 6000]), 9000);
});

test('BAT-174 짝수·홀수 길이 경계: 홀수는 가운데 하나, 짝수는 가운데 둘의 평균', () => {
  assert.equal(median([7]), 7);
  assert.equal(median([1, 4]), 2.5);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(median([5, 1, 4, 2, 3]), 3);
  assert.equal(median([6, 1, 5, 2, 4, 3]), 3.5);
  assert.equal(median([2, 1, 1, 2, 1]), 1);
  assert.throws(() => median([]), /값이 없다/);
});

test('BAT-174 바깥 경계: 다섯 번 가운데 값이 한도와 같으면 통과, 1ms 넘으면 실패, 두 번 튄 값은 판정을 바꾸지 않는다', () => {
  // 월렛 LCP 한도: 기준선 5,804ms × 1.25 = 7,255ms(docs/frontend.md §5.8)
  const limit = loadLimit(undefined, 5804, 'lcpMs');
  assert.equal(limit, 7255);
  const at = median([9000, 7255, 1000, 7256, 7254]);
  assert.equal(at, 7255);
  assert.ok(at <= limit, '한도와 같은 가운데 값은 통과다');
  const over = median([9000, 7256, 1000, 7257, 7255]);
  assert.equal(over, 7256);
  assert.ok(over > limit, '한도를 1ms 넘는 가운데 값은 실패다');
  // 두 번 튄 실행: 다섯 번이면 가운데 값이 튀지 않는다(세 번이면 튄다, 대조)
  const five = median([8042, 8041, 5804, 5900, 6000]);
  assert.equal(five, 6000);
  assert.ok(five <= limit);
  const three = median([8042, 8041, 5804]);
  assert.equal(three, 8041);
  assert.ok(three > limit);
});

test('BAT-174 가운데 값은 받은 배열을 바꾸지 않는다', () => {
  const xs = [3, 1, 2, 5, 4];
  assert.equal(median(xs), 3);
  assert.deepEqual(xs, [3, 1, 2, 5, 4]);
});

test('BAT-174 lighthouse.spec.mjs는 RUNS만큼 재고 median으로 LCP·CLS·총 차단 시간을 판정한다', () => {
  const src = readFileSync(new URL('./lighthouse.spec.mjs', import.meta.url), 'utf8');
  assert.match(src, /import \{[^}]*\bRUNS\b[^}]*\bmedian\b[^}]*\} from '\.\/limits\.mjs'/);
  assert.match(src, /for \(let i = 0; i < RUNS; i\+\+\)/);
  assert.doesNotMatch(src, /i < \d/, '재는 횟수를 숫자로 박지 않는다');
  for (const k of ['lcpMs', 'cls', 'tbtMs']) assert.ok(src.includes(`median(runs.map((x) => x.${k}))`), `${k}는 다섯 번의 가운데 값으로 판정한다`);
  assert.doesNotMatch(src, /runs\.at\(|runs\[runs\.length/, '마지막 실행 값으로 판정하지 않는다');
});

// BAT-177-r2(OPEN[52] (나), ADR-0359): 월렛 LCP 임시 알림(BAT-176)을 되돌린다. 초안 PR #65 CI(실행 45048960248)에서
// 월렛 LCP 가운데 값 3,850ms ≤ 한도 7,255ms라 계획 docs/review/plans/BAT-177-r2.md 5의 T6·T7대로 알림 없이 실패로 판정한다.
// 단언 값은 정본 문장(한도 7,255ms = 기준선 5,804ms × 1.25, 첫 JS 한도 166kB)과 계획 4·5의 숫자다. 코드 상수를 정답으로 가져오지 않는다.
const stripComments = (src) =>
  src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');

test('BAT-177-r2 T6 ① limits.mjs는 임시 알림(목록·한국 시각 날짜·판정)을 내보내지 않고 한도 계산만 내보낸다', () => {
  for (const name of ['WARN_ONLY', 'kstDate', 'loadVerdict']) assert.equal(name in limitsModule, false, `limits.mjs가 ${name}를 내보내지 않아야 한다`);
  // 계획 4: I2 뒤 내보내기는 이 여섯뿐이다
  assert.deepEqual(Object.keys(limitsModule).sort(), ['JS_OVER_BUDGET_MARGIN', 'LOAD_MARGIN', 'RUNS', 'jsLimit', 'loadLimit', 'median']);
});

test('BAT-177-r2 T6 ③ lighthouse.spec.mjs에 알림 고리가 없고, 기록 파일을 먼저 쓴 뒤 지표마다 한도와 견준다', () => {
  const spec = stripComments(readFileSync(new URL('./lighthouse.spec.mjs', import.meta.url), 'utf8'));
  for (const s of ['loadVerdict', 'warnLine', '::warning', 'warnOnly', 'WARN_ONLY', "type: 'warning'", 'verdict[']) assert.ok(!spec.includes(s), `spec에 '${s}'가 남아 있다`);
  assert.doesNotMatch(spec, /import \{[^}]*\bloadVerdict\b[^}]*\} from '\.\/limits\.mjs'/);
  assert.match(spec, /const record = \{[^\n]*\blimit, lcpSummary: lcpSummary\(runs\) \};/, '기록 파일에 판정 칸 없이 값·한도·LCP 요약을 쓴다');
  assert.equal(spec.match(/expect\.soft\(got\[k\], msg\)\.toBeLessThanOrEqual\(limit\[k\]\);/g)?.length, 1, '지표마다 한도와 견주는 줄이 하나 있다');
  assert.ok(spec.indexOf('writeFileSync(') < spec.indexOf("page.name === '월렛'"), '기록 파일을 먼저 쓰고 월렛 lcpSummary를 본다');
  assert.ok(spec.indexOf('writeFileSync(') < spec.indexOf('expect.soft(got[k]'), '기록 파일을 먼저 쓰고 판정한다');
});

test('BAT-177 T8 ① 한도 7,255ms·기준선 5,804ms·RUNS 5·여유는 그대로다', () => {
  assert.equal(loadLimit(undefined, 5804, 'lcpMs'), 7255);
  const lh = JSON.parse(readFileSync(new URL('./lighthouse-baseline.json', import.meta.url), 'utf8')).pages;
  assert.equal(lh['월렛'].lcpMs, 5804, '월렛 기준선은 5,804ms 그대로다');
  assert.equal(RUNS, 5);
  assert.deepEqual(LOAD_MARGIN, { ms: 0.25, cls: 0.02 });
});

test('BAT-177 T9 ③ spec은 모든 화면 × 세 지표를 판정하고 지표 loop에서 건너뛰지 않는다(BAT-177-r2: 경고 갈래 없음)', () => {
  const spec = stripComments(readFileSync(new URL('./lighthouse.spec.mjs', import.meta.url), 'utf8'));
  const loopStart = spec.indexOf('for (const [k, ko, fmt, unit] of METRICS) {');
  assert.ok(loopStart >= 0, '지표 판정 loop가 있다');
  // 중괄호 균형으로 loop 본문을 꺼낸다(템플릿 리터럴의 ${}도 서로 상쇄된다)
  let depth = 0;
  let loopEnd = -1;
  for (let i = spec.indexOf('{', loopStart); i < spec.length; i++) {
    if (spec[i] === '{') depth += 1;
    else if (spec[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        loopEnd = i;
        break;
      }
    }
  }
  assert.ok(loopEnd > loopStart, '지표 loop의 끝을 찾는다');
  const body = spec.slice(loopStart, loopEnd + 1);
  assert.equal(body.match(/\bcontinue\b/g)?.length ?? 0, 0, '지표 loop에 continue가 없다');
  assert.doesNotMatch(body, /\bif \(/, '지표 loop에 갈래가 없다(화면·지표·판정 칸으로 건너뛰지 않는다)');
  assert.match(body, /expect\.soft\(got\[k\], msg\)\.toBeLessThanOrEqual\(limit\[k\]\);/, '모든 지표를 한도와 견준다');
  // 세 지표를 모두 돈다
  for (const key of ['lcpMs', 'cls', 'tbtMs']) assert.ok(spec.includes(`['${key}',`), `METRICS에 ${key}가 있다`);
});

test('BAT-177 T10 ① /my/tickets 첫 JS 한도는 166kB이고 js.spec이 그 한도로 막는다', () => {
  const budget = loadJsBudgets().get('월렛');
  assert.equal(budget, 120, "§5.8 월렛 행의 첫 JS 예산은 120KB [가정]");
  const baseline = JSON.parse(readFileSync(new URL('./js-baseline.json', import.meta.url), 'utf8')).pages['web /my/tickets'];
  assert.equal(baseline, 165);
  assert.equal(jsLimit(budget, baseline), 166);
  const spec = readFileSync(new URL('./js.spec.mjs', import.meta.url), 'utf8');
  assert.match(spec, /const limit = jsLimit\(budget, baseline\[key\]\)/);
  assert.match(spec, /expect\(kb,[\s\S]{0,300}\)\.toBeLessThanOrEqual\(limit\)/);
});

test('BAT-177 T10 ② js.spec.mjs는 jsLimit를 곱하거나 더하지 않고 그대로 한도로 쓴다', () => {
  const spec = readFileSync(new URL('./js.spec.mjs', import.meta.url), 'utf8');
  assert.match(spec, /const budget = budgets\.get\(page\.row\);/, '예산은 §5.8에서 읽는다');
  assert.match(spec, /const limit = jsLimit\(budget, baseline\[key\]\);/, '한도는 jsLimit 결과를 그대로 쓴다');
  assert.doesNotMatch(spec, /jsLimit\([^)]*\)\s*[-+*/%]/, '한도에 산술 접미사를 붙이지 않는다');
  assert.doesNotMatch(spec, /limit\s*[-+*/%]\s*\d/, '한도를 곱하거나 더해 비교하지 않는다');
  assert.match(spec, /expect\(kb,[\s\S]{0,300}\)\.toBeLessThanOrEqual\(limit\)/, '그 한도로 kb를 막는다');
});
