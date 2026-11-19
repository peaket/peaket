// 첫 화면이 다 그려진(load) 뒤에 무거운 조각을 받는다(BAT-177, docs/frontend.md §5.8).
// 부르는 곳은 useEffect 안이다. SSR에는 window·document가 없으므로 아무것도 하지 않는다.
// load가 이미 지났으면 바로 부르고, 정리 함수는 아직 부르기 전이면 load 듣기를 뗀다.
export function afterLoad(run: () => void): () => void {
  if (typeof window === 'undefined' || typeof document === 'undefined') return () => {};
  if (document.readyState === 'complete') {
    run();
    return () => {};
  }
  window.addEventListener('load', run, { once: true });
  return () => window.removeEventListener('load', run);
}
