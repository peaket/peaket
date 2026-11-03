// 부정 예매 소명(SCR-042 fraud·fraud holder, CMP-063)의 이름표와 고정 문구, 그리고 다른 팬 화면(SCR-011·014·017·041)의 부정 예매 문구.
// 정본: d5 §5.11·§5.14·§5.17·§5.23·§5.24, d2 CMP-063 fraud·fraud holder, openapi `FraudReasonCategory`·`FraudAppealView`·탈퇴 409 `fraudHold`,
// POL-017·POL-046 ①③⑦, ADR-0173 결정 3·4·6·7(2026-10-31 FRN-080에서 d5에 고친 문장을 FRN-090에서 옮겼다).
// 팬에게는 알린 사유 범주·기한·잠긴 티켓·잠금 기한·소명 상태·조치 결과만 보인다. 받은 사람(party HOLDER)은 기한과 가진 표만 본다.
// 사건의 다른 계정·점수·가중치·근거 신호·조사관은 이 모듈에 두지 않는다(docs/security/authz-matrix.md §4.1 마지막 행).
// 화면 안내용 글이다. 잠금 기한·이의 기한 같은 값은 서버가 정해 사본으로 준다(openapi FraudAppealView). 이 모듈은 계산하지 않고 글에 넣기만 한다.
// Node 시험 실행기가 타입 지우기로 그대로 읽으므로 런타임 import 없이, 지울 수 있는 TS 문법만 쓴다(enum 금지, fraud.test.mjs).

/** openapi FraudReasonCategory 열거값 다섯(POL-046 ①) */
export type FraudReasonCategory = 'MACRO_BOT' | 'QUEUE_BYPASS' | 'CAPTCHA_BYPASS' | 'ACCOUNT_LENDING' | 'LIMIT_EVASION';

/** openapi FraudAppealView.party: PAYER 결제자(사건 계정) · HOLDER 그 계정이 결제한 표를 양도로 받아 가진 사람 */
export type FraudParty = 'PAYER' | 'HOLDER';

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

/**
 * 결제자와 받은 사람에게 보이는 칸(d5 §5.24 '받은 사람의 변형', openapi FraudAppealView party).
 * 받은 사람에게는 결제자의 사유 범주·이용 제한·우선 구매가 없고, 잠금 줄도 없다(원래 다시 양도할 수 없고 돌려주기는 된다).
 * 이의는 결제자의 조치에 대한 것이라 받은 사람에게는 이의 기한과 [이의 내기]가 없고 고객 문의로 묻는다(추천 적용 2026-10-31, ADR-0173).
 */
export function fraudPartyShows(party: FraudParty): {
  reasonCategories: boolean;
  lockLine: boolean;
  restriction: boolean;
  objection: boolean;
  priorityPurchase: boolean;
} {
  const payer = party === 'PAYER';
  return { reasonCategories: payer, lockLine: payer, restriction: payer, objection: payer, priorityPurchase: payer };
}

// ── 티켓 묶음 머리 글(h3) ──

/** '양도가 잠긴 티켓 2장'(소명 요청으로 잠긴 내 표) */
export function lockedTicketsText(count: number): string {
  return `양도가 잠긴 티켓 ${count}장`;
}

/** 소명이 인정된 뒤 같은 티켓 목록의 머리 글 '양도 잠금을 푼 티켓 2장'(결과 문장의 '이 티켓들'이 가리키는 목록) */
export function unlockedTicketsText(count: number): string {
  return `양도 잠금을 푼 티켓 ${count}장`;
}

/** 소명 상태는 그대로이고 잠금만 풀린 뒤(lockActive false) 잠긴 티켓 목록 자리의 글 '잠금을 푼 티켓 2장'(d5 '양도 잠금 풀림') */
export function releasedTicketsText(count: number): string {
  return `잠금을 푼 티켓 ${count}장`;
}

/** 조치 결과의 '취소한 티켓 2장' */
export function cancelledTicketsText(count: number): string {
  return `취소한 티켓 ${count}장`;
}

/** 받은 사람의 '내가 가진 표 1장' */
export function heldTicketsText(count: number): string {
  return `내가 가진 표 ${count}장`;
}

// ── 결제자(party PAYER) ──

/** 사안 카드 제목 */
export const FRAUD_APPEAL_TITLE = '부정 예매 소명 요청';
/** 제목 오른쪽 상태 배지(OPEN, 제출 전) */
export const FRAUD_STATUS_LABEL = '답변 기다림';
/** 페이지 머리 설명 */
export const FRAUD_SUBTITLE = '부정 예매 소명 요청에 대해 사정을 설명합니다';

/** 양도 잠금 최대 기한: 그 계정의 첫 소명 요청 + 14일 [가정], 연장 없음(ADR-0173 결정 3). 화면 글의 '14일'이다 */
export const LOCK_MAX_DAYS = 14;

