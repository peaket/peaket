// 후기 화면 모델 시험(SCR-016 API 매핑·정렬·신고 대상). node --test가 .ts를 타입 지우기로 읽는다.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapReview, mapReviewPage, mapReviewSummary, reviewSortParam, reviewTargetOf, sortReviewItems } from './model.ts';

test('SCR016_ API 후기를 화면 카드로 바꾸고 KST 관람·작성일을 만든다', () => {
  const item = mapReview({
    reviewId: 'r1',
    eventId: 'e1',
    authorDisplay: '김**',
    attendedStartsAt: '2026-10-25T09:00:00Z',
    rating: 4,
    body: '무대가 좋았습니다.',
    createdAt: '2026-10-25T12:00:00Z',
    mine: true,
    reportedByMe: true,
    status: 'VISIBLE',
    permalink: '/reviews/r1',
    images: [{ imageId: 'i1', thumbnailUrl: 'https://img.test/t.jpg', url: 'https://img.test/f.jpg', alt: '무대' }],
  });
  assert.deepEqual(item, {
    kind: 'review',
    id: 'r1',
    eventId: 'e1',
    author: '김**',
    watched: '10월 25일 18:00 관람',
    written: '10/25 작성',
    order: Date.parse('2026-10-25T12:00:00Z'),
    stars: 4,
    body: '무대가 좋았습니다.',
    photos: [{ caption: '무대', url: 'https://img.test/f.jpg', thumbnailUrl: 'https://img.test/t.jpg' }],
    mine: true,
    reportedByMe: true,
    status: 'VISIBLE',
    permalink: '/reviews/r1',
  });
});

test('SCR016_ 조치된 후기는 공시 카드로, 내가 쓴 가려진 후기는 노출 제한 카드로 바꾼다', () => {
  assert.deepEqual(mapReview({ reviewId: 'r2', notice: 'RIGHTS_TEMP', noticeUntil: '2026-11-18T00:00:00Z', createdAt: '2026-10-25T12:00:00Z' }), {
    kind: 'notice',
    id: 'r2',
    order: Date.parse('2026-10-25T12:00:00Z'),
    text: '권리 침해 신고로 임시조치된 후기입니다(11/18까지)',
    label: '임시조치된 후기',
  });
  assert.deepEqual(mapReview({ reviewId: 'r3', notice: 'POLICY' }), {
    kind: 'notice',
    id: 'r3',
    order: 0,
    text: '운영정책에 따라 가려진 후기입니다',
    label: '가려진 후기',
  });
  const mine = mapReview({ reviewId: 'r4', status: 'HIDDEN', mine: true, rating: 5, body: '가려진 내 글' });
  assert.equal(mine.kind, 'review');
  assert.equal(mine.restricted, true);
  assert.equal(mine.stars, 0);
  assert.equal(mine.body, '');
});

test('SCR016_ 목록·요약을 화면 모양으로 바꾸고 reviewId 없는 행은 뺀다', () => {
  const page = mapReviewPage({
    items: [{ reviewId: 'r1', rating: 5 }, { rating: 4 }, { reviewId: 'r2', notice: 'POLICY' }],
    nextCursor: 'c1',
  });
  assert.deepEqual(page.items.map((i) => i.id), ['r1', 'r2']);
  assert.equal(page.nextCursor, 'c1');
  assert.deepEqual(mapReviewSummary({ averageRating: 4.6, count: 128 }), { average: 4.6, count: 128 });
  assert.deepEqual(mapReviewSummary({ averageRating: null }), { average: null, count: 0 });
});

test('SCR016_ 화면 정렬을 API 정렬로 바꾸고, 별점 정렬은 조치 카드를 뒤로 보낸다', () => {
  assert.equal(reviewSortParam('latest'), 'LATEST');
  assert.equal(reviewSortParam('high'), 'RATING_DESC');
  assert.equal(reviewSortParam('low'), 'RATING_ASC');
  const items = [
    { kind: 'review', id: 'a', author: 'A', watched: '', written: '', order: 1, stars: 3, body: '', photos: [] },
    { kind: 'review', id: 'b', author: 'B', watched: '', written: '', order: 2, stars: 5, body: '', photos: [] },
    { kind: 'notice', id: 'n', order: 3, text: '가림', label: '가려진 후기' },
  ];
  assert.deepEqual(sortReviewItems(items, 'high').map((i) => i.id), ['b', 'a', 'n']);
  assert.deepEqual(sortReviewItems(items, 'latest').map((i) => i.id), ['n', 'b', 'a']);
});

test('SCR016_ 신고 대상 상자는 작성자·관람 회차·게시물 번호·본문을 담는다', () => {
  const item = mapReview({ reviewId: 'r1', authorDisplay: '김**', attendedStartsAt: '2026-10-25T09:00:00Z', body: '본문' });
  assert.deepEqual(reviewTargetOf(item), { author: '김**', watched: '10월 25일 18:00 관람', postId: 'r1', excerpt: '본문' });
});
