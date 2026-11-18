'use client';
// 고정 띠의 실제 높이를 문서 스크롤 여백으로 넘긴다(WCAG 2.4.11, docs/frontend.md §5.11 '초점이 가려지지 않게', BAT-171 HOT-381).
// 위에 붙는 띠는 --pk-sticky-top, 아래에 붙는 띠는 --pk-sticky-bottom에 지금 그려진 높이(px, 올림)를 적고, globals.css가 그 값을
// html의 scroll-padding-top·bottom으로 쓴다. 안내 글이 좁은 폭에서 줄을 바꾸거나 글자 간격·확대로 띠가 높아지면 ResizeObserver가 다시 잰다.
// 같은 쪽에 띠가 여럿이면(겹쳐 붙는다) 가장 높은 것을 쓰고, 숨은 띠(display: none)는 0이다. 띠가 모두 빠지면 변수를 지워
// globals.css의 기본값으로 돌아간다. CSSOM으로 값을 넣으므로 CSP(style-src)에 걸리지 않는다.
// 조건부로 그리는 띠(좌석 요약)도 붙고 떨어질 때마다 따라가도록 콜백 ref로 준다(React 19 ref 정리 함수).
import { useCallback } from 'react';

type Edge = 'top' | 'bottom';

const bars: Record<Edge, Map<Element, number>> = { top: new Map(), bottom: new Map() };

function publish(edge: Edge): void {
  const root = document.documentElement.style;
  const name = `--pk-sticky-${edge}`;
  if (bars[edge].size === 0) root.removeProperty(name);
  else root.setProperty(name, `${Math.max(0, ...bars[edge].values())}px`);
}

/** 그 쪽(edge)에 붙는 고정 띠 요소에 다는 ref. 그려진 높이를 문서 스크롤 여백으로 넘긴다 */
export function useStickyInset(edge: Edge): (el: HTMLElement | null) => (() => void) | undefined {
  return useCallback(
    (el: HTMLElement | null) => {
      if (!el) return undefined;
      const measure = () => {
        bars[edge].set(el, Math.ceil(el.getBoundingClientRect().height));
        publish(edge);
      };
      measure();
      const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
      ro?.observe(el, { box: 'border-box' });
      return () => {
        ro?.disconnect();
        bars[edge].delete(el);
        publish(edge);
      };
    },
    [edge],
  );
}
