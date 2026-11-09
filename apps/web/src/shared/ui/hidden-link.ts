// 숨긴 일반 링크(docs/frontend.md §5.15, ADR-0249 결정 3). next/link로 바꾸면 라우터가 미리 가져와 사람을 적중으로 잡으므로 일반 <a>만 쓴다.
import { createElement, type ReactElement } from 'react';

export function hiddenLink(href: string): ReactElement {
  return createElement('a', { href, hidden: true, tabIndex: -1, rel: 'nofollow' }, '전체 일정');
}
