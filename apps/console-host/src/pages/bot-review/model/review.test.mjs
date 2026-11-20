// SCR-067 봇 판정 표본 검토 화면의 순수 함수 시험(BAT-197 BOT-080, FR-049, d5 §7.15).
// 앱에 시험 도구가 없어 Node 내장 시험 실행기로 돌린다(`pnpm --filter @peaket/console-host test`). 타입 지우기로 .ts를 그대로 읽는다.
// 진행률·남은 수·기한 문구·BOT 근거 필수·가림을 값까지 본다. 받은 순서를 다시 정렬하지 않는지도 본다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  canSubmit,
  DEFAULT_REVIEW_KIND,
  EVIDENCE_KINDS,
  formatKst,
  formatPercent,
  formatRate,
  formatRateRange,
  mapReview,
  mapSamples,
  needsEvidence,
  parseReviewKind,
  reviewKindHint,
  reviewKindIntro,
  reviewKindLabel,
  stepLabel,
  submitBlockReason,
  verdictLabel,
} from './review.ts';

const ROOT = fileURLToPath(new URL('../../../../../../', import.meta.url));
const OPENAPI = readFileSync(join(ROOT, 'docs/api/openapi.yaml'), 'utf8');

test('FR-049 진행률·남은 수·기한 문구·BOT 근거 필수·가림을 순수 함수로 계산한다', () => {
  // 진행률·남은 수·기한은 서버가 준 수를 그대로 쓴다
  const progress = mapReview(
    {
      eventId: 'ev-1',
      reviewKind: 'PASSED_SAMPLE',
      reviewedCount: 51,
      targetCount: 200,
      deadlineAt: '2026-12-21T05:00:00.000Z',
      r2DueAt: '2026-11-28T05:00:00.000Z',
      interim: { missedBotRate: 0.4, ci95Low: 0.168, ci95High: 0.687 },
    },
    'PASSED_SAMPLE',
  );
  assert.deepEqual(progress, {
    eventId: 'ev-1',
    reviewKind: 'PASSED_SAMPLE',
    reviewedCount: 51,
    targetCount: 200,
    remaining: 149,
    percent: 25.5,
    deadlineAt: '2026-12-21T05:00:00.000Z',
    r2DueAt: '2026-11-28T05:00:00.000Z',
    interim: { missedBotRate: 0.4, ci95Low: 0.168, ci95High: 0.687 },
  });
  // 목표를 넘겨도 남은 수는 0이고 퍼센트는 100에서 자른다
  assert.equal(mapReview({ reviewedCount: 210, targetCount: 200 }, 'PASSED_SAMPLE').remaining, 0);
  assert.equal(mapReview({ reviewedCount: 210, targetCount: 200 }, 'PASSED_SAMPLE').percent, 100);
  assert.equal(mapReview({ targetCount: 0 }, 'PASSED_SAMPLE').percent, 0);
  // HUMAN_BASELINE은 interim을 null로 두고 묶음별 수를 만들지 않는다
  const human = mapReview({ reviewKind: 'HUMAN_BASELINE', reviewedCount: 12, targetCount: 400 }, 'PASSED_SAMPLE');
  assert.equal(human.reviewKind, 'HUMAN_BASELINE');
  assert.equal(human.interim, null);
  assert.equal(Object.hasOwn(human, 'passedCount'), false);
  assert.equal(Object.hasOwn(human, 'shadowCount'), false);
  assert.equal(parseReviewKind(undefined), DEFAULT_REVIEW_KIND);
  assert.equal(parseReviewKind(null), 'PASSED_SAMPLE');
  assert.equal(parseReviewKind('HUMAN_BASELINE'), 'HUMAN_BASELINE');
  assert.equal(parseReviewKind('human_baseline'), 'PASSED_SAMPLE');
  assert.equal(reviewKindLabel('PASSED_SAMPLE'), '통과 세션 표본');
  assert.equal(reviewKindLabel('HUMAN_BASELINE'), '출시 뒤 사람 기준');
  assert.match(reviewKindHint('HUMAN_BASELINE'), /어느 묶음인지/);
  assert.match(reviewKindHint('PASSED_SAMPLE'), /위험 점수 범주/);
  // 머리 설명은 종류마다 다르다: HUMAN_BASELINE은 그림자 추가 검증 묶음도 섞여 있다
  assert.match(reviewKindIntro('HUMAN_BASELINE'), /그림자 추가 검증/);
  assert.match(reviewKindIntro('PASSED_SAMPLE'), /검증을 통과한 세션/);
  assert.notEqual(reviewKindIntro('HUMAN_BASELINE'), reviewKindIntro('PASSED_SAMPLE'));
  // 근거 이름 '그 밖'에는 메모 칸이 없다(openapi 판정 본문에 메모 칸이 없다)
  assert.equal(EVIDENCE_KINDS.find((e) => e.kind === 'OTHER')?.label, '그 밖');
  assert.equal(EVIDENCE_KINDS.some((e) => e.label.includes('메모')), false);

  // 표기: 퍼센트·비율·구간·시각(KST)
  assert.equal(formatPercent(25.5), '25.5%');
  assert.equal(formatPercent(120), '100.0%');
  assert.equal(formatPercent(-3), '0.0%');
  assert.equal(formatRate(0.4), '40.0%');
  assert.equal(formatRate(1.2), '100.0%');
  assert.equal(formatRateRange(0.168, 0.687), '16.8%~68.7%');
  assert.equal(formatKst('2026-11-21T05:00:00.000Z'), '2026. 11. 21. 14:00');
  assert.equal(formatKst(null), '—');
  assert.equal(formatKst('아님'), '—');
  assert.equal(verdictLabel('HUMAN'), '사람');
  assert.equal(verdictLabel('BOT'), '봇');
  assert.equal(verdictLabel('UNDECIDED'), '판단 불가');
  assert.equal(stepLabel('ENTRY'), '진입');
  assert.equal(stepLabel('HOLD'), '홀드');
  assert.equal(stepLabel('PAYMENT'), '결제');

  // 사람 기준 표본의 BOT은 행동 요약 밖의 근거가 하나 이상 필요하다
  assert.equal(needsEvidence('HUMAN_BASELINE', 'BOT'), true);
  assert.equal(needsEvidence('HUMAN_BASELINE', 'HUMAN'), false);
  assert.equal(needsEvidence('PASSED_SAMPLE', 'BOT'), false);
  assert.equal(canSubmit('HUMAN_BASELINE', 'BOT', []), false);
  assert.equal(canSubmit('HUMAN_BASELINE', 'BOT', ['CONFIRMED_SIGNAL']), true);
  assert.equal(canSubmit('PASSED_SAMPLE', 'BOT', []), true);
  assert.equal(canSubmit('HUMAN_BASELINE', null, []), false);
  assert.match(submitBlockReason('HUMAN_BASELINE', null, []), /판정을 고르면/);
  assert.match(submitBlockReason('HUMAN_BASELINE', 'BOT', []), /근거를 하나 이상/);
  assert.equal(submitBlockReason('HUMAN_BASELINE', 'BOT', ['OTHER']), null);
  assert.equal(submitBlockReason('PASSED_SAMPLE', 'BOT', []), null);
  // 근거 종류는 정본 다섯(OTHER 포함)이고 화면 문구가 있다
  assert.deepEqual(
    EVIDENCE_KINDS.map((e) => e.kind),
    ['CONFIRMED_SIGNAL', 'SHARED_DEVICE_OR_PAYMENT', 'POST_LABEL', 'VERIFICATION_FAILED', 'OTHER'],
  );
});

