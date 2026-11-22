// 로그아웃 정리 루틴(routine.ts)의 브라우저 조립(ADR-0363 결정 8). 셸·탈퇴 완료·계정 흡수가 이 파일의 함수만 부른다.
// 웹 푸시 해제는 같은 층의 다른 조각(features/web-push)이라 부르는 쪽(위젯·화면)이 pushUnbind로 넘긴다.
import { isLogoutMessage, onSessionLogout, runLogoutCleanup, type CleanupDeps, type CleanupOptions, type CleanupResult, type EnumerableStorage } from './routine.ts';
import { SESSION_CHANNEL } from './keys.ts';

function storage(name: 'localStorage' | 'sessionStorage'): EnumerableStorage | null {
  try {
    return window[name];
  } catch {
    return null;
  }
}

/** 이 탭의 정리 의존. broadcast는 이 탭이 시작한 정리일 때만 넣는다 */
export function browserCleanupDeps(o: { broadcast: boolean; pushUnbind?: () => Promise<unknown> }): CleanupDeps {
  return {
    local: storage('localStorage'),
    session: storage('sessionStorage'),
    idb: typeof indexedDB === 'undefined' ? null : indexedDB,
    caches: typeof caches === 'undefined' ? null : caches,
    serviceWorker: typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null,
    ...(o.broadcast
      ? {
          broadcast: (channel: string, message: string) => {
            if (typeof BroadcastChannel === 'undefined') return;
            const ch = new BroadcastChannel(channel);
            ch.postMessage(message);
            ch.close();
          },
        }
      : {}),
    ...(o.pushUnbind ? { pushUnbind: o.pushUnbind } : {}),
    fetch: (url, init) => fetch(url, init),
  };
}

/** 이 탭이 정리를 시작했다(같은 탭의 다른 채널 객체가 자기 logout을 받아 로그인 화면으로 가지 않게 한다) */
let startedHere = false;

/** 셸 대화상자·탈퇴 완료·계정 흡수가 부른다. pushUnbind는 features/web-push browserWebPush().unbind다 */
export function logoutCleanup(o: CleanupOptions & { pushUnbind?: () => Promise<unknown> }): Promise<CleanupResult> {
  startedHere = true;
  return runLogoutCleanup(browserCleanupDeps({ broadcast: true, ...(o.pushUnbind ? { pushUnbind: o.pushUnbind } : {}) }), { wallet: o.wallet, server: o.server });
}

/** 다른 탭의 logout을 들어 이 탭의 저장물을 지우고 then(로그인 화면으로)을 부른다. 돌려준 함수로 듣기를 멈춘다 */
export function listenSessionLogout(then: () => void): () => void {
  if (typeof BroadcastChannel === 'undefined') return () => {};
  const ch = new BroadcastChannel(SESSION_CHANNEL);
  ch.addEventListener('message', (e: MessageEvent<unknown>) => {
    if (!isLogoutMessage(e.data) || startedHere) return;
    void onSessionLogout(browserCleanupDeps({ broadcast: false }), then);
  });
  return () => ch.close();
}
