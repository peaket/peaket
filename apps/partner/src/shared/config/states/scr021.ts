// SCR-021 공연 등록 위저드 상태(보드 SCR-021-m·t·d·xl). 경로마다 기본 상태가 다르다(첫 값이 기본).
// 보드에 없고 d5 §6.4 상태 표에만 있는 것은 뒤에 더했다: '3단계 좌석맵', '이미지 기준 위반', '오픈 간격 충돌', '예금주 불일치', '휠체어석 확인 누락', '실무자 보기'.

/** /events/new — 데스크톱·태블릿 단계 화면(d·t·xl 보드) */
export const NEW_WIZARD_STATES = [
  '1단계 기본 정보',
  '2단계 회차·가격·입장 정책 · 오픈 시각 오류',
  '3단계 좌석맵',
  '4단계 판매 정책 · 임시저장 중',
  '5단계 판매자 정보·승인 요청',
  '이미지 기준 위반',
  '오픈 간격 충돌',
  '예금주 불일치',
  '휠체어석 확인 누락',
  '실무자 보기',
] as const;

/** /events/[id]/edit — 등록 정보 고치기(d·t 보드의 수정 상태 + 휴대폰 보드의 판매 승인 상태) */
export const EDIT_WIZARD_STATES = [
  '오픈 뒤 수정 · 판매 정책',
  '오픈 뒤 수정 · 회차 재입장',
  '재승인 대기',
  '변경 반려',
  '판매 중지',
  '승인 뒤 중요 항목 변경',
  '판매 승인됨',
  '승인 대기',
  '반려',
] as const;

/** /events/[id]/sale-review — 5단계 판매자 정보·승인 요청 */
export const SALE_REVIEW_STATES = ['5단계 판매자 정보·승인 요청', '예금주 불일치', '휠체어석 확인 누락', '반려', '실무자 보기'] as const;

/** 세 경로의 합집합(화면 목록 등록용) */
export const WIZARD_STATES = [
  ...NEW_WIZARD_STATES,
  ...EDIT_WIZARD_STATES.filter((s) => !(NEW_WIZARD_STATES as readonly string[]).includes(s)),
] as const;

export type NewWizardState = (typeof NEW_WIZARD_STATES)[number];
export type EditWizardState = (typeof EDIT_WIZARD_STATES)[number];
export type SaleReviewState = (typeof SALE_REVIEW_STATES)[number];
export type WizardState = NewWizardState | EditWizardState | SaleReviewState;
