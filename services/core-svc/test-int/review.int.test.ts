// review 실제 PostgreSQL 통합 시험(BUILD_ORDER BAT-585, LCH-150·LCH-160).
// 0013_review.sql 적용, 후기 한 회차 하나·신고 한도·같은 내용 지문·조치 트랜잭션·동시 신고를 실제 DB에서 본다.
import 'reflect-metadata';
import { createDatabase, createService, ensureOutboxPartitions, systemClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import {
  MemoryFanProfile,
  MemoryReviewCaseSink,
  MemoryReviewEligibility,
  MemoryReviewNotifier,
  Reviews,
} from '../src/modules/review/index.js';
import { FakeIdentity, fan, quiet, testMedia } from '../test/support.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
let svc: Awaited<ReturnType<typeof createService>>;
let reviews: Reviews;
const identity = new FakeIdentity();
const eligibility = new MemoryReviewEligibility();
const fanProfiles = new MemoryFanProfile();
const notifier = new MemoryReviewNotifier();
const cases = new MemoryReviewCaseSink();
const ACTOR = randomUUID();

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'core-svc-review-int', max: 8 });
  await ensureOutboxPartitions(database, systemClock);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({
      database,
      partnerDatabase: database,
      media: testMedia(),
      review: { eligibility, fanProfile: fanProfiles, notifier, cases },
    }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: quiet(),
    adminAuthz: identity,
  });
  reviews = svc.app.get(Reviews);
});
afterAll(async () => {
  await svc?.close();
  await database?.close();
  pg?.stop();
});

