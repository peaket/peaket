// 부정 예매 소명(SCR-042 fraud, CMP-063 fraud)의 사유 범주 이름표와 고정 문구. 정본: d5 §5.24 '부정 예매 소명', d2 CMP-063 fraud,
// openapi `FraudReasonCategory`·`FraudAppealView`, POL-046 ①③⑦. 팬에게는 알린 사유 범주·기한·잠긴 티켓·소명 상태만 보인다.
// 사건의 다른 계정·점수·가중치·근거 신호·조사관은 이 모듈에 두지 않는다(docs/security/authz-matrix.md §4.1 마지막 행).
// Node 시험 실행기가 타입 지우기로 그대로 읽으므로 런타임 import 없이, 지울 수 있는 TS 문법만 쓴다(enum 금지, fraud.test.mjs).

/** openapi FraudReasonCategory 열거값 다섯(POL-046 ①) */
export type FraudReasonCategory = 'MACRO_BOT' | 'QUEUE_BYPASS' | 'CAPTCHA_BYPASS' | 'ACCOUNT_LENDING' | 'LIMIT_EVASION';

/** 사유 범주 이름표(테두리 배지 글) */
export const FRAUD_REASON_LABEL: Readonly<Record<FraudReasonCategory, string>> = {
  MACRO_BOT: '자동화 프로그램(매크로·봇)',
  QUEUE_BYPASS: '대기열 우회 링크',
  CAPTCHA_BYPASS: '보안문자 우회',
  ACCOUNT_LENDING: '명의 대여·사들인 계정',
  LIMIT_EVASION: '1인 매수 제한 회피',
};

/** 알린 사유 범주를 알린 순서대로 이름표로 바꾼다(d5: 알린 범주 모두 배지로) */
export function fraudReasonLabels(categories: readonly FraudReasonCategory[]): string[] {
  return categories.map((c) => FRAUD_REASON_LABEL[c]);
}

/** 잠긴 티켓 머리 글 '양도가 잠긴 티켓 2장' */
export function lockedTicketsText(count: number): string {
  return `양도가 잠긴 티켓 ${count}장`;
}

/** 소명이 인정된 뒤 같은 티켓 목록의 머리 글 '양도 잠금을 푼 티켓 2장'(결과 문장의 '이 티켓들'이 가리키는 목록) */
export function unlockedTicketsText(count: number): string {
  return `양도 잠금을 푼 티켓 ${count}장`;
}

/** 사안 카드 제목 */
export const FRAUD_APPEAL_TITLE = '부정 예매 소명 요청';
/** 제목 오른쪽 상태 배지(OPEN, 제출 전) */
export const FRAUD_STATUS_LABEL = '답변 기다림';
/** 페이지 머리 설명 */
export const FRAUD_SUBTITLE = '부정 예매 소명 요청에 대해 사정을 설명합니다';

/** 잠긴 티켓 목록 아래 안내 */
export const LOCK_NOTICE = '결정될 때까지 이 표들의 양도가 잠깁니다. 입장은 그대로 할 수 있습니다';
/** 정보 띠(CMP-017 info): 가족·지인 대리 예매 안내 */
export const FAMILY_NOTICE = '돈이 오가지 않은 가족·지인 대리 예매는 부정 예매가 아닙니다. 그런 경우라면 사정을 적어 주세요';

/** 제출됨(SUBMITTED)의 처리 일정 둘째 문장 */
export const FRAUD_SUBMITTED_SCHEDULE = '결과와 사유 범주를 알려 드립니다. 결정될 때까지 양도 잠금은 그대로입니다';
/** 결과 · 인정(ACCEPTED) */
export const FRAUD_ACCEPTED_TEXT = '소명이 인정되었습니다. 이 티켓들의 양도 잠금을 풀었습니다';
/** 결과 · 불인정(REJECTED). 조치는 다른 승인자가 확인한 뒤에만 실행된다(POL-038 ⑪) */
export const FRAUD_REJECTED_TEXT = '소명이 받아들여지지 않았습니다. 조치가 정해지면 결과와 이의 방법을 알려 드립니다';
