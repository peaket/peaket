// SCR-060 환불 계좌 입력(지연 환급) 상태별로 무엇을 보일지(캔버스 보드 SCR-060-m의 renderVals를 옮겼다).
import type { Scr060State } from '@/shared/config/screens.account';

export interface RefundAccountView {
  /** 계좌 폼 모양: input(빈 칸) · submitting(제출 중) · error(계좌 오류). 폼이 없으면 null */
  form: 'input' | 'submitting' | 'error' | null;
  /** 폼 위에 열어 둘 재인증 시트 */
  sheet: 'reauth' | 'expired' | null;
  done: boolean;
}

export function refundAccountView(st: Scr060State): RefundAccountView {
  const reauth = st === '재인증 시트';
  const expired = st === '재인증 만료';
  const form = st === '입력' || reauth || expired ? 'input' : st === '제출 중' ? 'submitting' : st === '계좌 오류' ? 'error' : null;
  return { form, sheet: reauth ? 'reauth' : expired ? 'expired' : null, done: st === '완료' };
}
