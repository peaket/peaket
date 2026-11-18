// BAT-166 2만 미달 뒤 고침(커밋 60a136b4, 계획 '구현 메모' 2만 미달 뒤 고침)의 시험: 그 쪽까지만 고르기와 큰 후보를 끊어 처리하기.
// 정본: docs/features/search.md §5.3(정렬 차례, '모든 정렬의 끝을 공연 ID로 두어, 같은 검색에서 쪽을 넘겨도 같은 공연이 두 번 나오거나 빠지지 않는다'),
// §5.4(한 쪽 20개, page × 20 ≤ 1,000, 결과가 1,000을 넘으면 total 1000·totalCapped 참), ADR-0268 결정 3(등급 → 판매 상태 → 관심도 → 이름 → ID),
// ADR-0271 결정 23(응답은 바뀌지 않는다, 주 스레드가 다 차지 않게). 쪽 크기·상한은 정본 값을 적는다(코드 상수를 가져오지 않는다).
// 같은 이름의 공연만 두어 이름 차례가 끼지 않게 하고, 동점은 관심도·판매 상태·오픈 시각으로 만든다. 끝은 늘 ID다.
import { fakeClock } from '@peaket/platform';
import { nameKeys } from '@peaket/search-normalize';
import { describe, expect, test } from 'vitest';
import type { Database } from '@peaket/platform';
import { DrizzleSearchIndex, SuggestionDictionary, type DictionarySnapshot, type SearchDictionarySource, type SearchDocument, type SearchTermRow } from '../src/modules/catalog/index.js';
import { firstSorted, searchDocuments, type SearchQuery } from '../src/modules/catalog/domain/search.js';
import type { DocumentRow } from '../src/modules/catalog/adapters/db/search-rows.js';

