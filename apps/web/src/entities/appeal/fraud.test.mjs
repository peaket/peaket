// 부정 예매 소명(SCR-042 fraud·fraud holder, CMP-063)과 다른 팬 화면(SCR-011·014·017·041)의 부정 예매 문구 시험.
// add-fraud-investigation-screens tasks 2.3에서 만들고, apply-legal-review-to-screens tasks 2.1에서 법률 검토(ADR-0173) 문구로 고쳤다.
// 앱에 시험 도구가 아직 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/web test`). 타입 지우기로 .ts를 그대로 읽는다.
// 기준: docs/design/d5 §5.11·§5.14·§5.17·§5.23·§5.24, openapi `FraudReasonCategory`·`FraudAppealView`·탈퇴 409 `fraudHold`,
// docs/security/authz-matrix.md §4.1 마지막 행(팬 화면에는 점수·가중치·근거 신호·다른 계정·조사관이 없다).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as fraud from './fraud.ts';
import { APPEALS } from './model.ts';

const {
  FRAUD_REASON_LABEL,
  fraudReasonLabels,
  lockedTicketsText,
  unlockedTicketsText,
  releasedTicketsText,
  cancelledTicketsText,
  heldTicketsText,
  lockNoticeText,
  FAMILY_NOTICE,
  FRAUD_ACCEPTED_TEXT,
  FRAUD_REJECTED_TEXT,
  FRAUD_SUBMITTED_SCHEDULE,
  LOCK_RELEASED_TEXT,
  LOCK_MAX_DAYS,
  actionResultLines,
  OBJECTION_RESULT_LABEL,
  fraudPartyShows,
  HOLDER_TITLE,
  HOLDER_NOTICE,
  HOLDER_ENTRY_TEXT,
  HOLDER_REFUND_TEXT,
  HOLDER_FIELD_LABEL,
  HOLDER_HINT,
  HOLDER_REVIEW,
  HOLDER_SUBMITTED_SCHEDULE,
  HOLDER_EXCLUDED_TEXT,
  HOLDER_CANCELLED_TEXT,
  HOLDER_INQUIRY_TEXT,
  holderTicketResultLines,
  checkoutLockWarning,
  transferLockedText,
  TRANSFER_OFFER_FRAUD_NOTICE,
  withdrawFraudHoldText,
} = fraud;

/** openapi FraudReasonCategory 열거값(POL-046 ①). 계약 원본 docs/api/openapi.yaml에서 읽는다 */
const OPENAPI = readFileSync(new URL('../../../../../docs/api/openapi.yaml', import.meta.url), 'utf8');
const OPENAPI_REASONS = (() => {
  const m = OPENAPI.match(/\bFraudReasonCategory: \{ type: string, enum: \[([^\]]+)\]/);
  assert.ok(m, 'openapi에 FraudReasonCategory 열거값이 없다');
  return m[1].split(',').map((x) => x.trim());
})();

test('사유 범주 이름표는 openapi 열거값 다섯을 빠짐없이, 그것만 덮는다', () => {
  assert.deepEqual(Object.keys(FRAUD_REASON_LABEL).sort(), [...OPENAPI_REASONS].sort());
});

test('사유 범주 이름표 글은 POL-046 ①의 쉬운 말이다', () => {
  assert.deepEqual(FRAUD_REASON_LABEL, {
    MACRO_BOT: '자동화 프로그램(매크로·봇)',
    QUEUE_BYPASS: '대기열 우회 링크',
    CAPTCHA_BYPASS: '보안문자 우회',
    ACCOUNT_LENDING: '명의 대여·사들인 계정',
    LIMIT_EVASION: '1인 매수 제한 회피',
  });
});

test('알린 사유 범주는 알린 순서대로 모두 이름표로 바뀐다', () => {
  assert.deepEqual(fraudReasonLabels(['LIMIT_EVASION', 'ACCOUNT_LENDING']), ['1인 매수 제한 회피', '명의 대여·사들인 계정']);
});