/** 잠긴 티켓 목록 아래 안내. 날짜는 서버가 준 lockExpiresAt(KST 표기 글)이다(d5 §5.24, ADR-0173 결정 3) */
export function lockNoticeText(lockExpiresAtText: string): string {
  return `이 표들의 양도가 잠겼습니다. 늦어도 ${LOCK_MAX_DAYS}일 뒤 ${lockExpiresAtText}에 풀리고, 그 전에 입장이 시작되면 그때 풀립니다. 입장과 직접 취소(취소 수수료 기준대로)는 그대로 할 수 있습니다`;
}

/** 정보 띠(CMP-017 info): 가족·지인 대리 예매 안내 */
export const FAMILY_NOTICE = '돈이 오가지 않은 가족·지인 대리 예매는 부정 예매가 아닙니다. 그런 경우라면 사정을 적어 주세요';

/** 제출됨(SUBMITTED)의 처리 일정 둘째 문장 */
export const FRAUD_SUBMITTED_SCHEDULE = `결과와 사유 범주를 알려 드립니다. 양도 잠금은 늦어도 ${LOCK_MAX_DAYS}일 뒤 풀립니다`;
/** 결과 · 인정(ACCEPTED) */
export const FRAUD_ACCEPTED_TEXT = '소명이 인정되었습니다. 이 티켓들의 양도 잠금을 풀었습니다';
/** 결과 · 불인정(REJECTED). 조치는 다른 승인자가 확인한 뒤에만 실행된다(POL-038 ⑪) */
export const FRAUD_REJECTED_TEXT = '소명이 받아들여지지 않았습니다. 조치가 정해지면 결과와 이의 방법을 알려 드립니다';
/** 양도 잠금 풀림(lockActive false, 소명 상태는 그대로). 알림 FRAUD_TRANSFER_LOCK_RELEASED */
export const LOCK_RELEASED_TEXT = '이 표들의 양도 잠금을 풀었습니다. 조사 결과가 정해지면 따로 알려 드립니다';

/** 조치 결과 배지 */
export const ACTIONED_LABEL = '조치됨';

/**
 * 조치 결과 줄(d5 §5.24 '조치 결과 · 부정 예매', openapi FraudAppealView.actionResult·objectionDueAt).
 * 취소한 표가 없으면 취소 줄이, 이용 제한이 없으면(restrictedUntil null) 제한 줄이 없다. 환급은 공제 없는 전액, 3영업일(ADR-0173 결정 6).
 */
export function actionResultLines(input: { cancelledCount: number; restrictedUntilText?: string; objectionDueText: string }): {
  cancelled?: string;
  cancelledHeading?: string;
  restriction?: string;
  objection: string;
} {
  // 화면에서 읽는 순서(취소 → 제한 → 이의)대로 둔다
  const out: { cancelled?: string; cancelledHeading?: string; restriction?: string; objection: string } = {} as { objection: string };
  if (input.cancelledCount > 0) {
    out.cancelled = '부정 예매로 확인되어 이 표들을 취소했습니다. 결제 금액 전액을 공제 없이 3영업일 안에 결제한 수단으로 돌려드립니다';
    out.cancelledHeading = cancelledTicketsText(input.cancelledCount);
  }
  if (input.restrictedUntilText) out.restriction = `${input.restrictedUntilText}까지 예매가 제한됩니다`;
  out.objection = `${input.objectionDueText}까지 이의를 낼 수 있습니다`;
  return out;
}

/** 이의 결과 배지(openapi FraudAppealView.objectionStatus ACCEPTED·REJECTED) */
export const OBJECTION_RESULT_LABEL: Readonly<Record<'ACCEPTED' | 'REJECTED', string>> = {
  ACCEPTED: '이의 인정',
  REJECTED: '이의 기각',
};

// ── 받은 사람(party HOLDER, ADR-0173 결정 4) ──

/** 사안 카드 제목 */
export const HOLDER_TITLE = '받은 표 확인 요청';
/** 페이지 머리 설명(추천 적용 2026-10-31: d5에 없어 결제자 머리 설명과 같은 꼴로 정했다) */
export const HOLDER_SUBTITLE = '받은 표에 대해 사정을 알려 주세요';
/** 정보 띠(CMP-017 info) */
export const HOLDER_NOTICE = '결제자의 부정 예매 조사에 이 표가 포함되었습니다. 표를 정당하게 받으셨다면 사정을 알려 주세요';
/** 가진 표 목록 아래 */
export const HOLDER_ENTRY_TEXT = '입장은 그대로 할 수 있습니다';
/** 가진 표 목록 아래 둘째 줄(POL-017, 약관법 제3조 제4항) */
export const HOLDER_REFUND_TEXT = '결제자의 부정 예매로 확인되면 이 표가 취소될 수 있고, 환급은 결제한 분에게 갑니다';
/** 입력 칸 이름 */
export const HOLDER_FIELD_LABEL = '사정 설명';
/** 입력 칸 안내 */
export const HOLDER_HINT = '언제, 누구에게서, 어떻게 받았는지 적어 주세요. 건강 정보 같은 민감한 내용은 적지 않아도 됩니다';
/** 처리 일정 첫 문장(작성 화면 한 줄과 제출됨) */
export const HOLDER_REVIEW = '기한 안에 알려 주시면 담당자가 검토합니다';
/** 제출됨의 처리 일정 둘째 문장 */
export const HOLDER_SUBMITTED_SCHEDULE = '결과를 알려 드립니다';
/** 결과 · 취소 대상에서 빠짐 */
export const HOLDER_EXCLUDED_TEXT = '이 표는 취소하지 않습니다. 그대로 입장할 수 있습니다';
/** 결과 · 취소됨 */
export const HOLDER_CANCELLED_TEXT =
  '결제자의 부정 예매로 확인되어 이 표가 취소되었습니다. 환급은 결제자에게 갑니다. 티켓값을 주고받았다면 결제한 분과 직접 정산해야 합니다';
