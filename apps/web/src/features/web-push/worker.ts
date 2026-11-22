/// <reference lib="webworker" />
// 웹 푸시 전용 워커의 처리기(docs/frontend.md §5.4 '웹 푸시를 받는 서비스 워커는 따로 둔다', docs/features/notify.md §3.4·§3.5, ADR-0363 결정 7, FE-T48).
// app/push-sw.ts가 installPushWorker(self)로 싣는다. 시험은 이벤트 대역을 가진 가짜 전역으로 부른다.
// - 처리기는 push·notificationclick·pushsubscriptionchange 셋뿐이다. fetch 처리기와 Cache Storage는 두지 않는다(화면을 제어하지 않는다).
// - 새 판은 바로 활성화한다(skipWaiting). 화면을 제어하지 않으므로 clients.claim은 하지 않는다.
// - push: Safari가 권한을 거두지 않게 본문을 풀지 못해도 늘 showNotification을 한 번 부른다(풀지 못하면 기본 문구와 알림 목록 링크 [가정]).
// - notificationclick: 본문의 url이 같은 출처의 `/`로 시작하고 허용한 앞부분일 때만 그 주소를 열고, 그 밖이면 홈을 연다.
// - pushsubscriptionchange: 새 구독을 IndexedDB `peaket-push`에 '다시 등록 필요'(pending)로 적는다. 액세스 토큰이 없을 수 있어 직접 등록하지 않는다.
import { indexedDbPendingStore, type PendingPushStore } from './pending-store.ts';

/** 알림을 누르면 열어도 되는 앞부분(notify §3.5 [가정]) */
export const PUSH_OPEN_PREFIXES = ['/events/', '/productions/', '/my/', '/queue/', '/help/'] as const;
/** 풀지 못한 푸시의 기본 문구와 링크(notify §3.5 [가정]) */
export const PUSH_FALLBACK = { title: '피켓 알림이 도착했습니다', body: '알림 목록에서 내용을 확인해 주세요', url: '/my/likes' } as const;

export interface PushPayload {
  title: string;
  body: string;
  url: string;
  tag?: string;
}

/** 받은 푸시 본문(core-svc가 싣는 `{v, kind, title, body, url?, tag}`)을 알림 값으로. 풀지 못하면 기본 문구 */
export function pushPayloadOf(data: { json(): unknown } | null | undefined): PushPayload {
  try {
    const raw = data?.json() as { title?: unknown; body?: unknown; url?: unknown; tag?: unknown } | undefined;
    if (!raw || typeof raw.title !== 'string' || raw.title === '') return { ...PUSH_FALLBACK };
    return {
      title: raw.title,
      body: typeof raw.body === 'string' ? raw.body : '',
      url: typeof raw.url === 'string' ? raw.url : '/',
      ...(typeof raw.tag === 'string' && raw.tag !== '' ? { tag: raw.tag } : {}),
    };
  } catch {
    return { ...PUSH_FALLBACK };
  }
}

/** 알림을 누르면 열 주소: 같은 출처 상대 경로이고 허용한 앞부분이면 그 주소, 아니면 홈 */
export function pushOpenPath(url: unknown): string {
  if (typeof url !== 'string' || !url.startsWith('/') || url.startsWith('//') || url.includes('\\')) return '/';
  return PUSH_OPEN_PREFIXES.some((p) => url.startsWith(p)) ? url : '/';
}

/** 이 워커가 쓰는 전역(ServiceWorkerGlobalScope의 일부) */
export interface PushWorkerScope {
  addEventListener(type: string, listener: (event: never) => void): void;
  skipWaiting(): Promise<void>;
  registration: Pick<ServiceWorkerRegistration, 'showNotification' | 'pushManager'>;
  clients: Pick<Clients, 'openWindow'>;
  location: { origin: string };
}

export interface InstallPushWorkerOptions {
  pending?: PendingPushStore;
  now?: () => number;
}

export function installPushWorker(scope: PushWorkerScope, o: InstallPushWorkerOptions = {}): void {
  const pending = o.pending ?? indexedDbPendingStore(typeof indexedDB === 'undefined' ? undefined : indexedDB);
  const now = o.now ?? (() => Date.now());

  scope.addEventListener('install', () => {
    void scope.skipWaiting();
  });

  scope.addEventListener('push', ((event: PushEvent) => {
    const p = pushPayloadOf(event.data);
    event.waitUntil(scope.registration.showNotification(p.title, { body: p.body, data: { url: p.url }, ...(p.tag ? { tag: p.tag } : {}) }));
  }) as (event: never) => void);

  scope.addEventListener('notificationclick', ((event: NotificationEvent) => {
    event.notification.close();
    const path = pushOpenPath((event.notification.data as { url?: unknown } | null)?.url);
    event.waitUntil(scope.clients.openWindow(new URL(path, scope.location.origin).href).then(() => undefined));
  }) as (event: never) => void);

  scope.addEventListener('pushsubscriptionchange', ((event: Event & { newSubscription?: PushSubscription | null; oldSubscription?: PushSubscription | null; waitUntil(p: Promise<unknown>): void }) => {
    event.waitUntil(
      (async () => {
        let sub = event.newSubscription ?? null;
        if (!sub && event.oldSubscription?.options) {
          try {
            sub = await scope.registration.pushManager.subscribe(event.oldSubscription.options);
          } catch {
            sub = null;
          }
        }
        if (!sub) return;
        const j = sub.toJSON();
        if (typeof j.endpoint !== 'string' || typeof j.keys?.p256dh !== 'string' || typeof j.keys?.auth !== 'string') return;
        await pending.write({ endpoint: j.endpoint, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth }, expirationTime: typeof j.expirationTime === 'number' ? j.expirationTime : null, at: now() });
      })(),
    );
  }) as (event: never) => void);
}