async function seed(): Promise<{ productionId: string; eventId: string }> {
  const promoterId = randomUUID();
  const placeId = randomUUID();
  const productionId = randomUUID();
  const eventId = randomUUID();
  await database.db.insert(promoter).values({ id: promoterId, legalName: '(주)피켓공연' });
  await database.db.insert(place).values({ id: placeId, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: ACTOR });
  await database.db.insert(production).values({ id: productionId, promoterId, placeId, title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') });
  await database.db.insert(event).values({ id: eventId, productionId, promoterId, venueId: null, openAt: new Date('2026-01-01T00:00:00Z'), startsAt: new Date('2026-01-01T10:00:00Z'), endsAt: new Date('2026-01-01T12:30:00Z') });
  return { productionId, eventId };
}

const postReview = (eventId: string, account: string, body: Record<string, unknown>) => svc.http.inject({ method: 'POST', url: `/v1/events/${eventId}/reviews`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify(body) });
const report = (reviewId: string, account: string) => svc.http.inject({ method: 'POST', url: `/v1/reviews/${reviewId}/reports`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify({ category: 'SPAM' }) });

describe('review PostgreSQL [BAT-585]', () => {
  test('0013_review.sql이 네 표와 부분 유일 인덱스를 만든다', async () => {
    const tables = await database.pool.query("select table_name from information_schema.tables where table_schema = 'public' and table_name in ('review','content_report','takedown_action','review_hidden_fingerprint') order by table_name");
    expect(tables.rows.map((r) => r.table_name)).toEqual(['content_report', 'review', 'review_hidden_fingerprint', 'takedown_action']);
    const idx = await database.pool.query("select indexname, indexdef from pg_indexes where schemaname = 'public' and tablename = 'review' and indexname = 'review_event_account_uq'");
    expect(idx.rows[0].indexdef).toContain("status");
  });

  test('같은 계정이 같은 회차에 동시에 두 번 쓰면 하나만 저장되고 다른 하나는 409다', async () => {
    const { eventId } = await seed();
    const me = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const body = { rating: 5, body: '동시에 두 번 써도 한 번만 저장되는 후기 본문입니다.' };
    const results = await Promise.all([postReview(eventId, me, body), postReview(eventId, me, body)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const rows = await database.pool.query('select count(*)::int as n from review where event_id = $1 and account_id = $2', [eventId, me]);
    expect(rows.rows[0].n).toBe(1);
  });

  test('신고는 한 계정 하루 10건까지이고 11번째는 429다', async () => {
    const { eventId } = await seed();
    const reporter = randomUUID();
    const reviewIds: string[] = [];
    for (let i = 0; i < 11; i += 1) {
      const author = randomUUID();
      eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
      const r = await postReview(eventId, author, { rating: 5, body: `신고 한도 시험용 후기 본문 ${i}번입니다.` });
      expect(r.statusCode).toBe(201);
      reviewIds.push(JSON.parse(r.payload).reviewId);
    }
    for (let i = 0; i < 10; i += 1) expect((await report(reviewIds[i]!, reporter)).statusCode).toBe(201);
    const limited = await report(reviewIds[10]!, reporter);
    expect(limited.statusCode).toBe(429);
    expect(JSON.parse(limited.payload).type).toBe('https://peaket.example/problems/report-limited');
  });

  test('같은 신고를 동시에 보내면 하나만 저장되고 다른 하나는 409다', async () => {
    const { eventId } = await seed();
    const author = randomUUID();
    const reporter = randomUUID();
    eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
    const created = JSON.parse((await postReview(eventId, author, { rating: 5, body: '동시 신고 시험용 후기 본문입니다.' })).payload);
    const results = await Promise.all([report(created.reviewId, reporter), report(created.reviewId, reporter)]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    const rows = await database.pool.query('select count(*)::int as n from content_report where target_id = $1 and reporter_account_id = $2', [created.reviewId, reporter]);
    expect(rows.rows[0].n).toBe(1);
  });

  test('통보로 가린 같은 내용 지문은 새 후기를 바로 HIDDEN으로 만들고, 조치와 신고 처리는 한 트랜잭션으로 남는다', async () => {
    const { eventId } = await seed();
    const first = randomUUID();
    const second = randomUUID();
    eligibility.set(first, eventId, { eligible: true, basisOrderId: randomUUID() });
    eligibility.set(second, eventId, { eligible: true, basisOrderId: randomUUID() });
    const body = '정말 좋았습니다! 다음에도 또 보고 싶어요.';
    const created = JSON.parse((await postReview(eventId, first, { rating: 5, body })).payload);
    const noticeId = randomUUID();
    await reviews.applyNoticeTakedown({ reviewIds: [created.reviewId], noticeId, receivedAtMs: Date.now(), kind: 'GENERAL', reason: '신고기관 통보' });
    const same = await postReview(eventId, second, { rating: 4, body: '정말 좋았습니다 다음에도 또 보고싶어요' });
    expect(JSON.parse(same.payload).status).toBe('HIDDEN');
    const fp = await database.pool.query('select count(*)::int as n from review_hidden_fingerprint');
    expect(fp.rows[0].n).toBe(1);

    const reporter = randomUUID();
    const author = randomUUID();
    eligibility.set(author, eventId, { eligible: true, basisOrderId: randomUUID() });
    const targetReview = JSON.parse((await postReview(eventId, author, { rating: 5, body: '조치 트랜잭션 시험용 후기 본문입니다.' })).payload);
    await report(targetReview.reviewId, reporter);
    const cs = identity.ops('cs_agent');
    const moderated = await svc.http.inject({ method: 'POST', url: `/v1/ops/reviews/${targetReview.reviewId}/moderation`, headers: { ...cs, 'content-type': 'application/json' }, payload: JSON.stringify({ action: 'BLOCK', reason: '운영정책 위반', violation: 'SPAM' }) });
    expect(moderated.statusCode).toBe(200);
    const rows = await database.pool.query("select r.status, r.notice, c.status as report_status, c.outcome from review r join content_report c on c.target_id = r.id where r.id = $1", [targetReview.reviewId]);
    expect(rows.rows[0]).toMatchObject({ status: 'HIDDEN', notice: 'POLICY', report_status: 'RESOLVED', outcome: 'BLOCKED' });
  });
});
