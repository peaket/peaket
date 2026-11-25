// 스캐너 서비스 워커의 message·sync 처리기(ASVS 3.5.5, offline-gate §6.5).
// 실제 서비스 워커에서는 self에 리스너를 걸고, Node 시험은 createServiceWorkerHandler를 직접 부른다.
import { SCANNER_API_ORIGIN } from '../api/config.ts';
import { loadDeviceKey } from '../api/key-store.ts';
import { BACKGROUND_SYNC_TAG, createServiceWorkerUploader, runBackgroundUpload } from '../sync/background-sync.ts';
import { openPackageStore } from '../storage/package-store.ts';
import { openScanQueue } from '../storage/scan-queue.ts';
import { isTrustedClientMessage, parseServiceWorkerMessage } from './protocol.ts';
import { CACHE_NAME, cacheAppShell, cleanupCaches } from './register.ts';

export interface ServiceWorkerHandlerDeps {
  origin: string;
  skipWaiting(): void;
  claim?(): void;
  upload?(): Promise<{ accepted: number; resyncRequired?: boolean; stopped?: 'device-revoked' | 'device-unregistered' }>;
  caches?: { match(request: unknown): Promise<Response | undefined> };
  fetch?: typeof fetch;
  clients?: { matchAll(): Promise<{ postMessage(message: unknown): void }[]> };
}

export function createServiceWorkerHandler(deps: ServiceWorkerHandlerDeps): {
  onMessage(event: { origin?: string; source?: { url?: string } | null; data: unknown }): Promise<void>;
  onFetch(event: { request: { method: string; url: string; mode?: string } }): Promise<Response | undefined>;
  onSync(event: { tag?: string }): Promise<void>;
} {
  return {
    async onMessage(event) {
      if (!isTrustedClientMessage(event, { origin: deps.origin })) return;
      const message = parseServiceWorkerMessage(event.data);
      if (!message) return;
      if (message.type === 'SKIP_WAITING') deps.skipWaiting();
      // BACKGROUND_UPLOAD_DONE은 화면이 참고하는 알림이다. 서비스 워커가 할 일은 없다.
    },

    async onFetch(event) {
      if (event.request.method !== 'GET') return undefined;
      let url: URL;
      try {
        url = new URL(event.request.url);
      } catch {
        return undefined;
      }
      // 앱 셸(같은 출처)만 캐시 우선. API·다른 출처는 서비스 워커가 가로채지 않는다.
      if (url.origin !== deps.origin || url.pathname === '/sw.js') return undefined;
      const cached = await deps.caches?.match(event.request);
      if (cached) return cached;
      // SPA 이동은 캐시한 앱 셸로 돌린다(설치 start_url 밖 경로도 오프라인에서 다시 연다).
      if (event.request.mode === 'navigate') {
        const shell = await deps.caches?.match('/index.html');
        if (shell) return shell;
      }
      if (!deps.fetch) return undefined;
      return deps.fetch(event.request as unknown as RequestInfo, { credentials: 'omit' } as RequestInit);
    },

    async onSync(event) {
      if (event.tag !== 'peaket-scanner-scans' || !deps.upload) return;
      const result = await deps.upload();
      const clients = (await deps.clients?.matchAll()) ?? [];
      const message = {
        type: 'BACKGROUND_UPLOAD_DONE',
        accepted: result.accepted,
        resyncRequired: result.resyncRequired === true,
        ...(result.stopped ? { stopped: result.stopped } : {}),
      };
      for (const client of clients) client.postMessage(message);
    },
  };
}

type SelfLike = {
  location?: { origin?: string };
  addEventListener(type: string, fn: (event: unknown) => void): void;
  skipWaiting?(): void;
  clients?: { claim?(): Promise<void>; matchAll?(): Promise<{ postMessage(message: unknown): void }[]> };
  caches?: unknown;
  fetch?: typeof fetch;
  registration?: { showNotification?(title: string, options?: unknown): Promise<void> };
};

type UploadResult = { accepted: number; resyncRequired?: boolean; stopped?: 'device-revoked' | 'device-unregistered' };

const workerSelf = typeof self !== 'undefined' ? (self as unknown as SelfLike) : undefined;

