// 걸린 자동 조치(목업, d5 §7.2 '걸린 자동 조치', ADR-0078 결정 2). 위 상태 바의 '자동 조치 n'이 이 수를 센다.
export type AutoActionBadge = '사람이 풂' | '자동 해제 대기' | '회차 끝까지 유지' | '최근 풀림';

export interface AutoAction {
  id: string;
  group: '이 회차' | '플랫폼';
  badge: AutoActionBadge;
  name: string;
  since: string;
}

export const AUTO_ACTIONS: readonly AutoAction[] = [
  { id: 'aa-pg-stop', group: '이 회차', badge: '자동 해제 대기', name: '결제 신규 진입 정지 · 토스페이먼츠', since: '20:02:51 KST' },
  { id: 'aa-held', group: '플랫폼', badge: '사람이 풂', name: '보류 사건(서비스 DB 보류 표 held_event) · 알림 3건', since: '19:41 KST' },
  { id: 'aa-deploy-lock', group: '플랫폼', badge: '자동 해제 대기', name: '배포 잠금 · 28일 에러 버짓 전량 소진(공연 상세)', since: '10/14(수) 09:40 KST' },
];

/** 위 상태 바 표시: 걸린 수(최근 풀림 제외)와 사람이 풀 것이 있는지 */
export function autoActionSummary(list: readonly AutoAction[]) {
  const active = list.filter((a) => a.badge !== '최근 풀림');
  return { count: active.length, needsHuman: active.some((a) => a.badge === '사람이 풂') };
}
