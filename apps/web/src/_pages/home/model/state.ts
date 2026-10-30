// SCR-001 홈 상태별로 무엇을 보일지(캔버스 보드 SCR-001의 renderVals를 옮겼다. '빈 화면(오픈 예정)'은 d5 상태 표에서 더했다).
import type { Scr001State } from '@/shared/config/screens.discovery';

export interface HomeView {
  loading: boolean;
  guest: boolean;
  offline: boolean;
  bannerShown: boolean;
  paused: boolean;
  openList: boolean;
  openEmpty: boolean;
  likeShown: boolean;
  rankingStale: boolean;
  themeList: boolean;
  showSheet: boolean;
}

export function homeView(st: Scr001State): HomeView {
  const loading = st === '로딩';
  const emptySec = st === '섹션 비어 있음';
  const emptyUpcoming = st === '빈 화면(오픈 예정)';
  const guest = st === '비로그인';
  return {
    loading,
    guest,
    offline: st === '오프라인',
    bannerShown: !loading && !emptySec,
    paused: st === '배너 멈춤',
    openList: !loading && !emptySec && !emptyUpcoming,
    openEmpty: emptySec || emptyUpcoming,
    likeShown: !guest && !emptySec,
    rankingStale: st === '랭킹 갱신 실패',
    themeList: !loading && !emptySec,
    showSheet: st === '알림 권한 안내',
  };
}
