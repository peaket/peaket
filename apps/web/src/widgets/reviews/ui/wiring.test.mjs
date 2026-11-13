// SCR-016 화면이 실제 API 생성 함수를 부르고 목업 목록을 쓰지 않는지 소스로 확인한다(컴포넌트 배선 시험).
// 렌더 시험은 Next 빌드·브라우저 확인이 맡고, 여기서는 API 이름과 목업 제거를 못 박는다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

test('SCR016_ 후기 모달은 목록·요약·자격·쓰기/고치기/지우기·신고 API를 부른다', () => {
  const src = read('./ReviewModalsClient.tsx');
  for (const name of ['listEventReviews', 'getEventReviewSummary', 'getEventReviewEligibility', 'createEventReview', 'updateReview', 'deleteReview', 'createReviewReport']) {
    assert.match(src, new RegExp(`\\b${name}\\b`), `${name} 호출이 없다`);
  }
  assert.doesNotMatch(src, /REVIEW_ITEMS|REVIEW_SUMMARY/);
  assert.match(src, /mapReviewPage/);
  assert.match(src, /withFanRefresh\(\(\) => listEventReviews\(eventId, \{ sort: reviewSortParam\(sort\), limit: 10 \}\)\)/);
  assert.match(src, /e\.status === 503/);
  assert.match(src, /return \{ kind: 'off' \};/);
  assert.match(src, /e\.status === 401/);
  assert.match(src, /e\.status === 429/);
  assert.match(src, /setAlert\('limited'\);\s*setView\(\(v\) => \(\{ \.\.\.v, kind: 'report' \}\)\)/);
  assert.match(src, /e\.status === 409/);
  assert.match(src, /e\.status === 422/);
});

test('SCR016_ 운영자 조치 컴포넌트는 core-svc 조치 API를 부른다', () => {
  const src = read('./ReviewModerationActions.tsx');
  assert.match(src, /await createOpsReviewModeration\(reviewId, payload\.body\)/);
  assert.match(src, /opsApiAvailable/);
  assert.match(src, /if \(!opsApiAvailable\(\)\) return null/);
  assert.match(src, /buildModerationPayload/);
});
