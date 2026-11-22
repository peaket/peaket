/// <reference lib="webworker" />
// 웹 푸시 전용 서비스 워커(`/push/sw.js`, 범위 `/push/`, docs/frontend.md §5.4, docs/features/notify.md §3.4·§3.5, ADR-0363 결정 7).
// 빌드 때 scripts/service-worker.mjs가 묶어 <distDir>/serwist/push-sw.js로 두고 app/push/sw.js/route.ts가 낸다.
// 처리기는 src/features/web-push/worker.ts(push·notificationclick·pushsubscriptionchange). fetch 처리기와 Cache Storage는 두지 않는다.
import { installPushWorker } from '../src/features/web-push/worker';

declare const self: ServiceWorkerGlobalScope;

installPushWorker(self as unknown as Parameters<typeof installPushWorker>[0]);
