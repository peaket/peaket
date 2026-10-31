// CMP-081 CaseStatusBadge 이름표 시험(OpenSpec add-fraud-investigation-screens tasks 3.3). `pnpm --filter @peaket/ds test`.
// openapi 열거값(FraudCaseStatus 일곱, FraudClusterMember.appealResult 여섯, FraudCluster.scoreBand 셋)을 모두 덮고,
// d5 §7.18·§7.19의 한국어 글을 쓰는지 본다. 색만으로 뜻을 말하지 않도록 글이 비어 있으면 안 된다(d2 CMP-081).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { APPEAL_RESULT, CASE_STATUS, SCORE_BAND } from './labels.ts';

const OPENAPI = readFileSync(new URL('../../../../../docs/api/openapi.yaml', import.meta.url), 'utf8');

/** openapi.yaml에서 `이름: { type: string, enum: [..] }`의 열거값을 읽는다(계약과 이름표가 어긋나면 실패) */
function openapiEnum(name) {
  const m = OPENAPI.match(new RegExp(String.raw`\b${name}: \{ type: string, enum: \[([^\]]+)\]`));
  assert.ok(m, `openapi에 ${name} 열거값이 없다`);
  return m[1].split(',').map((x) => x.trim()).sort();
}

test('이름표의 키가 openapi.yaml의 열거값과 같다', () => {
  assert.deepEqual(Object.keys(CASE_STATUS).sort(), openapiEnum('FraudCaseStatus'));
  assert.deepEqual(Object.keys(APPEAL_RESULT).sort(), openapiEnum('appealResult'));
  assert.deepEqual(Object.keys(SCORE_BAND).sort(), openapiEnum('scoreBand'));
});

test('사건 상태 일곱을 d5 글로 옮긴다', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(CASE_STATUS).map(([k, v]) => [k, v.label])),
    {
      INVESTIGATING: '조사 중',
      APPEAL_PENDING: '소명 대기',
      DECISION_PENDING: '결정 대기',
      ACTIONED: '조치됨',
      OBJECTED: '이의 접수',
      CLEARED: '정상 종료',
      REVERSED: '이의 인정',
    },
  );
});

test('계정 소명 결과 여섯을 d5 글로 옮긴다', () => {
  assert.deepEqual(
    Object.fromEntries(Object.entries(APPEAL_RESULT).map(([k, v]) => [k, v.label])),
    {
      NOT_REQUESTED: '요청 전',
      PENDING: '기다림',
      SUBMITTED: '냄·판단 전',
      ACCEPTED: '인정',
      REJECTED: '불인정',
      EXPIRED: '기한까지 안 냄',
    },
  );
});

test('점수 범주는 셋이고 점수 원값을 갖지 않는다', () => {
  assert.deepEqual(Object.keys(SCORE_BAND).sort(), ['HIGH', 'LOW', 'MEDIUM']);
  assert.equal(SCORE_BAND.HIGH.label, '높음');
  for (const v of Object.values(SCORE_BAND)) assert.deepEqual(Object.keys(v).sort(), ['label', 'tone']);
});

test('모든 값에 글과 색 단계가 있다', () => {
  for (const map of [CASE_STATUS, APPEAL_RESULT, SCORE_BAND]) {
    for (const [k, v] of Object.entries(map)) {
      assert.ok(v.label.length > 0, k);
      assert.ok(['neutral', 'primary', 'success', 'warning', 'danger', 'outline'].includes(v.tone), k);
    }
  }
});
