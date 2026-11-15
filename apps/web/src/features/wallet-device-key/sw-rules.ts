// 월렛 서비스 워커의 경로·캐시·메시지 규칙(docs/frontend.md §5.4 '서비스 워커'·'갱신' ①⑤, ASVS 14.3.2, BUILD_ORDER HOT-390).
// app/sw.ts가 이 넷을 써서 규칙을 만든다. 시험 담당이 먼저 둔 빈 뼈대다(BAT-170 웨이브 7, ADR-0270 결정 3). 동작은 구현 담당이 쓴다.
import type { SerwistPlugin } from 'serwist';

/** 페이지 이동 캐시를 받는 주소인지: `/my/tickets`와 `/my/tickets/{ticketId}` 두 꼴만(끝 `/`는 같은 주소) */
export function isWalletDocumentPath(pathname: string): boolean {
  void pathname;
  throw new Error('아직 없음');
}

/** 캐시하지 않고 네트워크로만 받는 주소인지: API(`/v1/`)와 워커 자신(`/serwist/`) */
export function isNetworkOnlyPath(pathname: string): boolean {
  void pathname;
  throw new Error('아직 없음');
}

/** 응답의 `Cache-Control`에 `no-store`가 있으면 Cache Storage에 넣지 않는다(cacheWillUpdate가 null) */
export const rejectNoStore: SerwistPlugin = {
  async cacheWillUpdate() {
    throw new Error('아직 없음');
  },
};

/** 창이 보낸 활성화 요청(`{ type: 'SKIP_WAITING' }`)인지 */
export function isSkipWaitingMessage(data: unknown): boolean {
  void data;
  throw new Error('아직 없음');
}
