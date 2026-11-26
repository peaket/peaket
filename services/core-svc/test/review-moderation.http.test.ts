// 운영자 후기 조치의 규칙(POL-044 ③, openapi /v1/ops/reviews/{reviewId}/moderation, F-07-10).
// 신고가 있는 후기만, 통보·같은 내용으로 가린 후기는 법정 통보 경로로만, RELEASE는 가린 후기만 받는다.
// 조치·조치 기록·신고 완료는 저장소의 moderate 한 번으로 넘긴다(한 트랜잭션). 같은 조치는 다시 저장하지 않는다.
// 기준 트리에서는 신고 없는 후기·가리지 않은 후기의 해제도 200이라 새 시험이 실패한다.
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

class SpyReviewStore extends MemoryReviewStore {
  readonly moderated: { reviewId: string; effect: Parameters<MemoryReviewStore['moderate']>[1] }[] = [];
  override async moderate(reviewId: string, effect: Parameters<MemoryReviewStore['moderate']>[1]): Promise<void> {
    this.moderated.push({ reviewId, effect });
    return super.moderate(reviewId, effect);
  }
}

let svc: Awaited<ReturnType<typeof createService>>;
let reviews: Reviews;
const repo = new MemoryCatalogRepository();
const store = new SpyReviewStore();
const eligibility = new MemoryReviewEligibility();
const fanProfiles = new MemoryFanProfile();
const notifier = new MemoryReviewNotifier();
const cases = new MemoryReviewCaseSink();
const identity = new FakeIdentity();
const clock = fakeClock({ now: NOW_MS });
const PROMOTER = randomUUID();
const DAY = 24 * 60 * 60 * 1000;

beforeAll(async () => {
  repo.sellerNames.set(PROMOTER, '(주)피켓공연');
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, review: { store, eligibility, fanProfile: fanProfiles, notifier, cases } }),
    env: { PEAKET_ENV: 'ci' },
    clock,
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
  repo.events.set(eventId, { id: eventId, productionId: p.id, venueId: randomUUID(), openAt: new Date('2026-01-01T00:00:00Z'), startsAt: o.startsAt ?? new Date('2026-01-01T10:00:00Z'), status: o.status ?? 'SCHEDULED' });
  return { eventId, productionId: p.id };
}

const postReview = (eventId: string, account: string, body: string) =>
  svc.http.inject({ method: 'POST', url: `/v1/events/${eventId}/reviews`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify({ rating: 5, body }) });
const report = (reviewId: string, account: string, category: string) =>
  svc.http.inject({ method: 'POST', url: `/v1/reviews/${reviewId}/reports`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify({ category }) });
