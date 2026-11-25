// 스캐너 서비스 워커 등록·앱 셸 캐시·새 판 적용(offline-gate §6.2, devops §6.6).
// 등록·캐시 실패는 앱을 막지 않는다. 새 판 적용은 근무 준비에서만 보낸다.
import { shouldApplyUpdate } from './update-gate.ts';

export interface ServiceWorkerRegistrationLike {
  waiting?: { postMessage(message: unknown): void } | null;
  addEventListener?(type: 'controllerchange', fn: () => void): void;
}

export interface ServiceWorkerContainerLike {
  register(url: string, options?: { scope?: string; type?: 'classic' | 'module' }): Promise<ServiceWorkerRegistrationLike>;
}

export interface CacheStorageLike {
  open(name: string): Promise<{ addAll(urls: readonly string[]): Promise<void> }>;
}

let currentRegistration: ServiceWorkerRegistrationLike | undefined;
const appliedListeners = new WeakSet<object>();

/** /sw.js를 범위 /로 등록한다. 등록 실패는 던지지 않고 registered=false로 알린다 */
export async function registerServiceWorker(o: {
  container?: unknown;
  url?: string;
  scope?: string;
}): Promise<{ registered: boolean; registration?: unknown; error?: unknown }> {
  const container =
    (o.container as ServiceWorkerContainerLike | undefined) ??
    (typeof navigator !== 'undefined' ? (navigator.serviceWorker as unknown as ServiceWorkerContainerLike | undefined) : undefined);
  if (!container || typeof container.register !== 'function') {
    return { registered: false, error: new Error('서비스 워커를 등록할 수 없는 환경이다') };
  }
  try {
    const registration = await container.register(o.url ?? '/sw.js', { scope: o.scope ?? '/', type: 'module' });
    currentRegistration = registration;
    return { registered: true, registration };
  } catch (error) {
    return { registered: false, error };
  }
}

/** 앱 셸을 캐시에 넣는다. 실패해도 앱은 온라인으로 계속 뜬다 */
export async function cacheAppShell(o: {
  caches?: unknown;
  cacheName?: string;
  shell?: readonly string[];
}): Promise<{ cached: number; failed: boolean }> {
  const caches =
    (o.caches as CacheStorageLike | undefined) ??
    (typeof globalThis !== 'undefined' ? (globalThis.caches as unknown as CacheStorageLike | undefined) : undefined);
  const shell = o.shell ?? ['/', '/index.html', '/manifest.webmanifest'];
  if (!caches || typeof caches.open !== 'function') return { cached: 0, failed: true };
  try {
    const cache = await caches.open(o.cacheName ?? 'peaket-scanner-v1');
    await cache.addAll(shell);
    return { cached: shell.length, failed: false };
  } catch {
    return { cached: 0, failed: true };
  }
}

/**
 * 대기 중인 새 판에 SKIP_WAITING을 보낸다. 근무 준비이고 스캔이 없을 때만이다.
 * controllerchange가 오면 onApplied를 한 번 부른다(목록 재수신 고리).
 */
export function applyWaitingUpdate(o: {
  registration?: ServiceWorkerRegistrationLike;
  phase: 'prep' | 'entry';
  activeScans?: number;
  post?: (m: { type: 'SKIP_WAITING' }) => void;
  onApplied?: () => void;
}): boolean {
  const registration = o.registration;
  const waiting = registration?.waiting;
  if (!waiting) return false;
  if (!shouldApplyUpdate({ phase: o.phase, waiting: true, ...(o.activeScans !== undefined ? { activeScans: o.activeScans } : {}) })) return false;
  const message = { type: 'SKIP_WAITING' } as const;
  if (o.post) o.post(message);
  else waiting.postMessage(message);
  if (o.onApplied && registration && !appliedListeners.has(registration)) {
    appliedListeners.add(registration);
    registration.addEventListener?.('controllerchange', o.onApplied);
  }
  return true;
}

/** 화면(근무 준비)이 등록 객체를 다시 쓸 수 있게 한다 */
export function getServiceWorkerRegistration(): ServiceWorkerRegistrationLike | undefined {
  return currentRegistration;
}
