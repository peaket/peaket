// SCR-028 상태(디자인 캔버스 보드 state 열거값 23개). 보드 하나에 로그인(셸 없음)과 내 계정(관제 셸)이 함께 있어
// 셸 안 상태 셋('내 계정'·'유휴 만료 2분 전 경고'·'인증 앱 다시 등록')은 /me, 나머지는 /login에 둔다.
// 보드의 '내 계정' 상태는 보안 설정 재인증 대화상자가 열린 그림이라, 대화상자를 닫은 화면을 '기본'으로 더하고 처음 값으로 둔다(추천안).
export const ME_STATES = ['기본', '내 계정', '유휴 만료 2분 전 경고', '인증 앱 다시 등록'] as const;
export type MeState = (typeof ME_STATES)[number];
export const ME_DEFAULT: MeState = '기본';

export const LOGIN_STATES = [
  '로그인',
  'TOTP 단계',
  '허용 IP 대역 밖',
  '반복 실패·시간 잠금',
  '보호 잠금',
  '역할 없음',
  '유휴 만료',
  '초대 수락·인증 앱 등록',
  '초대 수락·패스키 등록',
  '잠금 해제 화면',
  '잠금 해제 · 코드 틀림',
  '잠금 해제 완료',
  '잠금 해제 · 쓸 수 없는 링크',
  '해제 링크 다시 받기 한도',
  '비밀번호를 바꿔 주세요',
  '비밀번호 바꾸기 · 거절',
  '비밀번호 바꾸기 · 확인할 수 없음',
  '세션 종료 · 권한 바뀜',
  '세션 종료 · 비밀번호 바뀜',
  '세션 종료 · 계정 삭제',
] as const;
export type LoginState = (typeof LOGIN_STATES)[number];
export const LOGIN_DEFAULT: LoginState = '로그인';
