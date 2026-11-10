// 공연 등록·회차 더하기·찜의 Drizzle 저장소 통합 시험(실제 PostgreSQL 18 컨테이너, ADR-0198, BUILD_ORDER HOT-171)
import 'reflect-metadata';
import { createDatabase, createService, type Database, ensureOutboxPartitions, fakeClock, systemClock } from '@peaket/platform';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { artist, event, place, production, productionArtist, promoter, searchAlias, wish } from '../src/modules/catalog/adapters/db/schema.js';
import { WISH_LIMIT } from '../src/modules/catalog/domain/registration.js';
import { eventBody, FakeIdentity, fan, NOW_MS, productionBody, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';
import { loginFor } from './roles.js';

let pg: PostgresContainer;
let database: Database;
// 서비스는 운영과 같은 권한의 사용자로 접속한다(빠진 GRANT가 있으면 이 시험이 실패한다, ADR-0241). 확인 쿼리만 소유자로 한다
let appDb: Database;
let partnerDb: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const identity = new FakeIdentity();
const TENANT = randomUUID();
const OTHER = randomUUID();
const PLACE = randomUUID();
const ARTIST = randomUUID();
const ACTOR = randomUUID();

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'core-svc-test', max: 8 });
  await ensureOutboxPartitions(database, systemClock);
  appDb = await loginFor(database, pg, 'core_app_login', 'core_app', 4);
  partnerDb = await loginFor(database, pg, 'core_partner_login', 'core_partner', 4);
  await database.db.insert(promoter).values([
    { id: TENANT, legalName: '(주)피켓공연' },
    { id: OTHER, legalName: '(주)다른공연' },
  ]);
  await database.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울 어딘가 1', region: '서울', createdBy: ACTOR });
  await database.db.insert(artist).values({ id: ARTIST, name: '피켓밴드', createdBy: ACTOR });
  svc = await createService({ name: 'core-svc', module: AppModule.register({ database: appDb, partnerDatabase: partnerDb, media: testMedia() }), env: { PEAKET_ENV: 'ci' }, clock: fakeClock({ now: NOW_MS }), logDestination: quiet(), adminAuthz: identity });
});
afterAll(async () => {
  await svc?.close();
  await appDb?.close();
  await partnerDb?.close();
  await database?.close();
  pg?.stop();
});

const post = (url: string, h: Record<string, string>, body: unknown, key: string = randomUUID()) =>
  svc.http.inject({ method: 'POST', url, headers: { ...h, 'content-type': 'application/json', 'idempotency-key': key }, payload: JSON.stringify(body) });

