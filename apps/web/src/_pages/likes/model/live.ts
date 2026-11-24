// IR-06(구현 리뷰 통과 기준): 실서버 화면의 탭 배지는 실제 목록 수만 쓴다.
// 로딩·빈 목록·오류·로그인 안내에는 숫자를 붙이지 않는다(목업 수 금지, plan §8 #2·§4, d5 §5.28).
// 화면 상태·목록과 분리한 순수 함수라 node 시험이 바로 읽는다(별칭 import 없음).
export type LikesScreen = 'loading' | 'ready' | 'guest' | 'error';

export function liveLikesBadge(screen: LikesScreen, cards: readonly unknown[]): number | undefined {
  return screen === 'ready' && cards.length > 0 ? cards.length : undefined;
}
