// 성능 예산 판정과 정본 읽기 시험(docs/frontend.md §5.8, BUILD_ORDER BAS-220)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JS_OVER_BUDGET_MARGIN, LOAD_MARGIN, RUNS, WARN_ONLY, jsLimit, kstDate, loadLimit, loadVerdict, median } from './limits.mjs';
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

// BAT-176: 월렛 첫 화면의 LCP 하나만 임시로 한도를 넘어도 실패 대신 알림을 낸다(docs/frontend.md §5.8 'Lighthouse CI', 소유자 결정 2026-11-19 OPEN[52]).
// 단언 값은 정본 문장(한도 7,255ms = 기준선 5,804ms × 1.25, 늦어도 2026-11-30, 한국 시각으로 그날이 끝날 때까지)과 계획 docs/review/plans/BAT-176.md 3의 숫자다.
// WARN_ONLY는 단언 대상으로만 가져온다. 날짜 경계는 now에 가짜 시각을 넣어 본다.
const at = (iso) => new Date(iso);
const WALLET_LCP_OVER = { page: '월렛', metric: 'lcpMs', value: 8040, limit: 7255 };

test('BAT-176 알림만 목록은 월렛 LCP 하나뿐이고 되돌릴 날은 2026-11-30이다', () => {
  assert.deepEqual(
    WARN_ONLY.map(({ page, metric, until }) => ({ page, metric, until })),
    [{ page: '월렛', metric: 'lcpMs', until: '2026-11-30' }],
  );
  assert.ok(Object.isFrozen(WARN_ONLY), '목록이 얼어 있어야 한다');
  for (const e of WARN_ONLY) assert.ok(Object.isFrozen(e), '항목이 얼어 있어야 한다');
});

test('BAT-176 알림 문구에 임시·되돌릴 날·OPEN[52]가 있다', () => {
  const wallet = WARN_ONLY.find((e) => e.page === '월렛' && e.metric === 'lcpMs');
  assert.ok(wallet, '월렛 LCP 항목이 있어야 한다');
  for (const s of ['임시', '되돌릴 날', '(나)를 합치는 날', '2026-11-30', 'OPEN[52]']) assert.ok(wallet.reason.includes(s), `문구에 '${s}'가 없다: ${wallet.reason}`);
});

test('BAT-176 월렛 LCP가 한도를 넘으면 알림이고 한도 값은 7,255ms 그대로다', () => {
  assert.equal(loadLimit(undefined, 5804, 'lcpMs'), 7255);
  const lh = JSON.parse(readFileSync(new URL('./lighthouse-baseline.json', import.meta.url), 'utf8')).pages;
  assert.equal(lh['월렛'].lcpMs, 5804, '월렛 기준선은 5,804ms 그대로다');
  const now = at('2026-11-19T12:00:00+09:00');
  const v = loadVerdict({ ...WALLET_LCP_OVER, now });
  assert.equal(v.verdict, 'warn');
  assert.equal(v.until, '2026-11-30');
  assert.ok(v.reason.includes('OPEN[52]'), v.reason);
  // 한도 경계 양쪽: 한도와 같으면 통과, 1ms 넘으면 알림(여유를 더하지 않는다)
  assert.deepEqual(loadVerdict({ ...WALLET_LCP_OVER, value: 7255, now }), { verdict: 'pass' });
  assert.equal(loadVerdict({ ...WALLET_LCP_OVER, value: 7256, now }).verdict, 'warn');
  // 한도 안이면 월렛 LCP여도 통과다
  assert.deepEqual(loadVerdict({ ...WALLET_LCP_OVER, value: 5400, now }), { verdict: 'pass' });
});

test('BAT-176 되돌릴 날 경계: 한국 시각 2026-11-30 끝까지 알림, 다음 날부터 실패', () => {
  for (const iso of ['2026-11-30T00:00:00+09:00', '2026-11-30T23:59:59+09:00', '2026-11-30T23:59:59.999+09:00', '2026-11-30T14:59:59Z']) {
    assert.equal(loadVerdict({ ...WALLET_LCP_OVER, now: at(iso) }).verdict, 'warn', `${iso}는 아직 한국 시각 2026-11-30이라 알림이다`);
  }
  // 2026-11-30T15:00:00Z는 UTC 날짜로는 아직 11-30이지만 한국 시각으로는 12-01 0시다
  for (const iso of ['2026-12-01T00:00:00+09:00', '2026-11-30T15:00:00Z', '2026-12-15T12:00:00+09:00', '2027-01-01T00:00:00+09:00']) {
    assert.deepEqual(loadVerdict({ ...WALLET_LCP_OVER, now: at(iso) }), { verdict: 'fail' }, `${iso}는 되돌릴 날이 지나 실패다`);
  }
  assert.equal(kstDate(at('2026-11-30T15:00:00Z')), '2026-12-01');
  assert.equal(kstDate(at('2026-11-30T14:59:59.999Z')), '2026-11-30');
  assert.equal(kstDate(at('2026-11-19T00:00:00+09:00')), '2026-11-19');
  // 되돌릴 날이 지나도 한도 안이면 통과다
  assert.deepEqual(loadVerdict({ ...WALLET_LCP_OVER, value: 7000, now: at('2026-12-01T00:00:00+09:00') }), { verdict: 'pass' });
});

