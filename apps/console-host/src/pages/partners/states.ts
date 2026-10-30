// SCR-065 상태(디자인 캔버스 보드 state 열거값, 세 배치 같음)
export const STATES = ['계약(기본)', '결제사 등록 탭', '변경 승인 대기'] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '계약(기본)';