test('티켓 묶음 머리 글은 장 수를 붙인다(잠김·인정 뒤 풀림·잠금 풀림·취소·받은 표)', () => {
  assert.equal(lockedTicketsText(2), '양도가 잠긴 티켓 2장');
  assert.equal(lockedTicketsText(1), '양도가 잠긴 티켓 1장');
  assert.equal(unlockedTicketsText(2), '양도 잠금을 푼 티켓 2장');
  assert.equal(releasedTicketsText(2), '잠금을 푼 티켓 2장');
  assert.equal(cancelledTicketsText(2), '취소한 티켓 2장');
  assert.equal(heldTicketsText(1), '내가 가진 표 1장');
});

test('FR073_ADR0173결정3_잠금 안내는 최대 기한(lockExpiresAt)을 넣은 d5 §5.24 문장이다', () => {
  assert.equal(LOCK_MAX_DAYS, 14);
  assert.equal(
    lockNoticeText('11/1(일) 16:00'),
    '이 표들의 양도가 잠겼습니다. 늦어도 14일 뒤 11/1(일) 16:00에 풀리고, 그 전에 입장이 시작되면 그때 풀립니다. 입장과 직접 취소(취소 수수료 기준대로)는 그대로 할 수 있습니다',
  );
});

test('가족·지인 대리 예매 안내는 d5 §5.24 글 그대로다', () => {
  assert.equal(FAMILY_NOTICE, '돈이 오가지 않은 가족·지인 대리 예매는 부정 예매가 아닙니다. 그런 경우라면 사정을 적어 주세요');
});

test('FR073_ADR0173결정3_제출 뒤 처리 일정과 결과 문장은 d5 §5.24 글 그대로다', () => {
  assert.equal(FRAUD_SUBMITTED_SCHEDULE, '결과와 사유 범주를 알려 드립니다. 양도 잠금은 늦어도 14일 뒤 풀립니다');
  assert.equal(FRAUD_ACCEPTED_TEXT, '소명이 인정되었습니다. 이 티켓들의 양도 잠금을 풀었습니다');
  assert.equal(FRAUD_REJECTED_TEXT, '소명이 받아들여지지 않았습니다. 조치가 정해지면 결과와 이의 방법을 알려 드립니다');
});

test('FR073_ADR0173결정3_양도 잠금 풀림은 d5 §5.24 글 그대로다', () => {
  assert.equal(LOCK_RELEASED_TEXT, '이 표들의 양도 잠금을 풀었습니다. 조사 결과가 정해지면 따로 알려 드립니다');
});

test('POL046_ADR0173결정6_조치 결과 줄: 취소·전액 환급·이용 제한 끝·이의 기한', () => {
  assert.deepEqual(actionResultLines({ cancelledCount: 2, restrictedUntilText: '2027년 10월 22일(금)', objectionDueText: '11/22(일) 18:00' }), {
    cancelled: '부정 예매로 확인되어 이 표들을 취소했습니다. 결제 금액 전액을 공제 없이 3영업일 안에 결제한 수단으로 돌려드립니다',
    cancelledHeading: '취소한 티켓 2장',
    restriction: '2027년 10월 22일(금)까지 예매가 제한됩니다',
    objection: '11/22(일) 18:00까지 이의를 낼 수 있습니다',
  });
  // 취소한 표가 없거나 이용 제한이 없으면 그 줄을 두지 않는다
  assert.deepEqual(actionResultLines({ cancelledCount: 0, restrictedUntilText: '2027년 10월 22일(금)', objectionDueText: '11/22(일) 18:00' }), {
    restriction: '2027년 10월 22일(금)까지 예매가 제한됩니다',
    objection: '11/22(일) 18:00까지 이의를 낼 수 있습니다',
  });
  assert.deepEqual(actionResultLines({ cancelledCount: 1, objectionDueText: '11/22(일) 18:00' }), {
    cancelled: '부정 예매로 확인되어 이 표들을 취소했습니다. 결제 금액 전액을 공제 없이 3영업일 안에 결제한 수단으로 돌려드립니다',
    cancelledHeading: '취소한 티켓 1장',
    objection: '11/22(일) 18:00까지 이의를 낼 수 있습니다',
  });
});

