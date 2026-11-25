// GAT-260 찜 목록 실제 PostgreSQL 통합 시험(BUILD_ORDER F-05-8, 시험 먼저).
// wish 표의 차례·커서·공개 여부가 search_document_source_at의 카드와 맞는지 본다.
import { eq } from 'drizzle-orm';
import 'reflect-metadata';
import { createDatabase, createService, type Database, ensureOutboxPartitions, systemClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { AppModule } from '../src/app.module.js';
import { event, place, production, promoter, wish } from '../src/modules/catalog/adapters/db/schema.js';
import { DrizzleCatalogRepository } from '../src/modules/catalog/adapters/db/drizzle-catalog-repository.js';
import { WishLifecycle } from '../src/modules/catalog/application/wish-lifecycle.js';
import { FakeIdentity, fan, quiet, testMedia } from '../test/support.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
let svc: Awaited<ReturnType<typeof createService>>;
const ACTOR = randomUUID();
const NOW = Date.now();

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'core-svc-wish-list', max: 4 });
  await ensureOutboxPartitions(database, systemClock);
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ database, notifyDatabase: database, partnerDatabase: database, media: testMedia() }),
    env: { PEAKET_ENV: 'ci' },
    logDestination: quiet() as Writable,
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
  await database?.close();
  pg?.stop();
});

async function seed(o: { title: string; saleReview?: string; startsAt?: Date }): Promise<{ productionId: string; eventId: string }> {
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
    title: o.title,
    genre: '콘서트',
    saleReview: o.saleReview ?? 'APPROVED',
    saleApprovedAt: o.saleReview === 'DRAFT' ? null : new Date(NOW - 86_400_000),
  });
  await database.db.insert(event).values({
    id: eventId,
    productionId,
    promoterId,
    venueId: null,
    openAt: new Date(NOW - 86_400_000),
    startsAt: o.startsAt ?? new Date(NOW + 7 * 86_400_000),
    endsAt: new Date((o.startsAt ?? new Date(NOW + 7 * 86_400_000)).getTime() + 2 * 3_600_000),
  });
  return { productionId, eventId };
}

const list = (accountId: string, query = '') => svc.http.inject({ method: 'GET', url: `/v1/wishes${query}`, headers: fan(accountId) });

