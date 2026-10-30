// SCR-064 상태(디자인 캔버스 보드 state 열거값). 휴대폰 보드는 10개 상태만 있다(초대·역할 변경·삭제는 태블릿 이상, d5 §3.9).
export const STATES = [
  '기본',
  '자기 계정',
  '역할 변경 재인증',
  '역할 변경 · 패스키 확인',
  '역할 변경 · 패스키 확인 실패',
  '파트너 계정 탭',
  '파트너 계정 탭 · 시간 잠금',
  '초대 보내기',
  '마지막 관리자',
  '초대됨',
  '초대 만료',
  '파트너 계정 탭 · 재초대(분실)',
  '파트너 계정 탭 · 보호 잠금(비밀번호 누계)',
  'commander 역할 승인 대기',
  'commander 계정 삭제',
  '삭제한 계정',
] as const;
export type State = (typeof STATES)[number];
export const DEFAULT: State = '기본';
