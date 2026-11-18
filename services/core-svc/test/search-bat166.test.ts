// BAT-166 구현 뒤 시험(계획 docs/review/plans/BAT-166.md §4 A3, 그리고 SR-T4의 query.converted 몫). 메모리 사전·도메인 공개 함수의 단위 시험.
// 정본: ADR-0271 결정 23(이름 비교 값을 요청마다 후보 전체에 다시 만들지 않는다, 파드 캐시는 옛 이름으로 맞지 않게, 응답은 그대로),
// docs/features/search.md §3.2 ④(로마자만이고 ①~③이 0건일 때만 한/영 변환, '…으로 찾은 결과입니다'), 98줄(친 그대로 → 소문자 차례), SR-T4(297줄: 'LUMEN'은 바꾸지 않는다),
// §4.1(자동완성 순서: 일치 등급 → … → 이름 가나다 → ID, 종류별 몫 5·2·1, 빈 몫은 채워 8개), §5.5(0건 제안은 가장 가까운 이름 하나).
import { fakeClock } from '@peaket/platform';
import { nameKeys } from '@peaket/search-normalize';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { SuggestionDictionary, type DictionarySnapshot, type SearchDictionarySource, type SearchDocument, type SearchTermRow } from '../src/modules/catalog/index.js';
import { indexDocuments, searchDocuments, type SearchQuery } from '../src/modules/catalog/domain/search.js';

// 이름 비교 값을 만든 횟수를 센다(동작은 그대로 넘긴다). 패키지 안의 호출은 세지 않고 core-svc가 부른 것만 센다
vi.mock(import('@peaket/search-normalize'), async (orig) => {
  const m = await orig();
  return { ...m, nameKeys: vi.fn(m.nameKeys) };
});
const nameKeysCalls = () => vi.mocked(nameKeys).mock.calls.length;

const T0 = Date.parse('2026-11-18T00:00:00.000Z');

const doc = (productionId: string, title: string, o: Partial<SearchDocument> = {}): SearchDocument => ({ productionId, eventId: `${productionId}-e`, title, aliases: [], genre: '콘서트', artists: [], saleStatus: 'ON_SALE', popularity: 0, ...o });

function term(id: string, kind: SearchTermRow['kind'], targetId: string, name: string): SearchTermRow {
  const k = nameKeys(name);
  return { id, kind, targetId, displayName: name, aliasOf: null, norm: k.norm, normNospace: k.nospace, jamo: k.jamo, chosung: k.chosung, updatedVersion: 1 };
}

/** 판 하나로 통째로 읽기만 하는 원천 */
function source(documents: SearchDocument[], terms: SearchTermRow[]): SearchDictionarySource {
  return {
    version: async () => 1,
    read: async (): Promise<DictionarySnapshot> => ({ version: 1, full: true, documents, terms, removals: [] }),
  };
}

beforeEach(() => {
  vi.mocked(nameKeys).mockClear();
});