test('BAT-176 월렛의 CLS·총 차단 시간과 다른 일곱 화면의 세 지표는 넘으면 그대로 실패다', () => {
  const now = at('2026-11-19T12:00:00+09:00');
  assert.deepEqual(loadVerdict({ page: '월렛', metric: 'cls', value: 0.2, limit: 0.1, now }), { verdict: 'fail' });
  assert.deepEqual(loadVerdict({ page: '월렛', metric: 'tbtMs', value: 300, limit: 200, now }), { verdict: 'fail' });
  const others = lighthousePages('h').map((p) => p.name).filter((n) => n !== '월렛');
  assert.equal(others.length, 7, '월렛을 뺀 대표 주소는 일곱이다');
  // LCP 한도는 월렛과 같은 7,255ms로 두어 화면 이름으로만 갈리는지 본다
  const limits = { lcpMs: 7255, cls: 0.1, tbtMs: 200 };
  const over = { lcpMs: 7256, cls: 0.11, tbtMs: 201 };
  for (const page of others) {
    for (const metric of ['lcpMs', 'cls', 'tbtMs']) {
      assert.deepEqual(loadVerdict({ page, metric, value: over[metric], limit: limits[metric], now }), { verdict: 'fail' }, `${page} ${metric}`);
      assert.deepEqual(loadVerdict({ page, metric, value: limits[metric], limit: limits[metric], now }), { verdict: 'pass' }, `${page} ${metric} 한도 안`);
    }
  }
  // 화면과 지표가 둘 다 맞아야 한다: 이름이 조금 다르거나 지표 이름이 다르면 알림이 아니다
  assert.equal(loadVerdict({ ...WALLET_LCP_OVER, page: '월렛 ', now }).verdict, 'fail');
  assert.equal(loadVerdict({ ...WALLET_LCP_OVER, metric: 'LCP', now }).verdict, 'fail');
});

test('BAT-176 시계가 없거나 망가졌거나 되돌릴 날이 없는 항목은 알림으로 새지 않고 던진다', () => {
  assert.throws(() => loadVerdict({ ...WALLET_LCP_OVER }));
  assert.throws(() => loadVerdict({ ...WALLET_LCP_OVER, now: new Date('x') }));
  assert.throws(() => loadVerdict({ ...WALLET_LCP_OVER, now: '2026-11-19' }));
  assert.throws(() => loadVerdict({ ...WALLET_LCP_OVER, now: Date.parse('2026-11-19T12:00:00+09:00') }), '숫자 시각도 Date가 아니다');
  assert.throws(() => kstDate(new Date('x')));
  assert.throws(() => kstDate(undefined));
  const now = at('2026-11-19T12:00:00+09:00');
  const good = { page: '월렛', metric: 'lcpMs', until: '2026-11-25', reason: '시험용 까닭' };
  // 시험용 항목 자체는 알림이 된다(아래 망가진 항목과 대조)
  assert.deepEqual(loadVerdict({ ...WALLET_LCP_OVER, now, warnOnly: [good] }), { verdict: 'warn', until: '2026-11-25', reason: '시험용 까닭' });
  const { until: _until, ...noUntil } = good;
  for (const bad of [noUntil, { ...good, until: '11/30' }, { ...good, until: '2026-11-30T23:59' }, { ...good, reason: '' }, { ...good, reason: '   ' }]) {
    assert.throws(() => loadVerdict({ ...WALLET_LCP_OVER, now, warnOnly: [bad] }), `망가진 항목 ${JSON.stringify(bad)}`);
  }
});

test('BAT-176 lighthouse.spec.mjs는 판정을 loadVerdict에 맡기고 화면 이름·날짜를 박지 않는다', () => {
  const src = readFileSync(new URL('./lighthouse.spec.mjs', import.meta.url), 'utf8');
  // 주석(머리 설명 등)은 빼고 코드만 본다
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  assert.match(code, /import \{[^}]*\bloadVerdict\b[^}]*\} from '\.\/limits\.mjs'/);
  for (const s of ['월렛', 'OPEN[52]', '2026-11-30', '2026-12']) assert.ok(!code.includes(s), `spec 코드에 '${s}'를 박지 않는다`);
  assert.match(code, /loadVerdict\(\{[^}]*page: page\.name[^}]*\bnow\b[^}]*\}\)/, '화면 이름과 시계를 넘겨 판정한다');
  assert.equal(code.match(/new Date\(/g)?.length, 1, '시계는 시험 머리의 new Date() 하나다');
  assert.ok(code.includes('expect.soft('), '실패 갈래가 남아 있다');
  assert.ok(code.includes('toBeLessThanOrEqual(limit'), '한도와 견주는 실패 갈래가 남아 있다');
  assert.match(code, /verdict\[k\] === 'warn'/, '알림만인 지표만 실패 갈래를 건너뛴다');
  assert.match(code, /annotations\.push\(\{ type: 'warning'/, '알림을 시험 주석에 남긴다');
  assert.ok(code.includes('::warning title=Lighthouse 알림만::'), '잡 로그에 경고 줄을 남긴다');
  assert.match(code, /const record = \{.*\blimit, verdict, warnOnly \};/, '기록 파일에 verdict·warnOnly를 쓴다');
  assert.ok(code.indexOf('loadVerdict({') < code.indexOf('writeFileSync('), '판정 뒤에 기록 파일을 쓴다');
});
