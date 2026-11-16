// 검색 순위·쪽·0건 제안·자동완성 몫 시험(ADR-0268, docs/features/search.md §4~§6, SR-T2·SR-T4·SR-T9).
// SR-T11 ①(같은 검색이 같은 요청 주소)은 브라우저 시험(apps/web autocomplete.test.mjs)이 본다. 여기 순서·몫 시험은 그 ID를 달지 않는다(BAT-165 웨이브 7 T-24).
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

  test('q가 없으면 OPEN_SOON, POPULAR는 관심도 순이고 같은 값은 이름·ID로 깨진다(§5.3)', () => {
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
  test('자동완성은 공연 5·아티스트 2·공연장 1을 먼저 채우고 빈 몫은 다른 종류로 채운다(§4.1)', () => {
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

describe('관련 공연(§6)', () => {
  test('검색어 없이 필터로 0건인 목록의 관련 공연은 오픈 예정 인기 공연이고, 결과가 있는 목록에는 관련 공연이 없다(§6, R165-22)', () => {
    // 맨 위 결과(판매 중 '나 공연')의 아티스트에 필터로 빠진 다른 공연('다 공연', 뮤지컬)을 둔다. 검색어 없는 목록이 관련 공연을 고르면 이것이 나온다(V165-22: 근거 공연이 없던 옛 자료는 빈 시험이었다)
    const docs = [
      doc('p1', '가 공연', { genre: '콘서트', saleStatus: 'UPCOMING', popularity: 3 }),
      doc('p2', '나 공연', { genre: '콘서트', saleStatus: 'ON_SALE', popularity: 9, artists: [{ artistId: 'a1', name: '루멘' }], placeId: 'pl1', placeName: '피켓홀' }),
      doc('p3', '다 공연', { genre: '뮤지컬', saleStatus: 'UPCOMING', popularity: 5, artists: [{ artistId: 'a1', name: '루멘' }], placeId: 'pl1', placeName: '피켓홀' }),
    ];
    const zero = searchDocuments(docs, q({ genre: '연극' }));
    expect(zero.items).toEqual([]);
    expect(zero.related?.basis?.kind).toBe('UPCOMING_POPULAR');
    expect(zero.related?.items.length).toBeGreaterThanOrEqual(1);
    const some = searchDocuments(docs, q({ genre: '콘서트' }));
    expect(some.items.length).toBe(2);
    expect(some.related ?? null).toBeNull();
  });
});

describe('검증에서 살아남은 틀린 구현(BAT-165 검증 V165)', () => {
  test('SR-T9 같은 점수 공연 30개는 1·2쪽에 겹침·빠짐 없이 공연 ID 차례로 나뉜다(V165-2)', () => {
    // 이름·판매 상태·관심도가 모두 같다(정확도 정렬의 끝 키는 공연 ID, search.md §5.3 '모든 정렬의 끝을 공연 ID로')
    const ids = Array.from({ length: 30 }, (_, i) => `p${String(i).padStart(2, '0')}`);
    const shuffled = [...ids].sort((a, b) => (a.charCodeAt(2) * 7 + a.charCodeAt(1)) % 13 - (b.charCodeAt(2) * 7 + b.charCodeAt(1)) % 13 || (a < b ? 1 : -1));
    const docs = shuffled.map((id) => doc(id, '같은 점수 공연', { popularity: 4 }));
    for (const sort of [undefined, 'POPULAR', 'OPEN_SOON'] as const) {
      const p1 = searchDocuments(docs, q({ q: '같은 점수', page: 1, ...(sort ? { sort } : {}) })).items.map((x) => x.productionId);
      const p2 = searchDocuments(docs, q({ q: '같은 점수', page: 2, ...(sort ? { sort } : {}) })).items.map((x) => x.productionId);
      expect({ sort, n1: p1.length, n2: p2.length }).toEqual({ sort, n1: 20, n2: 10 });
      expect({ sort, overlap: p1.filter((x) => p2.includes(x)) }).toEqual({ sort, overlap: [] });
      expect({ sort, all: [...p1, ...p2] }).toEqual({ sort, all: ids });
    }
  });

  test('0건 제안은 편집 거리 2인 오타에 제안하고 3이면 없다(긴 이름, §5.5 2·§4.4, V165-4)', () => {
    const docs = [doc('p1', '라이온킹'), doc('p2', '오페라의 유령')];
    // 두 군데 다름(낱자로도 둘): 제안을 받는다
    expect(searchDocuments(docs, q({ q: '라이언깅' })).didYouMean).toBe('라이온킹');
    expect(searchDocuments(docs, q({ q: '오패라의 유렁' })).didYouMean).toBe('오페라의 유령');
    // 세 군데 다름: 제안이 없다
    expect(searchDocuments(docs, q({ q: '러이언깅' })).items).toEqual([]);
    expect(searchDocuments(docs, q({ q: '러이언깅' })).didYouMean).toBeNull();
  });

  test('0건 제안은 같은 거리의 이름이 여럿이면 넣은 차례와 상관없이 가나다 앞쪽을 고른다(§5.5 2, V165-5)', () => {
    const a = doc('p1', '가나다');
    const b = doc('p2', '가나마');
    for (const docs of [
      [a, b],
      [b, a],
    ]) {
      expect(searchDocuments(docs, q({ q: '가나라' })).didYouMean).toBe('가나다');
    }
  });

  test('결과가 있는데 맨 위 결과에 근거(아티스트·공연장)가 없으면 관련 공연을 숨기고 인기 공연으로 채우지 않는다(§6, V165-6)', () => {
    const docs = [
      // 맨 위 결과: 아티스트는 있지만 그 아티스트의 다른 공연이 없고, 공연장이 없다
      doc('p1', '루멘 단독', { saleStatus: 'ON_SALE', artists: [{ artistId: 'a1', name: '루멘' }] }),
      // 인기 공연 후보(채우면 나올 것들)
      doc('p2', '다른 인기 공연', { saleStatus: 'UPCOMING', popularity: 99 }),
      doc('p3', '또 다른 공연', { saleStatus: 'UPCOMING', popularity: 50 }),
    ];
    const out = searchDocuments(docs, q({ q: '루멘 단독' }));
    expect(out.items.map((x) => x.productionId)).toEqual(['p1']);
    expect(out.related ?? null).toBeNull();
    // 대조군: 결과가 0건이면 인기 공연이다
    expect(searchDocuments(docs, q({ q: '없는공연이름하나' })).related?.basis?.kind).toBe('UPCOMING_POPULAR');
  });

  test('짧은 이름의 0건 제안은 낱자 거리가 낱자 길이 ÷ 4(최소 1) 안일 때만이다(§4.4, V165-4 정본 경계)', () => {
    // '루멘'은 낱자 다섯(ㄹㅜㅁㅔㄴ) → 기준 1(5 ÷ 4의 몫). '루만'은 낱자 하나 다름 → 제안, '라만'은 낱자 둘 다름 → 없음
    const docs = [doc('p1', '루멘')];
    expect(searchDocuments(docs, q({ q: '루만' })).didYouMean).toBe('루멘');
    expect(searchDocuments(docs, q({ q: '라만' })).didYouMean).toBeNull();
  });
});
