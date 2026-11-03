// SCR-020 설정 쪽(파트너 셸 안 화면) 상태(캔버스 보드 SCR-020-m·t·d의 state 열거값). 첫 값이 기본 상태다.
// '유휴 만료 2분 전 경고'·'유휴 만료'는 셸(ShellFrame)이 대화상자를 연다.
// '실무자 보기'(정산 계좌·팀 계정)는 보드에 없고 d5 §6.1 상태 표의 '실무자 보기'와 '(파트너 관리자만)' 규칙에서 더했다. ?role=member와 같다.

/** /settings/account */
export const ACCOUNT_STATES = ['내 계정', '보안 설정 재인증', '유휴 만료 2분 전 경고', '유휴 만료'] as const;

/** /settings/seller */
export const SELLER_STATES = ['판매자 정보', '판매자 정보 변경 요청', '판매자 정보 검토 중', '실무자 권한 없음'] as const;

/** /settings/payout */
export const PAYOUT_STATES = [
  '정산 계좌',
  '정산 계좌 변경 · 패스키 확인',
  '패스키 확인 실패',
  '정산 계좌 변경',
  '예금주 불일치',
  '정산 계좌 변경 완료',
  '포트원 계좌 불일치',
  '실무자 보기',
] as const;

/** /settings/team */
export const TEAM_STATES = ['팀 계정', '실무자 보기'] as const;
