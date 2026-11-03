// 경로(mode)와 ?state= 값을 화면 조각으로 푼다. 보드 SCR-021-d·t의 renderVals()와 휴대폰 보드의 상태를 한 표로 맞췄다.
import type { WizardState } from '@/shared/config/states/scr021';

export type WizardMode = 'new' | 'edit' | 'sale-review';
export type WizardStep = 1 | 2 | 3 | 4 | 5;

/** 판매 승인 쪽 상황(머리 배지·배너·휴대폰 요약 카드) */
export type ReviewSituation = 'draft' | 'approved' | 'wait' | 'rejected' | 'reReq' | 'reRej' | 'suspended';

export interface WizardView {
  /** 머리: 새 공연(빵부스러기·초안) 또는 공연 문맥(EventContextHeader) */
  context: 'new' | 'event';
  /** 단계 입력 화면, 또는 고치는 화면의 두 구역(e4: 판매 정책 잠김, e2: 회차 재입장) */
  body: { kind: 'step'; step: WizardStep } | { kind: 'e4' } | { kind: 'e2' };
  review: ReviewSituation;
  /** '승인 뒤 중요 항목 변경' 대화상자 */
  showChangeDialog: boolean;
  /** 4단계 자동 임시저장 중 */
  saving: boolean;
  imageError: boolean;
  /** 2단계 오류 종류 */
  openError: 'maintenance' | 'gap' | null;
  holderMismatch: boolean;
  wheelchairMissing: boolean;
}

const base: Omit<WizardView, 'context' | 'body' | 'review'> = {
  showChangeDialog: false,
  saving: false,
  imageError: false,
  openError: null,
  holderMismatch: false,
  wheelchairMissing: false,
};

export function resolveView(mode: WizardMode, state: WizardState): WizardView {
  const context = mode === 'new' ? 'new' : 'event';
  const step = (n: WizardStep) => ({ kind: 'step', step: n }) as const;
  const draft = { ...base, context, review: 'draft' } as const;
  switch (state) {
    case '1단계 기본 정보':
      return { ...draft, body: step(1) };
    case '이미지 기준 위반':
      return { ...draft, body: step(1), imageError: true };
    case '2단계 회차·가격·입장 정책 · 오픈 시각 오류':
      return { ...draft, body: step(2), openError: 'maintenance' };
    case '오픈 간격 충돌':
      return { ...draft, body: step(2), openError: 'gap' };
    case '3단계 좌석맵':
      return { ...draft, body: step(3) };
    case '4단계 판매 정책 · 임시저장 중':
      return { ...draft, body: step(4), saving: true };
    case '5단계 판매자 정보·승인 요청':
    case '실무자 보기':
      return { ...draft, body: step(5) };
    case '예금주 불일치':
      return { ...draft, body: step(5), holderMismatch: true };
    case '휠체어석 확인 누락':
      return { ...draft, body: step(5), wheelchairMissing: true };
    case '반려':
      return { ...base, context: 'event', body: step(5), review: 'rejected' };
    case '오픈 뒤 수정 · 회차 재입장':
      return { ...base, context, body: { kind: 'e2' }, review: 'approved' };
    case '재승인 대기':
      return { ...base, context, body: { kind: 'e4' }, review: 'reReq' };
    case '변경 반려':
      return { ...base, context, body: { kind: 'e4' }, review: 'reRej' };
    case '판매 중지':
      return { ...base, context, body: { kind: 'e4' }, review: 'suspended' };
    case '승인 대기':
      return { ...base, context, body: { kind: 'e4' }, review: 'wait' };
    case '승인 뒤 중요 항목 변경':
      return { ...base, context, body: { kind: 'e4' }, review: 'approved', showChangeDialog: true };
    case '오픈 뒤 수정 · 판매 정책':
    case '판매 승인됨':
    default:
      return { ...base, context, body: { kind: 'e4' }, review: 'approved' };
  }
}

/** 새 공연 단계 사이를 오가는 미리보기 상태 이름 */
export const STEP_STATE: Record<WizardStep, WizardState> = {
  1: '1단계 기본 정보',
  2: '2단계 회차·가격·입장 정책 · 오픈 시각 오류',
  3: '3단계 좌석맵',
  4: '4단계 판매 정책 · 임시저장 중',
  5: '5단계 판매자 정보·승인 요청',
};
