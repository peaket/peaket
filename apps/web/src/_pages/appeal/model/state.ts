// SCR-042 소명 제출 상태별로 무엇을 보일지(캔버스 보드 SCR-042-m의 renderVals를 옮겼다. '제출됨 · 양도 회수'는 d5 §5.24 submitted 줄에서 더했다).
import type { AppealKind } from '@/entities/appeal';
import type { Scr042State } from '@/shared/config/screens.account';

export type AppealResult = 'lift' | 'keep' | 'not-reclaimed' | 'reclaimed';

export interface AppealView {
  /** 이 상태가 보이는 소명 종류(보드는 예매 제한과 양도 회수를 한 화면 상태로 둔다) */
  kind: AppealKind;
  /** form(작성·제출됨·기한 지남, CMP-063) · result(검토 결과) · closed(소명 닫힘) · empty(빈 화면) */
  mode: 'form' | 'result' | 'closed' | 'empty';
  formState: 'default' | 'submitted' | 'overdue';
  /** 작성 칸에 예시 글을 채운다 */
  draft: boolean;
  result: AppealResult | null;
}

export function appealView(st: Scr042State): AppealView {
  const base: AppealView = { kind: 'restriction', mode: 'form', formState: 'default', draft: false, result: null };
  switch (st) {
    case '작성':
      return { ...base, draft: true };
    case '양도 회수 사유':
      return { ...base, kind: 'reclaim' };
    case '제출됨':
      return { ...base, formState: 'submitted' };
    case '제출됨 · 양도 회수':
      return { ...base, kind: 'reclaim', formState: 'submitted' };
    case '기한 지남':
      return { ...base, formState: 'overdue' };
    case '결과 · 제한 해제':
      return { ...base, mode: 'result', result: 'lift' };
    case '결과 · 제한 유지':
      return { ...base, mode: 'result', result: 'keep' };
    case '결과 · 회수하지 않음':
      return { ...base, kind: 'reclaim', mode: 'result', result: 'not-reclaimed' };
    case '결과 · 회수됨':
      return { ...base, kind: 'reclaim', mode: 'result', result: 'reclaimed' };
    case '빈 화면':
      return { ...base, mode: 'empty' };
    case '소명 닫힘(대상 아님·기한 경과)':
      return { ...base, mode: 'closed' };
  }
}