const PAGE = 20;
const CAP = 1_000;
const T0 = Date.parse('2026-11-19T00:00:00.000Z');
const TITLE = '같은 이름 공연';
const pid = (n: number) => `p-${String(n).padStart(5, '0')}`;
const q = (s: string, o: Partial<SearchQuery> = {}): SearchQuery => ({ q: s, includePast: true, noConvert: false, page: 1, now: new Date(T0), ...o });
const doc = (n: number, o: Partial<SearchDocument> = {}): SearchDocument => ({ productionId: pid(n), eventId: `${pid(n)}-e`, title: TITLE, aliases: [], genre: '콘서트', artists: [], saleStatus: 'ON_SALE', popularity: 0, ...o });
const ids = (out: { items: { productionId: string }[] }) => out.items.map((x) => x.productionId);
/** 정해진 섞기(넣는 차례가 답에 영향을 주지 않는지 본다) */
const shuffle = <T>(xs: T[]): T[] => {
  const out = [...xs];
  let s = 7;
  for (let i = out.length - 1; i > 0; i--) {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};
const pages = (docs: SearchDocument[], o: Partial<SearchQuery> = {}) => {
  const first = searchDocuments(docs, q('같은 이름', o));
  const all = [first];
  for (let p = 2; p <= first.totalPages; p++) all.push(searchDocuments(docs, q('같은 이름', { ...o, page: p })));
  return all;
};

describe('SR-T13 ① 그 쪽까지만 골라도 정렬·쪽은 그대로(§5.3·§5.4)', () => {
  test('SR-T13 ① 동점이 없으면 공연 ID 차례로 20번째·21번째가 쪽 경계이고 마지막 쪽은 남은 수, 그 뒤 쪽은 빈 목록이다', () => {
    const docs = shuffle(Array.from({ length: 45 }, (_, n) => doc(n)));
    const want = Array.from({ length: 45 }, (_, n) => pid(n));
    const p1 = searchDocuments(docs, q('같은 이름'));
    expect([p1.total, p1.totalPages, p1.totalCapped]).toEqual([45, 3, false]);
    expect(ids(p1)).toEqual(want.slice(0, PAGE));
    expect(ids(searchDocuments(docs, q('같은 이름', { page: 2 })))).toEqual(want.slice(PAGE, 2 * PAGE));
    expect(ids(searchDocuments(docs, q('같은 이름', { page: 3 })))).toEqual(want.slice(2 * PAGE));
    expect(ids(searchDocuments(docs, q('같은 이름', { page: 4 })))).toEqual([]);
  });

  test('SR-T13 ① 관심도 동점 무리가 쪽 경계에 걸쳐도 쪽마다 차례가 이어지고 같은 공연이 두 번 나오거나 빠지지 않는다(정확도·인기 순)', () => {
    // 관심도 5인 공연 25개와 3인 공연 25개: 1쪽은 5의 앞 20개, 2쪽은 5의 남은 5개와 3의 앞 15개
    const docs = shuffle(Array.from({ length: 50 }, (_, n) => doc(n, { popularity: n % 2 === 0 ? 5 : 3 })));
    const five = Array.from({ length: 50 }, (_, n) => n).filter((n) => n % 2 === 0).map(pid);
    const three = Array.from({ length: 50 }, (_, n) => n).filter((n) => n % 2 === 1).map(pid);
    for (const sort of ['RELEVANCE', 'POPULAR'] as const) {
      const all = pages(docs, { sort });
      expect(all.map(ids), sort).toEqual([five.slice(0, 20), [...five.slice(20), ...three.slice(0, 15)], three.slice(15)]);
    }
  });

  test('SR-T13 ① 판매 상태·관심도·오픈 시각 동점이 여럿 섞여도 여러 쪽을 이은 차례가 정본 차례(정확도·오픈 임박·인기)이고 빠짐·겹침이 없다', () => {
    const status = ['ON_SALE', 'UPCOMING', 'SOLD_OUT', 'ENDED'] as const;
    const rank = { ON_SALE: 0, UPCOMING: 1, SOLD_OUT: 2, ENDED: 3 } as const;
    const byId = (a: SearchDocument, b: SearchDocument) => (a.productionId < b.productionId ? -1 : a.productionId > b.productionId ? 1 : 0);
    const N = 137;
    // 정본 차례(§5.3, 이름이 모두 같아 이름 차례는 빠진다). 정본과 코드가 같은 몫만 쓴다: 오픈 임박은 모두 오픈 시각이 있고, 인기는 판매 상태가 모두 같다
    const cases = {
      RELEVANCE: {
        docs: Array.from({ length: N }, (_, n) => doc(n, { saleStatus: status[n % 4]!, popularity: n % 3 })),
        canon: (a: SearchDocument, b: SearchDocument) => rank[a.saleStatus] - rank[b.saleStatus] || b.popularity - a.popularity || byId(a, b),
      },
      OPEN_SOON: {
        docs: Array.from({ length: N }, (_, n) => doc(n, { nextOpenAt: `2026-12-0${(n % 3) + 1}T10:00:00.000Z`, nextOpenEventId: `${pid(n)}-e` })),
        canon: (a: SearchDocument, b: SearchDocument) => (a.nextOpenAt! < b.nextOpenAt! ? -1 : a.nextOpenAt! > b.nextOpenAt! ? 1 : byId(a, b)),
      },
      POPULAR: {
        docs: Array.from({ length: N }, (_, n) => doc(n, { popularity: n % 3 })),
        canon: (a: SearchDocument, b: SearchDocument) => b.popularity - a.popularity || byId(a, b),
      },
    };
    for (const [sort, c] of Object.entries(cases) as Array<[keyof typeof cases, (typeof cases)[keyof typeof cases]]>) {
      const all = pages(shuffle(c.docs), { sort });
      expect(all.length, sort).toBe(7);
      expect(all.flatMap(ids), sort).toEqual([...c.docs].sort(c.canon).map((d) => d.productionId));
    }
  });

  test('SR-T13 ① 맞은 공연이 1,000을 넘으면 total 1000·totalCapped이고 50쪽은 981~1,000번째, 1,000개 딱이면 상한이 아니다(§5.4)', () => {
    const over = shuffle(Array.from({ length: CAP + 1 }, (_, n) => doc(n)));
    const p50 = searchDocuments(over, q('같은 이름', { page: CAP / PAGE }));
    expect([p50.total, p50.totalCapped, p50.totalPages]).toEqual([1000, true, 50]);
    expect(ids(p50)).toEqual(Array.from({ length: PAGE }, (_, i) => pid(CAP - PAGE + i)));
    const exact = Array.from({ length: CAP }, (_, n) => doc(n));
    const e50 = searchDocuments(exact, q('같은 이름', { page: CAP / PAGE }));
    expect([e50.total, e50.totalCapped]).toEqual([1000, false]);
    expect(ids(e50)).toEqual(Array.from({ length: PAGE }, (_, i) => pid(CAP - PAGE + i)));
    // page × 20이 1,000을 넘는 쪽은 받지 않는다
    expect(() => searchDocuments(over, q('같은 이름', { page: CAP / PAGE + 1 }))).toThrow();
  });

  test('SR-T13 ① firstSorted는 같은 값이 있어도 전부 정렬한 배열의 앞 k개와 같다(k가 0·1·길이−1·길이·길이+1)', () => {
    const xs = shuffle(Array.from({ length: 31 }, (_, i) => ({ v: i % 4, at: i })));
    const cmp = (a: { v: number }, b: { v: number }) => a.v - b.v;
    for (const k of [0, 1, 30, 31, 32]) expect(firstSorted(xs, cmp, k), `k=${k}`).toEqual([...xs].sort(cmp).slice(0, k));
  });
});

// ---- DB 어댑터의 끊어 처리하기(후보 줄 수가 많을 때). DB는 가짜: 첫 트랜잭션의 질의가 후보 줄을 돌려주고 나머지는 빈 줄이다 ----
const row = (n: number, interest = 0): DocumentRow => ({
  production_id: pid(n),
  representative_event_id: `${pid(n)}-e`,
  title: TITLE,
  genre: '콘서트',
  place_id: null,
  place_name: null,
  artists: [],
  aliases: [],
  period_start: '2026-12-20',
  period_end: '2026-12-21',
  next_open_at: null,
  next_open_event_id: null,
  sale_status: 'ON_SALE',
  sale_ends_at: null,
  min_price: null,
  poster_image_id: null,
  poster_alt: null,
  interest,
});

function fakeDb(rows: DocumentRow[]): Database {
  let tx = 0;
  return {
    transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> => {
      const mine = ++tx;
      return fn({ execute: async () => ({ rows: mine === 1 ? rows : [] }) });
    },
  } as unknown as Database;
}

describe('SR-T13 ① 큰 후보를 끊어 처리해도 답은 그대로이고 사이에 다른 요청이 돈다(ADR-0271 결정 23)', () => {
  // 끊는 덩이의 경계 앞뒤(2,000·2,001), 덩이 크기의 배수가 아닌 수(2,500·3,999·4,001). 경계 자리의 줄을 맨 앞 결과로 만들어 빠짐·겹침을 본다
  test.each([2_000, 2_001, 2_500, 3_999, 4_001])('SR-T13 ① 후보 %i줄에서 덩이 경계(1,999·2,000·4,000번째 줄)와 마지막 줄이 빠지거나 겹치지 않고 쪽·전체 수가 같다', async (n) => {
    const marked = new Map<number, number>([
      [1_999, 9],
      [2_000, 8],
      [4_000, 7],
      [n - 1, 6],
    ]);
    const rows = Array.from({ length: n }, (_, i) => row(i, marked.get(i) ?? 0));
    const index = new DrizzleSearchIndex(fakeDb(rows), 'https://img.test');
    const out = await index.search(q('같은 이름'));
    const top = [...new Set([1_999, 2_000, 4_000, n - 1].filter((i) => i < n))].sort((a, b) => (marked.get(b) ?? 0) - (marked.get(a) ?? 0)).map(pid);
    const rest = Array.from({ length: n }, (_, i) => i).filter((i) => !marked.has(i)).map(pid);
    const want = [...top, ...rest].slice(0, PAGE);
    expect(ids(out)).toEqual(want);
    expect([out.total, out.totalCapped]).toEqual([Math.min(n, CAP), n > CAP]);
    // 마지막 쪽(50쪽)도 같은 차례의 981~1,000번째다
    const last = await new DrizzleSearchIndex(fakeDb(rows), 'https://img.test').search(q('같은 이름', { page: CAP / PAGE }));
    expect(ids(last)).toEqual([...top, ...rest].slice(CAP - PAGE, CAP));
  });

  test('SR-T13 ① 후보가 많은 검색을 처리하는 도중에 들어온 자동완성 요청은 검색이 끝나기 전에 답한다', async () => {
    const n = 6_001;
    const rows = Array.from({ length: n }, (_, i) => row(i));
    // 자동완성 사전(공연 하나)
    const k = nameKeys('루멘 콘서트');
    const term: SearchTermRow = { id: 't1', kind: 'PRODUCTION', targetId: 'lumen', displayName: '루멘 콘서트', aliasOf: null, norm: k.norm, normNospace: k.nospace, jamo: k.jamo, chosung: k.chosung, updatedVersion: 1 };
    const d: SearchDocument = { productionId: 'lumen', eventId: 'lumen-e', title: '루멘 콘서트', aliases: [], genre: '콘서트', artists: [], saleStatus: 'ON_SALE', popularity: 0 };
    const source: SearchDictionarySource = { version: async () => 1, read: async (): Promise<DictionarySnapshot> => ({ version: 1, full: true, documents: [d], terms: [term], removals: [] }) };
    const dict = new SuggestionDictionary(source, fakeClock({ now: T0 }));
    await dict.refresh();
    let looked = 0;
    let atSuggest = -1;
    let suggested: number | undefined;
    // 검색이 첫 덩이의 이름 비교 값을 만드는 동안 자동완성 요청이 '들어온다'(다음 차례의 콜백으로 줄을 선다)
    const keysOf = () => {
      looked += 1;
      if (looked === 1)
        setImmediate(() => {
          atSuggest = looked;
          suggested = dict.suggest('루멘').items.length;
        });
      return undefined;
    };
    const out = await new DrizzleSearchIndex(fakeDb(rows), 'https://img.test', { keysOf }).search(q('같은 이름'));
    expect(out.total).toBe(CAP);
    // 이름 비교 값은 공연마다 하나(이름 하나)씩 찾았다: 끊어 처리한 일이 실제로 있었다
    expect(looked).toBe(n);
    // 자동완성은 답했고(후보 1개), 그때 검색은 아직 남은 덩이가 있었다
    expect(suggested).toBe(1);
    expect(atSuggest).toBeGreaterThan(0);
    expect(atSuggest).toBeLessThan(n);
  });
});

// 검증 P12(계획 '검증' 절): 끊어 처리하는 사이(다음 차례로 넘기는 동안) 같은 어댑터의 다른 검색이 끼어든다. 중간 결과를 요청 밖에 두면 두 검색의 후보가 빠지거나 섞인다
/** 질의 값에 든 글로 후보를 고르는 가짜 DB(후보 질의만 줄을 돌려주고, 관련 공연 등 다른 질의는 빈 줄) */
function routedDb(routes: Array<{ key: string; rows: DocumentRow[] }>): Database {
  const strings = (v: unknown, out: string[] = [], seen = new Set<unknown>()): string[] => {
    if (typeof v === 'string') out.push(v);
    else if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v);
      for (const x of Object.values(v)) strings(x, out, seen);
    }
    return out;
  };
  return {
    transaction: async <T>(fn: (t: unknown) => Promise<T>): Promise<T> =>
      fn({
        execute: async (query: unknown) => {
          const text = strings(query).join('\n');
          if (!/search_term/.test(text)) return { rows: [] };
          return { rows: routes.find((r) => text.includes(r.key))?.rows ?? [] };
        },
      }),
  } as unknown as Database;
}