test('FR073_이의 결과 배지는 openapi objectionStatus ACCEPTED·REJECTED 둘이다', () => {
  assert.deepEqual(OBJECTION_RESULT_LABEL, { ACCEPTED: '이의 인정', REJECTED: '이의 기각' });
});

test('POL046_ADR0173결정4_받은 사람에게는 사유 범주·잠금 줄·이용 제한·이의·우선 구매가 없다', () => {
  assert.deepEqual(fraudPartyShows('HOLDER'), {
    reasonCategories: false,
    lockLine: false,
    restriction: false,
    objection: false,
    priorityPurchase: false,
  });
  assert.deepEqual(fraudPartyShows('PAYER'), {
    reasonCategories: true,
    lockLine: true,
    restriction: true,
    objection: true,
    priorityPurchase: true,
  });
});

// 리뷰 결함 9(FRN-090): 위 시험은 함수 값만 봤다. 화면(SCR-042)이 다섯 칸을 모두 이 함수로 고르는지도 본다
test('POL046_ADR0173결정4_소명 화면은 받은 사람 판정의 다섯 칸을 모두 써서 결제자 칸을 고른다', () => {
  const page = readFileSync(new URL('../../_pages/appeal/ui/AppealPage.tsx', import.meta.url), 'utf8');
  for (const key of ['reasonCategories', 'lockLine', 'restriction', 'objection', 'priorityPurchase']) {
    assert.match(page, new RegExp(String.raw`shows\??\.${key}\b`), `AppealPage가 shows.${key}를 쓰지 않는다`);
  }
});

// 리뷰 결함 8(FRN-090): 409 transfer-locked 글은 §9.2이고 §5.14 상태 글과 다르다('그 전에 입장이 시작되면' 없음)
test('ADR0173결정3_양도 요청 409 transfer-locked 글은 d5 §9.2 그대로다', () => {
  assert.equal(
    fraud.transferLocked409Text('11/1(일) 16:00'),
    '부정 예매 조사가 끝날 때까지 이 티켓은 양도할 수 없습니다. 늦어도 11/1(일) 16:00에 풀립니다. 입장과 직접 취소는 그대로 할 수 있습니다',
  );
  assert.notEqual(fraud.transferLocked409Text('11/1(일) 16:00'), fraud.transferLockedText('11/1(일) 16:00'));
});

test('POL046_ADR0173결정4_받은 사람 변형 문구는 d5 §5.24 글 그대로다', () => {
  assert.equal(HOLDER_TITLE, '받은 표 확인 요청');
  assert.equal(HOLDER_NOTICE, '결제자의 부정 예매 조사에 이 표가 포함되었습니다. 표를 정당하게 받으셨다면 사정을 알려 주세요');
  assert.equal(HOLDER_ENTRY_TEXT, '입장은 그대로 할 수 있습니다');
  assert.equal(HOLDER_REFUND_TEXT, '결제자의 부정 예매로 확인되면 이 표가 취소될 수 있고, 환급은 결제한 분에게 갑니다');
  assert.equal(HOLDER_FIELD_LABEL, '사정 설명');
  assert.equal(HOLDER_HINT, '언제, 누구에게서, 어떻게 받았는지 적어 주세요. 건강 정보 같은 민감한 내용은 적지 않아도 됩니다');
  assert.equal(HOLDER_REVIEW, '기한 안에 알려 주시면 담당자가 검토합니다');
  assert.equal(HOLDER_SUBMITTED_SCHEDULE, '결과를 알려 드립니다');
  assert.equal(HOLDER_EXCLUDED_TEXT, '이 표는 취소하지 않습니다. 그대로 입장할 수 있습니다');
  assert.equal(
    HOLDER_CANCELLED_TEXT,
    '결제자의 부정 예매로 확인되어 이 표가 취소되었습니다. 환급은 결제자에게 갑니다. 티켓값을 주고받았다면 결제한 분과 직접 정산해야 합니다',
  );
  assert.equal(HOLDER_INQUIRY_TEXT, '궁금한 점은 고객 문의로 물어보실 수 있습니다');
  // 받은 사람 문구에는 이의를 내라는 말이 없다(이의는 결제자의 조치에 대한 것)
  for (const t of [HOLDER_TITLE, HOLDER_NOTICE, HOLDER_REVIEW, HOLDER_SUBMITTED_SCHEDULE, HOLDER_EXCLUDED_TEXT, HOLDER_CANCELLED_TEXT, HOLDER_INQUIRY_TEXT]) {
    assert.doesNotMatch(t, /이의/, t);
  }
});

