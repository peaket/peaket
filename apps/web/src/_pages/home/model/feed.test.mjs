// 홈 피드 → 화면 값(SCR-001, d5 §5.1, openapi HomeFeed·ProductionCard·RankingFile, ADR-0199, BUILD_ORDER HOT-300)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { daysLeftText, EMPTY_HOME, openText, periodText, rankingBasis, toCard, toHomeData, toRankings } from './feed.ts';

const NOW = new Date('2026-11-05T03:00:00Z'); // 12:00 KST
const card = (o = {}) => ({
  productionId: 'p1',
  eventId: 'e1',
  title: '겨울 콘서트',
  genre: '콘서트',
  posterUrl: 'https://img.peaket.example/posters/p1',
  placeName: '피켓홀',
  periodStart: '2026-12-24',
  periodEnd: '2026-12-26',
  nextOpenAt: '2026-11-20T11:00:00Z',
  nextOpenEventId: 'e1',
  saleStatus: 'UPCOMING',
  saleEndsAt: '2026-12-25T10:00:00Z',
  minPrice: 110000,
  badges: ['HYBRID', 'PRESALE'],
  ...o,
});

test('SCR-001 카드는 대표 회차 상세로 가고 오픈 일시·기간을 한국 시각으로 쓴다', () => {
  const c = toCard(card(), NOW);
  assert.equal(c.href, '/events/e1');
  assert.equal(c.openText, '11/20(금) 20:00');
  assert.equal(c.periodText, '12/24~12/26');
  assert.equal(c.status, 'upcoming');
  assert.deepEqual(c.badge, { text: '선예매', tone: 'primary' });
  assert.equal(c.posterAlt, '겨울 콘서트 포스터');
  assert.equal(c.daysLeftText, undefined);
});

test('SCR-001 대표 회차·공연명이 없는 카드는 빼고, 하루짜리 기간은 날짜 하나다', () => {
  assert.equal(toCard(card({ eventId: undefined }), NOW), undefined);
  assert.equal(toCard(card({ title: '' }), NOW), undefined);
  assert.equal(periodText('2026-12-24', '2026-12-24'), '12/24');
  assert.equal(openText('not-a-date'), '');
});

test('SCR-001 지금 판매 중의 남은 기간은 한국 날짜 차이로 센다(판매 종료가 오늘이면 오늘 마감)', () => {
  assert.equal(toCard(card({ saleStatus: 'ON_SALE', saleEndsAt: '2026-11-17T03:00:00Z' }), NOW).daysLeftText, '12일 남음');
  assert.equal(daysLeftText('2026-11-05T10:00:00Z', NOW), '오늘 마감');
  assert.equal(daysLeftText('2026-11-05T02:00:00Z', NOW), undefined);
  // 11/13 23:00 KST에 판매 종료 11/14 10:00 KST: 시간으로는 하루 안이지만 날짜로는 내일
  assert.equal(daysLeftText('2026-11-14T01:00:00Z', new Date('2026-11-13T14:00:00Z')), '1일 남음');
  // 11/12 09:00 KST에 판매 종료 11/14 10:00 KST: 49시간이지만 날짜로는 2일
  assert.equal(daysLeftText('2026-11-14T01:00:00Z', new Date('2026-11-12T00:00:00Z')), '2일 남음');
});

test('SCR-001 피드의 빈 섹션은 빈 배열로 두고(화면이 숨긴다), 랭킹 경로는 피드 값이 아니라 정해진 같은 출처 경로다', () => {
  const d = toHomeData({ banners: [{ eventId: 'e1', alt: '배너', imageUrl: 'https://img.peaket.example/banners/b1', title: '겨울 콘서트' }, { alt: '대표 회차 없음' }], upcoming: [card()], themes: [{ name: '빈 테마', productions: [] }], places: [{ placeId: 'pl1', name: '피켓홀' }], rankingsPath: 'https://evil.example/x.json' }, NOW);
  assert.equal(d.banners.length, 1);
  assert.equal(d.banners[0].href, '/events/e1');
  assert.equal(d.themes.length, 0);
  assert.deepEqual(d.places, [{ id: 'pl1', name: '피켓홀', initial: '피', href: '/search?placeId=pl1' }]);
  assert.equal(d.rankingsPath, '/v1/home/rankings.json');
  assert.deepEqual(EMPTY_HOME.upcoming, []);
});

test('SCR-001 랭킹은 순위 순 최대 10개, 장르별로 나눈다', () => {
  const items = Array.from({ length: 12 }, (_, i) => card({ eventId: `e${i}`, rank: 12 - i }));
  const r = toRankings({ basisDate: '2026-11-04', overall: items, genres: [{ genre: '뮤지컬', items: [card({ eventId: 'm1', rank: 1 })] }] }, NOW);
  assert.equal(r.overall.length, 10);
  assert.deepEqual(r.overall.slice(0, 2).map((c) => c.rank), [1, 2]);
  assert.equal(r.byGenre['뮤지컬'][0].eventId, 'm1');
  assert.equal(toRankings({}, NOW), undefined);
});

test('SCR-001 랭킹 기준: 10시 뒤에는 어제 판매분이 정상, 하루 밀리면 판매일 문구, 2일 밀리면(파일이 2일 넘게 묵음) 숨긴다', () => {
  assert.deepEqual(rankingBasis('2026-11-04', NOW), { stale: false, text: '어제 판매 매수 기준, 매일 오전 10시 갱신' });
  assert.deepEqual(rankingBasis('2026-11-03', NOW), { stale: true, text: '11/3 판매 기준' });
  // 11/05 12:00 KST, 기준일 11/02: 기준일이 3일 지났고 파일(11/03 10:00 게시)이 50시간 묵었다(d5 §5.1, analytics §8.5)
  assert.equal(rankingBasis('2026-11-02', NOW), undefined);
});

test('SCR-001 랭킹 기준: 10시 전(게시 전)에는 그제 판매분 파일도 정상이다', () => {
  const morning = new Date('2026-11-05T00:30:00Z'); // 09:30 KST
  assert.equal(rankingBasis('2026-11-03', morning).stale, false);
  assert.equal(rankingBasis('2026-11-02', morning).stale, true);
  assert.equal(rankingBasis('2026-11-01', morning), undefined);
});
