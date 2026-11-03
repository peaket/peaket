// 대시보드 보드 부품에 페이지가 넘기는 것(보드 vals 밖의 값): 탭 주소, 위젯 자리 상태, 퍼블리싱 덧붙임 상태.
export type TabKey = 't30' | 't0' | 'live' | 'after' | 'entry';

export interface DashCtx {
  /** 탭 링크 주소(그 탭의 대표 상태) */
  tabHref(tab: TabKey): string;
  /** 위젯 자리 상태(d5 §7.2 '위젯 로딩'·'위젯 오류'·'원격 위젯 적재 실패') */
  slot: 'normal' | 'loading' | 'error' | 'remote-fail';
  /** '자동 조치 최근 풀림'(걸린 것은 없고 10분 안에 풀린 것만 있다) */
  recentReleased: boolean;
}
