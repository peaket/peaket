// 대시보드 보드 부품에 페이지가 넘기는 것(보드 vals 밖의 값): 탭 주소, 위젯 자리 상태, 퍼블리싱 덧붙임 상태, 실제 값 화면인가.
export type TabKey = 't30' | 't0' | 'live' | 'after' | 'entry';

export interface DashCtx {
  /** 탭 링크 주소(그 탭의 대표 상태) */
  tabHref(tab: TabKey): string;
  /** 위젯 자리 상태(d5 §7.2 '위젯 로딩'·'위젯 오류'·'원격 위젯 적재 실패') */
  slot: 'normal' | 'loading' | 'error' | 'remote-fail';
  /** '자동 조치 최근 풀림'(걸린 것은 없고 10분 안에 풀린 것만 있다) */
  recentReleased: boolean;
  /** 실제 값 화면(?state= 없음, 관제 API 주소 있음): 원천이 있는 위젯 둘(입장 비율·결제사)을 원격으로 싣는다(ADR-0360) */
  live: boolean;
  /** 실제 값 화면의 고른 회차(?event=, UUID일 때만). 자세히 보기 주소 틀에 넣는다(F-03-3) */
  eventId?: string | null;
  /** 실제 값 화면에서 판정 버튼을 보일 역할(F-03-3) */
  role?: string | null;
}