describe('공연 등록(DB)', () => {
  test('공연·아티스트 연결·새 이름 요청·다른 이름·회차 칸을 한 트랜잭션에 쓰고_같은 키는 처음 결과를 돌려준다', async () => {
    const h = identity.partner(TENANT, 'partner_member');
    const key = randomUUID();
    const body = productionBody(PLACE, { artists: [{ name: '새 밴드' }, { artistId: ARTIST }], events: [eventBody({ lobbyMinutes: 15, entryOpensAt: '2026-12-24T09:00:00Z', reentryAllowed: true })] });
    const r = await post('/v1/partner/productions', h, body, key);
    expect(r.statusCode).toBe(201);
    const out = JSON.parse(r.payload);
    const [p] = await database.db.select().from(production).where(eq(production.id, out.productionId));
    expect(p).toMatchObject({ promoterId: TENANT, placeId: PLACE, saleReview: 'DRAFT', saleApprovedAt: null, requestedPlace: null, requestedArtists: [{ name: '새 밴드', sortOrder: 0 }] });
    expect(await database.db.select({ artistId: productionArtist.artistId, sortOrder: productionArtist.sortOrder }).from(productionArtist).where(eq(productionArtist.productionId, out.productionId))).toEqual([{ artistId: ARTIST, sortOrder: 1 }]);
    expect((await database.db.select().from(searchAlias).where(eq(searchAlias.targetId, out.productionId))).map((a) => [a.alias, a.targetKind, a.source])).toEqual([['WINTER CONCERT', 'PRODUCTION', 'PARTNER']]);
    const [e] = await database.db.select().from(event).where(eq(event.id, out.eventIds[0]));
    expect(e).toMatchObject({ productionId: out.productionId, promoterId: TENANT, venueId: null, lobbyMinutes: 15, reentryAllowed: true, lobbyShuffle: true, openBatch: true, seatAssignment: 'PICK', perPersonLimit: 4 });
    expect(e?.entryOpensAt).toEqual(new Date('2026-12-24T09:00:00Z'));
    const again = await post('/v1/partner/productions', h, body, key);
    expect(again.payload).toBe(r.payload);
    expect((await database.db.select().from(production).where(eq(production.title, '겨울 콘서트'))).length).toBe(1);
  });

  test('공개 중인 다른 공연과 오픈이 5분 안이면 409이고 아무것도 쓰지 않는다', async () => {
    const first = await post('/v1/partner/productions', identity.partner(TENANT), productionBody(PLACE, { title: '먼저', events: [eventBody({ openAt: '2026-11-26T11:00:00Z' })] }));
    expect(first.statusCode).toBe(201);
    await database.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-04T00:00:00Z') }).where(eq(production.id, JSON.parse(first.payload).productionId));
    const r = await post('/v1/partner/productions', identity.partner(OTHER), productionBody(PLACE, { title: '나중', events: [eventBody({ openAt: '2026-11-26T11:04:00Z' })] }));
    expect(r.statusCode).toBe(409);
    expect(JSON.parse(r.payload)).toMatchObject({ type: 'https://peaket.example/problems/open-too-close', suggestedOpenAt: '2026-11-26T11:05:00.000Z' });
    expect((await database.db.select().from(production).where(eq(production.title, '나중'))).length).toBe(0);
  });

  test('승인 전·판매 중지 공연의 회차는 남의 오픈을 막지 않는다(간격은 판매 승인이 다시 본다)', async () => {
    const draft = await post('/v1/partner/productions', identity.partner(TENANT), productionBody(PLACE, { title: '초안', events: [eventBody({ openAt: '2026-11-19T11:00:00Z' })] }));
    expect(draft.statusCode).toBe(201);
    expect((await post('/v1/partner/productions', identity.partner(OTHER), productionBody(PLACE, { title: '초안 옆', events: [eventBody({ openAt: '2026-11-19T11:02:00Z' })] }))).statusCode).toBe(201);
    await database.db.update(production).set({ saleReview: 'SUSPENDED', saleApprovedAt: new Date('2026-11-04T00:00:00Z') }).where(eq(production.id, JSON.parse(draft.payload).productionId));
    expect((await post('/v1/partner/productions', identity.partner(OTHER), productionBody(PLACE, { title: '중지 옆', events: [eventBody({ openAt: '2026-11-19T11:03:00Z' })] }))).statusCode).toBe(201);
  });

  test('회차 더하기는 다른 테넌트의 공연 행을 잠그지도 읽지도 않고 404다(범위 인자)', async () => {
    const theirs = await post('/v1/partner/productions', identity.partner(OTHER), productionBody(PLACE, { title: '남의 공연', events: [eventBody({ openAt: '2026-11-18T11:00:00Z' })] }));
    const id = JSON.parse(theirs.payload).productionId;
    const r = await post(`/v1/partner/productions/${id}/events`, identity.partner(TENANT, 'partner_admin'), eventBody({ openAt: '2026-11-18T11:00:00Z' }));
    expect(r.statusCode).toBe(404);
  });
});

describe('공연 설명·전산망 항목(DB)', () => {
  test('실제 권한으로 구조 문서·글자판·전산망 항목을 저장한다', async () => {
    const description = { v: 1, blocks: [{ t: 'p', c: [{ t: 'text', v: '설명', b: true }] }] };
    const r = await post('/v1/partner/productions', identity.partner(TENANT), productionBody(PLACE, { title: '설명 공연', events: [eventBody({ openAt: '2026-11-27T11:00:00Z' })], description, kopisFields: { producer: '(주)피켓공연' } }));
    expect(r.statusCode).toBe(201);
    const [p] = await database.db.select().from(production).where(eq(production.id, JSON.parse(r.payload).productionId));
    expect(p).toMatchObject({ description: '설명', descriptionDoc: description, kopisFields: { producer: '(주)피켓공연' } });
  });
});

