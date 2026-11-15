// 검색 읽기 모델 원천의 판매 상태·대표 회차·다음 오픈·판매 종료(COV2-02, BAT-165 웨이브 7 T-04, ADR-0271 결정 1).
// 원천 함수 search_document_source_at(at)을 시각을 넘겨 부르고, 같은 회차로 메모리 documentOf가 내는 값과 정본 값을 함께 견준다.
// 정본: ADR-0093 결정 8(대표 회차: ① 판매 중 회차 가운데 판매 종료가 가장 이른 것 → ② 오픈 예정 가운데 오픈이 가장 이른 것 → ④ 가장 최근에 공연한 것,
// 취소된 회차는 고르지 않는다. 카드 판매 상태: 판매 중이 하나라도 있으면 판매 중, 없고 오픈 예정이 있으면 오픈 예정, 모두 판매 종료면 끝남),
// docs/data.md:547(판매 종료 = 마지막 회차의 판매 종료), 판매 종료 = 공연 시작 − 24시간(회차 판매 상태: open_at <= at < starts_at − 24시간이면 판매 중).
// search_term 칸은 @peaket/search-normalize nameKeys와 같은 값이다(ADR-0271 결정 1, HOT-270 단계 줄).
import 'reflect-metadata';
import { createDatabase, type Database } from '@peaket/platform';
import { nameKeys } from '@peaket/search-normalize';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { migrateCore } from '../scripts/migrate.mjs';
import { artist, event, place, production, productionArtist, promoter, searchAlias } from '../src/modules/catalog/adapters/db/schema.js';
import { DrizzleSearchReadModel } from '../src/modules/catalog/index.js';
import { documentOf } from '../src/modules/catalog/domain/search.js';
import type { EventSaleState } from '../src/modules/catalog/domain/production.js';
import { startPostgres, type PostgresContainer } from './postgres.js';

let pg: PostgresContainer;
let db: Database;
const PROMOTER = randomUUID();
const PLACE = randomUUID();
const H = 3_600_000;
const D = 24 * H;
// 기준 시각(앱 시계). 원천 함수에 이 값을 넘긴다
const A = Date.parse('2026-11-16T03:00:00.000Z');

beforeAll(async () => {
  pg = await startPostgres();
  await migrateCore(pg.url);
  db = createDatabase({ url: pg.url, applicationName: 'core-search-sale-status-int', max: 2 });
  await db.db.insert(promoter).values({ id: PROMOTER, legalName: '(주)에이' });
  await db.db.insert(place).values({ id: PLACE, name: '피켓홀', address: '서울', region: '서울', createdBy: PROMOTER });
});

afterAll(async () => {
  await db?.close();
  pg?.stop();
});

interface Ev {
  key: string;
  open: number;
  start: number;
  cancelled?: boolean;
}

/** 정본 규칙의 회차 판매 상태(시험이 적은 값) */
const saleAt = (at: number, e: Ev): EventSaleState => (at < e.open ? 'UPCOMING' : at >= e.start - D ? 'ENDED' : 'ON_SALE');

async function seed(evs: Ev[]): Promise<{ productionId: string; ids: Record<string, string> }> {
  const productionId = randomUUID();
  await db.db.insert(production).values({ id: productionId, promoterId: PROMOTER, placeId: PLACE, title: `대표 회차 ${productionId.slice(0, 8)}`, genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date(A - 30 * D) });
  const ids: Record<string, string> = {};
  for (const e of evs) {
    ids[e.key] = randomUUID();
    await db.db.insert(event).values({ id: ids[e.key]!, productionId, promoterId: PROMOTER, venueId: null, openAt: new Date(e.open), startsAt: new Date(e.start), endsAt: new Date(e.start + 2 * H), ...(e.cancelled ? { status: 'CANCELLED' } : {}) });
  }
  return { productionId, ids };
}

