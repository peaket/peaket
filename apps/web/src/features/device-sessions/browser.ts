// 로그인한 기기 흐름을 실제 브라우저에 잇는다(flow.ts의 fetch를 만든다). 규칙은 flow.ts와 docs/features/identity.md §8 '로그인한 기기와 다른 세션 끝내기의 첫 구현'에 있다.
// 탭 저장소·재인증 양식 제출·재인증 결과 받기는 탈퇴 흐름의 것을 그대로 쓴다(같은 출처 POST /reauth/{provider}·/reauth/token, 돌아올 곳 /my/settings).
import { ORIGINS } from '@/shared/config/origins';
import { refreshLock } from '@/shared/lib/refresh-lock';
import { createDevicesApi, type DevicesApi } from './flow';

/** 토큰 갱신은 본인확인·탈퇴 흐름과 같은 잠금(Web Locks `peaket.refresh`)으로 창끼리 하나씩 돈다 */
export function browserDevicesApi(): DevicesApi {
  return createDevicesApi({ origin: ORIGINS.api, fetch: (input, init) => fetch(input, init), lock: (fn) => refreshLock(fn) });
}
