// 웹 푸시 구독의 화면 쪽 흐름(ADR-0363 결정 7, docs/frontend.md §4.2.4·§5.4, docs/features/notify.md §3.4·§3.5, FE-T48).
// - 켜기(CMP-068 [알림 켜기]를 누른 처리기 안): 권한 묻기 → 전용 워커 `/push/sw.js`(범위 `/push/`) 등록 → 활성화 기다림 →
//   pushManager.subscribe(VAPID 공개키) → `POST /v1/push-subscriptions`를 본문으로만 한 번. 201·200이면 끝이다.
//   권한 거부·PushManager 없음·VAPID 공개키 없음(또는 틀린 꼴)·422 `push-service-not-allowed`면 요청 없이(또는 그 응답 뒤) '이메일로 알려 드립니다'.
// - 다시 묶기(로그인 뒤 셸이 그려질 때): 권한이 이미 허용이고 `getRegistration('/push/')`의 구독이 있으면 지금 계정으로 등록한다. 권한을 새로 묻지 않는다.
//   `peaket-push`의 `pending`이 있으면 그것을 먼저 등록하고 지운다.
// - 해제(로그아웃 정리 루틴 2번의 맨 앞): 이 브라우저의 구독이 있으면 `DELETE /v1/push-subscriptions/{subscriptionKey}`(구독 주소 SHA-256 base64url).
//   브라우저의 구독 자체(`unsubscribe()`)와 `/push/` 등록은 풀지 않는다. 실패해도 던지지 않는다(로그아웃은 이어 간다).
// 구독 주소와 subscriptionKey는 주소창·저장소·로그 밖으로 내지 않는다(서버 응답의 subscriptionKey도 저장하지 않는다).
// 모든 바깥 의존(fetch·serviceWorker·IDB·권한·VAPID)은 주입한다(시험·연결 시험이 같은 모양으로 부른다). 브라우저 조립은 browser.ts다.
import { refreshOnce } from '../../shared/lib/token-refresh.ts';
import type { PendingPushStore } from './pending-store.ts';

export const PUSH_WORKER_URL = '/push/sw.js';
export const PUSH_WORKER_SCOPE = '/push/';
/** 화면 문구(d5 CMP-068, notify §3.5): 웹 푸시를 켤 수 없을 때 */
export const PUSH_EMAIL_FALLBACK_TEXT = '이메일로 알려 드립니다';

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** serviceWorker 가운데 이 흐름이 쓰는 것 */
export interface ServiceWorkerLike {
  register(url: string, o: { scope: string }): Promise<ServiceWorkerRegistration>;
  getRegistration(scope: string): Promise<ServiceWorkerRegistration | undefined>;
}

export interface WebPushDeps {
  /** 팬 API 출처(ORIGINS.api). 비면 서버를 부르지 않는다 */
  origin: string;
  fetch: FetchLike;
  /** navigator.serviceWorker. 없으면 웹 푸시를 켤 수 없다 */
  serviceWorker?: ServiceWorkerLike;
  /** IndexedDB `peaket-push` 'pending' */
  idb?: PendingPushStore;
  /** 공개 빌드 값 NEXT_PUBLIC_PEAKET_VAPID_PUBLIC_KEY(base64url 비압축 P-256 점 65바이트) */
  vapidKey?: string;
  /** 지금 알림 권한(Notification.permission). 없으면 Notification API가 없다 */
  permission?: () => NotificationPermission | undefined;
  /** 권한 묻기(Notification.requestPermission). 누른 처리기 안에서만 부른다 */
  requestPermission?: () => Promise<NotificationPermission>;
  /** PushManager가 있는가(window.PushManager) */
  pushSupported?: boolean;
  /** 구독 주소의 SHA-256 base64url(기본 crypto.subtle) */
  subscriptionKeyOf?: (endpoint: string) => Promise<string>;
  /** 등록이 활성화되기를 기다리는 시간 상한(기본 10초 [가정]) */
  activateTimeoutMs?: number;
}