describe('SR-T13 ① 끊어 처리하는 사이 함께 온 검색(검증 P12)', () => {
  test('SR-T13 ① 후보가 큰 검색 둘을 같은 어댑터에 함께 보내도 각자의 쪽·전체 수가 혼자 보냈을 때와 같다', async () => {
    const make = (prefix: string, title: string, n: number) =>
      Array.from({ length: n }, (_, i) => ({ ...row(i, i % 7), production_id: `${prefix}-${String(i).padStart(5, '0')}`, title }));
    // 서로 다른 질의, 둘 다 덩이 하나(2,000줄)보다 크고 줄 수도 다르다
    const a = make('a', '같은 이름 공연', 5_003);
    const b = make('b', '다른 제목 공연', 3_501);
    const db = routedDb([
      // 후보 질의는 입력의 낱자를 값으로 싣는다
      { key: nameKeys('같은 이름').jamo, rows: a },
      { key: nameKeys('다른 제목').jamo, rows: b },
    ]);
    const qa = q('같은 이름', { page: 2 });
    const qb = q('다른 제목', { sort: 'POPULAR' });
    const solo = new DrizzleSearchIndex(db, 'https://img.test');
    const wantA = await solo.search(qa);
    const wantB = await solo.search(qb);
    // 혼자 보낸 답이 맞는 후보에서 나왔다(빈 결과로 통과하지 않게)
    expect([wantA.items.length, wantA.total, wantA.items.every((x) => x.productionId.startsWith('a-'))]).toEqual([PAGE, CAP, true]);
    expect([wantB.items.length, wantB.total, wantB.items.every((x) => x.productionId.startsWith('b-'))]).toEqual([PAGE, CAP, true]);
    // 같은 어댑터(같은 인스턴스)에 함께 보낸다. 끼어드는 차례를 바꿔 두 번
    const shared = new DrizzleSearchIndex(db, 'https://img.test');
    const [gotA, gotB] = await Promise.all([shared.search(qa), shared.search(qb)]);
    expect(ids(gotA)).toEqual(ids(wantA));
    expect(ids(gotB)).toEqual(ids(wantB));
    expect([gotA.total, gotB.total]).toEqual([wantA.total, wantB.total]);
    const [gotB2, gotA2] = await Promise.all([shared.search(qb), shared.search(qa)]);
    expect(ids(gotA2)).toEqual(ids(wantA));
    expect(ids(gotB2)).toEqual(ids(wantB));
  });
});
