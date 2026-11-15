// COV2-02: PostgreSQL search_document.sale_status가 메모리 cardSaleStatus와 같은 규칙인지 본다.
// 지난 회차 + 아직 오픈 전인 다음 회차는 ON_SALE이 아니라 UPCOMING이어야 한다.
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { event, place, production, promoter } from '../src/modules/catalog/adapters/db/schema.js';
import { cardSaleStatus, type CatalogEvent, type EventWithSale } from '../src/modules/catalog/domain/production.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pg: PostgresContainer;
let db: Database;
const PROMOTER = randomUUID();
const PLACE = randomUUID();
const PRODUCTION = randomUUID();
const PAST = randomUUID();
const UPCOMING = randomUUID();
const now = new Date();
const pastStart = new Date(now.getTime() - 2 * 86_400_000);
const pastOpen = new Date(now.getTime() - 3 * 86_400_000);
const nextOpen = new Date(now.getTime() + 7 * 86_400_000);
const nextStart = new Date(now.getTime() + 8 * 86_400_000);

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  db = createDatabase({ url: pg.url, applicationName: 'core-search-sale-status-int', max: 2 });
  await db.db.insert(promoter).values({ id: PROMOTER, legalName: '(주)에이' });
  await db.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울', region: '서울', createdBy: PROMOTER });
  await db.db.insert(production).values({ id: PRODUCTION, promoterId: PROMOTER, placeId: PLACE, title: '겨울 콘서트', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: pastOpen });
  await db.db.insert(event).values([
    { id: PAST, productionId: PRODUCTION, promoterId: PROMOTER, venueId: null, openAt: pastOpen, startsAt: pastStart, endsAt: new Date(pastStart.getTime() + 2 * 3_600_000) },
    { id: UPCOMING, productionId: PRODUCTION, promoterId: PROMOTER, venueId: null, openAt: nextOpen, startsAt: nextStart, endsAt: new Date(nextStart.getTime() + 2 * 3_600_000) },
  ]);
});

afterAll(async () => {
  await db?.close();
  pg?.stop();
});

const catalog = (id: string, openAt: Date, startsAt: Date, sale: EventWithSale['sale']): EventWithSale => ({
  event: { id, productionId: PRODUCTION, venueId: null, openAt, startsAt, status: 'SCHEDULED' } as CatalogEvent,
  sale,
});

describe('COV2-02 search_document.sale_status', () => {
  test('지난 회차 + 오픈 전 다음 회차는 PostgreSQL과 메모리 모두 UPCOMING이다', async () => {
    const r = await db.pool.query('select sale_status from search_document where production_id = $1', [PRODUCTION]);
    const view = r.rows[0]?.sale_status;
    const memory = cardSaleStatus([catalog(PAST, pastOpen, pastStart, 'ENDED'), catalog(UPCOMING, nextOpen, nextStart, 'UPCOMING')]);
    expect(view).toBe('UPCOMING');
    expect(view).toBe(memory);
  });
});