export type WebPushEmailReason = 'denied' | 'unsupported' | 'no-vapid' | 'push-service-not-allowed' | 'failed';
export type WebPushEnableResult = { kind: 'subscribed'; status: 200 | 201 } | { kind: 'email-only'; reason: WebPushEmailReason };
export type WebPushRebindResult = { kind: 'bound'; pending: boolean; current: boolean } | { kind: 'skipped'; reason: 'no-permission' | 'no-registration' | 'no-subscription' | 'unsupported' } | { kind: 'failed' };
export type WebPushUnbindResult = { kind: 'deleted'; status: number } | { kind: 'none' } | { kind: 'failed' };

export interface WebPush {
  enable(): Promise<WebPushEnableResult>;
  rebind(): Promise<WebPushRebindResult>;
  unbind(): Promise<WebPushUnbindResult>;
}

/** VAPID 공개키 꼴: base64url, 풀면 65바이트이고 첫 바이트 0x04(비압축 점) */
export function vapidKeyBytes(key: string | undefined): Uint8Array | undefined {
  if (!key || !/^[A-Za-z0-9_-]+$/.test(key)) return undefined;
  try {
    const bin = atob(key.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (key.length % 4)) % 4));
    if (bin.length !== 65 || bin.charCodeAt(0) !== 4) return undefined;
    const out = new Uint8Array(65);
    for (let i = 0; i < 65; i += 1) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return undefined;
  }
}

const base64Url = (bytes: ArrayBuffer): string => {
  let bin = '';
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
};

/** 구독 주소의 SHA-256 base64url(notify §3.4 subscriptionKey, 서버 subscriptionKeyOf와 같다) */
export async function subscriptionKeyOfEndpoint(endpoint: string): Promise<string> {
  return base64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint)));
}

/** 등록 본문(openapi createPushSubscription). 구독의 toJSON()이나 pending에서 만든다 */
export interface PushSubscriptionBody {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  expirationTime: number | null;
}

export function subscriptionBodyOf(sub: { toJSON(): PushSubscriptionJSON } | PushSubscriptionBody): PushSubscriptionBody | undefined {
  const j = ('toJSON' in sub ? sub.toJSON() : sub) as PushSubscriptionJSON;
  const p256dh = j.keys?.p256dh;
  const auth = j.keys?.auth;
  if (typeof j.endpoint !== 'string' || typeof p256dh !== 'string' || typeof auth !== 'string') return undefined;
  return { endpoint: j.endpoint, keys: { p256dh, auth }, expirationTime: typeof j.expirationTime === 'number' ? j.expirationTime : null };
}

async function problemTypeOf(r: Response): Promise<string> {
  try {
    const b = (await r.json()) as { type?: unknown };
    return typeof b.type === 'string' ? (b.type.split('/').filter(Boolean).pop() ?? '') : '';
  } catch {
    return '';
  }
}

/** 설치·대기 중인 등록이 활성화될 때까지 기다린다(push 범위는 화면을 제어하지 않아 serviceWorker.ready가 오지 않는다) */
function waitActive(reg: ServiceWorkerRegistration, timeoutMs: number): Promise<boolean> {
  if (reg.active) return Promise.resolve(true);
  const worker = reg.installing ?? reg.waiting;
  if (!worker) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(Boolean(reg.active)), timeoutMs);
    const onChange = () => {
      if (worker.state === 'activated') {
        clearTimeout(timer);
        worker.removeEventListener('statechange', onChange);
        resolve(true);
      } else if (worker.state === 'redundant') {
        clearTimeout(timer);
        worker.removeEventListener('statechange', onChange);
        resolve(false);
      }
    };
    worker.addEventListener('statechange', onChange);
  });
}