const moderate = (reviewId: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/v1/ops/reviews/${reviewId}/moderation`, headers: { ...identity.ops('cs_agent'), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const opsDetail = (reviewId: string) => svc.http.inject({ method: 'GET', url: `/v1/ops/reviews/${reviewId}`, headers: identity.ops('cs_agent') });

async function createAndReport(): Promise<{ eventId: string; reviewId: string; author: string; reporter: string }> {
  const { eventId } = seed();
  const author = randomUUID();
  const reporter = randomUUID();
  eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
  const created = await postReview(eventId, author, '운영자 조치 시험에 쓰는 후기 본문입니다.');
  expect(created.statusCode).toBe(201);
  const reviewId = JSON.parse(created.payload).reviewId;
  expect((await report(reviewId, reporter, 'SPAM')).statusCode).toBe(201);
  return { eventId, reviewId, author, reporter };
}

describe('운영자 후기 조치의 409', () => {
  test('OPS-02 [ASVS v5.0.0-2.3.3] 신고가 없는 후기, 가리지 않은 후기의 해제, 통보·같은 내용으로 가린 후기는 409다', async () => {
    const { eventId } = seed();
    const author = randomUUID();
    const other = randomUUID();
    eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
    eligibility.set(other, eventId, { eligible: true, basisOrderId: randomUUID() });
    const body = '통보와 같은 내용으로 가리는지 보는 후기 본문입니다.';
    const created = JSON.parse((await postReview(eventId, author, body)).payload);

    const noReport = await moderate(created.reviewId, { action: 'NO_ACTION', reason: '신고가 아직 없음' });
    expect(noReport.statusCode).toBe(409);
    expect(JSON.parse(noReport.payload).type).toBe('https://peaket.example/problems/review-no-reports');

    expect((await report(created.reviewId, other, 'SPAM')).statusCode).toBe(201);
    const releaseVisible = await moderate(created.reviewId, { action: 'RELEASE', reason: '가리지 않은 후기' });
    expect(releaseVisible.statusCode).toBe(409);
    expect(JSON.parse(releaseVisible.payload).type).toBe('https://peaket.example/problems/review-not-hidden');

    const noticeId = randomUUID();
    expect((await reviews.applyNoticeTakedown({ reviewIds: [created.reviewId], noticeId, receivedAtMs: clock.now(), kind: 'GENERAL', reason: '법정 통보' })).applied).toBe(1);
    const noticeHidden = await moderate(created.reviewId, { action: 'BLOCK', reason: '통보로 가린 후기', violation: 'ABUSE' });
    expect(noticeHidden.statusCode).toBe(409);
    expect(JSON.parse(noticeHidden.payload).type).toBe('https://peaket.example/problems/review-not-moderation-target');

    // 통보로 등록한 지문과 같은 내용(공백·문장부호 차이)은 새 후기도 바로 HIDDEN이다(C-T22). 그 후기도 이 경로로 바꾸지 못한다.
    const same = await postReview(eventId, other, '통보와 같은 내용으로 가리는지 보는 후기 본문입니다');
    expect(same.statusCode).toBe(201);
    expect(JSON.parse(same.payload).status).toBe('HIDDEN');
    const sameHidden = await moderate(JSON.parse(same.payload).reviewId, { action: 'NO_ACTION', reason: '같은 내용으로 가림' });
    expect(sameHidden.statusCode).toBe(409);
    expect(JSON.parse(sameHidden.payload).type).toBe('https://peaket.example/problems/review-not-moderation-target');
  });
});

describe('운영자 후기 조치의 효과와 경계', () => {
  test('OPS-03 [ASVS v5.0.0-2.3.2][ASVS v5.0.0-2.3.3] 임시조치는 위반 사유와 30일 이내 끝 시각이 필요하고, 상태·조치 기록·신고 완료를 한 번에 바꾼다', async () => {
    const { reviewId, reporter } = await createAndReport();
    const before = store.moderated.length;

    expect((await moderate(reviewId, { action: 'TEMP_BLOCK', reason: '임시조치', endsAt: new Date(clock.now() + 7 * DAY).toISOString() })).statusCode).toBe(422);
    expect((await moderate(reviewId, { action: 'TEMP_BLOCK', reason: '임시조치', violation: 'ABUSE', endsAt: new Date(clock.now() - 1).toISOString() })).statusCode).toBe(422);
    expect((await moderate(reviewId, { action: 'TEMP_BLOCK', reason: '임시조치', violation: 'ABUSE', endsAt: new Date(clock.now() + 30 * DAY + 1).toISOString() })).statusCode).toBe(422);
    expect((await moderate(reviewId, { action: 'TEMP_BLOCK', reason: '', violation: 'ABUSE', endsAt: new Date(clock.now() + DAY).toISOString() })).statusCode).toBe(400);
    expect((await moderate(reviewId, { action: 'BLOCK', reason: '위반 사유 없음' })).statusCode).toBe(422);

    const endsAt = new Date(clock.now() + 30 * DAY).toISOString();
    const ok = await moderate(reviewId, { action: 'TEMP_BLOCK', reason: '권리 침해 임시조치', violation: 'ABUSE', endsAt });
    expect(ok.statusCode).toBe(200);
    expect(store.moderated).toHaveLength(before + 1);
    const effect = store.moderated[before]!.effect;
    expect(effect.status).toBe('HIDDEN');
    expect(effect.notice).toBe('RIGHTS_TEMP');
    expect(effect.noticeUntilMs).toBe(Date.parse(endsAt));
    expect(effect.takedown?.reason).toBe('RIGHTS_TEMP');
    expect(effect.outcome).toBe('TEMP_BLOCKED');

    const detail = JSON.parse((await opsDetail(reviewId)).payload);
    expect(detail.review).toMatchObject({ status: 'HIDDEN', notice: 'RIGHTS_TEMP', noticeUntil: endsAt });
    const reports = await store.reportsByTarget(reviewId);
    expect(reports.every((r) => r.status === 'RESOLVED' && r.outcome === 'TEMP_BLOCKED')).toBe(true);
    expect((await store.takedownsByReview(reviewId)).filter((t) => t.reason === 'RIGHTS_TEMP')).toHaveLength(1);

    // 같은 조치를 다시 보내면 새 기록 없이 지금 상태를 돌려준다
    expect((await moderate(reviewId, { action: 'TEMP_BLOCK', reason: '권리 침해 임시조치', violation: 'ABUSE', endsAt })).statusCode).toBe(200);
    expect(store.moderated).toHaveLength(before + 1);
    expect((await store.takedownsByReview(reviewId)).filter((t) => t.reason === 'RIGHTS_TEMP')).toHaveLength(1);

    const released = await moderate(reviewId, { action: 'RELEASE', reason: '조치 해제' });
    expect(released.statusCode).toBe(200);
    expect((await store.findReview(reviewId))?.status).toBe('VISIBLE');
    expect((await store.takedownsByReview(reviewId)).every((t) => t.restoredAtMs !== undefined)).toBe(true);

    const blocked = await moderate(reviewId, { action: 'BLOCK', reason: '운영정책 위반', violation: 'SPAM' });
    expect(blocked.statusCode).toBe(200);
    expect((await store.findReview(reviewId))?.status).toBe('HIDDEN');
    expect((await store.findReview(reviewId))?.notice).toBe('POLICY');
    expect((await store.reportsByTarget(reviewId)).some((r) => r.targetId === reviewId && r.outcome === 'BLOCKED' && r.status === 'RESOLVED')).toBe(true);
    expect(reporter).toMatch(/^[0-9a-f-]{36}$/);
  });

  test('OPS-04 [ASVS v5.0.0-2.3.3] 조치 없음은 후기 상태를 바꾸지 않고 신고만 처리 완료하며, 사유 2,001자는 받지 않는다', async () => {
    const { reviewId } = await createAndReport();
    const before = store.moderated.length;
    const noAction = await moderate(reviewId, { action: 'NO_ACTION', reason: '운영정책 위반 없음' });
    expect(noAction.statusCode).toBe(200);
    expect(store.moderated).toHaveLength(before + 1);
    expect(store.moderated[before]!.effect.status).toBeUndefined();
    expect(store.moderated[before]!.effect.takedown).toBeUndefined();
    expect(store.moderated[before]!.effect.outcome).toBe('NO_ACTION');
    expect((await store.findReview(reviewId))?.status).toBe('VISIBLE');
    expect((await store.reportsByTarget(reviewId)).every((r) => r.status === 'RESOLVED' && r.outcome === 'NO_ACTION')).toBe(true);

    // 같은 조치를 다시 보내면 새 조치 기록 없이 지금 상태를 돌려준다
    expect((await moderate(reviewId, { action: 'NO_ACTION', reason: '운영정책 위반 없음' })).statusCode).toBe(200);
    expect(store.moderated).toHaveLength(before + 1);

    const tooLong = await moderate(reviewId, { action: 'NO_ACTION', reason: '가'.repeat(2001) });
    expect(tooLong.statusCode).toBe(400);
  });
});