test('FR-049 목록은 받은 순서를 그대로 쓰고 sampleId로 다시 정렬하지 않는다', () => {
  const page = mapSamples({
    items: [
      { sampleId: 'z-last', sessionRef: 'sess-z', status: 'PENDING', riskBand: 'HIGH', behaviorSummaryBand: 'ENTRY_FAST', timeline: [{ step: 'ENTRY', at: '2026-11-21T05:00:00.000Z' }], evidenceAvailable: ['CONFIRMED_SIGNAL', 'UNKNOWN', 'OTHER'] },
      { sampleId: 'a-first', sessionRef: 'sess-a', status: 'RECORDED', riskBand: null, behaviorSummaryBand: null, timeline: [{ step: 'PAYMENT', at: '2026-11-21T05:01:00.000Z' }, { step: 'NOPE', at: 'x' }], evidenceAvailable: [] },
      { sessionRef: 'sess-idless' },
      { sampleId: 'a-first' },
    ],
  });
  assert.deepEqual(page.map((s) => s.sampleId), ['z-last', 'a-first']);
  assert.deepEqual(page[0], {
    sampleId: 'z-last',
    sessionRef: 'sess-z',
    status: 'PENDING',
    riskBand: 'HIGH',
    behaviorSummaryBand: 'ENTRY_FAST',
    timeline: [{ step: 'ENTRY', at: '2026-11-21T05:00:00.000Z' }],
    // 모르는 근거와 메모 자리(OTHER)는 카드에 싣지 않는다
    evidenceAvailable: ['CONFIRMED_SIGNAL'],
  });
  assert.deepEqual(page[1].timeline, [{ step: 'PAYMENT', at: '2026-11-21T05:01:00.000Z' }]);
  assert.equal(page[1].status, 'RECORDED');
  assert.equal(page[1].riskBand, null);
  assert.equal(page[1].behaviorSummaryBand, null);
  // 목록이 없거나 null이면 빈 배열이다
  assert.deepEqual(mapSamples(undefined), []);
  assert.deepEqual(mapSamples(null), []);
  assert.deepEqual(mapSamples({}), []);
  assert.deepEqual(mapSamples({ items: [] }), []);
  // 화면 행에는 서버가 준 금지 칸(pid·기기 가명·점수 원값)을 옮기지 않는다
  const keys = Object.keys(page[0]).sort();
  assert.deepEqual(keys, ['behaviorSummaryBand', 'evidenceAvailable', 'riskBand', 'sampleId', 'sessionRef', 'status', 'timeline']);
});

