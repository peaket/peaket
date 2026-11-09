'use client';
// 내 예매 제한(ADR-0213 결정 2). 회원 팬의 부품이 처음 쓸 때 GET /v1/booking-restrictions/me를 문서마다 한 번 받는다.
// 401이면 토큰을 한 번 갱신하고 다시 보낸다(withFanRefresh). 그래도 실패면 제한 없음(restriction-store.ts). api-client는 늦게 가져온다(첫 화면 JS 예산).
// 뒤로 가기로 페이지 보관(bfcache)에서 돌아오면 다시 받는다(그 사이 제한이 풀렸을 수 있다).
// 불러오기만 해도 가게를 만들므로 묶음 입구(index.ts)에서 내보내지 않는다. 쓰는 화면이 '@/entities/me/restriction'으로 가져온다(첫 화면 JS 예산).
import { useSyncExternalStore } from 'react';
import type { RestrictionState } from './restriction-model';
import { createRestrictionStore } from './restriction-store';
import type { FanSession } from './session-model';

const store = createRestrictionStore({
  fetchStatus: async () => {
    const [support, api] = await Promise.all([import('@peaket/api-client/endpoints/support'), import('@/shared/api')]);
    api.ensureBrowserApi();
    return (await api.withFanRefresh(() => support.getMyBookingRestriction())).data;
  },
});

if (typeof window !== 'undefined') {
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) void store.refreshIfStarted();
  });
}

const serverSnapshot: RestrictionState = { status: 'idle' };
const NONE: RestrictionState = { status: 'none' };

/** 회원 팬이면 예매 제한을 받아 보인다. 회원이 아니면 받지 않고 제한 없음이다 */
export function useBookingRestriction(session: FanSession): RestrictionState {
  const member = session.status === 'member';
  const state = useSyncExternalStore(member ? store.subscribe : store.listen, store.get, () => serverSnapshot);
  return member ? state : NONE;
}

/** SCR-042 소명 제출. 예매 제한의 소명은 주소 id를 그 제한 ID로 본다(ADR-0213 결정 3) */
export const appealHref = (restrictionId: string): string => `/my/appeals/${encodeURIComponent(restrictionId)}`;
