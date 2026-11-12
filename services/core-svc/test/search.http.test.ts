// 받는 층: 검색 결과·자동완성(openapi listSearchResults·getSearchSuggestions, ADR-0094, HOT-270·HOT-280).
// 메모리 저장소로 계약 모양, 정규화·필터·쪽·0건 제안·관련 공연·자동완성 몫을 본다. 실제 DB 뷰는 test-int가 본다.
import 'reflect-metadata';
import { GetSearchSuggestionsResponse, ListSearchResultsResponse } from '@peaket/contracts/openapi/catalog';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository } from '../src/modules/catalog/index.js';
import type { ProductionImageRow } from '../src/modules/catalog/domain/production-image.js';
import { testMedia, FakeIdentity } from './support.js';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const TENANT = randomUUID();
const PLACE = randomUUID();
const ARTIST = randomUUID();
const OTHER_ARTIST = randomUUID();
const repo = new MemoryCatalogRepository();
let svc: Awaited<ReturnType<typeof createService>>;

const at = (iso: string) => new Date(iso);
function production(id: string, title: string, genre: '콘서트' | '뮤지컬', placeId: string | null = PLACE): string {
  repo.productions.set(id, { id, promoterId: TENANT, placeId, title, genre, saleReview: 'APPROVED', saleApprovedAt: at('2026-11-01T00:00:00Z') });
  repo.registrations.set(id, { aliases: [{ id: randomUUID(), alias: `${title} 다른 이름` }] } as never);
  return id;
}
function event(id: string, productionId: string, openAt: string, startsAt: string, sale: 'UPCOMING' | 'ON_SALE' | 'ENDED', place = { id: PLACE, name: '피켓홀', address: '서울' }, artists = [{ artistId: ARTIST, name: '루멘' }]): void {
  repo.events.set(id, { id, productionId, venueId: null, openAt: at(openAt), startsAt: at(startsAt), status: 'SCHEDULED' });
  repo.saleStates.set(id, sale);
  repo.details.set(id, { event: { endsAt: at(new Date(at(startsAt).getTime() + 2 * 3_600_000).toISOString()) }, place, artists });
}
function poster(id: string, productionId: string): void {
  const row: ProductionImageRow = { id, productionId, promoterId: TENANT, kind: 'POSTER', alt: '포스터', order: 0, width: 1000, height: 1400, version: 1, createdAt: at('2026-11-01T00:00:00Z'), updatedAt: at('2026-11-01T00:00:00Z') };
  repo.images.set(id, row);
}

const P1 = production('11111111-1111-4111-8111-111111111111', '루멘 콘서트', '콘서트');
const P2 = production('22222222-2222-4222-8222-222222222222', '루멘 앙코르', '콘서트');
const P3 = production('33333333-3333-4333-8333-333333333333', '다른 뮤지컬', '뮤지컬');
const E1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const E2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
const E3 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa3';
event(E1, P1, '2026-11-01T00:00:00Z', '2026-12-01T10:00:00Z', 'ON_SALE');
event(E2, P2, '2026-12-01T00:00:00Z', '2027-01-01T10:00:00Z', 'UPCOMING');
event(E3, P3, '2026-10-01T00:00:00Z', '2026-11-01T10:00:00Z', 'ENDED', { id: PLACE, name: '피켓홀', address: '서울' }, [{ artistId: OTHER_ARTIST, name: '다른 배우' }]);
poster('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb1', P1);
poster('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2', P2);
repo.wishes.set(randomUUID(), new Map([[P2, at('2026-11-01T00:00:00Z')]]));
repo.wishes.set(randomUUID(), new Map([[P2, at('2026-11-01T00:00:00Z')]]));

beforeAll(async () => {
  svc = await createService({
    name: 'core-svc',
    module: AppModule.register({ memory: true, catalog: repo, media: testMedia() }),
    env: { PEAKET_ENV: 'ci' },
    clock: fakeClock({ now: NOW }),
    adminAuthz: new FakeIdentity(),
  });
});
afterAll(async () => {
  await svc?.close();
});

const get = (url: string) => svc.http.inject({ method: 'GET', url });
const json = (r: { payload: string }) => JSON.parse(r.payload) as Record<string, unknown>;

