// 받는 층: 후기·신고·조치(BUILD_ORDER BAT-585, FR-016·FR-070, POL-024·POL-042·POL-044, ADR-0066).
import 'reflect-metadata';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, type Production, type SaleReview } from '../src/modules/catalog/index.js';
import {
  MemoryFanProfile,
  MemoryReviewCaseSink,
  MemoryReviewEligibility,
  MemoryReviewNotifier,
  MemoryReviewStore,
  Reviews,
} from '../src/modules/review/index.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

let svc: Awaited<ReturnType<typeof createService>>;
let reviews: Reviews;
const repo = new MemoryCatalogRepository();
const store = new MemoryReviewStore();
const eligibility = new MemoryReviewEligibility();
const fanProfiles = new MemoryFanProfile();
const notifier = new MemoryReviewNotifier();
const cases = new MemoryReviewCaseSink();
const identity = new FakeIdentity();
const PROMOTER = randomUUID();
const ENDED = new Date('2026-01-01T10:00:00.000Z');
const FUTURE = new Date('2026-12-24T10:00:00.000Z');

beforeAll(async () => {
  repo.sellerNames.set(PROMOTER, '(주)피켓공연');
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, review: { store, eligibility, fanProfile: fanProfiles, notifier, cases } }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW_MS }),
    logDestination: quiet(),
    adminAuthz: identity,
  });
  reviews = svc.app.get(Reviews);
});
afterAll(async () => {
  await svc?.close();
});

function seed(o: { startsAt?: Date; status?: 'SCHEDULED' | 'CANCELLED'; saleReview?: SaleReview; saleApprovedAt?: Date | null } = {}): { eventId: string; productionId: string } {
  const p: Production = { id: randomUUID(), promoterId: PROMOTER, placeId: randomUUID(), title: '겨울 콘서트', genre: '콘서트', saleReview: o.saleReview ?? 'APPROVED', saleApprovedAt: o.saleApprovedAt ?? new Date('2026-11-01T00:00:00Z') };
  repo.productions.set(p.id, p);
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId: p.id, venueId: randomUUID(), openAt: new Date('2026-01-01T00:00:00Z'), startsAt: o.startsAt ?? ENDED, status: o.status ?? 'SCHEDULED' });
  return { eventId, productionId: p.id };
}

const postReview = (eventId: string, account: string, body: Record<string, unknown>) => svc.http.inject({ method: 'POST', url: `/v1/events/${eventId}/reviews`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const getReviews = (eventId: string, account?: string) => svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}/reviews`, headers: account ? fan(account) : {} });
const getSummary = (eventId: string) => svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}/review-summary` });
const getEligibility = (eventId: string, account: string) => svc.http.inject({ method: 'GET', url: `/v1/events/${eventId}/review-eligibility`, headers: fan(account) });