describe('SR-T13 ① 처리기 계산 줄이기(ADR-0271 결정 23)', () => {
  test('SR-T13 ① 0건 오타 제안은 사전이 만들어 둔 공연명 비교 값을 쓰고, 요청마다 공연명마다 비교 값을 다시 만들지 않는다', async () => {
    // 공연 301개. 결정 23 '이름 비교 값을 요청마다 후보 전체에 다시 만들지 않기'
    const docs = [doc('lumen', '루멘 콘서트'), ...Array.from({ length: 300 }, (_, i) => doc(`p${i}`, `일반 공연 ${i}`))];
    const dict = new SuggestionDictionary(source(docs, docs.map((d) => term(`t-${d.productionId}`, 'PRODUCTION', d.productionId, d.title))), fakeClock({ now: T0 }));
    await dict.refresh();
    // 답은 그대로다(§5.5: 가장 가까운 이름 하나)
    expect(dict.correct('루멘 콘서드')).toBe('루멘 콘서트');
    vi.mocked(nameKeys).mockClear();
    expect(dict.correct('루멘 콘서드')).toBe('루멘 콘서트');
    // 입력 하나의 비교 값만 만든다(공연 수에 비례하지 않는다)
    expect(nameKeysCalls()).toBeLessThanOrEqual(1);
  });

  test('SR-T13 ① 후보 공연의 이름 비교 값은 사전이 들고 있는 값을 그대로 쓰고, 사전에 없는 이름만 새로 만든다', () => {
    const d = doc('p1', '알려진 공연', { aliases: ['모르는 다른 이름'], placeId: 'l1', placeName: '알려진 홀', artists: [{ artistId: 'a1', name: '알려진 가수' }] });
    const known = new Map(['알려진 공연', '알려진 홀', '알려진 가수'].map((n) => [n, nameKeys(n)] as const));
    vi.mocked(nameKeys).mockClear();
    const index = indexDocuments([d], (n) => known.get(n));
    const keys = index[0]!.keys;
    // 사전에 있던 값은 같은 것(다시 만들지 않았다)
    for (const k of known.values()) expect(keys).toContain(k);
    // 새로 만든 것은 사전에 없던 이름 하나뿐이다
    expect(vi.mocked(nameKeys).mock.calls.map((c) => c[0])).toEqual(['모르는 다른 이름']);
    expect(keys).toContainEqual(nameKeys('모르는 다른 이름'));
    expect(keys).toHaveLength(4);
  });

  test('SR-T13 ① 자동완성은 일치가 많아도 종류마다 등급 → 가나다 차례의 앞쪽만 남기고, 빈 몫을 그 차례대로 채운다(§4.1)', async () => {
    // 아티스트 12명: 정확히 같은 '루멘' 하나와 이름 앞부분 11개. 사전에 넣는 차례는 거꾸로(가장 좋은 것이 마지막)
    const syll = ['가', '나', '다', '라', '마', '바', '사', '아', '자', '차', '카'];
    const artists = [...syll.map((s, i) => ({ artistId: `a${String(i + 1).padStart(2, '0')}`, name: `루멘 ${s}` })), { artistId: 'a00', name: '루멘' }].reverse();
    const docs = [doc('p1', '일반 공연', { artists })];
    const dict = new SuggestionDictionary(source(docs, [term('t-p1', 'PRODUCTION', 'p1', '일반 공연'), ...artists.map((a) => term(`t-${a.artistId}`, 'ARTIST', a.artistId, a.name))]), fakeClock({ now: T0 }));
    await dict.refresh();
    const out = dict.suggest('루멘');
    // 공연·공연장 후보가 없어 아티스트 몫 2 + 빈 몫 6 = 8개. 정본 차례: 정확히 같음 → 이름 앞부분, 같은 등급은 가나다
    expect(out.items.map((x) => [x.kind, x.label])).toEqual(['루멘', '루멘 가', '루멘 나', '루멘 다', '루멘 라', '루멘 마', '루멘 바', '루멘 사'].map((l) => ['ARTIST', l]));
  });
});

describe('SR-T4 바꿔 찾았을 때만 query.converted(§3.2 ④)', () => {
  const q = (s: string): SearchQuery => ({ q: s, includePast: true, noConvert: false, page: 1, now: new Date(T0) });
  const docs = [doc('lumen', '루멘 콘서트', { aliases: ['LUMEN'] }), doc('wet', '웻 쇼')];
  const run = (s: string) => {
    const out = searchDocuments(docs, q(s));
    return { ids: out.items.map((x) => x.productionId), converted: out.query.converted };
  };

  test("SR-T4 로마자 이름이 그대로 맞으면('LUMEN') 바꾸지 않고 query.converted가 null이다", () => {
    expect(run('LUMEN')).toEqual({ ids: ['lumen'], converted: null });
  });

  test("SR-T4 소문자 값으로 바꿔 찾았으면 query.converted.to는 실제로 찾은 그 값이다('DnPt' → '웻', 'FNAPS' → '루멘')", () => {
    // 대조군: 친 그대로 바꿔 찾은 것
    expect(run('fnaps')).toEqual({ ids: ['lumen'], converted: { from: 'fnaps', to: '루멘' } });
    // 친 그대로 '우ㅖㅅ'·'루몐'은 0건이고 소문자 'dnpt'·'fnaps'로 찾았다. 화면은 "'웻'으로 찾은 결과입니다"를 보인다
    expect(run('DnPt')).toEqual({ ids: ['wet'], converted: { from: 'DnPt', to: '웻' } });
    expect(run('FNAPS')).toEqual({ ids: ['lumen'], converted: { from: 'FNAPS', to: '루멘' } });
  });
});
