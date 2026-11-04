// catalog 저장소 통합 시험(실제 PostgreSQL 18 컨테이너): 마이그레이션, 회차 → 공연 → 판매자 읽기, 표 제약, 서비스 전체 경로(BUILD_ORDER HOT-170 ①)
import 'reflect-metadata';
import { createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { DrizzleCatalogRepository } from '../src/modules/catalog/adapters/db/drizzle-catalog-repository.js';
import { event, place, production, promoter, searchAlias } from '../src/modules/catalog/adapters/db/schema.js';
import { FakeIdentity } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const ACTOR = randomUUID();

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 4 });
  await ensureOutboxPartitions(database, systemClock);
});
afterAll(async () => {
  await database?.close();
  pg?.stop();
});

/** 판매자·공연장·공연·회차 한 벌을 넣고 ID를 돌려준다 */
async function seed(o: { saleReview?: string; saleApprovedAt?: Date | null } = {}) {
  const promoterId = randomUUID();
  const placeId = randomUUID();
  const productionId = randomUUID();
  const eventId = randomUUID();
  await database.db.insert(promoter).values({ id: promoterId, legalName: '(주)피켓공연' });
  await database.db.insert(place).values({ id: placeId, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: ACTOR });
  await database.db.insert(production).values({
    id: productionId,
    promoterId,
    placeId,
    title: '겨울 콘서트',
    genre: '콘서트',
    saleReview: o.saleReview ?? 'APPROVED',
    saleApprovedAt: o.saleApprovedAt === undefined ? new Date('2026-11-20T00:00:00Z') : o.saleApprovedAt,
  });
  await database.db.insert(event).values({
    id: eventId,
    productionId,
    promoterId,
    venueId: randomUUID(),
    openAt: new Date('2026-12-01T03:00:00Z'),
    startsAt: new Date('2026-12-24T10:00:00Z'),
    endsAt: new Date('2026-12-24T12:30:00Z'),
  });
  return { promoterId, placeId, productionId, eventId };
}