describe('찜 목록(실제 DB)', () => {
  test('GAT-260 실제 DB에서 찜 줄과 카드가 같은 차례로 오고 커서가 겹치거나 빠지지 않는다', async () => {
    const me = randomUUID();
    const first = await seed({ title: '첫 공연' });
    const second = await seed({ title: '둘째 공연' });
    const third = await seed({ title: '셋째 공연' });
    await database.db.insert(wish).values([
      { accountId: me, productionId: first.productionId, createdAt: new Date(NOW - 3 * 60_000) },
      { accountId: me, productionId: second.productionId, createdAt: new Date(NOW - 2 * 60_000) },
      { accountId: me, productionId: third.productionId, createdAt: new Date(NOW - 60_000) },
    ]);

    const p1r = await list(me, '?limit=2');
    expect(p1r.statusCode).toBe(200);
    const p1 = JSON.parse(p1r.payload) as { items: { productionId: string; title?: string; saleStatus?: string }[]; nextCursor: string | null };
    expect(p1.items.map((x) => x.productionId)).toEqual([third.productionId, second.productionId]);
    expect(p1.items[0]).toMatchObject({ title: '셋째 공연', saleStatus: 'ON_SALE' });
    expect(p1.nextCursor).not.toBeNull();

    const p2r = await list(me, `?limit=2&cursor=${encodeURIComponent(p1.nextCursor!)}`);
    const p2 = JSON.parse(p2r.payload) as typeof p1;
    expect(p2.items.map((x) => x.productionId)).toEqual([first.productionId]);
    expect(p2.nextCursor).toBeNull();
  });

  test('GAT-260 실제 DB 카드 배지는 대표 회차의 정렬·선예매·좌석 배정을 실제 값으로 싣는다', async () => {
    const me = randomUUID();
    const s = await seed({ title: '배지 공연' });
    await database.db.update(event).set({ lobbyShuffle: false, openBatch: true, seatAssignment: 'AUTO' }).where(eq(event.id, s.eventId));
    await database.db
      .update(production)
      .set({
        salePolicy: [
          {
            version: 1,
            name: '팬클럽 선예매',
            rounds: 'ALL',
            during: { from: new Date(NOW - 86_400_000).toISOString(), to: new Date(NOW + 86_400_000).toISOString() },
            rule: { if: { fact: 'buyer.lists', has: 'lumen' }, then: { limitPerPerson: 2 }, else: { deny: 'PRESALE_ONLY' } },
          },
        ],
      })
      .where(eq(production.id, s.productionId));
    await database.db.insert(wish).values({ accountId: me, productionId: s.productionId, createdAt: new Date(NOW) });

    const r = await list(me, `?productionIds=${s.productionId}`);
    expect(r.statusCode).toBe(200);
    expect((JSON.parse(r.payload) as { items: { badges?: string[] }[] }).items[0]?.badges).toEqual(['FIFO', 'PRESALE', 'AUTO_SEAT']);
  });

  test('GAT-260 실제 DB에서 판매 중지·승인 전 공연은 빠지고 productionIds는 내 찜만 준다', async () => {
    const me = randomUUID();
    const ok = await seed({ title: '공개 공연' });
    const suspended = await seed({ title: '판매 중지', saleReview: 'SUSPENDED' });
    const draft = await seed({ title: '승인 전', saleReview: 'DRAFT' });
    await database.db.insert(wish).values([
      { accountId: me, productionId: ok.productionId, createdAt: new Date(NOW - 2_000) },
      { accountId: me, productionId: suspended.productionId, createdAt: new Date(NOW - 1_000) },
      { accountId: me, productionId: draft.productionId, createdAt: new Date(NOW) },
    ]);

    const all = JSON.parse((await list(me)).payload) as { items: { productionId: string }[] };
    expect(all.items.map((x) => x.productionId)).toEqual([ok.productionId]);

    const only = JSON.parse((await list(me, `?productionIds=${ok.productionId},${suspended.productionId}`)).payload) as { items: { productionId: string }[] };
    expect(only.items.map((x) => x.productionId)).toEqual([ok.productionId]);
  });

  test('GAT-260 실제 DB에서 같은 시각 찜은 공연 ID 내림차순으로 갈리고 커서가 이어진다', async () => {
    const me = randomUUID();
    const a = await seed({ title: '같은 시각 A' });
    const b = await seed({ title: '같은 시각 B' });
    const at = new Date(NOW - 5_000);
    await database.db.insert(wish).values([
      { accountId: me, productionId: a.productionId, createdAt: at },
      { accountId: me, productionId: b.productionId, createdAt: at },
    ]);
    const expected = [a.productionId, b.productionId].sort().reverse();
    const p1 = JSON.parse((await list(me, '?limit=1')).payload) as { items: { productionId: string }[]; nextCursor: string | null };
    const p2 = JSON.parse((await list(me, `?limit=1&cursor=${encodeURIComponent(p1.nextCursor!)}`)).payload) as { items: { productionId: string }[]; nextCursor: string | null };
    expect([...p1.items, ...p2.items].map((x) => x.productionId)).toEqual(expected);
  });

  test('GAT-260 실제 DB에서 탈퇴는 그 계정 찜만 지우고 병합은 흡수 계정 찜을 대표 계정으로 옮긴다', async () => {
    const repo = new DrizzleCatalogRepository(database, database, systemClock);
    const lifecycle = new WishLifecycle(repo);
    const primary = randomUUID();
    const absorbed = randomUUID();
    const other = randomUUID();
    const onlyAbsorbed = await seed({ title: '흡수만 찜' });
    const both = await seed({ title: '둘 다 찜' });
    const otherWish = await seed({ title: '남의 찜' });
    await database.db.insert(wish).values([
      { accountId: primary, productionId: both.productionId, createdAt: new Date(NOW - 3_000) },
      { accountId: absorbed, productionId: onlyAbsorbed.productionId, createdAt: new Date(NOW - 2_000) },
      { accountId: absorbed, productionId: both.productionId, createdAt: new Date(NOW - 1_000) },
      { accountId: other, productionId: otherWish.productionId, createdAt: new Date(NOW) },
    ]);

    expect(await lifecycle.absorbedWishes(absorbed)).toBe(2);
    expect(await lifecycle.moveMerged(primary, absorbed)).toBe(2);
    expect(await lifecycle.moveMerged(primary, absorbed)).toBe(0);
    expect(await lifecycle.absorbedWishes(absorbed)).toBe(0);
    const primaryIds = (await repo.listWishRows(primary, { limit: 10 })).map((r) => r.productionId);
    expect(primaryIds).toEqual([onlyAbsorbed.productionId, both.productionId]);
    expect(await lifecycle.purgeWithdrawn(primary)).toBe(2);
    expect(await lifecycle.purgeWithdrawn(primary)).toBe(0);
    expect(await lifecycle.absorbedWishes(other)).toBe(1);
  });
});