test('POL046_받은 사람의 결과는 표마다 취소됨·취소하지 않음이다', () => {
  assert.deepEqual(holderTicketResultLines(['A구역 3열 16번'], ['A구역 3열 16번']), ['A구역 3열 16번 · 취소됨']);
  assert.deepEqual(holderTicketResultLines(['A구역 3열 16번', 'A구역 3열 17번'], ['A구역 3열 16번']), [
    'A구역 3열 16번 · 취소됨',
    'A구역 3열 17번 · 취소하지 않음',
  ]);
});

test('ADR0173결정3_SCR-011 결제 전 잠금 안내와 SCR-014 양도 잠김 글은 d5 그대로다', () => {
  assert.equal(
    checkoutLockWarning('11/1(일) 16:00'),
    '이 회차 표는 부정 예매 조사가 끝날 때까지(늦어도 11/1(일) 16:00) 양도가 잠깁니다. 입장과 직접 취소(취소 수수료 기준대로)는 그대로 할 수 있습니다',
  );
  assert.equal(
    transferLockedText('11/1(일) 16:00'),
    '부정 예매 조사가 끝날 때까지 이 티켓은 양도할 수 없습니다. 늦어도 11/1(일) 16:00에 풀리고, 그 전에 입장이 시작되면 그때 풀립니다. 입장과 직접 취소는 그대로 할 수 있습니다',
  );
});

test('POL017_ADR0173결정4_SCR-041 양도 받기의 결제자 고지 줄은 d5 그대로다', () => {
  assert.equal(TRANSFER_OFFER_FRAUD_NOTICE, '결제한 분의 부정 예매로 확인되면 이 표가 취소될 수 있고, 환급은 결제한 분에게 갑니다');
});