describe('아티스트·공연장 찾기(DB)', () => {
  test('실제 권한으로 이름·다른 이름·닫은 공연장을 거른다', async () => {
    const closed = randomUUID();
    await database.db.insert(place).values({ id: closed, name: '피켓 옛홀', address: '서울 어딘가 2', region: '서울', createdBy: ACTOR, status: 'CLOSED' });
    await database.db.insert(searchAlias).values({ id: randomUUID(), targetKind: 'ARTIST', targetId: ARTIST, alias: 'PICKET BAND', source: 'OPERATOR', createdBy: ACTOR });
    const removed = randomUUID();
    await database.db.insert(searchAlias).values({ id: removed, targetKind: 'ARTIST', targetId: ARTIST, alias: '지운 이름', source: 'OPERATOR', createdBy: ACTOR, removedAt: new Date('2026-11-01T00:00:00Z') });
    const h = identity.partner(TENANT, 'partner_member');
    const get = async (u: string) => JSON.parse((await svc.http.inject({ method: 'GET', url: u, headers: h })).payload) as { items: Array<Record<string, string>> };
    expect((await get(`/v1/partner/artists?q=${encodeURIComponent('ㅍㅋㅂㄷ')}`)).items).toEqual([{ artistId: ARTIST, name: '피켓밴드' }]);
    expect((await get('/v1/partner/artists?q=picket')).items).toEqual([{ artistId: ARTIST, name: '피켓밴드' }]);
    expect((await get(`/v1/partner/artists?q=${encodeURIComponent('지운')}`)).items).toEqual([]);
    expect((await get(`/v1/partner/places?q=${encodeURIComponent('피켓')}`)).items.map((p) => p.placeId)).toEqual([PLACE]);
  });
});

