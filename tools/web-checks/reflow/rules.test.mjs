// FE-T31 재배치·확대·글자 간격 시험 값(docs/frontend.md §5.11·§5.17, WCAG 1.4.10·1.4.4·1.4.12).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EXCEPTION_SELECTORS, REFLOW_PAGES, REFLOW_VIEWPORTS, TEXT_SPACING, TEXT_SPACING_CSS, clippedTextFindings, hasPageOverflow } from './rules.mjs';

test('FE-T31 뷰포트 둘은 320×256(400% 확대)과 640×400(200% 확대)이다', () => {
  assert.deepEqual(REFLOW_VIEWPORTS, [
    { name: 'reflow-320', width: 320, height: 256 },
    { name: 'zoom-200', width: 640, height: 400 },
  ]);
});

test('FE-T31 글자 간격 값은 WCAG 1.4.12의 1.5·2·0.12·0.16배다', () => {
  assert.deepEqual(TEXT_SPACING, { lineHeight: 1.5, paragraphSpacing: 2, letterSpacing: 0.12, wordSpacing: 0.16 });
  assert.match(TEXT_SPACING_CSS, /line-height:1\.5/);
  assert.match(TEXT_SPACING_CSS, /letter-spacing:0\.12em/);
  assert.match(TEXT_SPACING_CSS, /word-spacing:0\.16em/);
  assert.match(TEXT_SPACING_CSS, /margin-block-end:2em/);
});

test('FE-T31 두 방향 스크롤 예외는 표·좌석맵·에디터·그래프다', () => {
  for (const selector of ['table', '.seatmap', '.seatmap-editor', '.graph']) assert.ok(EXCEPTION_SELECTORS.includes(selector), selector);
});

test('FE-T31 문서 가로 스크롤은 1px 여유를 두고 판정한다', () => {
  assert.equal(hasPageOverflow({ scrollWidth: 320, clientWidth: 320 }), false);
  assert.equal(hasPageOverflow({ scrollWidth: 321, clientWidth: 320 }), false);
  assert.equal(hasPageOverflow({ scrollWidth: 322, clientWidth: 320 }), true);
});

test('FE-T31 글자 잘림은 overflow가 보이는 상자와 글자가 아닌 요소를 빼고 센다', () => {
  const items = [
    { text: true, overflow: 'hidden', scrollWidth: 102, clientWidth: 100, scrollHeight: 10, clientHeight: 10 },
    { text: true, overflow: 'hidden', scrollWidth: 100, clientWidth: 100, scrollHeight: 10, clientHeight: 10 },
    { text: true, overflow: 'visible', scrollWidth: 200, clientWidth: 100, scrollHeight: 10, clientHeight: 10 },
    { text: false, overflow: 'hidden', scrollWidth: 200, clientWidth: 100, scrollHeight: 10, clientHeight: 10 },
    { text: true, overflow: 'hidden', scrollWidth: 100, clientWidth: 100, scrollHeight: 12, clientHeight: 10 },
  ];
  assert.equal(clippedTextFindings(items).length, 2);
});

test('FE-T31 주요 흐름은 소비자 웹·파트너·관제의 대표 화면이다', () => {
  assert.ok(REFLOW_PAGES.some((p) => p.app === 'web' && p.path === '/my/tickets'));
  assert.ok(REFLOW_PAGES.some((p) => p.app === 'partner'));
  assert.ok(REFLOW_PAGES.some((p) => p.app === 'console'));
});
