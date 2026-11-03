// SCR-066 상태(디자인 캔버스 보드 state 열거값). 휴대폰 보드에는 '찾는 계정 없음'만 있다(가림 해제는 태블릿 이상, d5 §3.9).
export const STATES = ['기본', '열람 사유 대화상자', '열람 뒤', '찾는 계정 없음'] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '기본';
