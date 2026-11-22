// 웹 푸시 흐름(flow.ts)의 브라우저 조립(ADR-0363 결정 7). 화면은 이 함수만 부른다.
// VAPID 공개키는 공개 빌드 값 NEXT_PUBLIC_PEAKET_VAPID_PUBLIC_KEY(core-svc PEAKET_VAPID_PUBLIC_KEY와 같은 값, local·ci는 core-svc 고정 시험 키)다.
// 값이 없거나 틀린 꼴이면 웹 푸시를 켜지 않고 '이메일로 알려 드립니다'(flow.ts enable의 no-vapid).
import { ORIGINS } from '../../shared/config/origins.ts';
import { createWebPush, type WebPush } from './flow.ts';
import { indexedDbPendingStore } from './pending-store.ts';

/** 빌드 때 글자로 바뀐다(공개 값, docs/frontend.md §5.14.6) */
export const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_PEAKET_VAPID_PUBLIC_KEY ?? '';

export function browserWebPush(): WebPush {
  const hasWindow = typeof window !== 'undefined';
  const sw = hasWindow && 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
  const notification = hasWindow && 'Notification' in window ? window.Notification : undefined;
  return createWebPush({
    origin: ORIGINS.api,
    fetch: (input, init) => fetch(input, init),
    ...(sw ? { serviceWorker: sw } : {}),
    idb: indexedDbPendingStore(),
    vapidKey: VAPID_PUBLIC_KEY,
    ...(notification ? { permission: () => notification.permission, requestPermission: () => notification.requestPermission() } : {}),
    pushSupported: hasWindow && 'PushManager' in window,
  });
}