test('FR017_ADR0173결정7_SCR-017 탈퇴의 대조값 보관 안내는 fraudHold state마다 d5 글이다', () => {
  assert.equal(
    withdrawFraudHoldText({ state: 'RESTRICTED', untilText: '2027년 10월 22일(금)' }),
    '이용 제한이 끝날 때까지 본인확인 대조값을 남깁니다. 다시 가입해도 제한이 끝나는 2027년 10월 22일(금)까지 예매할 수 없습니다.',
  );
  assert.equal(
    withdrawFraudHoldText({ state: 'CASE_OPEN', untilText: '11/24(화)' }),
    '부정 예매 조사가 끝날 때까지(늦어도 11/24(화)) 본인확인 대조값을 남깁니다.',
  );
  // openapi fraudHold.state 열거값 둘
  const m = OPENAPI.match(/fraudHold: \{[^\n]*?state: \{ type: string, enum: \[([^\]]+)\]/);
  assert.ok(m, 'openapi에 fraudHold.state 열거값이 없다');
  assert.deepEqual(m[1].split(',').map((x) => x.trim()).sort(), ['CASE_OPEN', 'RESTRICTED']);
});

/** 팬 화면에 실으면 안 되는 칸 이름(점수·가중치·근거 신호·조사관·사건의 다른 계정) */
const FORBIDDEN_NAME = /score|weight|signal|investigator|account/i;
const FORBIDDEN_WORD = /점수|가중치|근거 신호|조사관/;

test('팬 화면 모듈은 점수·가중치·근거 신호·조사관을 내보내지 않는다(authz-matrix §4.1)', () => {
  const names = Object.keys(fraud);
  assert.ok(names.length > 0);
  for (const name of names) assert.doesNotMatch(name, FORBIDDEN_NAME, name);
  for (const value of Object.values(fraud)) {
    if (typeof value === 'string') assert.doesNotMatch(value, FORBIDDEN_WORD, value);
  }
});

test('FR073_부정 예매 소명 목업 apl-0003(결제자)은 알린 범주·기한·잠긴 티켓·잠금 기한·조치 결과만 가진다', () => {
  const a = APPEALS.find((x) => x.id === 'apl-0003');
  assert.ok(a, 'apl-0003이 있다');
  assert.equal(a.kind, 'fraud');
  assert.equal(a.party, 'PAYER');
  assert.equal(a.caseId, 'CASE-2610-0004');
  assert.deepEqual(a.reasonCategories, ['LIMIT_EVASION', 'ACCOUNT_LENDING']);
  for (const c of a.reasonCategories) assert.ok(OPENAPI_REASONS.includes(c), c);
  assert.equal(a.deadlineText, '10/21(수) 16:00');
  assert.equal(a.remainingHours, 49);
  assert.deepEqual(a.lockedSeatLabels, ['A구역 3열 14번', 'A구역 3열 15번']);
  // d5 그림의 예: 소명 요청 10/18(일) 16:00 + 14일
  assert.equal(a.lockExpiresAtText, '11/1(일) 16:00');
  assert.deepEqual(a.actionResult, {
    cancelledSeatLabels: ['A구역 3열 14번', 'A구역 3열 15번'],
    restrictedUntilText: '2027년 10월 22일(금)',
    objectionDueText: '11/22(일) 18:00',
  });
  assert.ok(a.priorityPurchase, '이의 인정 뒤 우선 구매 권리 목업');
  // 데모 팬의 R구역 12열 7·8번 티켓과 섞이지 않는다
  for (const s of a.lockedSeatLabels) assert.doesNotMatch(s, /R구역 12열/);
  for (const key of Object.keys(a)) assert.doesNotMatch(key, FORBIDDEN_NAME, key);
});

test('POL046_ADR0173결정4_받은 사람 목업 apl-0004는 같은 사건·기한과 가진 표만 가진다', () => {
  const payer = APPEALS.find((x) => x.id === 'apl-0003');
  const h = APPEALS.find((x) => x.id === 'apl-0004');
  assert.ok(h, 'apl-0004가 있다');
  assert.equal(h.kind, 'fraud');
  assert.equal(h.party, 'HOLDER');
  assert.equal(h.caseId, payer.caseId);
  assert.equal(h.deadlineText, payer.deadlineText);
  assert.deepEqual(h.heldSeatLabels, ['A구역 3열 16번']);
  // 결제자의 사유라서 받은 사람에게는 싣지 않는 칸(openapi FraudAppealView party HOLDER)
  for (const key of ['reasonCategories', 'lockedSeatLabels', 'lockExpiresAtText', 'priorityPurchase', 'reasonCategory']) {
    assert.equal(h[key], undefined, key);
  }
  assert.equal(h.actionResult?.restrictedUntilText, undefined);
  assert.equal(h.actionResult?.objectionDueText, undefined);
  for (const key of Object.keys(h)) assert.doesNotMatch(key, FORBIDDEN_NAME, key);
});
