// 검색 결과 주소 ↔ 조건 ↔ 계약 매개변수와 응답 → 화면 값(SCR-003, d5 §5.3, docs/features/search.md §5·§6, BUILD_ORDER HOT-312)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveSort, josa, MAX_PAGE, pageNumbers, readQuery, searchUrl, toApiParams, toResultView } from './search.ts';

const sp = (s) => new URLSearchParams(s);

test('주소를 검색 조건으로 읽는다: 필터는 하나씩, 옛 이름(venue)·대문자 상태도 받고 모르는 값은 버린다', () => {
  const q = readQuery(sp('q=%20루멘%20&genre=concert&status=UPCOMING&venue=a1d2c3b4-0000-4000-8000-000000000001&artistId=x&includePast=true&sort=popular&page=3&dateFrom=2026-12-01&dateTo=bad'));
  assert.deepEqual(q, {
    q: '루멘',
    filters: { genre: 'concert', status: 'upcoming', placeId: 'a1d2c3b4-0000-4000-8000-000000000001', artistId: 'x', dateFrom: '2026-12-01', includePast: true },
    sort: 'popular',
    page: 3,
    noConvert: false,
  });
  assert.deepEqual(readQuery(sp('genre=jazz&status=nope&page=0&sort=x&artistId=%3Cs%3E')), { q: '', filters: { includePast: false }, page: 1, noConvert: false });
  assert.equal(readQuery(sp('page=999')).page, MAX_PAGE, '쪽 상한(page × 20 ≤ 1,000)');
  assert.equal(readQuery(sp(`q=${'가'.repeat(80)}`)).q.length, 50);
});

test('정렬 기본은 검색어가 있으면 정확도, 없으면 오픈 임박이다', () => {
  assert.equal(effectiveSort({ q: '루멘' }), 'relevance');
  assert.equal(effectiveSort({ q: '' }), 'opening');
  assert.equal(effectiveSort({ q: '', sort: 'popular' }), 'popular');
});

test('계약 매개변수로 바꾼다: 장르는 정본 이름, 상태·정렬은 대문자, limit는 20, 값이 없는 칸은 싣지 않는다', () => {
  assert.deepEqual(toApiParams(readQuery(sp('q=루멘&genre=concert&status=on_sale&sort=opening&noConvert=true&page=2'))), {
    q: '루멘',
    genre: '콘서트',
    status: 'ON_SALE',
    noConvert: true,
    sort: 'OPEN_SOON',
    page: 2,
    limit: 20,
  });
  assert.deepEqual(toApiParams(readQuery(sp(''))), { page: 1, limit: 20 });
  // 기본 정렬과 같으면 싣지 않는다(CDN 캐시 칸이 갈리지 않게), q는 NFKC·공백 정리
  assert.deepEqual(toApiParams(readQuery(sp('q=%EF%BC%A1%20%20b&sort=relevance'))), { q: 'A b', page: 1, limit: 20 });
  assert.equal(searchUrl(readQuery(sp('q=x')), { sort: 'relevance' }), '/search?q=x');
});

test('같은 검색에서 값 하나만 바꾼 주소: 필터·정렬·검색어를 바꾸면 1쪽으로, 한/영 변환 끄기는 풀린다', () => {
  const q = readQuery(sp('q=fnaps&genre=concert&page=3&noConvert=true'));
  assert.equal(searchUrl(q), '/search?q=fnaps&genre=concert&noConvert=true&page=3');
  assert.equal(searchUrl(q, { page: 4 }), '/search?q=fnaps&genre=concert&noConvert=true&page=4');
  assert.equal(searchUrl(q, { filters: { includePast: false } }), '/search?q=fnaps');
  assert.equal(searchUrl(q, { sort: 'popular' }), '/search?q=fnaps&genre=concert&sort=popular');
  assert.equal(searchUrl(readQuery(sp('')), {}), '/search');
});

const card = (o = {}) => ({
  productionId: 'p1',
  eventId: 'e1',
  title: '겨울 콘서트',
  genre: '콘서트',
  posterUrl: 'https://img.peaket.example/posters/p1',
  posterAlt: '겨울 콘서트 포스터',
  placeName: '피켓 아레나',
  periodStart: '2026-12-24',
  periodEnd: '2026-12-26',
  nextOpenAt: '2026-11-20T11:00:00Z',
  saleStatus: 'UPCOMING',
  ...o,
});

test('[ASVS v5.0.0-1.2.1] 검색 응답을 화면 값으로 바꾼다(카드·쪽·바꿔 찾기·0건 제안·필터 풀기 수·관련 공연·필터 이름)', () => {
  const v = toResultView({
    items: [card(), card({ productionId: 'p2', eventId: undefined })],
    page: 1,
    limit: 20,
    total: 128,
    totalCapped: false,
    totalPages: 7,
    query: { normalized: 'fnaps', converted: { from: 'fnaps', to: '루멘' } },
    didYouMean: null,
    relaxedTotal: null,
    related: { basis: { kind: 'ARTIST', id: 'a1', name: 'LUMEN' }, items: [card({ productionId: 'p3', eventId: 'e3', title: '봄날 팬미팅' })] },
    filterNames: { placeName: '피켓 아레나', artistName: null },
  });
  assert.equal(v.cards.length, 1, '대표 회차가 없는 카드는 빼고 그린다');
  assert.deepEqual(v.cards[0], {
    id: 'p1',
    href: '/events/e1',
    title: '겨울 콘서트',
    period: '12/24~12/26',
    venue: '피켓 아레나',
    openMeta: '11/20(금) 20:00 오픈',
    status: 'upcoming',
    posterUrl: 'https://img.peaket.example/posters/p1',
    posterAlt: '겨울 콘서트 포스터',
  });
  assert.deepEqual([v.total, v.pages, v.page], [128, 7, 1]);
  assert.deepEqual(v.converted, { from: 'fnaps', to: '루멘' });
  assert.equal(v.related.title, 'LUMEN의 다른 공연');
  assert.equal(v.placeName, '피켓 아레나');
  assert.equal(v.artistName, undefined);
  const empty = toResultView({ items: [], page: 1, total: 0, totalPages: 0, didYouMean: '루멘', relaxedTotal: 12, related: { basis: { kind: 'UPCOMING_POPULAR', id: null, name: null }, items: [card()] } });
  assert.deepEqual([empty.total, empty.didYouMean, empty.relaxedTotal, empty.related.title], [0, '루멘', 12, '오픈 예정 인기 공연']);
});

test('쪽 번호와 조사', () => {
  assert.deepEqual(pageNumbers(1, 7), [1, 2, 3, null, 7]);
  assert.deepEqual(pageNumbers(4, 7), [1, null, 3, 4, 5, null, 7]);
  assert.deepEqual(pageNumbers(1, 3), [1, 2, 3]);
  assert.equal(josa('루멘', '을'), '을');
  assert.equal(josa('LUMEN', '으로'), '로');
  assert.equal(josa('서울', '으로'), '로');
});