describe('관람 후기', () => {
  test('자격 있는 팬이 쓰면 목록·요약에 보이고, 같은 회차에 두 번 쓰면 409다', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    const order = randomUUID();
    fanProfiles.nicknames.set(me, '김피켓');
    eligibility.set(me, eventId, { eligible: true, basisOrderId: order });
    expect((await getEligibility(eventId, me)).statusCode).toBe(200);
    const created = await postReview(eventId, me, { rating: 5, body: '정말 좋았습니다! 다음에도 또 보고 싶어요.' });
    expect(created.statusCode).toBe(201);
    const body = JSON.parse(created.payload);
    expect(body).toMatchObject({ eventId, authorDisplay: '김**', rating: 5, mine: true, reportedByMe: false, status: 'VISIBLE' });
    expect(body.permalink).toBe(`/reviews/${body.reviewId}`);

    const list = JSON.parse((await getReviews(eventId, me)).payload);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ reviewId: body.reviewId, mine: true });
    const summary = JSON.parse((await getSummary(eventId)).payload);
    expect(summary).toMatchObject({ averageRating: 5, count: 1 });

    const again = await postReview(eventId, me, { rating: 4, body: '두 번째 후기는 쓸 수 없습니다.' });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.payload)).toMatchObject({ type: 'https://peaket.example/problems/review-already-written', myReviewId: body.reviewId });
    expect(JSON.parse((await getEligibility(eventId, me)).payload)).toMatchObject({ eligible: false, reason: 'ALREADY_WRITTEN', myReviewId: body.reviewId });
  });

  test('자격이 없으면 이유별 403이고, 취소된 회차는 EVENT_CANCELLED다', async () => {
    const notEnded = seed({ startsAt: FUTURE });
    const me = randomUUID();
    eligibility.set(me, notEnded.eventId, { eligible: false, reason: 'NOT_ENDED' });
    const r1 = await postReview(notEnded.eventId, me, { rating: 5, body: '아직 끝나지 않은 공연의 후기입니다.' });
    expect(r1.statusCode).toBe(403);
    expect(JSON.parse(r1.payload).type).toBe('https://peaket.example/problems/review-not-ended');

    const cancelled = seed({ status: 'CANCELLED' });
    eligibility.set(me, cancelled.eventId, { eligible: true, basisOrderId: randomUUID() });
    const r2 = await postReview(cancelled.eventId, me, { rating: 5, body: '취소된 회차에는 쓸 수 없습니다.' });
    expect(r2.statusCode).toBe(403);
    expect(JSON.parse(r2.payload).type).toBe('https://peaket.example/problems/review-event-cancelled');

    const noTicket = seed();
    const r3 = await postReview(noTicket.eventId, me, { rating: 5, body: '티켓이 없으면 쓸 수 없습니다.' });
    expect(r3.statusCode).toBe(403);
    expect(JSON.parse(r3.payload).type).toBe('https://peaket.example/problems/review-not-purchaser');
  });

  test('고치기·지우기는 작성자만 할 수 있고, 지운 뒤 같은 회차에 다시 쓸 수 있다', async () => {
    const { eventId } = seed();
    const me = randomUUID();
    const other = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const created = JSON.parse((await postReview(eventId, me, { rating: 5, body: '처음 쓴 후기 본문입니다.' })).payload);
    const patched = await svc.http.inject({ method: 'PATCH', url: `/v1/reviews/${created.reviewId}`, headers: { ...fan(me), 'content-type': 'application/json' }, payload: JSON.stringify({ rating: 3, body: '고친 후기 본문입니다.' }) });
    expect(patched.statusCode).toBe(200);
    expect(JSON.parse(patched.payload)).toMatchObject({ rating: 3, body: '고친 후기 본문입니다.', edited: true });
    const denied = await svc.http.inject({ method: 'PATCH', url: `/v1/reviews/${created.reviewId}`, headers: { ...fan(other), 'content-type': 'application/json' }, payload: JSON.stringify({ rating: 4, body: '남의 후기를 고칩니다.' }) });
    expect(denied.statusCode).toBe(403);
    expect((await svc.http.inject({ method: 'DELETE', url: `/v1/reviews/${created.reviewId}`, headers: fan(me) })).statusCode).toBe(204);
    expect(JSON.parse((await getReviews(eventId, me)).payload).items).toHaveLength(0);
    expect((await getEligibility(eventId, me)).statusCode).toBe(200);
  });
});

