// SCR-068 상태(디자인 캔버스 보드 state 열거값, 세 배치 같음). 탭(대기실 공지 템플릿·파트너 긴급 공지·홈 구성)은 그 탭의 상태로 옮긴다.
export const STATES = ['템플릿', '파트너 긴급 공지', '승인된 템플릿 없음', '홈 구성'] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '템플릿';