test('FR-049 화면 모델 계약은 reviewKind·PENDING·판정 400·422·409·503을 안다', () => {
  assert.match(OPENAPI, /PASSED_SAMPLE/);
  assert.match(OPENAPI, /HUMAN_BASELINE/);
  assert.match(OPENAPI, /bot-review-label-unavailable/);
  assert.match(OPENAPI, /reviewKind/);
  const model = readFileSync(join(ROOT, 'apps/console-host/src/pages/bot-review/model/review.ts'), 'utf8');
  for (const text of ["status: 'PENDING'", 'HUMAN', 'BOT', 'UNDECIDED', 'CONFIRMED_SIGNAL', 'VERIFICATION_FAILED']) assert.ok(model.includes(text), text);
});

test('FR-049 계약은 진행 GET의 400·410, 목록 400의 잘못된 커서, targetCount의 실제 모집단 수를 적는다', () => {
  const start = OPENAPI.indexOf('  /v1/ops/events/{eventId}/bot-review:');
  const samplesAt = OPENAPI.indexOf('  /v1/ops/events/{eventId}/bot-review-samples:');
  const judgementAt = OPENAPI.indexOf('  /v1/ops/bot-review-samples/{sampleId}/judgement:');
  assert.ok(start >= 0 && samplesAt > start && judgementAt > samplesAt, 'openapi에서 세 경로 자리를 찾지 못했다');
  const progress = OPENAPI.slice(start, samplesAt);
  // 진행 GET도 reviewKind가 틀리면 400, 기한이 지나면 410이다(구현이 내는 응답)
  assert.match(progress, /'400'/);
  assert.match(progress, /'410'/);
  assert.match(progress, /retention-ended/);
  // 목록 400에는 잘못된 커서가 들어간다
  const list = OPENAPI.slice(samplesAt, judgementAt);
  assert.match(list, /잘못된 커서/);
  // targetCount는 고정 200·400이 아니라 모집단이 더 작으면 그 수(전수 검토)다(계획 B18)
  assert.match(OPENAPI, /targetCount:.*모집단이 더 작으면 그 수/);
});
