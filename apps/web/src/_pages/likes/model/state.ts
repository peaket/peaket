// SCR-054 관심 공연·알림 신청 상태별로 무엇을 보일지(캔버스 보드 SCR-054-m의 renderVals를 옮겼다).
// 태블릿·데스크톱 보드의 '알림 신청'은 휴대폰 보드의 '알림 신청 탭'과 같은 상태다.
// 두 빈 화면 상태는 보드에서 두 탭 모두 숫자 배지가 없으므로 관심 공연·알림 신청을 함께 비운다.
import type { Scr054State } from '@/shared/config/screens.account';

export type LikesTab = 'likes' | 'alerts';

export interface LikesView {
  /** 처음 고른 탭 */
  tab: LikesTab;
  /** 오프라인에서 누른 찜이 저장을 기다린다(띠 + 카드의 '저장 대기' 배지) */
  offline: boolean;
  /** 관심 공연·알림 신청이 모두 없다 */
  empty: boolean;
  /** 끝난 까닭 셋을 모두 보이는 알림 목록 */
  endedSample: boolean;
}

export function likesView(st: Scr054State): LikesView {
  return {
    tab: st === '알림 신청 탭' || st === '신청 끝 · 끝난 까닭 셋' || st === '알림 신청 빈 화면' ? 'alerts' : 'likes',
    offline: st === '오프라인 저장 대기',
    empty: st === '빈 화면' || st === '알림 신청 빈 화면',
    endedSample: st === '신청 끝 · 끝난 까닭 셋',
  };
}
