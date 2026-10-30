// SCR-046 상태(디자인 캔버스 보드 state 열거값). 휴대폰 보드에는 정산서 수기 조정 두 상태가 없다(새 요청은 태블릿 이상, d5 §3.9).
export const STATES = [
  '승인 대기',
  '요청자 본인',
  '실행 직전 재인증',
  '실행 직전 재인증 — commander',
  '재인증 · 패스키 확인',
  '재인증 · 패스키 확인 실패',
  '실행 실패',
  '권한 밖 승인',
  '정산서 수기 조정(이의 없음)',
  '수기 조정 · 지급 요청 뒤(409)',
] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '승인 대기';
