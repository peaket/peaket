// 부정 예매 소명(SCR-042 fraud, CMP-063 fraud)의 이름표와 고정 문구 시험(OpenSpec add-fraud-investigation-screens tasks 2.3, design.md 결정 9·12).
// 앱에 시험 도구가 아직 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/web test`). 타입 지우기로 .ts를 그대로 읽는다.
// 기준: docs/design/d5 §5.24 '부정 예매 소명', openapi `FraudReasonCategory`·`FraudAppealView`,
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
  LOCK_NOTICE,
  FAMILY_NOTICE,
  FRAUD_ACCEPTED_TEXT,
  FRAUD_REJECTED_TEXT,
  FRAUD_SUBMITTED_SCHEDULE,
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

test('잠긴 티켓 머리 글은 장 수를 붙인다', () => {
  assert.equal(lockedTicketsText(2), '양도가 잠긴 티켓 2장');
  assert.equal(lockedTicketsText(1), '양도가 잠긴 티켓 1장');
});

test('소명 인정 뒤 머리 글은 잠금을 푼 티켓 장 수다', () => {
  assert.equal(unlockedTicketsText(2), '양도 잠금을 푼 티켓 2장');
});

test('잠김 안내와 가족·지인 대리 예매 안내는 d5 §5.24 글 그대로다', () => {
  assert.equal(LOCK_NOTICE, '결정될 때까지 이 표들의 양도가 잠깁니다. 입장은 그대로 할 수 있습니다');
  assert.equal(FAMILY_NOTICE, '돈이 오가지 않은 가족·지인 대리 예매는 부정 예매가 아닙니다. 그런 경우라면 사정을 적어 주세요');
});

test('제출 뒤 처리 일정과 결과 문장은 d5 §5.24 글 그대로다', () => {
  assert.equal(FRAUD_SUBMITTED_SCHEDULE, '결과와 사유 범주를 알려 드립니다. 결정될 때까지 양도 잠금은 그대로입니다');
  assert.equal(FRAUD_ACCEPTED_TEXT, '소명이 인정되었습니다. 이 티켓들의 양도 잠금을 풀었습니다');
  assert.equal(FRAUD_REJECTED_TEXT, '소명이 받아들여지지 않았습니다. 조치가 정해지면 결과와 이의 방법을 알려 드립니다');
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

test('부정 예매 소명 목업 apl-0003은 알린 범주·기한·잠긴 티켓만 가진다', () => {
  const a = APPEALS.find((x) => x.id === 'apl-0003');
  assert.ok(a, 'apl-0003이 있다');
  assert.equal(a.kind, 'fraud');
  assert.equal(a.caseId, 'CASE-2610-0004');
  assert.deepEqual(a.reasonCategories, ['LIMIT_EVASION', 'ACCOUNT_LENDING']);
  for (const c of a.reasonCategories) assert.ok(OPENAPI_REASONS.includes(c), c);
  assert.equal(a.deadlineText, '10/21(수) 16:00');
  assert.equal(a.remainingHours, 49);
  assert.deepEqual(a.lockedSeatLabels, ['A구역 3열 14번', 'A구역 3열 15번']);
  // 데모 팬의 R구역 12열 7·8번 티켓과 섞이지 않는다
  for (const s of a.lockedSeatLabels) assert.doesNotMatch(s, /R구역 12열/);
  for (const key of Object.keys(a)) assert.doesNotMatch(key, FORBIDDEN_NAME, key);
});
