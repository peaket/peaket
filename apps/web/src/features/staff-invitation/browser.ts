// 초대 수락·거절·내 현장 배정 흐름을 실제 브라우저에 잇는다(flow.ts의 fetch·잠금을 만든다). 규칙은 flow.ts와 docs/features/identity.md §6.1 '휴대폰 화면 실제 연결'.
import { ORIGINS } from '@/shared/config/origins';
import { refreshLock } from '@/shared/lib/refresh-lock';
import { createStaffInvitationApi, type StaffInvitationApi } from './flow';

/** 실제 흐름인가(API 출처가 있으면 실제, 개발 서버에서 출처를 주지 않으면 목업. 본인확인·탈퇴 흐름과 같은 판정) */
export const isLiveStaff = (): boolean => ORIGINS.api !== '';

/** 토큰 갱신은 본인확인·탈퇴·로그인한 기기 흐름과 같은 잠금(Web Locks `peaket.refresh`)으로 창끼리 하나씩 돈다 */
export function browserStaffInvitationApi(): StaffInvitationApi {
  return createStaffInvitationApi({ origin: ORIGINS.api, fetch: (input, init) => fetch(input, init), lock: (fn) => refreshLock(fn) });
}
