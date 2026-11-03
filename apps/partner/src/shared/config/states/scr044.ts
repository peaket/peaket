// SCR-044 회차 취소·연기 요청 상태(보드 SCR-044-d·t: 요청 폼·요청 확인·판정 대기·확정·환불 진행·이미 요청 중, 보드 -m: 반려 더함).
// '반려'는 보드 m의 상태로, d·t에서는 '요청 폼'이 반려 카드를 함께 보이므로 모양이 같다.
// '공연 종료 뒤'·'실무자 보기'는 보드에 없고 d5 §6.12 상태 표에서 더했다.
export const CANCELLATION_STATES = [
  '요청 폼',
  '요청 확인',
  '판정 대기',
  '확정·환불 진행',
  '이미 요청 중',
  '반려',
  '공연 종료 뒤',
  '실무자 보기',
] as const;
export type CancellationState = (typeof CANCELLATION_STATES)[number];
