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
import { event, place, priceTier, production, promoter, searchAlias, seat, section, venue } from '../src/modules/catalog/adapters/db/schema.js';
import { FakeIdentity, testMedia } from '../test/support.js';
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
    venueId: null,
    openAt: new Date('2026-12-01T03:00:00Z'),
    startsAt: new Date('2026-12-24T10:00:00Z'),
    endsAt: new Date('2026-12-24T12:30:00Z'),
  });
  return { promoterId, placeId, productionId, eventId };
}

describe('Drizzle 저장소', () => {
  test('회차_공연_판매자상호를_한번에읽고_없는회차와모양이틀린ID는_없음이다', async () => {
    const s = await seed();
    const repo = new DrizzleCatalogRepository(database, database, systemClock);
    const row = await repo.findEventSummary(s.eventId);
    expect(row).toMatchObject({
      event: { id: s.eventId, productionId: s.productionId, status: 'SCHEDULED', startsAt: new Date('2026-12-24T10:00:00Z') },
      production: { id: s.productionId, promoterId: s.promoterId, title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED' },
      sellerName: '(주)피켓공연',
    });
    expect(row?.event).toMatchObject({ lobbyMinutes: 10, lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4, endsAt: new Date('2026-12-24T12:30:00Z') });
    expect(row?.place).toMatchObject({ id: s.placeId, name: '피켓홀' });
    expect(row?.seller).toMatchObject({ legalName: '(주)피켓공연', representative: null, exemptionBasis: null });
    // 시계는 시스템 시각이라 2026-12-24 공연은 시험 날짜에 따라 판매 종료가 지났을 수 있다. 이 회차는 어느 쪽이든 늘 든다
    expect(row?.rounds.map((x) => x.id)).toEqual([s.eventId]);
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
    await expect(database.db.insert(event).values({ id: randomUUID(), productionId: s.productionId, promoterId: s.promoterId, venueId: null, ...times })).rejects.toThrow();
    const ok = { ...times, endsAt: new Date('2026-12-24T12:00:00Z') };
    await expect(database.db.insert(event).values({ id: randomUUID(), productionId: randomUUID(), promoterId: s.promoterId, venueId: null, ...ok })).rejects.toThrow();
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
    await expect(database.db.insert(event).values({ id: randomUUID(), productionId: mine.productionId, promoterId: other.promoterId, venueId: null, ...times })).rejects.toThrow();
    await database.db.insert(event).values({ id: randomUUID(), productionId: mine.productionId, promoterId: mine.promoterId, venueId: null, ...times });
  });

  test('S-T38 ① 배치본 표는 구역 범위·좌석 색인·가격 범위를 지키고 회차는 같은 판매자의 배치본만 가리킨다 [ASVS v5.0.0-2.2.3]', async () => {
    const mine = await seed();
    const other = await seed();
    const L = randomUUID();
    const O = randomUUID();
    await database.db.insert(venue).values([
      { id: L, kind: 'LAYOUT', promoterId: mine.promoterId },
      { id: O, kind: 'LAYOUT', promoterId: other.promoterId },
    ]);
    // 배치본은 판매자가 있고 틀은 없다, 판 차례는 행의 판보다 작지 않다
    await expect(database.db.insert(venue).values({ id: randomUUID(), kind: 'LAYOUT' })).rejects.toThrow();
    await expect(database.db.insert(venue).values({ id: randomUUID(), kind: 'TEMPLATE', promoterId: mine.promoterId })).rejects.toThrow();
    await expect(database.db.insert(venue).values({ id: randomUUID(), kind: 'LAYOUT', promoterId: mine.promoterId, layoutVersion: 3, versionSeq: 2 })).rejects.toThrow();
    const tri: [number, number][] = [
      [0, 0],
      [1, 0],
      [1, 1],
    ];
    const sec = { venueId: L, promoterId: mine.promoterId, name: 'A', shape: tri };
    await expect(database.db.insert(section).values({ ...sec, sectionKey: 'X', sortOrder: 0, seatIndexFrom: 0, seatIndexTo: null })).rejects.toThrow();
    await expect(database.db.insert(section).values({ ...sec, sectionKey: 'X', sortOrder: 0, seatIndexFrom: 3, seatIndexTo: 2 })).rejects.toThrow();
    // 구역의 판매자는 배치본의 판매자와 같아야 한다
    await expect(database.db.insert(section).values({ ...sec, sectionKey: 'X', sortOrder: 0, promoterId: other.promoterId })).rejects.toThrow();
    await database.db.insert(section).values([
      { ...sec, sectionKey: 'A', sortOrder: 0, seatIndexFrom: 0, seatIndexTo: 1 },
      { ...sec, sectionKey: 'E', sortOrder: 1 },
    ]);
    await expect(database.db.insert(section).values({ ...sec, sectionKey: 'B', sortOrder: 1 })).rejects.toThrow();
    const st = { venueId: L, sectionKey: 'A', promoterId: mine.promoterId, rowLabel: '1', x: 0, y: 0 };
    const S1 = randomUUID();
    // 좌석 ID는 uuid 칸이다(판매·홀드 기록의 좌석 ID, 소문자 UUID, ADR-0260 결정 2)
    await expect(database.db.insert(seat).values({ ...st, seatKey: 'A-1-1', seatIndex: 0, number: 1 })).rejects.toThrow();
    await database.db.insert(seat).values({ ...st, seatKey: S1, seatIndex: 0, number: 1 });
    // 같은 색인·같은 열·번호·같은 좌석 ID는 하나뿐이고, 없는 구역에는 좌석을 두지 못한다
    await expect(database.db.insert(seat).values({ ...st, seatKey: randomUUID(), seatIndex: 0, number: 2 })).rejects.toThrow();
    await expect(database.db.insert(seat).values({ ...st, seatKey: randomUUID(), seatIndex: 1, number: 1 })).rejects.toThrow();
    await expect(database.db.insert(seat).values({ ...st, seatKey: S1, seatIndex: 1, number: 2 })).rejects.toThrow();
    await expect(database.db.insert(seat).values({ ...st, sectionKey: 'Z', seatKey: randomUUID(), seatIndex: 1, number: 1 })).rejects.toThrow();
    const tier = { venueId: L, promoterId: mine.promoterId, name: 'R석' };
    for (const price of [0, 10_000_001]) await expect(database.db.insert(priceTier).values({ ...tier, tierId: 'R', price, displayOrder: 0 })).rejects.toThrow();
    await expect(database.db.insert(priceTier).values({ ...tier, tierId: 'R', price: 1, displayOrder: 16 })).rejects.toThrow();
    await database.db.insert(priceTier).values([
      { ...tier, tierId: 'R', price: 1, displayOrder: 0 },
      { ...tier, tierId: 'S', price: 10_000_000, displayOrder: 1 },
    ]);
    await expect(database.db.insert(priceTier).values({ ...tier, tierId: 'A', price: 5, displayOrder: 1 })).rejects.toThrow();
    // 회차는 같은 판매자의 배치본만 가리킨다
    const times = { openAt: new Date('2026-12-01T03:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), endsAt: new Date('2026-12-24T12:00:00Z') };
    await expect(database.db.insert(event).values({ id: randomUUID(), productionId: mine.productionId, promoterId: mine.promoterId, venueId: O, ...times })).rejects.toThrow();
    await expect(database.db.insert(event).values({ id: randomUUID(), productionId: mine.productionId, promoterId: mine.promoterId, venueId: randomUUID(), ...times })).rejects.toThrow();
    await database.db.insert(event).values({ id: randomUUID(), productionId: mine.productionId, promoterId: mine.promoterId, venueId: L, ...times });
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
    svc = await createService({ name: 'core-svc', module: AppModule.register({ database, partnerDatabase: database, media: testMedia() }), env: { PEAKET_ENV: 'ci' }, logDestination: quiet, adminAuthz: new FakeIdentity() });
  });
  afterAll(async () => {
    await svc?.close();
  });

  test('판매승인된회차는200이고_판매중지는410·승인전은404다', async () => {
    const open = await seed();
    const r = await svc.http.inject({ method: 'GET', url: `/v1/events/${open.eventId}` });
    expect(r.statusCode).toBe(200);
    expect(JSON.parse(r.payload)).toMatchObject({ eventId: open.eventId, productionId: open.productionId, title: '겨울 콘서트', startsAt: '2026-12-24T10:00:00.000Z', sellerName: '(주)피켓공연' });
    const suspended = await seed({ saleReview: 'SUSPENDED' });
    const draft = await seed({ saleReview: 'DRAFT', saleApprovedAt: null });
    expect((await svc.http.inject({ method: 'GET', url: `/v1/events/${suspended.eventId}` })).statusCode).toBe(410);
    expect((await svc.http.inject({ method: 'GET', url: `/v1/events/${draft.eventId}` })).statusCode).toBe(404);
  });
});
