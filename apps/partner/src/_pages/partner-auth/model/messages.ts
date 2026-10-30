// 로그인 쪽 화면 문구 목업(d5 §6.1 상태 표 원문, 보드 SCR-020 renderVals와 같다).

/** 세션 종료 사유 배너(d5 §3.5 사유 문구) */
export const SESSION_END_MESSAGES: Record<string, string> = {
  '세션 종료 · 권한 바뀜': '계정 권한이 바뀌어 로그아웃되었습니다. 다시 로그인해 주세요',
  '세션 종료 · 비밀번호 바뀜': '비밀번호가 바뀌어 이 기기에서 로그아웃되었습니다. 다시 로그인해 주세요',
  '세션 종료 · 계정 삭제': '계정이 삭제되어 로그아웃되었습니다',
};

/** 비밀번호 거절 이유 넷(auth-controls §4.3). 유출 횟수는 보이지 않는다 */
export const PASSWORD_REJECT_MESSAGES: Record<string, string> = {
  '비밀번호 거절 · 유출': '유출된 적이 있는 비밀번호입니다',
  '비밀번호 거절 · 금칙어': '서비스·회사·계정 이름에 숫자나 기호만 붙인 비밀번호는 쓸 수 없습니다',
  '비밀번호 거절 · 흔한 비밀번호': '너무 흔한 비밀번호입니다',
  '비밀번호 거절 · 길이': '15자 이상이어야 합니다',
};

export const PASSWORD_HINT = '15자 이상 · 문자 조합 규칙 없음 · 유출된 적 있는 비밀번호는 쓸 수 없습니다';
export const PASSWORD_REJECT_HINT = '서로 관계없는 낱말 여러 개를 이은 문장이나 비밀번호 관리자가 만든 값을 쓰세요';

/** 잠금 해제 링크로 남은 시도(그림 예 2번)·로그인 남은 시도·다음 가능 시각(보드의 지금 시각에 맞춘 값) */
export const UNLOCK_ATTEMPTS_LEFT = 2;
export const RESEND_NEXT_AT = '20:41 KST';
