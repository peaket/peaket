// 주소의 검색 값(?state=·?theme=)을 읽고 바꾼다. 라우터 없이 history API만 쓴다(한 페이지 데모).
import { useSyncExternalStore } from 'react';

const EVENT = 'peaket:search';

function subscribe(cb: () => void) {
  window.addEventListener('popstate', cb);
  window.addEventListener(EVENT, cb);
  return () => {
    window.removeEventListener('popstate', cb);
    window.removeEventListener(EVENT, cb);
  };
}

export function useSearch(): string {
  return useSyncExternalStore(subscribe, () => window.location.search, () => '');
}

/** ?state=를 바꾼다(다른 검색 값은 남긴다). undefined면 지워 기본 상태로 */
export function goState(state: string | undefined) {
  const params = new URLSearchParams(window.location.search);
  if (state === undefined) params.delete('state');
  else params.set('state', state);
  const q = params.toString();
  window.history.pushState(null, '', q ? `?${q}` : window.location.pathname);
  window.dispatchEvent(new Event(EVENT));
}
