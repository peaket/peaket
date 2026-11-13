// review 순수 규칙(BUILD_ORDER BAT-585, FR-016·FR-033·FR-070, POL-024·POL-042·POL-044).
import { describe, expect, test } from 'vitest';
import {
  contentFingerprint,
  graphemes,
  maskAuthor,
  moderationEffect,
  noticeDeadlineMs,
  type ReviewRecord,
  reviewView,
  summaryOf,
  validateReport,
  validateReviewWrite,
} from '../src/modules/review/domain/review.js';
import { MemoryReviewStore } from '../src/modules/review/adapters/memory-review-store.js';

const NOW = Date.parse('2026-11-13T00:00:00.000Z');
const record = (o: Partial<ReviewRecord> = {}): ReviewRecord => ({
  reviewId: 'r1',
  eventId: 'e1',
  productionId: 'p1',
  accountId: 'a1',
  basisOrderId: 'o1',
  rating: 5,
  body: '정말 좋았습니다! 다음에도 또 보고 싶어요.',
  status: 'VISIBLE',
  contentFingerprint: contentFingerprint('정말 좋았습니다! 다음에도 또 보고 싶어요.'),
  authorDisplay: '김**',
  createdAtMs: NOW,
  updatedAtMs: NOW,
  edited: false,
  ...o,
});

describe('후기 본문·지문', () => {
  test('[ASVS v5.0.0-1.3.3] NFC 정규화 뒤 grapheme 10~1,000자만 받고 제어 문자를 지운다', () => {
    expect(validateReviewWrite({ rating: 5, body: '  정말 좋았습니다! 다음에도 또 보고 싶어요.  ' }).body).toBe('  정말 좋았습니다! 다음에도 또 보고 싶어요.  ');
    expect(() => validateReviewWrite({ rating: 0, body: '열 글자가 넘는 후기 본문입니다.' })).toThrow(/별점/);
    expect(() => validateReviewWrite({ rating: 5, body: '짧음' })).toThrow(/본문/);
    expect(() => validateReviewWrite({ rating: 5, body: '가'.repeat(1001) })).toThrow(/본문/);
    expect(graphemes('👨‍👩‍👧‍👦')).toHaveLength(1);
  });

  test('같은 내용 지문은 공백·문장부호·전각 차이를 지운다(FR-033 2호 마목)', () => {
    const a = '정말 좋았습니다! 다음에도 또 보고 싶어요.';
    const b = '정말 좋았습니다 다음에도 또 보고싶어요';
    expect(contentFingerprint(a)).toBe(contentFingerprint(b));
    expect(contentFingerprint('다른 내용입니다. 정말로 다릅니다.')).not.toBe(contentFingerprint(a));
  });

  test('작성자 표시는 첫 grapheme + **이고, 닉네임이 없으면 ***다', () => {
    expect(maskAuthor('김피켓')).toBe('김**');
    expect(maskAuthor('👨‍👩‍👧‍👦가족')).toBe('👨‍👩‍👧‍👦**');
    expect(maskAuthor(undefined)).toBe('***');
  });

  test('법정 통보 기한은 일반 24시간, 고시 10시간이다(공연법 시행령 §3의3 2호 바목)', () => {
    expect(noticeDeadlineMs(NOW, 'GENERAL')).toBe(NOW + 24 * 3600_000);
    expect(noticeDeadlineMs(NOW, 'MINISTRY')).toBe(NOW + 10 * 3600_000);
  });
});

describe('신고와 조치', () => {
  test('[ASVS v5.0.0-2.3.2] RIGHTS 본인 요청은 자세한 내용과 결과 받을 곳이 필수고, OTHER는 자세한 내용이 필수다', () => {
    expect(() => validateReport({ category: 'RIGHTS', rightsHolder: true })).toThrow(/자세한 내용/);
    expect(() => validateReport({ category: 'RIGHTS', rightsHolder: true, detail: '내 개인정보가 보입니다' })).toThrow(/받을 곳/);
    expect(validateReport({ category: 'RIGHTS', rightsHolder: true, detail: '내 개인정보가 보입니다', notifyChannel: 'APP' })).toMatchObject({ rightsHolder: true, notifyChannel: 'APP' });
    expect(() => validateReport({ category: 'OTHER' })).toThrow(/자세한 내용/);
    expect(validateReport({ category: 'SPAM', detail: '광고입니다' }).detail).toBe('광고입니다');
  });

  test('[ASVS v5.0.0-2.3.3] 임시조치는 30일 이내, 노출 차단은 위반 사유가 필요하고, 해제는 가림을 되돌린다', () => {
    expect(moderationEffect({ action: 'TEMP_BLOCK', reason: '권리 침해', violation: 'RIGHTS', endsAtMs: NOW + 10 * 24 * 3600_000 }, NOW)).toMatchObject({ status: 'HIDDEN', notice: 'RIGHTS_TEMP', outcome: 'TEMP_BLOCKED' });
    expect(() => moderationEffect({ action: 'TEMP_BLOCK', reason: '권리 침해', violation: 'RIGHTS', endsAtMs: NOW + 31 * 24 * 3600_000 }, NOW)).toThrow(/30일/);
    expect(() => moderationEffect({ action: 'BLOCK', reason: '정책 위반' }, NOW)).toThrow(/위반 사유/);
    expect(moderationEffect({ action: 'RELEASE', reason: '이의 인정' }, NOW)).toMatchObject({ status: 'VISIBLE', restoreTakedowns: true, outcome: 'NO_ACTION' });
    expect(moderationEffect({ action: 'NO_ACTION', reason: '위반 없음' }, NOW).status).toBeUndefined();
  });

  test('끝 시각이 지난 임시조치는 정비 일이 풀고 조치 기록을 복원한다', async () => {
    const store = new MemoryReviewStore();
    const r = record({ status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntilMs: NOW - 1 });
    await store.insertReview(r);
    await store.insertTakedown({ takedownId: 't1', reviewId: r.reviewId, reason: 'RIGHTS_TEMP', contentFingerprint: r.contentFingerprint, hiddenAtMs: NOW - 1000, endsAtMs: NOW - 1 });
    expect(await store.expireTemporaryBlocks(NOW)).toBe(1);
    expect(await store.findReview(r.reviewId)).toMatchObject({ status: 'VISIBLE', notice: undefined });
    expect((await store.takedownsByReview(r.reviewId))[0]?.restoredAtMs).toBe(NOW);
  });

  test('남에게는 통보·같은 내용 가림을 빼고, 신고 처리 가림은 notice만 보인다', () => {
    const hidden = record({ status: 'HIDDEN' });
    expect(reviewView(hidden, 'a2', false, '2026-01-01T10:00:00.000Z')).toBeUndefined();
    expect(reviewView(hidden, 'a1', false, '2026-01-01T10:00:00.000Z')).toMatchObject({ status: 'HIDDEN', body: hidden.body });
    const notice = record({ status: 'HIDDEN', notice: 'POLICY' });
    expect(reviewView(notice, 'a2', false, '2026-01-01T10:00:00.000Z')).toMatchObject({ status: 'HIDDEN', notice: 'POLICY' });
    expect(reviewView(notice, 'a2', false, '2026-01-01T10:00:00.000Z')?.body).toBeUndefined();
    expect(summaryOf([record(), record({ reviewId: 'r2', rating: 3 }), notice])).toEqual({ averageRating: 4, count: 2 });
  });
});
