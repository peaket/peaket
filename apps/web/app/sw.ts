/// <reference lib="webworker" />
// 월렛 서비스 워커(offline-gate §2·§4, docs/frontend.md §2.3·§5.4, ADR-0079 결정 14, BAT-350).
// - 정적 자산과 방문한 월렛 문서(`/my/tickets`·`/my/tickets/{ticketId}` 두 꼴만)를 캐시해 오프라인에서도 셸을 연다.
//   양도·취소·부가 상품 화면과 `no-store` 응답은 Cache Storage에 넣지 않는다(§5.4 '갱신' ⑤, ASVS 14.3.2, HOT-390).
//   티켓·키 데이터는 Dexie(`peaket-wallet`)가 맡는다.
// - API(`/v1/*`)는 개인 값이므로 절대 캐시하지 않는다(NetworkOnly). 오프라인 입장 판정은 기기 키 서명과 IndexedDB만 쓴다.
// - 캐시 못 한 문서는 `/~offline`으로 대체한다. 서비스 워커 자신(`/my/tickets/sw.js`)과 웹 푸시 워커(`/push/`)는 늘 네트워크로 받는다(NetworkOnly).
// - 주소·범위(ADR-0363 결정 5): `/my/tickets/sw.js`에서 범위 `/my/tickets`(끝 `/` 없음)로 등록한다. 킬 스위치는 같은 주소의 app/sw-kill.ts다(결정 6).
// - 갱신 보류(§5.4 '갱신' ①, HOT-390): 새 판은 waiting에 머문다. 창이 `{ type: 'SKIP_WAITING' }`을 보냈을 때만(QR 잠금이 빈 것을
//   창이 확인한 뒤, features/wallet-device-key/update-hold.ts) skipWaiting()을 부르고, 활성화한 뒤에 clients.claim()을 한다.
// - 런타임 캐시 판(§5.4 '갱신'의 런타임 캐시 판, ADR-0336 결정 5): 두 런타임 규칙은 판을 붙인 캐시 하나(`wallet-shell-{판}`)를 함께 쓴다.
//   판은 빌드 때 scripts/service-worker.mjs가 미리 저장 판과 같은 값을 `__WALLET_CACHE_VERSION__`로 넣는다(꼴 밖이면 빌드가 멈춘다).
//   활성화 때 옛 판 문서를 다시 받아 넣고 옛 판 캐시를 지운 뒤(rotateWalletCaches) clients.claim()을 한다.
import type { PrecacheEntry, RuntimeCaching, SerwistGlobalConfig, SerwistPlugin } from 'serwist';
import { NetworkOnly, Serwist, StaleWhileRevalidate } from 'serwist';
import { isNetworkOnlyPath, isSkipWaitingMessage, isWalletDocumentPath, rejectNoStore, rotateWalletCaches, walletCacheName } from '../src/features/wallet-device-key/sw-rules';

declare global {
  interface WorkerGlobalScope extends SerwistGlobalConfig {
    __SW_MANIFEST: (PrecacheEntry | string)[] | undefined;
  }
}

declare const self: ServiceWorkerGlobalScope;
/** 빌드 때 넣는 판(scripts/service-worker.mjs serwistOptions의 esbuildOptions.define). 미리 저장 판과 같은 값이다 */
declare const __WALLET_CACHE_VERSION__: string;

const WALLET_CACHE_VERSION = __WALLET_CACHE_VERSION__;
/** 런타임 캐시 이름 하나(문서·자산 규칙이 함께 쓴다). 판이 꼴 밖이면 워커가 뜨지 않는다 */
const WALLET_CACHE = walletCacheName(WALLET_CACHE_VERSION);

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
    handler: new StaleWhileRevalidate({ cacheName: WALLET_CACHE, plugins: [rejectServerErrors, rejectNoStore] }),
  },
  {
    // 그 밖의 /my/tickets/…(양도·취소·부가 상품) 문서는 네트워크로만 받는다
    matcher: ({ sameOrigin, request }) => sameOrigin && request.destination === 'document',
    handler: new NetworkOnly(),
  },
  {
    matcher: ({ sameOrigin, request }) =>
      sameOrigin && (request.destination === 'script' || request.destination === 'style' || request.destination === 'image' || request.destination === 'font'),
    handler: new StaleWhileRevalidate({ cacheName: WALLET_CACHE, plugins: [rejectNoStore] }),
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
  // 먼저 옛 판 런타임 캐시를 정리한다: 옛 판 문서 주소를 네트워크로 다시 받아 이 판 캐시에 넣고(10초 [가정] 안, 옛 응답은 옮기지 않음),
  // 지금 판이 아닌 `wallet-shell-` 캐시와 옛 이름 둘을 지운다. 미리 저장 캐시·IndexedDB·웹 푸시 워커는 건드리지 않는다.
  // 그다음 창의 요청으로 활성화한 뒤에만 열린 월렛 화면을 이 판이 맡는다(첫 설치 때는 다음 이동부터 맡는다)
  event.waitUntil(
    (async () => {
      try {
        await rotateWalletCaches({ caches: self.caches, fetch: (input, init) => self.fetch(input, init), version: WALLET_CACHE_VERSION });
      } catch {
        // 정리에 실패해도 활성화는 끝낸다(옛 판 캐시는 다음 판 활성화 때 다시 지운다)
      }
      await self.clients.claim();
    })(),
  );
});

serwist.addEventListeners();
