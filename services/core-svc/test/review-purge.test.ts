// I-T83 ②③⑥(W8-audit2a, 소유자 결정 2026-11-16 OPEN[42], ADR-0278, ADR-0086 ⑧): 파기한 후기는 공연 후기 목록·요약·상세에서 빠지고,
// 작성자가 지운 후기도 탈퇴 파기와 같은 칸을 비운다. 손으로 하는 파기(purgeHeldWithdrawal)는 보류된 탈퇴 사건이 있을 때만 하고 다시 정리 예약을 쓴다(웨이브 끝 리뷰 S1).
// 손으로 하는 파기는 한 번에 보류 행 ID 차례로 50개까지 처리하고, 처리한 보류 행 수·ID를 돌려준다(eventKey가 없는 행 포함, 다시 보기 N1, 계획 §10.5).
// 정본: docs/features/identity.md §8 '후기 파기'·§12 I-T83, docs/data.md §2 '후기 파기'·§6 '관람 후기'. 단언 값은 정본에서 적고 코드 상수를 가져오지 않는다.
import { fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { MemoryCatalogRepository, type Production } from '../src/modules/catalog/index.js';
import { MemoryReviewEventDirectory } from '../src/modules/review/adapters/memory-review-event-directory.js';
import {
  contentFingerprint,
  MemoryFanProfile,
  MemoryReviewCaseSink,
  MemoryReviewEligibility,
  MemoryReviewNotifier,
  MemoryReviewStore,
  type ReviewRecord,
  Reviews,
} from '../src/modules/review/index.js';

const T0 = Date.parse('2026-11-16T03:00:00.000Z');
const DAY = 86_400_000;
const A = '0190f3a1-7c2e-7a00-8000-00000000a002';
const B = '0190f3a1-7c2e-7a00-8000-00000000b002';
const PROMOTER = '0190f3a1-7c2e-7a00-8000-0000000c0002';

/** docs/data.md §2 '후기 파기'의 칸대로 비운 모양(정본 값을 시험이 따로 적는다) */
const purgedOf = (before: ReviewRecord, o: { nowMs: number; deletedAtMs: number }): Record<string, unknown> => ({
  reviewId: before.reviewId,
  eventId: before.eventId,
  productionId: before.productionId,
  accountId: before.reviewId,
  basisOrderId: before.reviewId,
  rating: null,
  body: '',
  status: 'DELETED',
  contentFingerprint: null,
  authorDisplay: '',
  createdAtMs: before.createdAtMs,
  updatedAtMs: o.nowMs,
  edited: before.edited,
  deletedAtMs: o.deletedAtMs,
});

/** 승인된 공연 하나와 그 회차 둘(같은 공연이라 후기 목록·요약을 함께 쓴다) */
function world() {
  const clock = fakeClock({ now: T0 });
  const repo = new MemoryCatalogRepository();
  repo.sellerNames.set(PROMOTER, '(주)피켓공연');
  const production: Production = { id: randomUUID(), promoterId: PROMOTER, placeId: randomUUID(), title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') };
  repo.productions.set(production.id, production);
  const round = (startsAt: string): string => {
    const id = randomUUID();
    repo.events.set(id, { id, productionId: production.id, venueId: randomUUID(), openAt: new Date('2026-10-01T00:00:00Z'), startsAt: new Date(startsAt), status: 'SCHEDULED' });
    return id;
  };
  const e1 = round('2026-11-10T10:00:00.000Z');
  const e2 = round('2026-11-11T10:00:00.000Z');
  const store = new MemoryReviewStore();
  const eligibility = new MemoryReviewEligibility();
  const reviews = new Reviews({
    store,
    events: new MemoryReviewEventDirectory(repo),
    eligibility,
    fanProfile: new MemoryFanProfile(),
    notifier: new MemoryReviewNotifier(),
    cases: new MemoryReviewCaseSink(),
    clock,
  });
  const record = (o: Partial<ReviewRecord> & Pick<ReviewRecord, 'eventId' | 'accountId'>): ReviewRecord => {
    const body = o.body ?? `회차 후기 본문입니다 ${randomUUID().slice(0, 8)}`;
    return {
      reviewId: randomUUID(),
      productionId: production.id,
      basisOrderId: randomUUID(),
      rating: 4,
      body,
      status: 'VISIBLE',
      contentFingerprint: contentFingerprint(body),
      authorDisplay: '김**',
      createdAtMs: T0 - DAY,
      updatedAtMs: T0 - DAY,
      edited: false,
      ...o,
    };
  };
  return { clock, store, eligibility, reviews, e1, e2, record };
}

describe('I-T83 파기한 후기는 공개 경로에서 빠진다', () => {
  test('I-T83 ② 파기한 후기는 공연 후기 목록·요약·상세에서 빠진다', async () => {
    const { clock, store, reviews, e1, e2, record } = world();
    const a1 = record({ eventId: e1, accountId: A, rating: 1, createdAtMs: T0 - 3 * DAY });
    const a2 = record({ eventId: e2, accountId: A, rating: 5, createdAtMs: T0 - 2 * DAY });
    const b1 = record({ eventId: e1, accountId: B, rating: 4, createdAtMs: T0 - DAY });
    for (const r of [a1, a2, b1]) await store.insertReview(r);

    // 처리 전: 후기 수 3, 평균 (1 + 5 + 4) / 3 = 3.33 → 소수 첫째 자리 3.3
    const before = await reviews.summary(e1);
    expect({ count: before.count, averageRating: before.averageRating }).toEqual({ count: 3, averageRating: 3.3 });
    expect((await reviews.list(e1, undefined, 'LATEST', undefined, 20)).items.map((v) => v.reviewId)).toEqual([b1.reviewId, a2.reviewId, a1.reviewId]);

    clock.advance(3 * 60_000);
    expect(await reviews.purgeWithdrawn({ accountId: A, withdrawnAt: '2026-11-16T02:58:00.000Z' })).toEqual({ purged: 2 });

    // 처리 뒤: 후기 수 1, 평균 4. 최근 후기에도 A 후기가 없다
    const after = await reviews.summary(e1);
    expect({ count: after.count, averageRating: after.averageRating }).toEqual({ count: 1, averageRating: 4 });
    expect(after.recent.map((v) => v.reviewId)).toEqual([b1.reviewId]);
    expect((await reviews.summary(e2)).count).toBe(1);
    // 목록: 정렬마다, 보는 사람마다(공개·탈퇴한 계정·다른 계정) A 후기가 없다
    for (const sort of ['LATEST', 'RATING_DESC', 'RATING_ASC'] as const) {
      for (const viewer of [undefined, A, B]) {
        for (const eventId of [e1, e2]) {
          const page = await reviews.list(eventId, viewer, sort, undefined, 20);
          expect(page.items.map((v) => v.reviewId), `${sort} ${viewer ?? '공개'} ${eventId === e1 ? '회차1' : '회차2'}`).toEqual([b1.reviewId]);
        }
      }
    }
    // 상세는 404
    for (const r of [a1, a2]) {
      for (const viewer of [undefined, A]) await expect(reviews.get(r.reviewId, viewer)).rejects.toMatchObject({ status: 404 });
    }
    expect((await reviews.get(b1.reviewId, undefined)).reviewId).toBe(b1.reviewId);
  });

  test('I-T83 ⑥ 작성자가 지운 후기도 같은 칸을 비운다', async () => {
    const { clock, store, eligibility, reviews, e1, e2, record } = world();
    const mine = record({ eventId: e1, accountId: A, rating: 4, edited: true });
    const hidden = record({ eventId: e2, accountId: A, status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntilMs: T0 + 5 * DAY, rating: 2 });
    const other = record({ eventId: e1, accountId: B });
    for (const r of [mine, hidden, other]) await store.insertReview(r);

    clock.advance(7 * 60_000);
    const NOW = T0 + 7 * 60_000;
    await reviews.delete(mine.reviewId, A);
    await reviews.delete(hidden.reviewId, A);

    // 지운 시각은 지금(처음 지움)이다
    expect(await store.findReview(mine.reviewId)).toEqual(purgedOf(mine, { nowMs: NOW, deletedAtMs: NOW }));
    expect(await store.findReview(hidden.reviewId)).toEqual(purgedOf(hidden, { nowMs: NOW, deletedAtMs: NOW }));
    for (const id of [mine.reviewId, hidden.reviewId]) {
      const after = (await store.findReview(id))!;
      expect(after.rating, id).toBeNull();
      expect(after.contentFingerprint, id).toBeNull();
      expect(after.authorDisplay, id).toBe('');
      expect(after.notice, id).toBeUndefined();
      expect(after.noticeUntilMs, id).toBeUndefined();
    }
    expect(await store.findReview(other.reviewId)).toEqual(other);
    // 작성자 지우기는 다시 정리 예약을 만들지 않는다
    expect(store.rechecks.size).toBe(0);

    // 같은 회차에 새 후기를 다시 쓸 수 있다
    expect(await store.findReviewByEventAccount(e1, A)).toBeUndefined();
    eligibility.set(A, e1, { eligible: true, basisOrderId: randomUUID() });
    expect(await reviews.eligibility(e1, A)).toEqual({ eligible: true });
    const again = await reviews.create(e1, A, { rating: 3, body: '지운 뒤 다시 쓴 후기 본문입니다.' });
    expect(again).toMatchObject({ status: 'VISIBLE', rating: 3, mine: true });
    expect(again.reviewId).not.toBe(mine.reviewId);
    expect((await store.findReview(mine.reviewId))?.status).toBe('DELETED');
  });

  test('I-T83 ⑨ 손으로 하는 파기는 계정 ID가 UUID가 아니면 거절하고 보류 사건을 처리하면 지금 + 16분 예약을 쓴다', async () => {
    // 웨이브 끝 보안 리뷰 S1: 옛 purgeAccount(어떤 계정이든 파기, 예약 없음)를 purgeHeldWithdrawal(보류된 탈퇴 사건이 있을 때만, 예약 씀)로 바꿨다
    const { clock, store, reviews, e1, record } = world();
    const a1 = record({ eventId: e1, accountId: A });
    const b1 = record({ eventId: e1, accountId: B });
    for (const r of [a1, b1]) await store.insertReview(r);
    const HELD = '0190f3a1-7c2e-7a00-8000-0000000d0b02';
    store.heldEvents.push({ id: HELD, topic: 'identity.accounts-withdrawn', eventKey: '0190f3a1-7c2e-7a00-8000-0000000e0b02', businessKey: A, msgKey: A });
    const by = { reason: '보류된 탈퇴 사건 손 처리 시험', requestedBy: 'ops-lee' };

    for (const bad of ['not-a-uuid', '', `${A}x`]) await expect(reviews.purgeHeldWithdrawal(bad, by), bad).rejects.toMatchObject({ type: 'review-invalid', status: 422 });
    expect(await store.findReview(a1.reviewId)).toEqual(a1);
    expect(store.rechecks.size).toBe(0);

    clock.advance(11 * 60_000);
    const NOW = T0 + 11 * 60_000;
    expect(await reviews.purgeHeldWithdrawal(A, by)).toEqual({ purged: 1, heldEvents: 1, heldEventIds: [HELD] });
    expect(await store.findReview(a1.reviewId)).toEqual(purgedOf(a1, { nowMs: NOW, deletedAtMs: NOW }));
    expect(await store.findReview(b1.reviewId)).toEqual(b1);
    expect(store.rechecks.get(A)?.dueAtMs).toBe(NOW + 16 * 60_000);
    expect(store.heldEvents[0]?.reprocessedAtMs).toBe(NOW);
    await expect(reviews.purgeHeldWithdrawal(A, by)).rejects.toMatchObject({ type: expect.stringMatching(/withdrawal-not-held$/), status: 409 });
  });

  test('I-T83 ⑨ 한 번에 처리하는 보류 행은 50개까지이고 남은 행은 다시 불러 처리한다', async () => {
    // 정본 docs/features/identity.md §8 '손으로 처리': 보류 행 ID 차례로 한 번에 50개 [가정]까지 잠그고 처리한다. 목록만 자르지 않고 처리 자체를 50개로 묶는다.
    // 남은 행이 있으면 다시 부르고, 409 withdrawal-not-held가 끝 신호다. 예약은 늦은 쪽이 남는다
    const { clock, store, reviews, e1, record } = world();
    const a1 = record({ eventId: e1, accountId: A });
    const b1 = record({ eventId: e1, accountId: B });
    for (const r of [a1, b1]) await store.insertReview(r);
    const TOPIC_W = 'identity.accounts-withdrawn';
    // 키 없는 보류 행 51개(해독하지 못한 사건, Kafka 키만 그 계정). ID는 차례가 정해진 고정 글자이고 ids가 ID 차례다
    const ids = Array.from({ length: 51 }, (_, i) => `0190f3a1-7c2e-7a00-8000-0000000d${(0x1000 + i).toString(16)}`);
    // 넣는 차례는 ID 차례와 다르다(i × 7 mod 51: 맨 끝에 넣는 행은 ids[44], 가장 큰 ID ids[50]은 가운데쯤)
    for (let k = 0; k < 51; k += 1) {
      const i = (k * 7) % 51;
      store.heldEvents.push({ id: ids[i]!, topic: TOPIC_W, eventKey: null, businessKey: `unreadable-${i}`, msgKey: i % 2 === 0 ? A : A.toUpperCase() });
    }
    // 다른 계정의 키 없는 보류 하나는 A의 어느 행보다 ID가 작다(상한을 다른 계정 행으로 채우지 않는다)
    const OTHER = '0190f3a1-7c2e-7a00-8000-0000000d0fff';
    store.heldEvents.push({ id: OTHER, topic: TOPIC_W, eventKey: null, businessKey: 'unreadable-b', msgKey: B });
    const at = (id: string) => store.heldEvents.find((h) => h.id === id)?.reprocessedAtMs;
    const by = { reason: '보류 행 상한 시험(51개)', requestedBy: 'ops-park' };

    clock.advance(5 * 60_000);
    const T1 = T0 + 5 * 60_000;
    // 첫 호출: ID 차례 앞 50개만 처리한다
    expect(await reviews.purgeHeldWithdrawal(A, by)).toEqual({ purged: 1, heldEvents: 50, heldEventIds: ids.slice(0, 50) });
    for (const id of ids.slice(0, 50)) expect(at(id), id).toBe(T1);
    expect(at(ids[50]!)).toBeUndefined();
    expect(at(OTHER)).toBeUndefined();
    expect(store.rechecks.get(A)?.dueAtMs).toBe(T1 + 16 * 60_000);

    // 1분 뒤 둘째 호출: 남은 하나(가장 큰 ID). 이미 파기한 후기는 0건, 예약은 늦은 쪽(둘째 시각 + 16분)
    clock.advance(60_000);
    const T2 = T1 + 60_000;
    expect(await reviews.purgeHeldWithdrawal(A, by)).toEqual({ purged: 0, heldEvents: 1, heldEventIds: [ids[50]] });
    expect(at(ids[50]!)).toBe(T2);
    for (const id of ids.slice(0, 50)) expect(at(id), id).toBe(T1);
    expect(store.rechecks.get(A)?.dueAtMs).toBe(T2 + 16 * 60_000);
    expect(store.rechecks.size).toBe(1);

    // 셋째 호출: 남은 보류가 없어 409(끝 신호). 다른 계정의 보류 행·후기는 그대로다
    clock.advance(60_000);
    await expect(reviews.purgeHeldWithdrawal(A, by)).rejects.toMatchObject({ type: expect.stringMatching(/withdrawal-not-held$/), status: 409 });
    expect(at(OTHER)).toBeUndefined();
    expect(await store.findReview(b1.reviewId)).toEqual(b1);
  });

  test('I-T83 ⑨ 손으로 하는 파기는 이미 지금 + 30분인 다시 정리 예약을 그대로 남긴다', async () => {
    // 정본 docs/features/identity.md §8 '손으로 처리': 예약은 늦은 쪽이 남는다(검증 2 V12). 대조로 더 이른 예약(지금 + 1분)은 지금 + 16분으로 늦춘다
    const { clock, store, reviews, e1, record } = world();
    const a1 = record({ eventId: e1, accountId: A });
    const b1 = record({ eventId: e1, accountId: B });
    for (const r of [a1, b1]) await store.insertReview(r);
    const TOPIC_W = 'identity.accounts-withdrawn';
    store.heldEvents.push(
      { id: '0190f3a1-7c2e-7a00-8000-0000000d0c02', topic: TOPIC_W, eventKey: null, businessKey: 'unreadable-a', msgKey: A },
      { id: '0190f3a1-7c2e-7a00-8000-0000000d0c03', topic: TOPIC_W, eventKey: null, businessKey: 'unreadable-b', msgKey: B },
    );
    clock.advance(9 * 60_000);
    const NOW = T0 + 9 * 60_000;
    // A는 이미 지금 + 30분인 예약, B는 지금 + 1분인 예약이 있다(둘 다 03:01에 만듦)
    store.rechecks.set(A, { dueAtMs: NOW + 30 * 60_000, createdAtMs: T0 + 60_000 });
    store.rechecks.set(B, { dueAtMs: NOW + 60_000, createdAtMs: T0 + 60_000 });
    const by = { reason: '늦은 쪽 예약 시험(손 처리)', requestedBy: 'ops-choi' };

    expect(await reviews.purgeHeldWithdrawal(A, by)).toMatchObject({ purged: 1, heldEvents: 1 });
    expect(store.rechecks.get(A)).toEqual({ dueAtMs: NOW + 30 * 60_000, createdAtMs: T0 + 60_000 });
    expect(await reviews.purgeHeldWithdrawal(B, by)).toMatchObject({ purged: 1, heldEvents: 1 });
    expect(store.rechecks.get(B)).toEqual({ dueAtMs: NOW + 16 * 60_000, createdAtMs: T0 + 60_000 });
    expect(store.rechecks.size).toBe(2);
  });
});