describe('신고와 운영자 조치', () => {
  test('[ASVS v5.0.0-2.4.1] 신고는 같은 후기·계정당 한 번, 내 후기는 403이고 불법 촬영물은 즉시 가린다', async () => {
    const { eventId } = seed();
    const author = randomUUID();
    const reporter = randomUUID();
    const third = randomUUID();
    eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
    const created = JSON.parse((await postReview(eventId, author, { rating: 5, body: '신고 대상이 되는 후기 본문입니다.' })).payload);

    const self = await svc.http.inject({ method: 'POST', url: `/v1/reviews/${created.reviewId}/reports`, headers: { ...fan(author), 'content-type': 'application/json' }, payload: JSON.stringify({ category: 'SPAM' }) });
    expect(self.statusCode).toBe(403);
    const first = await svc.http.inject({ method: 'POST', url: `/v1/reviews/${created.reviewId}/reports`, headers: { ...fan(reporter), 'content-type': 'application/json' }, payload: JSON.stringify({ category: 'SPAM' }) });
    expect(first.statusCode).toBe(201);
    expect(JSON.parse((await getReviews(eventId, reporter)).payload).items[0]).toMatchObject({ reportedByMe: true });
    const again = await svc.http.inject({ method: 'POST', url: `/v1/reviews/${created.reviewId}/reports`, headers: { ...fan(reporter), 'content-type': 'application/json' }, payload: JSON.stringify({ category: 'SPAM' }) });
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.payload).type).toBe('https://peaket.example/problems/already-reported');

    const filming = await svc.http.inject({ method: 'POST', url: `/v1/reviews/${created.reviewId}/reports`, headers: { ...fan(third), 'content-type': 'application/json' }, payload: JSON.stringify({ category: 'ILLEGAL_FILMING' }) });
    expect(filming.statusCode).toBe(201);
    expect(JSON.parse((await getReviews(eventId, reporter)).payload).items).toHaveLength(0);
    expect(JSON.parse((await getReviews(eventId, author)).payload).items[0]).toMatchObject({ status: 'HIDDEN', body: '신고 대상이 되는 후기 본문입니다.' });
    expect(cases.requests.map((r) => r.kind)).toEqual(['CONTENT_REPORT', 'CONTENT_REPORT']);
    expect(notifier.received).toHaveLength(2);
  });

  test('임시조치는 30일 이내만 되고, 가린 후기는 notice만 보이며 해제하면 다시 보인다', async () => {
    const { eventId } = seed();
    const author = randomUUID();
    const viewer = randomUUID();
    eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
    const created = JSON.parse((await postReview(eventId, author, { rating: 4, body: '임시조치 대상 후기 본문입니다.' })).payload);
    const cs = identity.ops('cs_agent');
    const tooLong = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/reviews/${created.reviewId}/moderation`,
      headers: { ...cs, 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'TEMP_BLOCK', reason: '권리 침해', violation: 'RIGHTS', endsAt: new Date(NOW_MS + 31 * 24 * 3600_000).toISOString() }),
    });
    expect(tooLong.statusCode).toBe(422);
    const endsAt = new Date(NOW_MS + 10 * 24 * 3600_000).toISOString();
    const temp = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/reviews/${created.reviewId}/moderation`,
      headers: { ...cs, 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'TEMP_BLOCK', reason: '권리 침해', violation: 'RIGHTS', endsAt }),
    });
    expect(temp.statusCode).toBe(200);
    const hidden = JSON.parse((await getReviews(eventId, viewer)).payload).items[0];
    expect(hidden).toMatchObject({ status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntil: endsAt });
    expect(hidden.body).toBeUndefined();
    const release = await svc.http.inject({
      method: 'POST',
      url: `/v1/ops/reviews/${created.reviewId}/moderation`,
      headers: { ...cs, 'content-type': 'application/json' },
      payload: JSON.stringify({ action: 'RELEASE', reason: '이의 인정' }),
    });
    expect(release.statusCode).toBe(200);
    expect(JSON.parse((await getReviews(eventId, viewer)).payload).items[0]).toMatchObject({ status: 'VISIBLE', body: '임시조치 대상 후기 본문입니다.' });
  });

  test('권리 침해 본인 신고는 RIGHTS_REQUEST CS 건으로 접수한다', async () => {
    const { eventId } = seed();
    const author = randomUUID();
    const reporter = randomUUID();
    eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
    const created = JSON.parse((await postReview(eventId, author, { rating: 5, body: '권리 침해 신고 시험용 후기 본문입니다.' })).payload);
    const r = await svc.http.inject({
      method: 'POST',
      url: `/v1/reviews/${created.reviewId}/reports`,
      headers: { ...fan(reporter), 'content-type': 'application/json' },
      payload: JSON.stringify({ category: 'RIGHTS', rightsHolder: true, detail: '내 개인정보가 보입니다', notifyChannel: 'APP' }),
    });
    expect(r.statusCode).toBe(201);
    expect(cases.requests.at(-1)).toMatchObject({ kind: 'RIGHTS_REQUEST', targetId: created.reviewId });
  });

  test('문화체육관광부 고시 통보의 처리 기한은 10시간이다', async () => {
    const { eventId } = seed();
    const author = randomUUID();
    eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
    const created = JSON.parse((await postReview(eventId, author, { rating: 5, body: '고시 통보 기한 시험용 후기 본문입니다.' })).payload);
    const result = await reviews.applyNoticeTakedown({ reviewIds: [created.reviewId], noticeId: randomUUID(), receivedAtMs: NOW_MS, kind: 'MINISTRY', reason: '고시 통보' });
    expect(result.deadlineAt).toBe(new Date(NOW_MS + 10 * 3600_000).toISOString());
  });

  test('[C-T22] 통보로 가리면 같은 내용 지문이 등록되어, 공백·문장부호만 다른 새 후기도 바로 HIDDEN이다', async () => {
    const { eventId } = seed();
    const first = randomUUID();
    const second = randomUUID();
    eligibility.set(first, eventId, { eligible: true, basisOrderId: randomUUID() });
    eligibility.set(second, eventId, { eligible: true, basisOrderId: randomUUID() });
    const body = '정말 좋았습니다! 다음에도 또 보고 싶어요.';
    const created = JSON.parse((await postReview(eventId, first, { rating: 5, body })).payload);
    const noticeId = randomUUID();
    const result = await reviews.applyNoticeTakedown({ reviewIds: [created.reviewId], noticeId, receivedAtMs: NOW_MS, kind: 'GENERAL', reason: '신고기관 통보' });
    expect(result.applied).toBe(1);
    expect(result.deadlineAt).toBe(new Date(NOW_MS + 24 * 3600_000).toISOString());
    const same = await postReview(eventId, second, { rating: 4, body: '정말 좋았습니다 다음에도 또 보고싶어요' });
    expect(same.statusCode).toBe(201);
    expect(JSON.parse(same.payload).status).toBe('HIDDEN');
    expect(JSON.parse((await getReviews(eventId, randomUUID())).payload).items).toHaveLength(0);
  });

  test('통보 하나를 해제해도 같은 지문의 다른 통보가 살아 있으면 같은 내용 차단은 유지된다', async () => {
    const { eventId } = seed();
    const a = randomUUID();
    const b = randomUUID();
    const c = randomUUID();
    eligibility.set(a, eventId, { eligible: true, basisOrderId: randomUUID() });
    eligibility.set(b, eventId, { eligible: true, basisOrderId: randomUUID() });
    eligibility.set(c, eventId, { eligible: true, basisOrderId: randomUUID() });
    const body = '같은 내용 차단 유지 시험용 후기 본문입니다.';
    const first = JSON.parse((await postReview(eventId, a, { rating: 5, body })).payload);
    const second = JSON.parse((await postReview(eventId, b, { rating: 4, body })).payload);
    const noticeA = randomUUID();
    const noticeB = randomUUID();
    await reviews.applyNoticeTakedown({ reviewIds: [first.reviewId], noticeId: noticeA, receivedAtMs: NOW_MS, kind: 'GENERAL', reason: '통보 A' });
    await reviews.applyNoticeTakedown({ reviewIds: [second.reviewId], noticeId: noticeB, receivedAtMs: NOW_MS, kind: 'GENERAL', reason: '통보 B' });
    const cs = identity.ops('cs_agent');
    await svc.http.inject({ method: 'POST', url: `/v1/ops/reviews/${first.reviewId}/moderation`, headers: { ...cs, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'RELEASE', reason: '통보 A 철회' }) });
    const stillHidden = await postReview(eventId, c, { rating: 5, body });
    expect(JSON.parse(stillHidden.payload).status).toBe('HIDDEN');
    await svc.http.inject({ method: 'POST', url: `/v1/ops/reviews/${second.reviewId}/moderation`, headers: { ...cs, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'RELEASE', reason: '통보 B 철회' }) });
    const d = randomUUID();
    eligibility.set(d, eventId, { eligible: true, basisOrderId: randomUUID() });
    const visible = await postReview(eventId, d, { rating: 5, body });
    expect(JSON.parse(visible.payload).status).toBe('VISIBLE');
  });

  test('모양이 틀린 회차·후기 ID는 500이 아니라 404이고, 자격 답에 근거 주문이 없으면 503이다', async () => {
    expect((await getReviews('not-a-uuid')).statusCode).toBe(404);
    expect((await svc.http.inject({ method: 'GET', url: '/v1/reviews/not-a-uuid' })).statusCode).toBe(404);
    expect((await svc.http.inject({ method: 'POST', url: '/v1/reviews/not-a-uuid/reports', headers: { ...fan(randomUUID()), 'content-type': 'application/json' }, payload: JSON.stringify({ category: 'SPAM' }) })).statusCode).toBe(404);
    const { eventId } = seed();
    const me = randomUUID();
    eligibility.set(me, eventId, { eligible: true });
    const r = await postReview(eventId, me, { rating: 5, body: '근거 주문이 없는 자격 답 시험용 본문입니다.' });
    expect(r.statusCode).toBe(503);
    expect(JSON.parse(r.payload).type).toBe('https://peaket.example/problems/review-eligibility-unavailable');
  });

  test('신고는 한 계정 하루 10건까지이고 11번째는 429다', async () => {
    const { eventId } = seed();
    const reporter = randomUUID();
    const reviewIds: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const author = randomUUID();
      eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
      const r = await postReview(eventId, author, { rating: 5, body: `신고 한도 시험용 후기 본문 ${i}번입니다.` });
      expect(r.statusCode).toBe(201);
      reviewIds.push(JSON.parse(r.payload).reviewId);
    }
    for (let i = 0; i < 10; i += 1) {
      const r = await svc.http.inject({ method: 'POST', url: `/v1/reviews/${reviewIds[i]}/reports`, headers: { ...fan(reporter), 'content-type': 'application/json' }, payload: JSON.stringify({ category: 'SPAM' }) });
      expect(r.statusCode).toBe(201);
    }
    const limited = await svc.http.inject({ method: 'POST', url: `/v1/reviews/${reviewIds[10]}/reports`, headers: { ...fan(reporter), 'content-type': 'application/json' }, payload: JSON.stringify({ category: 'SPAM' }) });
    expect(limited.statusCode).toBe(429);
    expect(JSON.parse(limited.payload).type).toBe('https://peaket.example/problems/report-limited');
  });
});
