/// <reference lib="webworker" />
// 월렛 서비스 워커(offline-gate §2·§4, docs/frontend.md §2.3·§5.4, ADR-0079 결정 14, BAT-350).
// - 정적 자산과 방문한 `/my/tickets` 문서를 캐시해 오프라인에서도 셸을 연다. 티켓·키 데이터는 Dexie(`peaket-wallet`)가 맡는다.
// - API(`/v1/*`)는 개인 값이므로 절대 캐시하지 않는다(NetworkOnly). 오프라인 입장 판정은 기기 키 서명과 IndexedDB만 쓴다.
// - 캐시 못 한 문서는 `/~offline`으로 대체한다. 서비스 워커 자신(`/serwist/*`)도 캐시하지 않는다.
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig, SerwistPlugin } from 'serwist';
import { NetworkOnly, Serwist, StaleWhileRevalidate } from 'serwist';

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
    matcher: ({ sameOrigin, url }) => sameOrigin && (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/serwist/')),
    handler: new NetworkOnly(),
  },
  {
    matcher: ({ sameOrigin, request, url }) => sameOrigin && request.destination === 'document' && url.pathname.startsWith('/my/tickets'),
    handler: new StaleWhileRevalidate({ cacheName: 'wallet-pages', plugins: [rejectServerErrors] }),
  },
  {
    matcher: ({ sameOrigin, request }) =>
      sameOrigin && (request.destination === 'script' || request.destination === 'style' || request.destination === 'image' || request.destination === 'font'),
    handler: new StaleWhileRevalidate({ cacheName: 'wallet-assets' }),
  },
];

const serwist = new Serwist({
  precacheEntries: self.__SW_MANIFEST,
  skipWaiting: true,
  clientsClaim: true,
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

serwist.addEventListeners();
