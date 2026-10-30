// SCR-049 상태(디자인 캔버스 보드 state 열거값). 휴대폰 보드에는 '승인 전 기록 시도'·'포트원 잔액 입력'·'이미 요청'이 없다(기록·확인 요청은 태블릿 이상, d5 §3.9).
export const STATES = [
  '기본',
  '잔액 부족',
  '지급 실패·지연',
  '승인 전 기록 시도',
  '포트원 잔액 입력',
  '이미 요청',
  '포트원 원장 대조 다름',
  '출금 대사 멈춤',
  '빈 화면',
  'viewer 보기',
  'CS 담당자',
] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '기본';
