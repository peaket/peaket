// I-T83 ⑥⑦(W8-audit2a, 소유자 결정 2026-11-16 OPEN[42], ADR-0278, ADR-0086 ⑧): 실제 PostgreSQL 18에서 운영과 같은 DB 역할(core_app)로 띄운 서비스로 본다.
// ⑥ 작성자가 후기를 지우면(DELETE /v1/reviews/{id}) 탈퇴 파기와 같은 칸(docs/data.md §2 '후기 파기')이 비워지고 같은 회차에 다시 쓸 수 있다.
// ⑦ 마이그레이션 0026 뒤 살아 있는 후기는 별점·내용 지문 없이 넣을 수 없다(review_live_complete_check, NOT VALID로 더함).
// 마이그레이션·시험 자료 넣기·확인은 관리자(슈퍼유저) 연결로 한다. 서비스 시계는 실제 시계(systemClock)라 지운 시각은 요청 앞뒤의 실제 시각과 견준다.
import 'reflect-metadata';
import { createDatabase, createService, ensureOutboxPartitions, systemClock, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { MemoryFanProfile, MemoryReviewCaseSink, MemoryReviewEligibility, MemoryReviewNotifier } from '../src/modules/review/index.js';
import { FakeIdentity, fan, quiet, testMedia } from '../test/support.js';
import { startPostgres, type PostgresContainer } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let admin: Database;
let database: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const eligibility = new MemoryReviewEligibility();
const ACTOR = randomUUID();

/** 그 연결로 SQL 하나를 돌려 PostgreSQL 오류 코드를 돌려준다(성공이면 'OK') */
const codeOf = async (db: Database, text: string, params: unknown[] = []): Promise<string> => {
  try {
    await db.pool.query(text, params);
    return 'OK';
  } catch (err) {
    return (err as { code?: string }).code ?? String(err);
  }
};

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  admin = createDatabase({ url: pg.url, applicationName: 'core-svc-review-purge-admin', max: 4 });
  await ensureOutboxPartitions(admin, systemClock);
  database = await loginFor(admin, pg, 'core_app_review_purge', 'core_app', 4);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({
      database,
      notifyDatabase: database,
      // 후기 경로는 파트너 연결을 쓰지 않는다
      partnerDatabase: admin,
      media: testMedia(),
      review: { eligibility, fanProfile: new MemoryFanProfile(), notifier: new MemoryReviewNotifier(), cases: new MemoryReviewCaseSink() },
    }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: quiet(),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
  await database?.close();
  await admin?.close();
  pg?.stop();
});

