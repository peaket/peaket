// 스캐너 서비스 워커의 message·sync 처리기(ASVS 3.5.5, offline-gate §6.5).
// 실제 서비스 워커에서는 self에 리스너를 걸고, Node 시험은 createServiceWorkerHandler를 직접 부른다.
import { SCANNER_API_ORIGIN } from '../api/config.ts';
import { loadDeviceKey } from '../api/key-store.ts';
import { BACKGROUND_SYNC_TAG, createServiceWorkerUploader, runBackgroundUpload } from '../sync/background-sync.ts';
import { openScanQueue } from '../storage/scan-queue.ts';
import { isTrustedClientMessage, parseServiceWorkerMessage } from './protocol.ts';

export interface ServiceWorkerHandlerDeps {
  origin: string;
  skipWaiting(): void;
  claim?(): void;
  upload?(): Promise<{ accepted: number }>;
}

export function createServiceWorkerHandler(deps: ServiceWorkerHandlerDeps): {
  onMessage(event: { origin?: string; source?: { url?: string } | null; data: unknown }): Promise<void>;
} {
  return {
    async onMessage(event) {
      if (!isTrustedClientMessage(event, { origin: deps.origin })) return;
      const message = parseServiceWorkerMessage(event.data);
      if (!message) return;
      if (message.type === 'SKIP_WAITING') {
        deps.skipWaiting();
        return;
      }
      // BACKGROUND_UPLOAD_DONE은 화면이 참고하는 알림이다. 서비스 워커가 할 일은 없다.
    },
  };
}

type SelfLike = {
  location?: { origin?: string };
  addEventListener(type: string, fn: (event: unknown) => void): void;
  skipWaiting?(): void;
  clients?: { claim?(): Promise<void>; matchAll?(): Promise<{ postMessage(message: unknown): void }[]> };
  registration?: { showNotification?(title: string, options?: unknown): Promise<void> };
};

const workerSelf = typeof self !== 'undefined' ? (self as unknown as SelfLike) : undefined;

async function uploadFromWorker(): Promise<{ accepted: number }> {
  const queue = await openScanQueue();
  const key = await loadDeviceKey();
  if (!key) return { accepted: 0 };
  const port = createServiceWorkerUploader({ queue, origin: SCANNER_API_ORIGIN, key });
  const result = await runBackgroundUpload({ queue, port });
  return { accepted: result.accepted };
}

if (workerSelf && typeof workerSelf.addEventListener === 'function') {
  const origin = workerSelf.location?.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const handler = createServiceWorkerHandler({
    origin,
    skipWaiting: () => workerSelf.skipWaiting?.(),
    upload: uploadFromWorker,
  });
  workerSelf.addEventListener('message', (event) => {
    void handler.onMessage(event as { origin?: string; source?: { url?: string } | null; data: unknown });
  });
  workerSelf.addEventListener('install', (event) => {
    const e = event as { waitUntil?(p: Promise<unknown>): void };
    e.waitUntil?.(
      import('./register.ts').then(({ cacheAppShell }) => cacheAppShell({})).catch(() => ({ cached: 0, failed: true })),
    );
  });
  workerSelf.addEventListener('activate', (event) => {
    const e = event as { waitUntil?(p: Promise<unknown>): void };
    e.waitUntil?.(Promise.resolve(workerSelf.clients?.claim?.()).catch(() => undefined));
  });
  workerSelf.addEventListener('sync', (event) => {
    const e = event as { tag?: string; waitUntil?(p: Promise<unknown>): void };
    if (e.tag !== BACKGROUND_SYNC_TAG) return;
    e.waitUntil?.(uploadFromWorker().catch(() => ({ accepted: 0 })));
  });
}
