/// <reference lib="webworker" />
// 월렛 킬 스위치 워커(RB-23, docs/frontend.md §5.4 '킬 스위치', ADR-0363 결정 6, FE-T14·FE-T43).
// 빌드 때 보통 워커(app/sw.ts)와 함께 묶어 두고(scripts/service-worker.mjs), 웹 앱 서버 실행 환경 `PEAKET_WALLET_SW_MODE=kill`이면
// 같은 주소 `/my/tickets/sw.js`가 이 워커를 낸다(app/my/tickets/sw.js/route.ts). 빌드 값으로 켜고 끄지 않는다(§5.18).
// 설치되자마자 활성화해 월렛 런타임·미리 저장 캐시를 지우고 자기 등록을 풀며 열린 월렛 창을 새로 읽힌다.
// IndexedDB `peaket-wallet`(입장 키)과 웹 푸시 워커(`/push/`)는 건드리지 않는다. fetch 처리기는 두지 않는다(요청을 가로채지 않는다).
import { runWalletKillSwitch } from '../src/features/wallet-device-key/sw-rules';

declare const self: ServiceWorkerGlobalScope;

self.addEventListener('install', () => {
  void self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      await runWalletKillSwitch({ caches: self.caches, registration: self.registration, clients: self.clients });
    })(),
  );
});
