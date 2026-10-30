// SCR-045 상태(디자인 캔버스 보드 state 열거값). 'viewer 주소로 열기'는 보드에 없고 d5 §7.6 상태 표에 있어 더했다. 휴대폰 보드에는 '열람 사유 입력'·'정산 이의 · 이의 인정'이 없다(가림 해제·이의 처리는 태블릿 이상, d5 §3.9).
export const STATES = [
  '기본',
  '열람 사유 입력',
  '기한 초과',
  '문의 답변',
  '게시물 신고',
  '빈 화면',
  '정산 이의',
  '정산 이의 · 이의 인정',
  '소명',
  'operator 보기',
  '없는 건(404)',
  'viewer 주소로 열기',
] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '기본';