async function sourceAt(at: number, productionId: string) {
  const r = await db.pool.query('select representative_event_id, sale_status, next_open_at, next_open_event_id, sale_ends_at from search_document_source_at($1) where production_id = $2', [new Date(at), productionId]);
  expect(r.rows).toHaveLength(1);
  const row = r.rows[0] as Record<string, unknown>;
  const iso = (v: unknown) => (v === null ? null : new Date(v as string | Date).toISOString());
  return { rep: row.representative_event_id, status: row.sale_status, nextOpen: row.next_open_event_id ?? null, nextOpenAt: iso(row.next_open_at), saleEnds: iso(row.sale_ends_at) };
}

function memoryAt(at: number, productionId: string, evs: Ev[], ids: Record<string, string>) {
  const d = documentOf({
    productionId,
    title: 'x',
    genre: '콘서트',
    events: evs.map((e) => ({ id: ids[e.key]!, openAt: new Date(e.open), startsAt: new Date(e.start), endsAt: new Date(e.start + 2 * H), status: e.cancelled ? ('CANCELLED' as const) : ('SCHEDULED' as const), sale: saleAt(at, e) })),
    now: new Date(at),
  })!;
  return { rep: d.eventId, status: d.saleStatus, nextOpen: d.nextOpenEventId ?? null, nextOpenAt: d.nextOpenAt ?? null, saleEnds: d.saleEndsAt ?? null };
}

// 경우: 회차, 넘길 시각, 정본으로 적은 기대(대표 회차 키·판매 상태·다음 오픈 회차 키)
const CASES: { name: string; evs: Ev[]; at: number; rep: string; status: string; next: string | null }[] = [
  { name: '지난 + 오픈 전', evs: [{ key: 'past', open: A - 3 * D, start: A - 2 * D }, { key: 'next', open: A + 7 * D, start: A + 8 * D }], at: A, rep: 'next', status: 'UPCOMING', next: 'next' },
  { name: '지난 + 판매 중', evs: [{ key: 'past', open: A - 10 * D, start: A - 2 * D }, { key: 'live', open: A - D, start: A + 5 * D }], at: A, rep: 'live', status: 'ON_SALE', next: null },
  { name: '판매 중 + 오픈 전', evs: [{ key: 'live', open: A - D, start: A + 5 * D }, { key: 'up', open: A + 2 * D, start: A + 9 * D }], at: A, rep: 'live', status: 'ON_SALE', next: 'up' },
  // 오픈 차례(early가 먼저)와 판매 종료 차례(soon이 먼저)가 반대: 판매 종료가 이른 soon이 대표다
  { name: '판매 중 둘(오픈 순서와 판매 종료 순서가 반대)', evs: [{ key: 'early', open: A - 5 * D, start: A + 10 * D }, { key: 'soon', open: A - D, start: A + 4 * D }], at: A, rep: 'soon', status: 'ON_SALE', next: null },
  // 지난 회차뿐: 가장 최근에 공연한 것
  { name: '지난 둘(가장 최근 공연)', evs: [{ key: 'old', open: A - 20 * D, start: A - 10 * D }, { key: 'recent', open: A - 8 * D, start: A - 3 * D }], at: A, rep: 'recent', status: 'ENDED', next: null },
  { name: '취소된 판매 중 + 오픈 전', evs: [{ key: 'gone', open: A - D, start: A + 5 * D, cancelled: true }, { key: 'up', open: A + 2 * D, start: A + 9 * D }], at: A, rep: 'up', status: 'UPCOMING', next: 'up' },
  // 오픈 시각 경계: at = open_at이면 판매 중, 1ms 전이면 오픈 예정
  { name: 'at = open_at', evs: [{ key: 'e', open: A, start: A + 5 * D }], at: A, rep: 'e', status: 'ON_SALE', next: null },
  { name: 'at = open_at − 1ms', evs: [{ key: 'e', open: A, start: A + 5 * D }], at: A - 1, rep: 'e', status: 'UPCOMING', next: 'e' },
  // 판매 종료 경계: at = starts_at − 24시간이면 끝남, 1ms 전이면 판매 중
  { name: 'at = starts_at − 24시간', evs: [{ key: 'e', open: A - 5 * D, start: A + D }], at: A, rep: 'e', status: 'ENDED', next: null },
  { name: 'at = starts_at − 24시간 − 1ms', evs: [{ key: 'e', open: A - 5 * D, start: A + D }], at: A - 1, rep: 'e', status: 'ON_SALE', next: null },
];