describe('검색(메모리)', () => {
  test('SR-T2·SR-T5 제목·다른 이름으로 찾고 계약 모양으로 카드·대표 회차·포스터를 준다 [ASVS v5.0.0-1.2.1] [ASVS v5.0.0-8.1.1]', async () => {
    const r = await get('/v1/search?q=' + encodeURIComponent('루멘'));
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toContain('stale-if-error=600');
    const out = ListSearchResultsResponse.parse(json(r));
    expect(out.items?.map((x) => x.productionId)).toEqual([P1, P2]);
    expect(out.items?.[0]).toMatchObject({ eventId: E1, title: '루멘 콘서트', placeName: '피켓홀', saleStatus: 'ON_SALE', posterAlt: '포스터' });
    expect(out.items?.[0]?.posterUrl).toMatch(/^https:\/\/img\.peaket\.test\/production\//);
    expect(out.query?.normalized).toBe('루멘');
    expect(out.total).toBe(2);
  });

  test('SR-T4·SR-T9 로마자 입력은 한/영 변환으로 찾고 noConvert면 변환하지 않으며, 쪽 상한을 넘으면 400이다 [ASVS v5.0.0-2.1.3] [ASVS v5.0.0-16.5.2]', async () => {
    const converted = await get('/v1/search?q=fnaps');
    expect(converted.statusCode).toBe(200);
    const out = ListSearchResultsResponse.parse(json(converted));
    expect(out.query?.converted?.to).toBe('루멘');
    const no = await get('/v1/search?q=fnaps&noConvert=true');
    expect(ListSearchResultsResponse.parse(json(no)).items).toEqual([]);
    expect((await get('/v1/search?page=51')).statusCode).toBe(400);
  });

  test('SR-T6·필터: 장르·공연장·아티스트·기간·상태로 거르고 filterNames를 채운다 [ASVS v5.0.0-1.2.4] [ASVS v5.0.0-1.2.9] [ASVS v5.0.0-2.1.1]', async () => {
    const byGenre = await get('/v1/search?genre=' + encodeURIComponent('뮤지컬') + '&includePast=true');
    expect(ListSearchResultsResponse.parse(json(byGenre)).items?.map((x) => x.productionId)).toEqual([P3]);
    const byPlace = await get(`/v1/search?placeId=${PLACE}`);
    expect(ListSearchResultsResponse.parse(json(byPlace)).filterNames?.placeName).toBe('피켓홀');
    const byArtist = await get(`/v1/search?artistId=${ARTIST}`);
    expect(ListSearchResultsResponse.parse(json(byArtist)).items?.map((x) => x.productionId)).toEqual([P1, P2]);
    const byDate = await get('/v1/search?dateFrom=2026-12-01&dateTo=2026-12-31');
    expect(ListSearchResultsResponse.parse(json(byDate)).items?.map((x) => x.productionId)).toEqual([P1]);
    const ended = await get('/v1/search?status=ENDED&includePast=true');
    expect(ListSearchResultsResponse.parse(json(ended)).items?.map((x) => x.productionId)).toEqual([P3]);
  });

  test('SR-T4 0건이면 didYouMean·relaxedTotal을 주고, 관련 공연은 같은 아티스트의 다른 공연이다 [ASVS v5.0.0-1.3.3] [ASVS v5.0.0-1.3.12]', async () => {
    const r = await get('/v1/search?q=' + encodeURIComponent('루멘 콘서드') + '&genre=' + encodeURIComponent('뮤지컬'));
    const out = ListSearchResultsResponse.parse(json(r));
    expect(out.items).toEqual([]);
    expect(out.didYouMean).toBe('루멘 콘서트');
    expect(out.relaxedTotal).toBe(0);
    const related = ListSearchResultsResponse.parse(json(await get('/v1/search?q=' + encodeURIComponent('루멘 콘서트'))));
    expect(related.related?.basis?.kind).toBe('ARTIST');
    expect(related.related?.items?.map((x) => x.productionId)).toContain(P2);
  });

  test('SR-T11 자동완성은 공연·아티스트·공연장 후보를 몫대로 주고 계약 모양이다 [ASVS v5.0.0-2.1.3]', async () => {
    const r = await get('/v1/search/suggestions?q=' + encodeURIComponent('루'));
    expect(r.statusCode).toBe(200);
    expect(r.headers['cache-control']).toContain('stale-if-error=600');
    const out = GetSearchSuggestionsResponse.parse(json(r));
    expect(out.query).toBe('루');
    expect(out.items?.some((x) => x.kind === 'PRODUCTION' && x.productionId === P1)).toBe(true);
    expect(out.items?.some((x) => x.kind === 'ARTIST' && x.artistId === ARTIST)).toBe(true);
    expect(out.items?.length).toBeLessThanOrEqual(8);
    expect((await get('/v1/search/suggestions?q=')).statusCode).toBe(400);
  });
});
