// SCR-043 배상금 계좌 입력 상태별로 무엇을 보일지(캔버스 보드 SCR-043-m의 renderVals를 옮겼다).
import type { Scr043State } from '@/shared/config/screens.account';

export interface CompensationView {
  /** 계좌 폼 모양: input(빈 칸) · submitting(요청 중) · error(계좌 오류). 폼이 없으면 null */
  form: 'input' | 'submitting' | 'error' | null;
  /** 폼 위에 열어 둘 재인증 시트 */
  sheet: 'reauth' | 'expired' | null;
  locked: boolean;
  paid: boolean;
  done: boolean;
}

export function compensationView(st: Scr043State): CompensationView {
  const reauth = st === '재인증 시트';
  const expired = st === '재인증 만료';
  const form =
    st === '입력' || reauth || expired ? 'input' : st === '송금 요청 중' ? 'submitting' : st === '계좌 오류' ? 'error' : null;
  return {
    form,
    sheet: reauth ? 'reauth' : expired ? 'expired' : null,
    locked: st === '3회 실패',
    paid: st === '이미 지급',
    done: st === '완료',
  };
}
