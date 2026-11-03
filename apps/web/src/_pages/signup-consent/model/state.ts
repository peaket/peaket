// SCR-005 가입 완료·동의 상태별로 무엇을 보일지(캔버스 보드 SCR-005-m의 renderVals를 옮겼다).
import type { Scr005State } from '@/shared/config/screens.account';

export type NickStatus = 'ok' | 'checking' | 'taken';

export interface SignupView {
  /** 폼(만 14세 미만이 아니면) */
  form: boolean;
  under14: boolean;
  /** 입력 오류: 위쪽 오류 요약 + 첫 오류 칸(만 14세 확인)으로 초점 */
  error: boolean;
  /** 만 14세 이상 체크가 켜져 있다 */
  ageChecked: boolean;
  nick: NickStatus;
}

export function signupView(st: Scr005State): SignupView {
  const error = st === '입력 오류';
  return {
    form: st !== '만 14세 미만',
    under14: st === '만 14세 미만',
    error,
    ageChecked: st === '기본' || st === '닉네임 확인 중',
    nick: error ? 'taken' : st === '닉네임 확인 중' ? 'checking' : 'ok',
  };
}
