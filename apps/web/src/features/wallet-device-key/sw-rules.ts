// 월렛 서비스 워커의 경로·캐시·메시지 규칙(docs/frontend.md §5.4 '서비스 워커'·'갱신' ①⑤, ASVS 14.3.2, BUILD_ORDER HOT-390).
// app/sw.ts가 이 넷을 써서 규칙을 만든다. 워커 묶음에 들어가므로 브라우저·워커 표준 API만 쓴다.
import type { SerwistPlugin } from 'serwist';

/** 페이지 이동 캐시를 받는 두 꼴: `/my/tickets`와 `/my/tickets/{ticketId}`(끝 `/`는 같은 주소) */
const WALLET_DOCUMENT = /^\/my\/tickets(?:\/[^/]+)?\/?$/;

/** 페이지 이동 캐시를 받는 주소인지: `/my/tickets`와 `/my/tickets/{ticketId}` 두 꼴만(끝 `/`는 같은 주소) */
export function isWalletDocumentPath(pathname: string): boolean {
  return WALLET_DOCUMENT.test(pathname);
}

/** 캐시하지 않고 네트워크로만 받는 주소인지: API(`/v1/`)와 워커 자신(`/serwist/`) */
export function isNetworkOnlyPath(pathname: string): boolean {
  return pathname.startsWith('/v1/') || pathname.startsWith('/serwist/');
}

/** `Cache-Control` 지시어 가운데 `no-store`가 있는지(대소문자·쉼표 사이 빈칸 무시) */
function hasNoStore(cacheControl: string | null): boolean {
  if (!cacheControl) return false;
  return cacheControl.split(',').some((d) => d.trim().toLowerCase() === 'no-store');
}

/** 응답의 `Cache-Control`에 `no-store`가 있으면 Cache Storage에 넣지 않는다(cacheWillUpdate가 null) */
export const rejectNoStore: SerwistPlugin = {
  async cacheWillUpdate({ response }) {
    return hasNoStore(response.headers.get('cache-control')) ? null : response;
  },
};

/** 창이 보낸 활성화 요청(`{ type: 'SKIP_WAITING' }`)인지 */
export function isSkipWaitingMessage(data: unknown): boolean {
  return typeof data === 'object' && data !== null && (data as { type?: unknown }).type === 'SKIP_WAITING';
}
