// SCR-067 상태(디자인 캔버스 보드 state 열거값, 세 배치 같음)
export const STATES = ['검토', '중간 결과', '표본 없음'] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '검토';
