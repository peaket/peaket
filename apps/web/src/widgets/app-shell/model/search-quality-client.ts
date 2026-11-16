// 브라우저의 검색 품질 사건 묶음 하나(docs/features/search.md §11). 같은 출처 `/_t/rum`으로만 보내고 검색어·주소·쿼리 문자열을 싣지 않는다(catalog-review 14.2.3).
// 화면을 떠날 때(pagehide) 모은 것을 보낸다. 수집기는 게이트웨이 단계 몫이라 그 전에는 보내기가 실패해도 화면은 그대로다.
import { createSearchQuality, type SearchQuality } from './search-quality.ts';

let quality: SearchQuality | undefined;

/** 검색 품질 사건(브라우저에서만. 서버 그리기에서는 아무것도 하지 않는 대역) */
export function searchQuality(): SearchQuality {
  if (quality) return quality;
  if (typeof window === 'undefined') return NOOP;
  quality = createSearchQuality({
    send: async (path, body) => {
      await fetch(path, { method: 'POST', body, keepalive: true, credentials: 'same-origin', headers: { 'content-type': 'application/json' } });
    },
    now: () => Date.now(),
  });
  const q = quality;
  window.addEventListener('pagehide', () => void q.flush());
  return q;
}

const NOOP: SearchQuality = {
  resultsShown: () => {},
  suggestShown: () => {},
  suggestSelected: () => {},
  resultClick: () => {},
  flush: async () => {},
};