/** 결과 · 취소됨 아래(이의 대신 고객 문의) */
export const HOLDER_INQUIRY_TEXT = '궁금한 점은 고객 문의로 물어보실 수 있습니다';

/** 받은 사람의 결과: 가진 표마다 '좌석 · 취소됨' 또는 '좌석 · 취소하지 않음'(openapi actionResult.cancelledTicketIds) */
export function holderTicketResultLines(heldSeats: readonly string[], cancelledSeats: readonly string[]): string[] {
  return heldSeats.map((s) => `${s} · ${cancelledSeats.includes(s) ? '취소됨' : '취소하지 않음'}`);
}

// ── 다른 팬 화면의 부정 예매 문구(ADR-0173) ──

/**
 * SCR-011 주문·결제의 '부정 예매 조사로 양도가 잠기는 회차' warning 상자(d5 §5.11, 약관법 제3조 제3항 설명의무, ADR-0173 결정 3).
 * 이 계정에 이 회차의 PAYER 소명 요청이 있고 lockActive가 참일 때만 보인다. 결제 버튼은 그대로다.
 */
export function checkoutLockWarning(lockExpiresAtText: string): string {
  return `이 회차 표는 부정 예매 조사가 끝날 때까지(늦어도 ${lockExpiresAtText}) 양도가 잠깁니다. 입장과 직접 취소(취소 수수료 기준대로)는 그대로 할 수 있습니다`;
}

/** SCR-014 티켓 양도의 '부정 예매 조사로 잠김' 상태 글(d5 §5.14, 티켓의 transferLocked 참). 날짜는 티켓의 transferLockExpiresAt. 409 글은 transferLocked409Text */
export function transferLockedText(transferLockExpiresAtText: string): string {
  return `부정 예매 조사가 끝날 때까지 이 티켓은 양도할 수 없습니다. 늦어도 ${transferLockExpiresAtText}에 풀리고, 그 전에 입장이 시작되면 그때 풀립니다. 입장과 직접 취소는 그대로 할 수 있습니다`;
}

/**
 * SCR-014 양도 요청 409 `transfer-locked` 글(d5 §9.2). 상태 글(§5.14)과 달리 '그 전에 입장이 시작되면' 줄이 없다
 * (정본 그대로 둔다, FRN-090 리뷰 결함 8). 날짜는 응답의 transferLockExpiresAt
 */
export function transferLocked409Text(transferLockExpiresAtText: string): string {
  return `부정 예매 조사가 끝날 때까지 이 티켓은 양도할 수 없습니다. 늦어도 ${transferLockExpiresAtText}에 풀립니다. 입장과 직접 취소는 그대로 할 수 있습니다`;
}

/** SCR-041 양도 받기 결제자 고지 블록의 셋째 줄(d5 §5.23, POL-017, ADR-0173 결정 4) */
export const TRANSFER_OFFER_FRAUD_NOTICE = '결제한 분의 부정 예매로 확인되면 이 표가 취소될 수 있고, 환급은 결제한 분에게 갑니다';

/**
 * SCR-017 탈퇴 단계의 본인확인 대조값 보관 안내(d5 §5.17, ADR-0173 결정 7). 탈퇴 409 `fraudHold`(state·until)로 고른다.
 * RESTRICTED면 이용 제한 끝, CASE_OPEN이면 그 회차 공연일 + 30일 [가정]이 until이다(openapi fraudHold).
 */
export function withdrawFraudHoldText(hold: { state: 'RESTRICTED' | 'CASE_OPEN'; untilText: string }): string {
  return hold.state === 'RESTRICTED'
    ? `이용 제한이 끝날 때까지 본인확인 대조값을 남깁니다. 다시 가입해도 제한이 끝나는 ${hold.untilText}까지 예매할 수 없습니다.`
    : `부정 예매 조사가 끝날 때까지(늦어도 ${hold.untilText}) 본인확인 대조값을 남깁니다.`;
}