describe('COV2-02 검색 읽기 모델 원천', () => {
  test('HOT-270 원천 함수의 판매 상태·대표 회차·다음 오픈·판매 종료가 메모리 documentOf와 같다(COV2-02)', async () => {
    expect(CASES).toHaveLength(10);
    for (const c of CASES) {
      const { productionId, ids } = await seed(c.evs);
      const live = c.evs.filter((e) => !e.cancelled);
      const expected = {
        rep: ids[c.rep],
        status: c.status,
        nextOpen: c.next === null ? null : ids[c.next],
        nextOpenAt: c.next === null ? null : new Date(c.evs.find((e) => e.key === c.next)!.open).toISOString(),
        saleEnds: new Date(Math.max(...live.map((e) => e.start)) - D).toISOString(),
      };
      const memory = memoryAt(c.at, productionId, c.evs, ids);
      expect({ case: c.name, memory }).toEqual({ case: c.name, memory: expected });
      const source = await sourceAt(c.at, productionId);
      expect({ case: c.name, source }).toEqual({ case: c.name, source: expected });
    }
  });

  test('HOT-270 동기화한 search_term의 norm·norm_nospace·jamo·chosung이 @peaket/search-normalize nameKeys 값과 같다', async () => {
    const productionId = randomUUID();
    const artistId = randomUUID();
    const placeId = randomUUID();
    const actor = randomUUID();
    await db.db.insert(place).values({ id: placeId, name: 'KSPO　DOME', address: '서울', region: '서울', createdBy: actor });
    await db.db.insert(artist).values({ id: artistId, name: '루멘', createdBy: actor });
    await db.db.insert(production).values({ id: productionId, promoterId: PROMOTER, placeId, title: '루멘 콘서트 2026 서울', genre: '콘서트', saleReview: 'APPROVED', saleApprovedAt: new Date(A - 30 * D) });
    await db.db.insert(productionArtist).values({ productionId, artistId, sortOrder: 0 });
    await db.db.insert(searchAlias).values({ id: randomUUID(), targetKind: 'PRODUCTION', targetId: productionId, alias: 'ＬＵＭＥＮ 콘서트', source: 'PARTNER', createdBy: actor });
    await db.db.insert(event).values({ id: randomUUID(), productionId, promoterId: PROMOTER, venueId: null, openAt: new Date(A - D), startsAt: new Date(A + 10 * D), endsAt: new Date(A + 10 * D + 2 * H) });

    const sync = new DrizzleSearchReadModel(db);
    const out = await db.transaction((tx) => sync.sync(tx, [productionId], new Date(A)));
    const r = await db.pool.query('select kind, target_id, display_name, alias_of, norm, norm_nospace, jamo, chosung, updated_version from search_term where target_id = any($1::uuid[]) order by kind, display_name', [[productionId, artistId, placeId]]);
    const rows = r.rows as Record<string, unknown>[];
    expect(rows.map((x) => [x.kind, x.target_id, x.display_name, x.alias_of])).toEqual([
      ['ARTIST', artistId, '루멘', null],
      ['PLACE', placeId, 'KSPO　DOME', null],
      ['PRODUCTION', productionId, '루멘 콘서트 2026 서울', null],
      ['PRODUCTION', productionId, 'ＬＵＭＥＮ 콘서트', '루멘 콘서트 2026 서울'],
    ]);
    for (const x of rows) {
      const k = nameKeys(x.display_name as string);
      expect({ name: x.display_name, norm: x.norm, nospace: x.norm_nospace, jamo: x.jamo, chosung: x.chosung }).toEqual({ name: x.display_name, norm: k.norm, nospace: k.nospace, jamo: k.jamo, chosung: k.chosung });
      expect(Number(x.updated_version)).toBe(out.version);
    }
  });
});