describe('회차 더하기(DB)', () => {
  test('승인 뒤 더한 회차는 변경분 JSON에만 두고 SUBMITTED가 되며, 승인 이력이 없으면 같은 배치본으로 event 행에 넣는다', async () => {
    const r = await post('/v1/partner/productions', identity.partner(TENANT), productionBody(PLACE, { title: '승인됨', events: [eventBody({ openAt: '2026-12-05T11:00:00Z' })] }));
    const { productionId } = JSON.parse(r.payload);
    const venue = randomUUID();
    await database.db.update(event).set({ venueId: venue }).where(eq(event.productionId, productionId));
    const direct = await post(`/v1/partner/productions/${productionId}/events`, identity.partner(TENANT, 'partner_member'), eventBody({ openAt: '2026-12-05T11:00:00Z', startsAt: '2026-12-29T10:00:00Z', endsAt: '2026-12-29T12:00:00Z' }));
    expect(direct.statusCode).toBe(201);
    const [d] = await database.db.select().from(event).where(eq(event.id, JSON.parse(direct.payload).eventId));
    expect(d?.venueId).toBe(venue);

    await database.db.update(production).set({ saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-04T00:00:00Z') }).where(eq(production.id, productionId));
    const added = await post(`/v1/partner/productions/${productionId}/events`, identity.partner(TENANT, 'partner_admin'), eventBody({ openAt: '2026-12-06T11:00:00Z', startsAt: '2026-12-30T10:00:00Z', endsAt: '2026-12-30T12:00:00Z', perPersonLimit: 2 }));
    expect(added.statusCode).toBe(201);
    const out = JSON.parse(added.payload);
    expect(out.pending).toBe(true);
    expect((await database.db.select().from(event).where(eq(event.id, out.eventId))).length).toBe(0);
    const [p] = await database.db.select().from(production).where(eq(production.id, productionId));
    expect(p?.saleReview).toBe('SUBMITTED');
    expect((p?.pendingRevision as { addedEvents: Record<string, unknown>[] }).addedEvents).toEqual([
      expect.objectContaining({ eventId: out.eventId, openAt: '2026-12-06T11:00:00.000Z', perPersonLimit: 2, lobbyShuffle: true }),
    ]);
    // 두 번째로 더하면 목록이 이어진다
    const more = await post(`/v1/partner/productions/${productionId}/events`, identity.partner(TENANT, 'partner_admin'), eventBody({ openAt: '2026-12-07T11:00:00Z', startsAt: '2026-12-31T10:00:00Z', endsAt: '2026-12-31T12:00:00Z' }));
    expect(more.statusCode).toBe(201);
    const [p2] = await database.db.select().from(production).where(eq(production.id, productionId));
    expect((p2?.pendingRevision as { addedEvents: unknown[] }).addedEvents).toHaveLength(2);
  });
});

describe('찜(DB)', () => {
  test('상한 직전에 동시에 보낸 찜도 상한을 넘지 않는다(계정 단위 잠금)', async () => {
    const me = randomUUID();
    const ids: string[] = [];
    for (let i = 0; i < WISH_LIMIT + 4; i++) ids.push(randomUUID());
    await database.db.insert(production).values(ids.map((id) => ({ id, promoterId: TENANT, placeId: PLACE, title: '찜 공연', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date('2026-11-01T00:00:00Z') })));
    await database.db.insert(wish).values(ids.slice(0, WISH_LIMIT - 1).map((productionId) => ({ accountId: me, productionId, createdAt: new Date(NOW_MS) })));
    const h = fan(me);
    const rs = await Promise.all(ids.slice(WISH_LIMIT - 1).map((id) => svc.http.inject({ method: 'PUT', url: `/v1/productions/${id}/wish`, headers: h })));
    expect(rs.map((r) => r.statusCode).sort()).toEqual([204, 422, 422, 422, 422]);
    const [{ n }] = await database.db.select({ n: sql<number>`count(*)::int` }).from(wish).where(eq(wish.accountId, me));
    expect(n).toBe(WISH_LIMIT);
  });

  test('같은 찜을 다시 보내도 처음 시각을 두고, 해제는 내 찜만 지운다', async () => {
    const [p] = await database.db.select({ id: production.id }).from(production).where(eq(production.title, '찜 공연')).limit(1);
    const me = randomUUID();
    expect((await svc.http.inject({ method: 'PUT', url: `/v1/productions/${p!.id}/wish`, headers: fan(me) })).statusCode).toBe(204);
    expect((await svc.http.inject({ method: 'PUT', url: `/v1/productions/${p!.id}/wish`, headers: fan(me) })).statusCode).toBe(204);
    expect((await database.db.select().from(wish).where(eq(wish.accountId, me))).length).toBe(1);
    expect((await svc.http.inject({ method: 'DELETE', url: `/v1/productions/${p!.id}/wish`, headers: fan(me) })).statusCode).toBe(204);
    expect((await database.db.select().from(wish).where(eq(wish.accountId, me))).length).toBe(0);
  });
});

describe('표 제약(0002)', () => {
  test('공연장은 등록된 공연장과 새 공연장 요청 가운데 꼭 하나이고, 승인 이력이 있으면 등록된 공연장이다', async () => {
    const base = { promoterId: TENANT, title: '제약', genre: '콘서트' };
    await expect(database.db.insert(production).values({ ...base, id: randomUUID() })).rejects.toThrow();
    await expect(database.db.insert(production).values({ ...base, id: randomUUID(), placeId: PLACE, requestedPlace: { name: 'a', address: 'b' } })).rejects.toThrow();
    await expect(database.db.insert(production).values({ ...base, id: randomUUID(), requestedPlace: { name: 'a', address: 'b' }, saleReview: 'APPROVED', saleApprovedAt: new Date() })).rejects.toThrow();
    await database.db.insert(production).values({ ...base, id: randomUUID(), requestedPlace: { name: 'a', address: 'b' } });
  });

  test('회차의 정렬 두 값을 둘 다 끄거나 1인 한도·로비 분이 범위 밖이면 넣지 못한다', async () => {
    const [p] = await database.db.select({ id: production.id }).from(production).where(eq(production.promoterId, TENANT)).limit(1);
    const row = { productionId: p!.id, promoterId: TENANT, openAt: new Date('2026-12-01T03:00:00Z'), startsAt: new Date('2026-12-24T10:00:00Z'), endsAt: new Date('2026-12-24T12:00:00Z') };
    await expect(database.db.insert(event).values({ ...row, id: randomUUID(), lobbyShuffle: false, openBatch: false })).rejects.toThrow();
    await expect(database.db.insert(event).values({ ...row, id: randomUUID(), perPersonLimit: 11 })).rejects.toThrow();
    await expect(database.db.insert(event).values({ ...row, id: randomUUID(), lobbyMinutes: 61 })).rejects.toThrow();
    await expect(database.db.insert(event).values({ ...row, id: randomUUID(), seatAssignment: 'RANDOM' })).rejects.toThrow();
  });
});