async function uploadFromWorker(): Promise<{ accepted: number; resyncRequired: boolean; stopped?: 'device-revoked' | 'device-unregistered' }> {
  const queue = await openScanQueue();
  const key = await loadDeviceKey();
  if (!key) return { accepted: 0, resyncRequired: false };
  const meta = await openPackageStore().then((store) => store.meta()).catch(() => ({ deviceSeq: 0 } as { clockOffsetMs?: number }));
  const clockOffsetMs = meta.clockOffsetMs;
  const port = createServiceWorkerUploader({
    queue,
    origin: SCANNER_API_ORIGIN,
    key,
    ...(clockOffsetMs !== undefined ? { loadClockOffsetMs: async () => clockOffsetMs } : {}),
  });
  const result = await runBackgroundUpload({ queue, port });
  return {
    accepted: result.accepted,
    resyncRequired: result.resyncRequired,
    ...(result.stopped ? { stopped: result.stopped } : {}),
  };
}

/**
 * 실제 서비스 워커 조립. self의 caches·fetch·clients를 createServiceWorkerHandler에 넘기고
 * install·activate·fetch·sync·message 사건을 건다. 시험도 이 함수를 그대로 부른다.
 */
export function createScannerServiceWorker(o: {
  scope: SelfLike;
  caches?: unknown;
  fetch?: typeof fetch;
  clients?: { matchAll(): Promise<{ postMessage(message: unknown): void }[]> };
  upload?: () => Promise<UploadResult>;
}): ReturnType<typeof createServiceWorkerHandler> {
  const scope = o.scope;
  const origin = scope.location?.origin ?? (typeof location !== 'undefined' ? location.origin : '');
  const caches = o.caches ?? scope.caches;
  const fetchImpl = o.fetch ?? scope.fetch ?? (typeof fetch !== 'undefined' ? fetch : undefined);
  const clients = o.clients ?? (scope.clients?.matchAll ? { matchAll: () => scope.clients!.matchAll!() } : undefined);
  const handler = createServiceWorkerHandler({
    origin,
    skipWaiting: () => scope.skipWaiting?.(),
    ...(o.upload ? { upload: o.upload } : {}),
    ...(caches ? { caches: caches as { match(request: unknown): Promise<Response | undefined> } } : {}),
    ...(fetchImpl ? { fetch: fetchImpl } : {}),
    ...(clients ? { clients } : {}),
  });
  scope.addEventListener('message', (event) => {
    void handler.onMessage(event as { origin?: string; source?: { url?: string } | null; data: unknown });
  });
  scope.addEventListener('install', (event) => {
    const e = event as { waitUntil?(p: Promise<unknown>): void };
    e.waitUntil?.(
      (async () => {
        let assets: string[] = [];
        try {
          if (!fetchImpl) return { cached: 0, failed: true };
          const res = await fetchImpl('/sw-precache.json', { cache: 'no-store' });
          if (res.ok) {
            const body = (await res.json()) as { assets?: unknown };
            if (Array.isArray(body.assets)) assets = body.assets.filter((x): x is string => typeof x === 'string');
          }
        } catch {
          // 매니페스트가 없으면 셸만 캐시한다
        }
        return cacheAppShell({ cacheName: CACHE_NAME, assets, ...(caches ? { caches } : {}) });
      })().catch(() => ({ cached: 0, failed: true })),
    );
  });
  scope.addEventListener('activate', (event) => {
    const e = event as { waitUntil?(p: Promise<unknown>): void };
    e.waitUntil?.(
      cleanupCaches({ keep: CACHE_NAME, ...(caches ? { caches } : {}) })
        .catch(() => ({ removed: 0 }))
        .then(() => scope.clients?.claim?.())
        .catch(() => undefined),
    );
  });
  scope.addEventListener('fetch', (event) => {
    const e = event as { request?: { method: string; url: string; mode?: string }; respondWith?(p: Promise<Response | undefined>): void };
    if (!e.request || e.request.method !== 'GET') return;
    let url: URL;
    try {
      url = new URL(e.request.url);
    } catch {
      return;
    }
    if (url.origin !== origin || url.pathname === '/sw.js') return;
    e.respondWith?.(
      handler
        .onFetch({ request: e.request })
        .then((r) => r ?? (fetchImpl ? fetchImpl(e.request as unknown as Request) : undefined))
        .catch(() => (caches ? (caches as { match(request: unknown): Promise<Response | undefined> }).match('/index.html') : undefined)),
    );
  });
  scope.addEventListener('sync', (event) => {
    const e = event as { tag?: string; waitUntil?(p: Promise<unknown>): void };
    e.waitUntil?.(handler.onSync({ tag: e.tag }).catch(() => undefined));
  });
  return handler;
}

if (workerSelf && typeof workerSelf.addEventListener === 'function') {
  createScannerServiceWorker({ scope: workerSelf, upload: uploadFromWorker });
}
