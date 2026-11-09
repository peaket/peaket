'use client';
// 팬 세션(로그인·본인확인 상태)을 문서마다 한 번 받아 나눠 쓴다(ADR-0202 결정 2, docs/frontend.md §2.5 '알림·외부 링크 착지 규칙').
// - 캐시 화면과 다른 사이트에서 온 첫 이동은 서버가 쿠키로 로그인 여부를 정하지 않는다. 화면 스크립트가 같은 사이트 요청으로 확인한다.
// - GET /v1/identity/me. 401이면 토큰을 한 번 갱신하고 다시 보낸다(withFanRefresh). 그래도 401이면 비로그인, 5xx·연결 실패는 모름(session-store.ts).
// - 팬 API 출처가 없는 실행(퍼블리싱 미리보기 빌드)은 비로그인이다. api-client는 늦게 가져온다(첫 화면 JS 예산, §5.8).
// - 본인확인을 마치면 refreshFanSession()으로, 뒤로 가기로 페이지 보관(bfcache)에서 돌아오면 저절로 다시 받는다(그 사이 로그아웃했을 수 있다).
import { useSyncExternalStore } from 'react';
import { isUnauthorizedError } from '@/shared/api/refresh';
import { ORIGINS } from '@/shared/config/origins';
import type { FanSession } from './session-model';
import { createFanSessionStore } from './session-store';

const store = createFanSessionStore({
  apiAvailable: () => ORIGINS.api !== '',
  fetchMe: async () => {
    const [identity, api] = await Promise.all([import('@peaket/api-client/endpoints/identity'), import('@/shared/api')]);
    api.ensureBrowserApi();
    return (await api.withFanRefresh(() => identity.getIdentityMe())).data;
  },
  isUnauthorized: isUnauthorizedError,
});

if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) void store.refreshIfStarted();
  });
}

const serverSnapshot: FanSession = { status: 'loading' };

/** 지금 팬 세션. 처음 쓰는 부품이 받기를 시작한다. enabled가 false면 받지 않고 지금 값만 본다(로그인 화면처럼 늘 로그인 전 모양인 셸) */
export function useFanSession({ enabled = true }: { enabled?: boolean } = {}): FanSession {
  return useSyncExternalStore(enabled ? store.subscribe : store.listen, store.get, () => serverSnapshot);
}

/** 다시 받는다(본인확인을 마친 뒤 등). 받는 동안은 지금 값을 그대로 보인다 */
export function refreshFanSession(): Promise<void> {
  return store.refresh();
}
