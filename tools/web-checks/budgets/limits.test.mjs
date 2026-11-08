// 성능 예산 판정과 정본 읽기 시험(docs/frontend.md §5.8, BUILD_ORDER BAS-220)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JS_OVER_BUDGET_MARGIN, LOAD_MARGIN, jsLimit, loadLimit, median } from './limits.mjs';
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
