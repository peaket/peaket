// SCR-053 상태(디자인 캔버스 보드 state 열거값). 휴대폰 보드에는 '등록 코드'·'코드 만료'가 없다(기기 등록은 태블릿 이상, d5 §3.9).
export const STATES = ['기본', '폐기 확인 대화상자', '등록 코드', '코드 만료', '폐기됨', '빈 화면'] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '기본';
