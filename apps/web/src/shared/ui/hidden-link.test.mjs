// 숨긴 링크의 렌더링(docs/frontend.md §5.15, queue-admission §7 '기록 조건', ADR-0249 결정 3).
// 일반 <a>여야 라우터가 미리 가져오지 않는다. next/link로 바뀌면 미리 가져오기가 사람을 적중으로 잡는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { hiddenLink } from './hidden-link.ts';

test('[Q-T40] 일반 <a>로 그리고 화면·접근성 트리·탭 순서에서 빠지며, 용도를 드러내는 이름이 없다', () => {
  const html = renderToStaticMarkup(hiddenLink('/_t/synthetic-path-for-test?e=e1'));
  assert.match(html, /^<a [^>]*href="\/_t\/synthetic-path-for-test\?e=e1"/);
  assert.match(html, / hidden=""/);
  assert.match(html, / tabindex="-1"/);
  assert.match(html, / rel="nofollow"/);
  assert.doesNotMatch(html, /class=|id=|data-|honeypot|허니팟/i);
});

test('[Q-T40] 공연 상세는 숨긴 링크를 이 함수로만 그리고 next/link를 쓰지 않는다', () => {
  const page = readFileSync(new URL('../../_pages/event-detail/ui/EventDetailPage.tsx', import.meta.url), 'utf8');
  assert.match(page, /hiddenLink\(extraHref\)/);
  assert.doesNotMatch(page, /<Link[^>]*extraHref/);
  const src = readFileSync(new URL('./hidden-link.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /from 'next\/link'/);
});
