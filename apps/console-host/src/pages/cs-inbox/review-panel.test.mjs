// 관제 CS 처리함의 신고된 후기 패널(SCR-045, F-07-10). 값 해석·조치 확인 규칙·배선을 시험한다.
// 정본: docs/design/d5-screen-blueprint.md §7.6, POL-044 ③, openapi OpsReviewDetail·/v1/ops/reviews/{reviewId}/moderation.
// 기준 트리에는 live.ts의 새 함수·ConnectedPage의 후기 패널·계약 images/takedownReason 칸이 없어 새 시험이 실패한다.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import * as live from './model/live.ts';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');
const count = (src, re) => (src.match(re) ?? []).length;
const has = (src, re, label) => assert.ok(re.test(src), label);

const REVIEW_ID = '0194f062-0000-7000-8000-000000000101';
const EVENT_ID = '0194f062-0000-7000-8000-000000000102';
const NOW = Date.parse('2026-11-26T01:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

const RAW = {
  review: {
    reviewId: REVIEW_ID,
    eventId: EVENT_ID,
    rating: 4,
    body: '무대가 좋았습니다',
    status: 'HIDDEN',
    notice: 'RIGHTS_TEMP',
    noticeUntil: '2026-12-26T01:00:00.000Z',
    takedownReason: 'RIGHTS_TEMP',
    authorDisplay: '김**',
    createdAt: '2026-11-20T10:00:00.000Z',
    edited: false,
    images: [
      { imageId: '0194f062-0000-7000-8000-000000000201', thumbnailUrl: 'https://img.peaket.test/review/a/240.webp', url: 'https://img.peaket.test/review/a/1280.webp', alt: '무대', width: 800, height: 600 },
      { imageId: '0194f062-0000-7000-8000-000000000202', thumbnailUrl: 'https://img.peaket.test/review/b/240.webp', url: 'https://img.peaket.test/review/b/1280.webp', alt: '', width: 800, height: 600 },
    ],
    reporterAccountId: '0194f062-0000-7000-8000-000000000301',
    accountId: '0194f062-0000-7000-8000-000000000302',
    basisOrderId: '0194f062-0000-7000-8000-000000000303',
  },
  summary: {
    total: 2,
    byCategory: { SPAM: 1, ABUSE: 1 },
    reports: [
      { category: 'SPAM', detail: '광고입니다', rightsHolder: false, createdAt: '2026-11-21T10:00:00.000Z', reporterAccountId: '0194f062-0000-7000-8000-000000000301' },
      { category: 'ABUSE', detail: '욕설입니다', rightsHolder: false, createdAt: '2026-11-22T10:00:00.000Z' },
    ],
    payerName: '김피켓',
  },
  payerName: '김피켓',
};

test('OPS-05 [ASVS v5.0.0-14.2.6] 후기 상세는 사진·신고 요약·가림 사유만 옮기고 신고자·작성자 계정·기준 주문·팬 이름은 버린다', () => {
  const d = live.reviewDetailOf(RAW);
  assert.ok(d);
  assert.equal(d.review.reviewId, REVIEW_ID);
  assert.equal(d.review.body, '무대가 좋았습니다');
  assert.equal(d.review.rating, 4);
  assert.equal(d.review.status, 'HIDDEN');
  assert.equal(d.review.notice, 'RIGHTS_TEMP');
  assert.equal(d.review.takedownReason, 'RIGHTS_TEMP');
  assert.equal(d.review.images.length, 2);
  assert.deepEqual(d.review.images[0], {
    thumbnailUrl: 'https://img.peaket.test/review/a/240.webp',
    url: 'https://img.peaket.test/review/a/1280.webp',
    alt: '무대',
  });
  assert.equal(d.summary.total, 2);
  assert.equal(d.summary.byCategory.SPAM, 1);
  assert.equal(d.summary.reports.length, 2);
  assert.equal(d.summary.reports[0].detail, '광고입니다');
  for (const k of ['reporterAccountId', 'accountId', 'basisOrderId', 'payerName']) assert.equal(k in d.review, false, k);
  for (const k of ['payerName']) assert.equal(k in d.summary, false, k);
  for (const k of ['payerName', 'reporterAccountId', 'accountId', 'basisOrderId']) assert.equal(k in d, false, k);
  assert.equal('reporterAccountId' in d.summary.reports[0], false);
  const empty = live.reviewDetailOf({ review: { reviewId: REVIEW_ID, images: [] }, summary: { total: 0, byCategory: {}, reports: [] } });
  assert.deepEqual(empty.review.images, []);
  assert.equal(live.reviewDetailOf({ review: { reviewId: REVIEW_ID } }), null);
});

test('OPS-06 [ASVS v5.0.0-2.3.2] 조치 입력은 사유·위반 유형·30일 경계를 화면에서 먼저 막고, 서버 본문을 만든다', () => {
  const endsAt = new Date(NOW + 30 * DAY).toISOString();
  assert.deepEqual(live.reviewModerationPlan({ action: 'TEMP_BLOCK', reason: '임시조치', violation: 'ABUSE', endsAt }, NOW), {
    ok: true,
    body: { action: 'TEMP_BLOCK', reason: '임시조치', violation: 'ABUSE', endsAt },
  });
  assert.equal(live.reviewModerationPlan({ action: 'TEMP_BLOCK', reason: '임시조치', endsAt }, NOW).ok, false);
  assert.equal(live.reviewModerationPlan({ action: 'TEMP_BLOCK', reason: '임시조치', violation: 'ABUSE', endsAt: new Date(NOW + 30 * DAY + 1).toISOString() }, NOW).ok, false);
  assert.equal(live.reviewModerationPlan({ action: 'TEMP_BLOCK', reason: '임시조치', violation: 'ABUSE', endsAt: new Date(NOW - 1).toISOString() }, NOW).ok, false);
  assert.equal(live.reviewModerationPlan({ action: 'BLOCK', reason: '차단' }, NOW).ok, false);
  assert.deepEqual(live.reviewModerationPlan({ action: 'BLOCK', reason: '차단', violation: 'SPAM' }, NOW), { ok: true, body: { action: 'BLOCK', reason: '차단', violation: 'SPAM' } });
  assert.deepEqual(live.reviewModerationPlan({ action: 'RELEASE', reason: '해제' }, NOW), { ok: true, body: { action: 'RELEASE', reason: '해제' } });
  assert.deepEqual(live.reviewModerationPlan({ action: 'NO_ACTION', reason: '조치 없음' }, NOW), { ok: true, body: { action: 'NO_ACTION', reason: '조치 없음' } });
  assert.equal(live.reviewModerationPlan({ action: 'NO_ACTION', reason: '가' }, NOW).ok, true);
  assert.equal(live.reviewModerationPlan({ action: 'NO_ACTION', reason: '가'.repeat(2000) }, NOW).ok, true);
  assert.equal(live.reviewModerationPlan({ action: 'NO_ACTION', reason: '가'.repeat(2001) }, NOW).ok, false);
  assert.equal(live.reviewModerationPlan({ action: 'NO_ACTION', reason: '   ' }, NOW).ok, false);
});

test('OPS-07 [ASVS v5.0.0-2.2.3] 역할·상태·가림 사유별로 할 수 있는 조치만 그린다', () => {
  const base = live.reviewDetailOf(RAW);
  const visible = { ...base, review: { ...base.review, status: 'VISIBLE', notice: undefined, takedownReason: undefined, noticeUntil: undefined } };
  assert.deepEqual(live.reviewActionsFor({ ...visible, summary: { ...visible.summary, total: 2 } }, 'cs_agent'), ['NO_ACTION', 'TEMP_BLOCK', 'BLOCK']);
  assert.deepEqual(live.reviewActionsFor({ ...visible, summary: { ...visible.summary, total: 0 } }, 'cs_agent'), ['TEMP_BLOCK']);
  assert.deepEqual(live.reviewActionsFor({ ...base, review: { ...base.review, status: 'HIDDEN', notice: 'POLICY', takedownReason: 'POLICY' } }, 'cs_agent'), ['RELEASE']);
  assert.deepEqual(live.reviewActionsFor(base, 'cs_lead'), ['RELEASE']);
  assert.deepEqual(live.reviewActionsFor({ ...base, review: { ...base.review, status: 'HIDDEN', notice: undefined, noticeUntil: undefined, takedownReason: 'FILMING_HOLD' } }, 'cs_agent'), ['RELEASE']);
  assert.deepEqual(live.reviewActionsFor({ ...base, review: { ...base.review, status: 'HIDDEN', notice: undefined, noticeUntil: undefined, takedownReason: 'NOTICE' } }, 'cs_agent'), []);
  assert.deepEqual(live.reviewActionsFor({ ...base, review: { ...base.review, status: 'HIDDEN', notice: undefined, noticeUntil: undefined, takedownReason: 'SAME_CONTENT' } }, 'cs_agent'), []);
  assert.deepEqual(live.reviewActionsFor({ ...base, review: { ...base.review, status: 'HIDDEN', notice: undefined, noticeUntil: undefined, takedownReason: undefined } }, 'cs_agent'), []);
  assert.deepEqual(live.reviewActionsFor(base, 'viewer'), []);
  assert.deepEqual(live.reviewActionsFor(base, 'operator'), []);
});

test('OPS-08 화면은 후기 ID가 있는 신고 건에서만 상세를 불러 패널을 그리고, 조치 뒤 상세·목록을 다시 읽으며 409·422를 보인다', () => {
  const caseView = { caseId: '0194f062-0000-7000-8000-000000000401', kind: 'CONTENT_REPORT', targetRef: REVIEW_ID, category: '', status: 'OPEN', progressDueAt: null, resultDueAt: null, dueState: 'NONE', assignee: null, version: 1, createdAt: null, resolvedAt: null, resultNote: null };
  assert.equal(live.reviewIdOf(caseView), REVIEW_ID);
  assert.equal(live.reviewIdOf({ ...caseView, kind: 'INQUIRY' }), null);
  assert.equal(live.reviewIdOf({ ...caseView, targetRef: 'not-a-uuid' }), null);

  const detail = live.reviewDetailOf(RAW);
  const panel = live.reviewPanelFor(detail, 'cs_agent');
  assert.equal(panel.reviewId, REVIEW_ID);
  assert.equal(panel.reports[0].detail, '광고입니다');
  assert.deepEqual(panel.images, [
    { url: 'https://img.peaket.test/review/a/1280.webp', alt: '무대' },
    { url: 'https://img.peaket.test/review/b/1280.webp', alt: '후기 사진 2/2' },
  ]);
  assert.deepEqual(panel.actions, ['RELEASE']);
  const noPhoto = live.reviewPanelFor(live.reviewDetailOf({ review: { reviewId: REVIEW_ID, status: 'VISIBLE' }, summary: { total: 1, byCategory: { SPAM: 1 }, reports: [{ category: 'SPAM', detail: '광고' }] } }), 'cs_agent');
  assert.deepEqual(noPhoto.images, []);
  assert.deepEqual(noPhoto.actions, ['NO_ACTION', 'TEMP_BLOCK', 'BLOCK']);

  const source = read('./ui/ConnectedPage.tsx');
  has(source, /\bgetOpsReview\b/, 'getOpsReview 호출이 없다');
  has(source, /\bcreateOpsReviewModeration\b/, 'createOpsReviewModeration 호출이 없다');
  has(source, /\breviewIdOf\(/, 'reviewIdOf를 쓰지 않는다');
  has(source, /\breviewPanelFor\(/, 'reviewPanelFor를 쓰지 않는다');
  has(source, /reviewPanel\.actions|panel\.actions/, '패널의 조치 목록을 그리지 않는다');
  has(source, /reviewPanel\.images|panel\.images/, '패널의 사진을 그리지 않는다');
  has(source, /reviewPanel\.reports|panel\.reports/, '패널의 신고 내용을 그리지 않는다');
  has(source, /reviewPanel\.reports\.map|panel\.reports\.map|reports\.map\(/, '신고 내용을 목록으로 그리지 않는다');
  has(source, /<img[\s\S]*alt=/, '사진 img·alt가 없다');
  has(source, /409[\s\S]{0,120}422|422[\s\S]{0,120}409|e\.status === 409|e\.status === 422/, '409·422 까닭 표시가 없다');
  const callAt = source.indexOf('createOpsReviewModeration');
  assert.ok(callAt >= 0, 'createOpsReviewModeration 호출이 없다');
  const moderationBlock = source.slice(Math.max(0, callAt - 500), callAt + 1500);
  has(moderationBlock, /loadDetail\(/, '조치 블록 안에서 상세를 다시 읽지 않는다');
  has(moderationBlock, /loadList\(/, '조치 블록 안에서 목록을 다시 읽지 않는다');
  assert.equal(count(source, /dangerouslySetInnerHTML|innerHTML/g), 0);
  assert.doesNotMatch(source, /\bfetch\s*\(/);

  const model = read('./model/live.ts');
  const filters = /FILTER_KINDS[^=]*=\s*\[([\s\S]*?)\]/.exec(model)?.[1] ?? '';
  has(filters, /'CONTENT_REPORT'/, '종류 필터에 CONTENT_REPORT가 없다');
  has(filters, /'RIGHTS_REQUEST'/, '종류 필터에 RIGHTS_REQUEST가 없다');
});

test('OPS-09 [ASVS v5.0.0-14.2.6] 계약·생성물의 후기 상세에 사진(최대 3, 1,280 URL)과 가림 사유가 있다', () => {
  const openapi = read('../../../../../docs/api/openapi.yaml');
  const block = /OpsReviewDetail:[\s\S]*?\n    InquiryCategory:/.exec(openapi)?.[0] ?? '';
  has(block, /images:/, 'OpsReviewDetail.review에 images가 없다');
  has(block, /\$ref: '#\/components\/schemas\/ReviewImage'/, 'images가 ReviewImage 참조가 아니다');
  has(block, /maxItems: 3/, 'images 최대 3장이 아니다');
  has(block, /takedownReason:/, 'takedownReason이 없다');
  has(block, /FILMING_HOLD/, 'takedownReason에 FILMING_HOLD가 없다');
  has(block, /NOTICE|SAME_CONTENT/, 'takedownReason에 법정 통보·같은 내용이 없다');
  const model = read('../../../../../packages/api-client/src/gen/model/opsReviewDetailReview.ts');
  has(model, /images\?: ReviewImage\[\]/, '생성 모델 review에 images?: ReviewImage[]가 없다');
  has(model, /takedownReason\?:/, '생성 모델 review에 takedownReason이 없다');
  const zod = read('../../../../../packages/contracts/src/gen/openapi/model/opsReviewDetail.zod.ts');
  has(zod, /"images"/, 'contracts zod에 images가 없다');
  has(zod, /"takedownReason"/, 'contracts zod에 takedownReason이 없다');
});
