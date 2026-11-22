// 스캐너 승인 흐름을 실제 브라우저에 잇는다(flow.ts의 fetch·잠금을 만든다). 규칙은 flow.ts와 docs/features/identity.md §6.1 '휴대폰 화면 실제 연결'.
import { ORIGINS } from '@/shared/config/origins';
import { refreshLock } from '@/shared/lib/refresh-lock';
import { createStaffApprovalApi, type StaffApprovalApi } from './flow';

/** 토큰 갱신은 다른 팬 흐름과 같은 잠금(Web Locks `peaket.refresh`)으로 창끼리 하나씩 돈다 */
export function browserStaffApprovalApi(): StaffApprovalApi {
  return createStaffApprovalApi({ origin: ORIGINS.api, fetch: (input, init) => fetch(input, init), lock: (fn) => refreshLock(fn) });
}
