// 검색 순위·쪽·0건 제안·자동완성 몫 시험(ADR-0268, docs/features/search.md §4~§6, SR-T2·SR-T4·SR-T9·SR-T11).
import { describe, expect, test } from 'vitest';
import { documentOf, searchDocuments, suggestDocuments, type SearchDocument } from '../src/modules/catalog/domain/search.js';

const now = new Date('2026-11-12T00:00:00Z');
const doc = (id: string, title: string, o: Partial<SearchDocument> = {}): SearchDocument => ({
  productionId: id,
  title,
  aliases: [],
  genre: '콘서트',
  artists: [],
  saleStatus: 'ON_SALE',
  popularity: 0,
  ...o,
});
const q = (o: Partial<Parameters<typeof searchDocuments>[1]> = {}) => ({ q: '', includePast: false, noConvert: false, page: 1, now, ...o });

describe('검색 순위·쪽', () => {
  test('SR-T9 쪽은 20개씩이고 1,000건에서 total이 멈추며 50쪽을 넘으면 던진다', () => {
    const docs = Array.from({ length: 1_001 }, (_, i) => doc(`p${String(i).padStart(4, '0')}`, `공연 ${i}`));
    const out = searchDocuments(docs, q({ q: '공연' }));
    expect([out.limit, out.total, out.totalCapped, out.totalPages]).toEqual([20, 1_000, true, 50]);
    expect(searchDocuments(docs, q({ page: 2 })).items).toHaveLength(20);
    expect(() => searchDocuments(docs, q({ page: 51 }))).toThrow('page');
  });

  test('SR-T11 q가 없으면 OPEN_SOON, POPULAR는 관심도 순이고 같은 값은 이름·ID로 깨진다', () => {
    const docs = [
      doc('p2', '나 공연', { nextOpenAt: '2026-12-02T00:00:00Z', popularity: 5 }),
      doc('p1', '가 공연', { nextOpenAt: '2026-12-01T00:00:00Z', popularity: 5 }),
      doc('p3', '다 공연', { nextOpenAt: '2026-12-03T00:00:00Z', popularity: 9 }),
    ];
    expect(searchDocuments(docs, q()).items.map((x) => x.productionId)).toEqual(['p1', 'p2', 'p3']);
    expect(searchDocuments(docs, q({ sort: 'POPULAR' })).items.map((x) => x.productionId)).toEqual(['p3', 'p1', 'p2']);
  });

  test('SR-T4 0건이면 didYouMean을 주고, 관련 공연은 같은 아티스트의 다른 공연이다', () => {
    const docs = [
      doc('p1', '루멘 콘서트', { artists: [{ artistId: 'a1', name: '루멘' }], saleStatus: 'ON_SALE' }),
      doc('p2', '루멘 앙코르', { artists: [{ artistId: 'a1', name: '루멘' }], saleStatus: 'UPCOMING' }),
      doc('p3', '다른 공연', { saleStatus: 'UPCOMING' }),
    ];
    const miss = searchDocuments(docs, q({ q: '루멘 콘서드' }));
    expect(miss.items).toEqual([]);
    expect(miss.didYouMean).toBe('루멘 콘서트');
    const hit = searchDocuments(docs, q({ q: '루멘 콘서트' }));
    expect(hit.related?.basis?.kind).toBe('ARTIST');
    expect(hit.related?.items.map((x) => x.productionId)).toEqual(['p2']);
  });

  test('한/영 변환은 noConvert로 끄고, 변환했으면 query.converted에 남긴다', () => {
    const docs = [doc('p1', '루멘 콘서트')];
    const converted = searchDocuments(docs, q({ q: 'fnaps' }));
    expect(converted.items.map((x) => x.productionId)).toEqual(['p1']);
    expect(converted.query.converted).toEqual({ from: 'fnaps', to: '루멘' });
    expect(searchDocuments(docs, q({ q: 'fnaps', noConvert: true })).items).toEqual([]);
  });
});

describe('자동완성 몫', () => {
  test('SR-T11 공연 5·아티스트 2·공연장 1을 먼저 채우고 빈 몫은 다른 종류로 채운다', () => {
    const docs = Array.from({ length: 7 }, (_, i) => doc(`p${i}`, `피켓 공연 ${i}`, { artists: i < 3 ? [{ artistId: `a${i}`, name: `피켓 배우 ${i}` }] : [], ...(i < 2 ? { placeId: `pl${i}`, placeName: `피켓홀 ${i}` } : {}) }));
    const out = suggestDocuments(docs, '피켓');
    expect(out.items.filter((x) => x.kind === 'PRODUCTION')).toHaveLength(5);
    expect(out.items.filter((x) => x.kind === 'ARTIST')).toHaveLength(2);
    expect(out.items.filter((x) => x.kind === 'PLACE')).toHaveLength(1);
    expect(out.items).toHaveLength(8);
    expect(out.items.every((x) => x.matches?.[0]?.start === 0)).toBe(true);
  });

  test('한 글자 로마자 입력은 자동완성하지 않고, 한글 한 글자는 찾는다', () => {
    const docs = [doc('p1', '피켓 공연')];
    expect(suggestDocuments(docs, 'p').items).toEqual([]);
    expect(suggestDocuments(docs, '피').items[0]?.productionId).toBe('p1');
  });
});

describe('documentOf', () => {
  test('공개 회차에서 대표 회차·판매 상태·기간·다음 오픈을 만든다', () => {
    const d = documentOf({
      productionId: 'p1',
      title: '루멘 콘서트',
      genre: '콘서트',
      events: [
        { id: 'e1', openAt: new Date('2026-11-01T00:00:00Z'), startsAt: new Date('2026-12-01T10:00:00Z'), endsAt: new Date('2026-12-01T12:00:00Z'), status: 'SCHEDULED', sale: 'ON_SALE' },
        { id: 'e2', openAt: new Date('2026-12-01T00:00:00Z'), startsAt: new Date('2027-01-01T10:00:00Z'), endsAt: new Date('2027-01-01T12:00:00Z'), status: 'SCHEDULED', sale: 'UPCOMING' },
      ],
      now,
    })!;
    expect([d.eventId, d.saleStatus, d.periodStart, d.periodEnd]).toEqual(['e1', 'ON_SALE', '2026-12-01', '2027-01-01']);
    expect(d.nextOpenEventId).toBe('e2');
  });
});
