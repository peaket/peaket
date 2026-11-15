// 받는 층: 검색 결과·자동완성(openapi listSearchResults·getSearchSuggestions, ADR-0094, HOT-270·HOT-280).
// 메모리 저장소로 계약 모양, 정규화·필터·쪽·0건 제안·관련 공연·자동완성 몫을 본다. 실제 DB 뷰는 test-int가 본다.
import 'reflect-metadata';
import { GetSearchSuggestionsResponse, ListSearchResultsResponse } from '@peaket/contracts/openapi/catalog';
import { createService, fakeClock } from '@peaket/platform';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { MemoryCatalogRepository, SEARCH_INDEX, SearchUnavailable, type SearchIndex } from '../src/modules/catalog/index.js';
import * as searchDomain from '../src/modules/catalog/domain/search.js';
import * as normalizePkg from '@peaket/search-normalize';
import type { ProductionImageRow } from '../src/modules/catalog/domain/production-image.js';
import { testMedia, FakeIdentity, logSinkUnit } from './support.js';

// HOT-280 T-19(COV2-07): 문서 만들기·이름 색인 만들기 호출을 센다(동작은 그대로 넘긴다)
vi.mock(import('../src/modules/catalog/domain/search.js'), async (orig) => {
  const m = await orig();
  return { ...m, documentOf: vi.fn(m.documentOf) };
});
vi.mock(import('@peaket/search-normalize'), async (orig) => {
  const m = await orig();
  return { ...m, indexNames: vi.fn(m.indexNames) as typeof m.indexNames, indexName: vi.fn(m.indexName) as typeof m.indexName, nameKeys: vi.fn(m.nameKeys) };
});

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

  test('자동완성은 공연·아티스트·공연장 후보를 몫대로 주고 계약 모양이다(§4.1·§4.3) [ASVS v5.0.0-2.1.3]', async () => {
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

// ---- BAT-165 웨이브 7 T-07·T-08·T-09·T-17·T-19(메모리). 공연 300개를 둔 다른 서비스로 돌려 위 시험의 기대값을 건드리지 않는다 ----
// 정본: docs/features/search.md §7.2(242·243줄: 검색 전용 연결 묶음이 넘치면 503, 캐시 수명), §10(268·269줄: search_query·search_suggest 줄의 칸),
// §11(286줄: 가리기, 검색은 가리기 전 값으로), catalog-review.md:172(검색어는 정규화한 값 50자 이하로 로그에), :175(검색 전용 연결 묶음 포화 기록), :191(14.2.5),
// openapi.yaml ServiceUnavailable(Retry-After), ADR-0271 결정 4·5·7·10.
// 시험이 정한 줄 칸 이름(구현이 다르면 '시험 이의'): search_query = { query, results(전체 결과 수), filters(건 필터 매개변수 이름 목록), page, durationMs },
// search_suggest = { inputLength, candidates, version }, search_pool_saturated = { kind: 'security', reason }. 공통 바탕 칸(level·ts·service·env·version·az·pod·msg·traceId·spanId)과 kind·event 밖의 칸은 없다.
describe('검색 원본의 503·캐시·로그·후보 읽기(메모리)', () => {
  const N = 300;
  const repo2 = new MemoryCatalogRepository();
  const logs = logSinkUnit();
  let svc2: Awaited<ReturnType<typeof createService>>;
  const PLACE2 = randomUUID();
  const STAR = '44444444-4444-4444-8444-444444444444';
  const AURORA = ['55555555-5555-4555-8555-555555555551', '55555555-5555-4555-8555-555555555552', '55555555-5555-4555-8555-555555555553'];
  const BASE_KEYS = new Set(['level', 'ts', 'service', 'env', 'version', 'az', 'pod', 'msg', 'traceId', 'spanId', 'kind', 'event']);

  function add(id: string, title: string, genre: '콘서트' | '뮤지컬'): void {
    repo2.productions.set(id, { id, promoterId: TENANT, placeId: PLACE2, title, genre, saleReview: 'APPROVED', saleApprovedAt: at('2026-11-01T00:00:00Z') });
    const e = randomUUID();
    repo2.events.set(e, { id: e, productionId: id, venueId: null, openAt: at('2026-11-01T00:00:00Z'), startsAt: at('2026-12-20T10:00:00Z'), status: 'SCHEDULED' });
    repo2.details.set(e, { event: { endsAt: at('2026-12-20T12:00:00Z') }, place: { id: PLACE2, name: '은하홀', address: '서울' }, artists: [] } as never);
  }
  add(STAR, '별빛 12345 투어', '콘서트');
  add(AURORA[0]!, '오로라 콘서트', '콘서트');
  add(AURORA[1]!, '오로라 뮤지컬', '뮤지컬');
  add(AURORA[2]!, '오로라 투어', '콘서트');
  for (let i = 0; i < N - 4; i++) add(randomUUID(), `일반 공연 ${i}`, '콘서트');

  beforeAll(async () => {
    svc2 = await createService({
      name: 'core-svc',
      module: AppModule.register({ memory: true, catalog: repo2, media: testMedia() }),
      env: { PEAKET_ENV: 'ci', PEAKET_LOG_LEVEL: 'info' },
      clock: fakeClock({ now: NOW }),
      logDestination: logs.stream,
      adminAuthz: new FakeIdentity(),
    });
  });
  afterAll(async () => {
    await svc2?.close();
  });

  const get2 = (url: string, headers: Record<string, string> = {}) => svc2.http.inject({ method: 'GET', url, headers });
  const lines = (event: string) => logs.lines().filter((l) => l.event === event);

  test('SR-T13 ① 검색 전용 연결 묶음이 넘치면 503·Retry-After·no-store이고 search_pool_saturated를 남기며 자동완성은 그대로다 [ASVS v5.0.0-2.4.1] [ASVS v5.0.0-16.3.3] [ASVS v5.0.0-16.5.2]', async () => {
    const index = svc2.app.get<SearchIndex>(SEARCH_INDEX);
    const real = index.search.bind(index);
    let saturated = 0;
    index.search = async () => {
      saturated += 1;
      throw new SearchUnavailable('pool-timeout');
    };
    try {
      const before = lines('search_pool_saturated').length;
      const r = await get2('/v1/search?q=' + encodeURIComponent('오로라'));
      // 포화 사례가 실제로 있었는지 먼저 본다(검색이 어댑터를 부르지 않으면 이 시험은 아무것도 보지 않는다)
      expect(saturated).toBeGreaterThanOrEqual(1);
      expect(r.statusCode).toBe(503);
      expect(Number(r.headers['retry-after'])).toBeGreaterThanOrEqual(1);
      expect(r.headers['cache-control']).toBe('no-store');
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(r.headers['content-type']).toContain('application/problem+json');
      const sat = lines('search_pool_saturated').slice(before);
      expect(sat).toHaveLength(1);
      expect(sat[0]).toMatchObject({ event: 'search_pool_saturated', kind: 'security', reason: 'pool-timeout' });
      // 질의 시간 상한을 넘은 것도 같은 503이다
      index.search = async () => {
        saturated += 1;
        throw new SearchUnavailable('statement-timeout');
      };
      const slow = await get2('/v1/search?q=' + encodeURIComponent('오로라'));
      expect([slow.statusCode, slow.headers['cache-control']]).toEqual([503, 'no-store']);
      expect(lines('search_pool_saturated').slice(before).map((l) => l.reason)).toEqual(['pool-timeout', 'statement-timeout']);
      // 자동완성은 메모리 사전이 답하므로 묶음이 넘쳐도 200이다
      const sug = await get2('/v1/search/suggestions?q=' + encodeURIComponent('오로라'));
      expect(sug.statusCode).toBe(200);
      expect(sug.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60, stale-if-error=600');
      // 다른 오류는 503으로 바꾸지 않는다(포화 기록도 없다)
      index.search = async () => {
        throw new Error('다른 오류');
      };
      const other = await get2('/v1/search?q=' + encodeURIComponent('오로라'));
      expect(other.statusCode).toBe(500);
      expect(lines('search_pool_saturated').slice(before)).toHaveLength(2);
    } finally {
      index.search = real;
    }
  });

  test('정의 밖 검색 경로는 404·no-store이고 공개 캐시 머리는 200 JSON에만 달며 Set-Cookie가 없다 [ASVS v5.0.0-14.2.5]', async () => {
    for (const path of ['/v1/search/x.css', '/v1/search/suggestions/x', '/v1/search/..%2f', '/v1/search/x.js', '/v1/search/suggestions.json', '/v1/searchx']) {
      const r = await get2(path);
      expect({ path, status: r.statusCode, cache: r.headers['cache-control'], cookie: r.headers['set-cookie'] }).toEqual({ path, status: 404, cache: 'no-store', cookie: undefined });
    }
    // 200 JSON에만 공개 캐시(정본 수명, search.md:243)
    const ok = await get2('/v1/search?q=' + encodeURIComponent('오로라'));
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('application/json');
    expect(ok.headers['cache-control']).toBe('public, max-age=30, stale-while-revalidate=30, stale-if-error=600');
    expect(ok.headers['set-cookie']).toBeUndefined();
    const sug = await get2('/v1/search/suggestions?q=' + encodeURIComponent('오로라'));
    expect(sug.headers['cache-control']).toBe('public, max-age=60, stale-while-revalidate=60, stale-if-error=600');
    // 400(쪽 상한·짧은 자동완성 입력·limit 밖)에는 공개 캐시 머리가 없다
    for (const path of ['/v1/search?page=51', '/v1/search/suggestions?q=', '/v1/search?limit=21']) {
      const r = await get2(path);
      expect({ path, status: r.statusCode, publicCache: String(r.headers['cache-control'] ?? '').includes('public'), cookie: r.headers['set-cookie'] }).toEqual({ path, status: 400, publicCache: false, cookie: undefined });
    }
  });

  test('search_query·search_suggest 줄은 가린 정규화 검색어 50자 이하와 정해진 칸만 싣고 바깥 호출이 없다 [ASVS v5.0.0-16.1.1] [ASVS v5.0.0-16.2.5] [ASVS v5.0.0-14.2.3]', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const secretHeaders = { cookie: 'sid=SECRET-COOKIE', 'x-forwarded-for': '203.0.113.77', 'x-user-id': '99999999-9999-4999-8999-999999999999' };
      const before = lines('search_query').length;
      const r1 = await get2('/v1/search?q=' + encodeURIComponent('  오로라  ') + '&genre=' + encodeURIComponent('뮤지컬'), secretHeaders);
      expect(r1.statusCode).toBe(200);
      const r2 = await get2('/v1/search?q=' + encodeURIComponent('오로라') + '&page=2', secretHeaders);
      expect(r2.statusCode).toBe(200);
      const r3 = await get2('/v1/search?q=' + encodeURIComponent('010-1234-5678'), secretHeaders);
      expect(r3.statusCode).toBe(200);
      const q50 = '가'.repeat(50);
      const r4 = await get2('/v1/search?q=' + encodeURIComponent(q50), secretHeaders);
      expect(r4.statusCode).toBe(200);
      const r5 = await get2('/v1/search?q=' + encodeURIComponent('가'.repeat(51)), secretHeaders);
      expect(r5.statusCode).toBe(400);
      const got = lines('search_query').slice(before);
      // 요청마다 한 줄(400은 줄이 없다), 칸 값은 정확히
      expect(got.map((l) => ({ query: l.query, results: l.results, filters: l.filters, page: l.page }))).toEqual([
        { query: '오로라', results: 1, filters: ['genre'], page: 1 },
        { query: '오로라', results: 3, filters: [], page: 2 },
        { query: '[전화]', results: 0, filters: [], page: 1 },
        { query: q50, results: 0, filters: [], page: 1 },
      ]);
      for (const l of got) {
        expect(typeof l.durationMs).toBe('number');
        expect(l.durationMs as number).toBeGreaterThanOrEqual(0);
        expect([...String(l.query)].length).toBeLessThanOrEqual(50);
        expect(Object.keys(l).filter((k) => !BASE_KEYS.has(k) && !['query', 'results', 'filters', 'page', 'durationMs'].includes(k))).toEqual([]);
        const text = JSON.stringify(l);
        for (const secret of ['SECRET-COOKIE', '203.0.113.77', '99999999-9999-4999-8999-999999999999', '127.0.0.1', '010-1234-5678']) expect(text).not.toContain(secret);
      }

      const sBefore = lines('search_suggest').length;
      const s1 = await get2('/v1/search/suggestions?q=' + encodeURIComponent('오로'), secretHeaders);
      expect(s1.statusCode).toBe(200);
      const items = (JSON.parse(s1.payload) as { items: unknown[] }).items;
      const sl = lines('search_suggest').slice(sBefore);
      expect(sl).toHaveLength(1);
      expect(items.length).toBeGreaterThanOrEqual(3);
      expect(sl[0]).toMatchObject({ inputLength: 2, candidates: items.length });
      expect(typeof sl[0]!.version).toBe('number');
      expect(Object.keys(sl[0]!).filter((k) => !BASE_KEYS.has(k) && !['inputLength', 'candidates', 'version'].includes(k))).toEqual([]);
      // 자동완성 줄에는 입력 자체가 없다(길이만)
      expect(JSON.stringify(sl[0])).not.toContain('오로');
      // 검색 처리기는 바깥을 부르지 않는다(외부 분석·추적 도구로 보내지 않는다)
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test('SR-T17 검색 결과는 가리기 전 값으로 찾은 것과 같고 search_query 줄에는 가린 값만 남는다', async () => {
    const before = lines('search_query').length;
    const r = await get2('/v1/search?q=12345');
    expect(r.statusCode).toBe(200);
    const out = ListSearchResultsResponse.parse(json(r));
    // 가리기 전 값 '12345'로 찾았으므로 '별빛 12345 투어'가 나온다(가린 '[숫자]'로 찾았다면 0건)
    expect(out.items?.map((x) => x.productionId)).toEqual([STAR]);
    expect(out.query?.normalized).toBe('12345');
    const both = await get2('/v1/search?q=' + encodeURIComponent('별빛 12345'));
    expect(ListSearchResultsResponse.parse(json(both)).items?.map((x) => x.productionId)).toEqual([STAR]);
    const got = lines('search_query').slice(before);
    expect(got.map((l) => [l.query, l.results])).toEqual([
      ['[숫자]', 1],
      ['별빛 [숫자]', 1],
    ]);
    expect(logs.text()).not.toContain('"query":"12345"');
  });

  test('HOT-280 검색 한 번은 후보 공연만 읽고 이름 색인을 요청마다 다시 만들지 않는다(COV2-07)', async () => {
    const documentOf = vi.mocked(searchDomain.documentOf);
    const counters = [vi.mocked(normalizePkg.indexNames), vi.mocked(normalizePkg.indexName)];
    const nameKeys = vi.mocked(normalizePkg.nameKeys);
    // 첫 요청(색인을 처음 만드는 일은 셈에서 뺀다)
    expect((await get2('/v1/search?q=' + encodeURIComponent('오로라'))).statusCode).toBe(200);
    documentOf.mockClear();
    nameKeys.mockClear();
    for (const c of counters) c.mockClear();
    const r = await get2('/v1/search?q=' + encodeURIComponent('오로라 투'));
    expect(r.statusCode).toBe(200);
    expect(ListSearchResultsResponse.parse(json(r)).items?.map((x) => x.productionId)).toEqual([AURORA[2]]);
    const r2 = await get2('/v1/search?q=' + encodeURIComponent('오로라'));
    expect(ListSearchResultsResponse.parse(json(r2)).items?.map((x) => x.productionId).sort()).toEqual([...AURORA].sort());
    // 공연 300개 가운데 후보 3개: 두 요청에서 문서를 만든 수는 후보 수(요청마다 3) 이하이고, 이름 색인은 다시 만들지 않는다
    expect(documentOf.mock.calls.length).toBeLessThanOrEqual(6);
    expect(counters.map((c) => c.mock.calls.length)).toEqual([0, 0]);
    // 이름 비교 값도 카탈로그 전체(이름 수백 개)를 다시 계산하지 않는다
    expect(nameKeys.mock.calls.length).toBeLessThan(N);
  });
});