export function createWebPush(d: WebPushDeps): WebPush {
  const keyOf = d.subscriptionKeyOf ?? subscriptionKeyOfEndpoint;
  const url = (path: string) => `${d.origin}${path}`;

  /** 팬 쿠키로 한 번 보내고, 401이면 토큰을 한 번 갱신한 뒤 한 번 더 보낸다 */
  async function send(path: string, init: RequestInit): Promise<Response> {
    const go = () => d.fetch(url(path), { ...init, credentials: 'include', cache: 'no-store', redirect: 'error' });
    const first = await go();
    if (first.status !== 401) return first;
    const refreshed = await refreshOnce(d.fetch, url('/v1/identity/access-tokens'));
    return refreshed === 'ok' ? go() : first;
  }

  async function post(body: PushSubscriptionBody): Promise<Response> {
    return send('/v1/push-subscriptions', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async function currentSubscription(): Promise<PushSubscription | null> {
    if (!d.serviceWorker) return null;
    const reg = await d.serviceWorker.getRegistration(PUSH_WORKER_SCOPE);
    if (!reg || !reg.pushManager) return null;
    return reg.pushManager.getSubscription();
  }

  return {
    async enable() {
      const vapid = vapidKeyBytes(d.vapidKey);
      if (!vapid) return { kind: 'email-only', reason: 'no-vapid' };
      if (!d.serviceWorker || !d.pushSupported || !d.requestPermission || !d.origin) return { kind: 'email-only', reason: 'unsupported' };
      let permission: NotificationPermission;
      try {
        permission = d.permission?.() === 'granted' ? 'granted' : await d.requestPermission();
      } catch {
        return { kind: 'email-only', reason: 'denied' };
      }
      if (permission !== 'granted') return { kind: 'email-only', reason: 'denied' };
      try {
        const reg = await d.serviceWorker.register(PUSH_WORKER_URL, { scope: PUSH_WORKER_SCOPE });
        if (!(await waitActive(reg, d.activateTimeoutMs ?? 10_000))) return { kind: 'email-only', reason: 'failed' };
        const existing = await reg.pushManager.getSubscription();
        const sub = existing ?? (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapid as BufferSource }));
        const body = subscriptionBodyOf(sub);
        if (!body) return { kind: 'email-only', reason: 'failed' };
        const r = await post(body);
        if (r.status === 201 || r.status === 200) return { kind: 'subscribed', status: r.status };
        if (r.status === 422 && (await problemTypeOf(r)) === 'push-service-not-allowed') return { kind: 'email-only', reason: 'push-service-not-allowed' };
        return { kind: 'email-only', reason: 'failed' };
      } catch {
        return { kind: 'email-only', reason: 'failed' };
      }
    },

    async rebind() {
      if (!d.origin || !d.serviceWorker) return { kind: 'skipped', reason: 'unsupported' };
      if (d.permission?.() !== 'granted') return { kind: 'skipped', reason: 'no-permission' };
      try {
        let pendingDone = false;
        const pending = await d.idb?.read();
        if (pending) {
          const body = subscriptionBodyOf(pending);
          const r = body ? await post(body) : undefined;
          if (r && (r.status === 201 || r.status === 200)) {
            await d.idb?.clear();
            pendingDone = true;
          } else if (r && r.status === 422) {
            // 받을 수 없는 구독이면 붙들지 않는다
            await d.idb?.clear();
          } else {
            return { kind: 'failed' };
          }
        }
        const reg = await d.serviceWorker.getRegistration(PUSH_WORKER_SCOPE);
        if (!reg || !reg.pushManager) return pendingDone ? { kind: 'bound', pending: true, current: false } : { kind: 'skipped', reason: 'no-registration' };
        const sub = await reg.pushManager.getSubscription();
        const body = sub ? subscriptionBodyOf(sub) : undefined;
        if (!body) return pendingDone ? { kind: 'bound', pending: true, current: false } : { kind: 'skipped', reason: 'no-subscription' };
        if (pending && pending.endpoint === body.endpoint && pendingDone) return { kind: 'bound', pending: true, current: true };
        const r = await post(body);
        if (r.status === 201 || r.status === 200) return { kind: 'bound', pending: pendingDone, current: true };
        return { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      }
    },

    async unbind() {
      if (!d.origin) return { kind: 'none' };
      try {
        const sub = await currentSubscription();
        if (!sub) return { kind: 'none' };
        const key = await keyOf(sub.endpoint);
        const r = await send(`/v1/push-subscriptions/${encodeURIComponent(key)}`, { method: 'DELETE', headers: { accept: 'application/json' } });
        return r.status >= 200 && r.status < 300 ? { kind: 'deleted', status: r.status } : { kind: 'failed' };
      } catch {
        return { kind: 'failed' };
      }
    },
  };
}
