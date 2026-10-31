// SCR-042 소명 제출 상태별로 무엇을 보일지(캔버스 보드 SCR-042-m의 renderVals를 옮겼다. '제출됨 · 양도 회수'는 d5 §5.24 submitted 줄에서 더했다).
// 부정 예매 소명('부정 예매 소명' ~ '이의 결과 · 부정 예매 · 기각')은 보드가 없어 d5 §5.24 '부정 예매 소명' 상태 표에서 옮겼다.
// 받은 사람 넷('받은 표 확인 요청' ~ '결과 · 취소됨')은 d5 §5.24 '받은 사람의 변형' 상태 표다(party HOLDER, ADR-0173 결정 4).
// 이 파일은 state.test.mjs가 Node 타입 지우기로 그대로 읽는다(타입 import만 쓴다).
import type { AppealKind, FraudParty } from '@/entities/appeal';
import type { Scr042State } from '@/shared/config/screens.account';

/**
 * lift·keep(예매 제한) · not-reclaimed·reclaimed(양도 회수) · accepted·rejected(부정 예매 소명 인정·불인정)
 * · released(양도 잠금 풀림) · actioned(조치 결과) · objection-accepted·objection-rejected(이의 결과)
 * · holder-excluded·holder-cancelled(받은 사람: 취소 대상에서 빠짐·취소됨)
 */
export type AppealResult =
  | 'lift'
  | 'keep'
  | 'not-reclaimed'
  | 'reclaimed'
  | 'accepted'
  | 'rejected'
  | 'released'
  | 'actioned'
  | 'objection-accepted'
  | 'objection-rejected'
  | 'holder-excluded'
  | 'holder-cancelled';

export interface AppealView {
  /** 이 상태가 보이는 소명 종류(보드는 예매 제한과 양도 회수를 한 화면 상태로 둔다. 부정 예매 소명도 같은 목록에 붙였다) */
  kind: AppealKind;
  /** 부정 예매 소명의 결제자·받은 사람(그 밖의 종류는 없음) */
  party?: FraudParty;
  /** form(작성·제출됨·기한 지남, CMP-063) · result(검토 결과) · closed(소명 닫힘) · empty(빈 화면) */
  mode: 'form' | 'result' | 'closed' | 'empty';
  formState: 'default' | 'submitted' | 'overdue';
  /** 작성 칸에 예시 글을 채운다 */
  draft: boolean;
  result: AppealResult | null;
}

export function appealView(st: Scr042State): AppealView {
  const base: AppealView = { kind: 'restriction', mode: 'form', formState: 'default', draft: false, result: null };
  const payer: AppealView = { ...base, kind: 'fraud', party: 'PAYER' };
  const holder: AppealView = { ...base, kind: 'fraud', party: 'HOLDER' };
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
    case '부정 예매 소명':
      return payer;
    case '제출됨 · 부정 예매':
      return { ...payer, formState: 'submitted' };
    case '결과 · 부정 예매 소명 인정':
      return { ...payer, mode: 'result', result: 'accepted' };
    case '결과 · 부정 예매 소명 불인정':
      return { ...payer, mode: 'result', result: 'rejected' };
    case '양도 잠금 풀림 · 부정 예매':
      return { ...payer, mode: 'result', result: 'released' };
    case '조치 결과 · 부정 예매':
      return { ...payer, mode: 'result', result: 'actioned' };
    case '이의 결과 · 부정 예매 · 인정':
      return { ...payer, mode: 'result', result: 'objection-accepted' };
    case '이의 결과 · 부정 예매 · 기각':
      return { ...payer, mode: 'result', result: 'objection-rejected' };
    case '받은 표 확인 요청':
      return holder;
    case '제출됨 · 받은 표':
      return { ...holder, formState: 'submitted' };
    case '결과 · 취소 대상에서 빠짐':
      return { ...holder, mode: 'result', result: 'holder-excluded' };
    case '결과 · 취소됨':
      return { ...holder, mode: 'result', result: 'holder-cancelled' };
  }
}
