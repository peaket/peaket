// 신고 기록 보관 정리(F-07-11, LCH-160, POL-044 ②, docs/data.md §2 content_report·§5.1 '후기 파기').
// 정본: content_report.purge_at은 '처리 뒤 1년 [가정]'이다(1924행). 처리 전 신고는 지우지 않는다(2929행).
// 정비 작업 review-report-retention이 status='RESOLVED'이고 purge_at <= 지금인 행만 지운다. 경계는 365일−1ms·365일·365일+1ms.
// 이 시험은 구현 전 트리에서 정비 작업 이름이 없어 실패한다(모듈 import 실패가 아니다).
import 'reflect-metadata';
import { createService, fakeClock, type FakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, type Production } from '../src/modules/catalog/index.js';
import { MemoryFanProfile, MemoryReviewCaseSink, MemoryReviewEligibility, MemoryReviewNotifier, MemoryReviewStore, reviewMaintenanceTasks } from '../src/modules/review/index.js';
import { FakeIdentity, fan, NOW_MS, quiet } from './support.js';

const DAY = 24 * 60 * 60 * 1000;
const YEAR = 365 * DAY;
const HOUR = 60 * 60 * 1000;
const PROMOTER = randomUUID();
const ENDED = new Date('2026-01-01T10:00:00.000Z');

let svc: Awaited<ReturnType<typeof createService>>;
let clock: FakeClock;
let store: MemoryReviewStore;
let eligibility: MemoryReviewEligibility;
const repo = new MemoryCatalogRepository();
const identity = new FakeIdentity();

beforeEach(async () => {
  repo.productions.clear();
  repo.events.clear();
  repo.sellerNames.set(PROMOTER, '(주)피켓공연');
  store = new MemoryReviewStore();
  eligibility = new MemoryReviewEligibility();
  clock = fakeClock({ now: NOW_MS });
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({
      memory: true,
      catalog: repo,
      review: { store, eligibility, fanProfile: new MemoryFanProfile(), notifier: new MemoryReviewNotifier(), cases: new MemoryReviewCaseSink() },
    }),
    env: { PEAKET_ENV: 'ci' },
    clock,
    logDestination: quiet(),
    adminAuthz: identity,
  });
});
afterEach(async () => {
  await svc?.close();
});

function seedEvent(): string {
  const p: Production = { id: randomUUID(), promoterId: PROMOTER, placeId: randomUUID(), title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') };
  repo.productions.set(p.id, p);
  const eventId = randomUUID();
  repo.events.set(eventId, { id: eventId, productionId: p.id, venueId: randomUUID(), openAt: new Date('2026-01-01T00:00:00Z'), startsAt: ENDED, status: 'SCHEDULED' });
  return eventId;
}

async function reviewAndReport(eventId: string): Promise<{ reviewId: string; reportId: string }> {
  const author = randomUUID();
  const reporter = randomUUID();
  eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
  const created = await svc.http.inject({
    method: 'POST',
    url: `/v1/events/${eventId}/reviews`,
    headers: { ...fan(author), 'content-type': 'application/json' },
    payload: JSON.stringify({ rating: 5, body: '보관 정리 시험용 후기 본문입니다.' }),
  });
  expect(created.statusCode).toBe(201);
  const reviewId = (JSON.parse(created.payload) as { reviewId: string }).reviewId;
  const reported = await svc.http.inject({
    method: 'POST',
    url: `/v1/reviews/${reviewId}/reports`,
    headers: { ...fan(reporter), 'content-type': 'application/json' },
    payload: JSON.stringify({ category: 'SPAM' }),
  });
  expect(reported.statusCode).toBe(201);
  return { reviewId, reportId: (JSON.parse(reported.payload) as { reportId: string }).reportId };
}

async function resolveReview(reviewId: string): Promise<void> {
  const r = await svc.http.inject({
    method: 'POST',
    url: `/v1/ops/reviews/${reviewId}/moderation`,
    headers: { ...identity.ops('cs_agent'), 'content-type': 'application/json' },
    payload: JSON.stringify({ action: 'NO_ACTION', reason: '운영정책 위반 없음' }),
  });
  expect(r.statusCode).toBe(200);
}

const retentionTask = () => reviewMaintenanceTasks(store, clock).find((t) => t.name === 'review-report-retention');

describe('신고 기록 보관 정리', () => {
  test('RET-01 [ASVS v5.0.0-2.3.3] 신고를 처리하면 보관 끝이 처리 시각 + 1년으로 다시 잡힌다', async () => {
    const eventId = seedEvent();
    const { reviewId } = await reviewAndReport(eventId);
    clock.advance(HOUR);
    await resolveReview(reviewId);
    const rows = await store.reportsByTarget(reviewId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'RESOLVED', resolvedAtMs: NOW_MS + HOUR, purgeAtMs: NOW_MS + HOUR + YEAR });
  });

  test('RET-02 [ASVS v5.0.0-2.3.3] 보관 끝 365일−1ms에는 남고 365일에는 지운다', async () => {
    const eventId = seedEvent();
    const { reviewId } = await reviewAndReport(eventId);
    clock.advance(HOUR);
    await resolveReview(reviewId);
    const task = retentionTask();
    expect(task).toBeDefined();

    clock.advance(YEAR - 1);
    await task!.run();
    expect(await store.reportsByTarget(reviewId)).toHaveLength(1);

    clock.advance(1);
    await task!.run();
    expect(await store.reportsByTarget(reviewId)).toHaveLength(0);
  });

  test('RET-03 처리 전 신고와 아직 1년이 안 된 신고는 지우지 않는다', async () => {
    const eventId = seedEvent();
    const resolved = await reviewAndReport(eventId);
    const unresolved = await reviewAndReport(eventId);
    clock.advance(HOUR);
    await resolveReview(resolved.reviewId);
    const task = retentionTask();
    expect(task).toBeDefined();

    clock.advance(YEAR - 1);
    await task!.run();
    expect(await store.reportsByTarget(resolved.reviewId)).toHaveLength(1);
    expect(await store.reportsByTarget(unresolved.reviewId)).toHaveLength(1);

    clock.advance(1);
    await task!.run();
    expect(await store.reportsByTarget(resolved.reviewId)).toHaveLength(0);
    expect(await store.reportsByTarget(unresolved.reviewId)).toHaveLength(1);
  });

  test('RET-04 같은 정리를 다시 돌려도 결과가 같다', async () => {
    const eventId = seedEvent();
    const { reviewId } = await reviewAndReport(eventId);
    clock.advance(HOUR);
    await resolveReview(reviewId);
    const task = retentionTask();
    expect(task).toBeDefined();
    clock.advance(YEAR);
    await task!.run();
    await task!.run();
    expect(await store.reportsByTarget(reviewId)).toHaveLength(0);
  });
});
