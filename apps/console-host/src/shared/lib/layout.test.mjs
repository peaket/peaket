// 콘솔 열 수 계산(F-03-5 T13 OPS-420, 시험 먼저 ADR 0372번).
// 정본: docs/design/d5-screen-blueprint.md §3.9(휴대폰 md 미만 360~767, 태블릿 md 768~1279, 데스크톱 1280 이상.
// '태블릿은 데스크톱과 기능이 같고 배치만 바뀐다'), 계획 docs/review/plans/F-03-5.md 6-7(768~1023 2열, 1024~1279 3열).
// 구현 전 트리에는 shared/lib/layout.ts에 columnsFor가 없어 이 시험이 실패한다.
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('F-03-5 T13 OPS-420 콘솔 열 수는 768 미만 1, 768~1023 2, 1024 이상 3이다', async () => {
  const { columnsFor } = await import('./layout.ts');
  assert.equal(typeof columnsFor, 'function', 'layout.ts에 columnsFor가 없다');
  for (const [width, want] of [
    [360, 1],
    [767, 1],
    [768, 2],
    [1023, 2],
    [1024, 3],
    [1279, 3],
    [1280, 3],
    [1920, 3],
  ]) {
    assert.equal(columnsFor(width), want, `${width}px`);
  }
});

test('F-03-5 T13 OPS-420 열 수 갈고리는 768·1024 경계를 matchMedia로 읽는다', () => {
  const src = readFileSync(new URL('./layout.ts', import.meta.url), 'utf8');
  assert.match(src, /useGridColumns/, 'useGridColumns가 없다');
  assert.match(src, /min-width:\s*1024px/, '1024 경계를 읽지 않는다');
  assert.match(src, /min-width:\s*768px/, '768 경계를 읽지 않는다');
});