describe('Drizzle 저장소', () => {
  test('회차_공연_판매자상호를_한번에읽고_없는회차와모양이틀린ID는_없음이다', async () => {
    const s = await seed();
    const repo = new DrizzleCatalogRepository(database, systemClock);
    const row = await repo.findEventSummary(s.eventId);
    expect(row).toMatchObject({
      event: { id: s.eventId, productionId: s.productionId, status: 'SCHEDULED', startsAt: new Date('2026-12-24T10:00:00Z') },
      production: { id: s.productionId, promoterId: s.promoterId, title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED' },
      sellerName: '(주)피켓공연',
    });
    expect(await repo.findEventSummary(randomUUID())).toBeUndefined();
    expect(await repo.findEventSummary('not-a-uuid')).toBeUndefined();
  });
});

describe('표 제약', () => {
  test('공연명은_1~100자이고_장르·판매승인값은_정한목록뿐이다', async () => {
    const s = await seed();
    const base = { promoterId: s.promoterId, placeId: s.placeId, genre: '콘서트' };
    await expect(database.db.insert(production).values({ ...base, id: randomUUID(), title: '' })).rejects.toThrow();
    await expect(database.db.insert(production).values({ ...base, id: randomUUID(), title: '가'.repeat(101) })).rejects.toThrow();
    await expect(database.db.insert(production).values({ ...base, id: randomUUID(), title: '공연', genre: '오페라' })).rejects.toThrow();
    await expect(database.db.insert(production).values({ ...base, id: randomUUID(), title: '공연', saleReview: 'OK' })).rejects.toThrow();
  });

  test('회차는_오픈<시작<끝이고_없는공연에는_달수없다', async () => {
    const s = await seed();
    const times = { openAt: new Date('2026-12-01T03:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), endsAt: new Date('2026-12-24T09:00:00Z') };
    await expect(database.db.insert(event).values({ id: randomUUID(), productionId: s.productionId, promoterId: s.promoterId, venueId: randomUUID(), ...times })).rejects.toThrow();
    const ok = { ...times, endsAt: new Date('2026-12-24T12:00:00Z') };
    await expect(database.db.insert(event).values({ id: randomUUID(), productionId: randomUUID(), promoterId: s.promoterId, venueId: randomUUID(), ...ok })).rejects.toThrow();
  });

  test('판매승인상태와승인시각이맞아야한다(초안은승인이력없음·승인과판매중지는있음)', async () => {
    const s = await seed();
    const base = { promoterId: s.promoterId, placeId: s.placeId, genre: '콘서트', title: '공연' };
    await expect(database.db.insert(production).values({ ...base, id: randomUUID(), saleReview: 'DRAFT', saleApprovedAt: new Date() })).rejects.toThrow();
    await expect(database.db.insert(production).values({ ...base, id: randomUUID(), saleReview: 'APPROVED', saleApprovedAt: null })).rejects.toThrow();
    // 판매 중지(T9·T10)는 승인 이력이 있을 때만 된다(ADR-0198 결정 7)
    await expect(database.db.insert(production).values({ ...base, id: randomUUID(), saleReview: 'SUSPENDED', saleApprovedAt: null })).rejects.toThrow();
    // 첫 승인 대기·첫 반려는 승인 이력이 없다
    await database.db.insert(production).values({ ...base, id: randomUUID(), saleReview: 'REJECTED', saleApprovedAt: null });
  });

  test('회차의판매자사본은_그공연의판매자와같아야한다(다른판매자의ID로는넣지못한다)', async () => {
    const mine = await seed();
    const other = await seed();
    const times = { openAt: new Date('2026-12-01T03:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), endsAt: new Date('2026-12-24T12:00:00Z') };
    await expect(database.db.insert(event).values({ id: randomUUID(), productionId: mine.productionId, promoterId: other.promoterId, venueId: randomUUID(), ...times })).rejects.toThrow();
    await database.db.insert(event).values({ id: randomUUID(), productionId: mine.productionId, promoterId: mine.promoterId, venueId: randomUUID(), ...times });
  });

  test('다른이름은_지우지않은같은대상의같은이름이하나뿐이고_지운뒤에는다시달수있다', async () => {
    const targetId = randomUUID();
    const row = { targetKind: 'ARTIST', targetId, alias: '피켓밴드', source: 'PARTNER', createdBy: ACTOR };
    const first = randomUUID();
    await database.db.insert(searchAlias).values({ ...row, id: first });
    await expect(database.db.insert(searchAlias).values({ ...row, id: randomUUID() })).rejects.toThrow();
    await database.db.execute(sql`update search_alias set removed_at = now() where id = ${first}`);
    await database.db.insert(searchAlias).values({ ...row, id: randomUUID() });
  });
});

describe('서비스 전체 경로(DB 저장소)', () => {
  let svc: Awaited<ReturnType<typeof createService>>;
  beforeAll(async () => {
    const quiet = new Writable({ write: (_c, _e, cb) => cb() });
    svc = await createService({ name: 'core-svc', module: AppModule.register({ database }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet, adminAuthz: new FakeIdentity() });
  });
  afterAll(async () => {
    await svc?.close();
  });

  test('판매승인된회차는200이고_판매중지·승인전은404다', async () => {
    const open = await seed();
    const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${open.eventId}` });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toEqual({ eventId: open.eventId, productionId: open.productionId, title: '겨울 콘서트', startsAt: '2026-12-24T10:00:00.000Z', sellerName: '(주)피켓공연' });
    const suspended = await seed({ saleReview: 'SUSPENDED' });
    const draft = await seed({ saleReview: 'DRAFT', saleApprovedAt: null });
    expect((await svc.http.inject({ method: 'GET', url: `/v1/events/${suspended.eventId}` })).statusCode).toBe(404);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/events/${draft.eventId}` })).statusCode).toBe(404);
  });
});
