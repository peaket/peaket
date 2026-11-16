/// <reference lib="webworker" />
// 월렛 서비스 워커(offline-gate §2·§4, docs/frontend.md §2.3·§5.4, ADR-0079 결정 14, BAT-350).
// - 정적 자산과 방문한 월렛 문서(`/my/tickets`·`/my/tickets/{ticketId}` 두 꼴만)를 캐시해 오프라인에서도 셸을 연다.
//   양도·취소·부가 상품 화면과 `no-store` 응답은 Cache Storage에 넣지 않는다(§5.4 '갱신' ⑤, ASVS 14.3.2, HOT-390).
//   티켓·키 데이터는 Dexie(`peaket-wallet`)가 맡는다.
// - API(`/v1/*`)는 개인 값이므로 절대 캐시하지 않는다(NetworkOnly). 오프라인 입장 판정은 기기 키 서명과 IndexedDB만 쓴다.
// - 캐시 못 한 문서는 `/~offline`으로 대체한다. 서비스 워커 자신(`/serwist/*`)도 캐시하지 않는다.
// - 갱신 보류(§5.4 '갱신' ①, HOT-390): 새 판은 waiting에 머문다. 창이 `{ type: 'SKIP_WAITING' }`을 보냈을 때만(QR 잠금이 빈 것을
//   창이 확인한 뒤, features/wallet-device-key/update-hold.ts) skipWaiting()을 부르고, 활성화한 뒤에 clients.claim()을 한다.
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig, SerwistPlugin } from 'serwist';
import { NetworkOnly, Serwist, StaleWhileRevalidate } from 'serwist';
import { isNetworkOnlyPath, isSkipWaitingMessage, isWalletDocumentPath, rejectNoStore } from '../src/features/wallet-device-key/sw-rules';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;

/** 원본이 502·503을 돌려줘도 '네트워크 실패'로 보고 캐시 셸로 넘어간다(프록시·게이트웨이 장애 포함) */
const rejectServerErrors: SerwistPlugin = {
  async fetchDidSucceed({ response }) {
    if (response.status >= 500) throw new Error(`origin ${response.status}`);
    return response;
  },
};

const runtimeCaching: RuntimeCaching[] = [
  {
    matcher: ({ sameOrigin, url }) => sameOrigin && isNetworkOnlyPath(url.pathname),
    handler: new NetworkOnly(),
  },
  {
    matcher: ({ sameOrigin, request, url }) => sameOrigin && request.destination === 'document' && isWalletDocumentPath(url.pathname),
    handler: new StaleWhileRevalidate({ cacheName: 'wallet-pages', plugins: [rejectServerErrors, rejectNoStore] }),
  },
  {
    // 그 밖의 /my/tickets/…(양도·취소·부가 상품) 문서는 네트워크로만 받는다
    matcher: ({ sameOrigin, request }) => sameOrigin && request.destination === 'document',
    handler: new NetworkOnly(),
  },
  {
    matcher: ({ sameOrigin, request }) =>
      sameOrigin && (request.destination === 'script' || request.destination === 'style' || request.destination === 'image' || request.destination === 'font'),
    handler: new StaleWhileRevalidate({ cacheName: 'wallet-assets', plugins: [rejectNoStore] }),
  },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  // 스스로 활성화하지 않는다(skipWaiting·clientsClaim 끔). 아래 message 처리기가 창의 요청을 받았을 때만 한다
  skipWaiting: false,
  clientsClaim: false,
  navigationPreload: true,
  runtimeCaching,
  fallbacks: {
    entries: [
      {
        url: '/~offline',
        matcher: ({ request }) => request.destination === 'document',
      },
    ],
  },
});

self.addEventListener('message', (event) => {
  if (!isSkipWaitingMessage(event.data)) return;
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  // 창의 요청으로 활성화한 뒤에만 열린 월렛 화면을 이 판이 맡는다(첫 설치 때는 다음 이동부터 맡는다)
  event.waitUntil(self.clients.claim());
});

serwist.addEventListeners();