async function seedEvent(): Promise<string> {
  const promoterId = randomUUID();
  const placeId = randomUUID();
  const productionId = randomUUID();
  const eventId = randomUUID();
  await admin.db.insert(promoter).values({ id: promoterId, legalName: '(주)피켓공연' });
  await admin.db.insert(place).values({ id: placeId, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: ACTOR });
  await admin.db.insert(production).values({ id: productionId, promoterId, placeId, title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') });
  await admin.db.insert(event).values({ id: eventId, productionId, promoterId, venueId: null, openAt: new Date('2026-01-01T00:00:00Z'), startsAt: new Date('2026-01-01T10:00:00Z'), endsAt: new Date('2026-01-01T12:30:00Z') });
  return eventId;
}

const postReview = (eventId: string, account: string, body: Record<string, unknown>) =>
  svc.http.inject({ method: 'POST', url: `/v1/events/${eventId}/reviews`, headers: { ...fan(account), 'content-type': 'application/json' }, payload: JSON.stringify(body) });

describe('I-T83 작성자 지우기와 살아 있는 후기 CHECK(실제 DB)', () => {
  test('I-T83 ⑥ 작성자가 지운 후기도 같은 칸을 비우고 같은 회차에 다시 쓸 수 있다', async () => {
    const eventId = await seedEvent();
    const me = randomUUID();
    eligibility.set(me, eventId, { eligible: true, basisOrderId: randomUUID() });
    const created = await postReview(eventId, me, { rating: 4, body: '지우기 전에 쓴 후기 본문입니다.' });
    expect(created.statusCode).toBe(201);
    const reviewId = JSON.parse(created.payload).reviewId as string;

    const before = Date.now();
    const del = await svc.http.inject({ method: 'DELETE', url: `/v1/reviews/${reviewId}`, headers: fan(me) });
    const afterMs = Date.now();
    expect(del.statusCode).toBe(204);

    const row = (
      await admin.pool.query(
        'select account_id, basis_order_id, rating, body, status, notice, notice_until, content_fingerprint, author_display, deleted_at, updated_at from review where id = $1',
        [reviewId],
      )
    ).rows[0] as Record<string, unknown> & { deleted_at: Date | null; updated_at: Date };
    expect(row).toMatchObject({
      account_id: reviewId,
      basis_order_id: reviewId,
      rating: null,
      body: '',
      status: 'DELETED',
      notice: null,
      notice_until: null,
      content_fingerprint: null,
      author_display: '',
    });
    // 지운 시각·갱신 시각은 요청 앞뒤의 실제 시각 사이(서비스 시계가 실제 시계다)
    expect(row.deleted_at).not.toBeNull();
    expect(row.deleted_at!.getTime()).toBeGreaterThanOrEqual(before - 1);
    expect(row.deleted_at!.getTime()).toBeLessThanOrEqual(afterMs + 1);
    expect(row.updated_at.getTime()).toBe(row.deleted_at!.getTime());

    // 같은 회차에 새 후기를 다시 쓸 수 있다
    const again = await postReview(eventId, me, { rating: 2, body: '지운 뒤 같은 회차에 다시 쓴 후기 본문입니다.' });
    expect(again.statusCode).toBe(201);
    const live = await admin.pool.query("select count(*)::int as n from review where event_id = $1 and account_id = $2 and status <> 'DELETED'", [eventId, me]);
    expect(live.rows[0].n).toBe(1);
  });

  test('I-T83 ⑦ 살아 있는 후기는 별점·지문 없이 넣을 수 없다', async () => {
    const insert = (status: string, rating: number | null, fingerprint: string | null) =>
      codeOf(
        admin,
        `insert into review (id, event_id, account_id, basis_order_id, rating, body, status, content_fingerprint, author_display, edited, created_at, updated_at)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, false, $10, $10)`,
        [randomUUID(), randomUUID(), randomUUID(), randomUUID(), rating, status === 'DELETED' ? '' : 'CHECK 시험용 후기 본문입니다.', status, fingerprint, status === 'DELETED' ? '' : '김**', new Date('2026-11-16T03:00:00Z')],
      );
    // 살아 있는 행(보이는 것·가린 것): 별점이나 지문이 없으면 CHECK 위반(23514)
    expect(await insert('VISIBLE', null, 'fp-live-1'), 'VISIBLE·별점 없음').toBe('23514');
    expect(await insert('VISIBLE', 4, null), 'VISIBLE·지문 없음').toBe('23514');
    expect(await insert('HIDDEN', null, 'fp-live-2'), 'HIDDEN·별점 없음').toBe('23514');
    expect(await insert('HIDDEN', 4, null), 'HIDDEN·지문 없음').toBe('23514');
    // 파기한 행(DELETED)은 별점·지문 없이 들어간다
    expect(await insert('DELETED', null, null), 'DELETED·둘 다 없음').toBe('OK');
    // 대조군: 살아 있는 행에 둘 다 있으면 들어간다
    expect(await insert('VISIBLE', 5, 'fp-live-3'), 'VISIBLE·둘 다 있음').toBe('OK');

    // 이번 출시는 NOT VALID로 더했다(기존 행을 검사하지 않는다). 검사는 다음 출시가 VALIDATE로 한다
    const c = await admin.pool.query("select convalidated from pg_constraint where conname = 'review_live_complete_check' and conrelid = 'review'::regclass");
    expect(c.rows).toEqual([{ convalidated: false }]);
  });
});
