// 검색 읽기 모델 통합 시험(실제 PostgreSQL 18 컨테이너): 0009 search_document 뷰와 DrizzleSearchIndex를 읽는다(BAT-165, ADR-0268).
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { artist, event, place, production, productionArtist, productionImage, promoter, searchAlias, wish } from '../src/modules/catalog/adapters/db/schema.js';
import { DrizzleSearchIndex } from '../src/modules/catalog/adapters/db/drizzle-search-index.js';
import { type PostgresContainer, startPostgres } from './postgres.js';

let pg: PostgresContainer;
let database: Database;
const ACTOR = randomUUID();
const now = Date.now();

async function seed(o: { title: string; saleReview?: string; approved?: boolean; withEvent?: boolean }) {
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
    saleApprovedAt: o.approved === false ? null : new Date(now - 86_400_000),
  });
  if (o.withEvent !== false) {
    await database.db.insert(event).values({
      id: eventId,
      productionId,
      promoterId,
      venueId: null,
      openAt: new Date(now - 86_400_000),
      startsAt: new Date(now + 7 * 86_400_000),
      endsAt: new Date(now + 7 * 86_400_000 + 7_200_000),
    });
  }
  return { promoterId, placeId, productionId, eventId };
}

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  database = createDatabase({ url: pg.url, applicationName: 'core-svc-search-view-check', max: 2 });
});
afterAll(async () => {
  await database?.close();
  pg?.stop();
});

describe('search_document 뷰', () => {
  test('공개 공연 한 줄에 제목·공연장·아티스트·다른 이름·포스터·관심도·KST 기간·판매 상태를 모은다', async () => {
    const s = await seed({ title: '루멘 콘서트' });
    const artistId = randomUUID();
    await database.db.insert(artist).values({ id: artistId, name: '루멘', createdBy: ACTOR });
    await database.db.insert(productionArtist).values({ productionId: s.productionId, artistId, sortOrder: 0 });
    await database.db.insert(searchAlias).values({ id: randomUUID(), targetKind: 'PRODUCTION', targetId: s.productionId, alias: 'LUMEN', source: 'PARTNER', createdBy: ACTOR });
    const imageId = randomUUID();
    await database.db.insert(productionImage).values({
      id: imageId,
      productionId: s.productionId,
      promoterId: s.promoterId,
      kind: 'POSTER',
      alt: '포스터',
      displayOrder: 0,
      width: 1000,
      height: 1400,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    });
    await database.db.insert(wish).values({ accountId: randomUUID(), productionId: s.productionId, createdAt: new Date(now) });

    const rows = (await database.db.execute(sql`select * from search_document where production_id = ${s.productionId}`)) as unknown as { rows?: Record<string, unknown>[] } | Record<string, unknown>[];
    const row = ((Array.isArray(rows) ? rows : rows.rows) ?? [])[0]!;
    expect(row).toMatchObject({
      production_id: s.productionId,
      representative_event_id: s.eventId,
      title: '루멘 콘서트',
      place_name: '피켓홀',
      sale_status: 'ON_SALE',
      poster_image_id: imageId,
      poster_alt: '포스터',
      interest: 1,
    });
    expect(Number(row.updated_version)).toBe(1);
    expect(row.aliases).toContain('LUMEN');
    expect(JSON.stringify(row.artists)).toContain('루멘');
    expect(String(row.period_start)).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const index = new DrizzleSearchIndex(database, 'https://img.test');
    const docs = await index.documents();
    expect(docs.find((d) => d.productionId === s.productionId)).toMatchObject({
      title: '루멘 콘서트',
      placeName: '피켓홀',
      aliases: ['LUMEN'],
      saleStatus: 'ON_SALE',
      popularity: 1,
      posterAlt: '포스터',
    });
    expect(docs.find((d) => d.productionId === s.productionId)?.artists[0]?.name).toBe('루멘');
    expect(docs.find((d) => d.productionId === s.productionId)?.saleEndsAt).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(await index.version()).toBeGreaterThanOrEqual(1);
  });

  test('판매 승인 전·판매 중지·회차 없는 공연은 뷰에 없다', async () => {
    const unapproved = await seed({ title: '미승인', saleReview: 'DRAFT', approved: false });
    const suspended = await seed({ title: '중지', saleReview: 'SUSPENDED' });
    const noEvent = await seed({ title: '회차 없음', withEvent: false });
    const rows = (await database.db.execute(sql`select production_id from search_document`)) as unknown as { rows?: { production_id: string }[] } | { production_id: string }[];
    const ids = ((Array.isArray(rows) ? rows : rows.rows) ?? []).map((r) => r.production_id);
    expect(ids).not.toContain(unapproved.productionId);
    expect(ids).not.toContain(suspended.productionId);
    expect(ids).not.toContain(noEvent.productionId);
  });
});
