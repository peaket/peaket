// 브라우저의 검색 품질 사건 묶음 하나(docs/features/search.md §11, ADR-0271 결정 20). 같은 출처 `/_t/rum`으로만 보내고 검색어·주소·쿼리 문자열을 싣지 않는다(catalog-review 14.2.3).
// 보내기는 @peaket/telemetry lite의 sendBatch다(credentials: omit, keepalive, referrerPolicy: no-referrer, keepalive를 모르면 sendBeacon).
// 60초 [가정]마다(사건을 부를 때 모듈이 본다), 화면을 숨길 때(visibilitychange), 떠날 때(pagehide) 보낸다. 수집기가 없어 보내기가 실패해도 화면은 그대로다.
import { sendBatch } from '@peaket/telemetry/lite';
import { createSearchQuality, type SearchQuality } from './search-quality.ts';

let quality: SearchQuality | undefined;

/** 검색 품질 사건(브라우저에서만. 서버 그리기에서는 아무것도 하지 않는 대역) */
export function searchQuality(): SearchQuality {
  if (quality) return quality;
  if (typeof window === 'undefined') return NOOP;
  const q = createSearchQuality({ send: (path, body) => sendBatch(path, body), now: () => Date.now() });
  quality = q;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void q.flush();
  });
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
