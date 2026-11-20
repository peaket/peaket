// BAT-167 구현 뒤 단위 시험(계획 docs/review/plans/BAT-167.md §10 T1·T2·T4·T6·T7·T8·T10, §12 M1~M10).
// 정본: ADR-0271 결정 25(한 글자 입력은 변환 단계마다 이름 줄을 따로 읽고 등급이 붙은 이름 줄만 공연으로 펼친다,
// 응답·차례·query.converted 불변, 사전 준비 전에는 지금 질의), 결정 22(후보 질의는 갈래마다, SubPlan 없음),
// 결정 23(응답 불변·처리기 계산을 후보 수에 가볍게), 결정 24(변환 값을 만들 수 없는 단계는 건너뜀),
// docs/features/search.md §3.2 ④(로마자만이고 앞 단계가 0건일 때만 한/영 변환)·§5.3(등급·정렬)·§5.5 1(query.converted),
// SR-T13 ①(docs/features/search.md:307) — 판정은 측정이고 이 파일은 원인 자리가 되살아나지 않게 지키는 보조다.
// 가짜 DB는 어댑터가 보낸 질의 글·값(PgDialect)을 모아 질의 모양을 보고, search_term/search_document를 메모리 자료로 답한다.
import type { Database } from '@peaket/platform';
import { GRADE, nameKeys, queryKeys } from '@peaket/search-normalize';
import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, test } from 'vitest';
import { DrizzleSearchIndex } from '../src/modules/catalog/adapters/db/drizzle-search-index.js';
import { matchGrades, matchStagesOf, nameGradeOf, type SearchQuery } from '../src/modules/catalog/domain/search.js';

const NOW = new Date('2026-11-20T00:00:00.000Z');
const ORIGIN = 'https://img.test';
const pad = (n: number, w: number) => String(n).padStart(w, '0');
const q = (s: string, o: Partial<SearchQuery> = {}): SearchQuery => ({ q: s, includePast: false, noConvert: false, page: 1, now: NOW, ...o });

interface FakeTerm {
  kind: 'PRODUCTION' | 'ARTIST' | 'PLACE';
  targetId: string;
  name: string;
  jamo: string;
  chosung: string;
}

interface FakeDoc {
  productionId: string;
  title: string;
  aliases?: string[];
  placeId?: string;
  placeName?: string;
  artists?: { artistId: string; name: string }[];
}

interface FakeModel {
  terms: FakeTerm[];
  docs: FakeDoc[];
}

const modelOf = (docs: FakeDoc[], extra: { kind: FakeTerm['kind']; targetId: string; name: string }[] = []): FakeModel => {
  const terms: FakeTerm[] = [];
  const add = (kind: FakeTerm['kind'], targetId: string, name: string) => {
    const k = nameKeys(name);
    terms.push({ kind, targetId, name, jamo: k.jamo, chosung: k.chosung });
  };
  for (const d of docs) {
    add('PRODUCTION', d.productionId, d.title);
    for (const a of d.aliases ?? []) add('PRODUCTION', d.productionId, a);
    if (d.placeId && d.placeName) add('PLACE', d.placeId, d.placeName);
    for (const a of d.artists ?? []) add('ARTIST', a.artistId, a.name);
  }
  for (const t of extra) add(t.kind, t.targetId, t.name);
  return { terms, docs };
};

const rowOf = (d: FakeDoc) => ({
  production_id: d.productionId,
  representative_event_id: null,
  title: d.title,
  genre: '콘서트',
  place_id: d.placeId ?? null,
  place_name: d.placeName ?? null,
  artists: d.artists ?? [],
  aliases: d.aliases ?? [],
  period_start: '2026-12-01',
  period_end: '2026-12-02',
  next_open_at: null,
  next_open_event_id: null,
  sale_status: 'ON_SALE',
  sale_ends_at: '2026-12-31T00:00:00.000Z',
  min_price: null,
  poster_image_id: null,
  poster_alt: null,
  interest: 0,
});

/** LIKE 값 `%…%`에서 가운뎃값(이스케이프를 푼다) */
const needleOf = (p: unknown): string | null => {
  if (typeof p !== 'string' || p.length < 2 || !p.startsWith('%') || !p.endsWith('%')) return null;
  return p.slice(1, -1).replace(/\\([\\%_])/g, '$1');
};

/** SQL의 `t.jamo like $k`·`t.chosung like $k` 조건을 값으로 다시 본다(OR) */
function termHits(text: string, params: unknown[], t: FakeTerm): boolean {
  let seen = false;
  for (const m of text.matchAll(/t\.(jamo|chosung) like \$(\d+)/g)) {
    const n = needleOf(params[Number(m[2]) - 1]);
    if (n === null) continue;
    seen = true;
    if ((m[1] === 'jamo' ? t.jamo : t.chosung).includes(n)) return true;
  }
  return !seen;
}

/** 가짜 DB가 실제 질의 글·값에 답한다(이름 줄·후보·펼치기·관련 공연·오타 제안 원천) */
function answer(m: FakeModel, text: string, params: unknown[]): unknown[] {
  if (/from search_term t/.test(text)) {
    const rows = m.terms.filter((t) => termHits(text, params, t)).map((t) => ({ kind: t.kind, target_id: t.targetId, display_name: t.name }));
    // 후보 질의(모든 단계를 합친 것)는 이름 줄을 공연으로 펼친다
    if (/with hit as/.test(text)) {
      const ids = new Set<string>();
      for (const r of rows) {
        if (r.kind === 'PRODUCTION') ids.add(r.target_id);
        else if (r.kind === 'PLACE') for (const d of m.docs) if (d.placeId === r.target_id) ids.add(d.productionId);
        else for (const d of m.docs) if (d.artists?.some((a) => a.artistId === r.target_id)) ids.add(d.productionId);
      }
      return m.docs.filter((d) => ids.has(d.productionId)).map(rowOf);
    }
    return rows;
  }
  if (/with ids as/.test(text)) {
    const targets = new Set(params.flatMap((p) => (Array.isArray(p) ? p : [])) as string[]);
    return m.docs
      .filter((d) => targets.has(d.productionId) || (d.placeId !== undefined && targets.has(d.placeId)) || (d.artists ?? []).some((a) => targets.has(a.artistId)))
      .map(rowOf);
  }
  // 오타 제안 원천(사전을 넘겨받지 않은 어댑터만): 공연명 줄
  if (/select display_name as title/.test(text)) return m.terms.filter((t) => t.kind === 'PRODUCTION').map((t) => ({ title: t.name, production_id: t.targetId }));
  // 관련 공연(정확한 차례는 이 시험의 관심이 아니다. 두 어댑터가 같은 답을 받게 앞의 6개)
  if (/from search_document/.test(text)) return m.docs.slice(0, 6).map(rowOf);
  return [];
}

interface Sent {
  text: string;
  params: unknown[];
}

/** 어댑터가 보낸 질의를 모으는 가짜 DB. options.before로 동시 검색의 끼어들기를 늘린다 */
function fakeDb(m: FakeModel, o: { before?: (text: string) => Promise<void> } = {}): { db: Database; sent: Sent[] } {
  const dialect = new PgDialect();
  const sent: Sent[] = [];
  const db = {
    transaction: async <T>(fn: (tx: unknown) => Promise<T>): Promise<T> =>
      fn({
        execute: async (query: unknown) => {
          const { sql: text, params } = dialect.sqlToQuery(query as never);
          sent.push({ text, params });
          await o.before?.(text);
          return { rows: answer(m, text, params) };
        },
      }),
  } as unknown as Database;
  return { db, sent };
}

const keysOfModel = (m: FakeModel) => {
  const byName = new Map(m.terms.map((t) => [t.name, nameKeys(t.name)] as const));
  return (n: string) => byName.get(n);
};

const ids = (out: { items: { productionId: string }[] }) => out.items.map((x) => x.productionId);
const nameQueries = (sent: Sent[]) => sent.filter((s) => /distinct t\.kind/.test(s.text) && !/with hit as/.test(s.text));
const candidateQueries = (sent: Sent[]) => sent.filter((s) => /with hit as/.test(s.text));
const documentQueries = (sent: Sent[]) => sent.filter((s) => /with ids as/.test(s.text));
const targetIds = (s: Sent) => new Set((s.params.flatMap((p) => (Array.isArray(p) ? p : [])) as string[]));

describe('SR-T13 ① 단계 목록·이름 줄 우선 등급(ADR-0271 결정 24·25)', () => {
  test('SR-T13 ① 한 글자 입력의 단계는 친 그대로 → 한/영 변환 → 소문자 변환이고, 같은 비교 값은 한 번만 둔다', () => {
    const values = (s: string, noConvert = false) => matchStagesOf(s, noConvert).map((x) => ({ value: x.value, converted: x.converted }));
    expect(values('a')).toEqual([
      { value: 'a', converted: null },
      { value: 'ㅁ', converted: 'ㅁ' },
    ]);
    expect(values('z')).toEqual([
      { value: 'z', converted: null },
      { value: 'ㅋ', converted: 'ㅋ' },
    ]);
    // 'A'의 두 변환은 같은 값이라 뒤 단계를 더 두지 않는다(중복 제거)
    expect(values('A')).toEqual([
      { value: 'A', converted: null },
      { value: 'ㅁ', converted: 'ㅁ' },
    ]);
    // 소문자 값의 변환이 앞 단계와 다를 때만 더한다('DnPt' → 친 그대로 '우ㅖㅅ' → 소문자 '웻')
    expect(values('DnPt')).toEqual([
      { value: 'DnPt', converted: null },
      { value: '우ㅖㅅ', converted: '우ㅖㅅ' },
      { value: '웻', converted: '웻' },
    ]);
    // 변환 값을 만들 수 없는 입력은 그 단계를 건너뛴다(결정 24)
    expect(values('npt')).toEqual([{ value: 'npt', converted: null }]);
    // noConvert면 친 그대로 하나, 두 글자 이상·한글 입력도 변환 단계가 없다
    expect(values('z', true)).toEqual([{ value: 'z', converted: null }]);
    expect(values('루')).toEqual([{ value: '루', converted: null }]);
    expect(values('ㅁ')).toEqual([{ value: 'ㅁ', converted: null }]);
  });

  test('SR-T13 ① 이름 줄 우선 등급도 사전의 비교 값을 쓰고, 사전에 없으면 이름에서 새로 만든다', () => {
    const known = nameKeys('뮤지컬 밤');
    const keysOf = (n: string) => (n === '뮤지컬 밤' ? known : undefined);
    expect(nameGradeOf(queryKeys('ㅁ'), '뮤지컬 밤', keysOf)).toBe(GRADE.PREFIX);
    expect(nameGradeOf(queryKeys('ㅁ'), '루멘', keysOf)).toBe(GRADE.NONE);
    // 사전에 없는 이름은 새로 만든다(같은 답)
    expect(nameGradeOf(queryKeys('ㅁ'), '뮤지컬 밤')).toBe(GRADE.PREFIX);
  });
});

describe('SR-T13 ① 한 글자 단계별 읽기(T1·T2·T6)', () => {
  test('SR-T13 ① 앞 단계가 등급을 내면 다음 변환 단계의 이름 줄을 질의하지 않고, 결과는 기준 코드(합친 질의)와 같다', async () => {
    const docs: FakeDoc[] = [
      { productionId: 'p-a', title: 'Aurora 콘서트' },
      // 'a'의 친 그대로 단계(SQL `%a%`)에 줄은 있지만 등급은 NONE(한 글자는 중간 일치를 보지 않는다)
      { productionId: 'p-star', title: 'Starry 밤' },
      // 한/영 변환 'ㅁ' 단계에서만 등급이 붙는다
      { productionId: 'p-musical', title: '뮤지컬 밤' },
    ];
    const model = modelOf(docs);
    const live = fakeDb(model);
    const staged = new DrizzleSearchIndex(live.db, ORIGIN, { keysOf: keysOfModel(model), ready: () => true });
    const out = await staged.search(q('a'));
    const plain = fakeDb(model);
    const baseline = await new DrizzleSearchIndex(plain.db, ORIGIN).search(q('a'));

    // 정답이 있는 자료인지 먼저 본다
    expect(ids(baseline)).toEqual(['p-a']);
    expect(JSON.stringify(out)).toBe(JSON.stringify(baseline));
    expect(out.query.converted).toBeNull();
    // 이름 줄 질의는 친 그대로 단계 하나뿐이고, `%ㅁ%` 조건이 나가지 않는다
    expect(nameQueries(live.sent)).toHaveLength(1);
    expect(live.sent.some((s) => s.params.some((p) => typeof p === 'string' && p.includes('ㅁ')))).toBe(false);
    // 기준 코드는 모든 단계를 한 질의에 합친다(이 시험이 새 길을 실제로 지나갔다는 대조)
    expect(candidateQueries(plain.sent)).toHaveLength(1);
    expect(plain.sent.some((s) => s.params.some((p) => typeof p === 'string' && p.includes('ㅁ')))).toBe(true);
  });

  test('SR-T13 ① 앞 단계가 줄은 있지만 등급이 없으면 다음 변환 단계로 넘어가고 query.converted가 그 값이다', async () => {
    const model = modelOf([
      { productionId: 'p-star', title: 'Starry 밤' },
      { productionId: 'p-musical', title: '뮤지컬 밤' },
    ]);
    const live = fakeDb(model);
    const staged = new DrizzleSearchIndex(live.db, ORIGIN, { keysOf: keysOfModel(model), ready: () => true });
    const out = await staged.search(q('a'));
    const baseline = await new DrizzleSearchIndex(fakeDb(model).db, ORIGIN).search(q('a'));

    expect(ids(out)).toEqual(['p-musical']);
    expect(out.query.converted).toEqual({ from: 'a', to: 'ㅁ' });
    expect(JSON.stringify(out)).toBe(JSON.stringify(baseline));
    // 단계마다 이름 줄 질의 하나(친 그대로 → 변환), 그 뒤 공연 줄 질의 하나
    const names = nameQueries(live.sent);
    expect(names).toHaveLength(2);
    expect(names[0]!.params).toEqual(['%a%']);
    expect(names[1]!.params).toContain('%ㅁ%');
    expect(documentQueries(live.sent)).toHaveLength(1);
  });

  test('SR-T13 ① 후보 좁히기는 등급이 붙은 이름 줄의 대상만 공연 줄로 펼치고, 등급이 붙은 이름 줄이 없으면 둘째 질의를 하지 않는다', async () => {
    // 100 공연 가운데 3개만 'a'의 앞부분이고, 97개는 'a'를 품기만 한다(등급 NONE)
    const docs: FakeDoc[] = [
      ...Array.from({ length: 3 }, (_, i) => ({ productionId: `hit-${i}`, title: `Aurora ${i}` })),
      ...Array.from({ length: 97 }, (_, i) => ({ productionId: `miss-${i}`, title: `Starry ${i}` })),
    ];
    const model = modelOf(docs);
    const live = fakeDb(model);
    const staged = new DrizzleSearchIndex(live.db, ORIGIN, { keysOf: keysOfModel(model), ready: () => true });
    const out = await staged.search(q('a'));
    const baseline = await new DrizzleSearchIndex(fakeDb(model).db, ORIGIN).search(q('a'));

    expect(out.total).toBe(3);
    expect(ids(out).sort()).toEqual(['hit-0', 'hit-1', 'hit-2']);
    expect(JSON.stringify(out)).toBe(JSON.stringify(baseline));
    // 둘째 질의에 넘긴 ID 배열은 등급이 붙은 3공연뿐이다(100개 전체가 아니다)
    const docsQuery = documentQueries(live.sent);
    expect(docsQuery).toHaveLength(1);
    expect([...targetIds(docsQuery[0]!)].sort()).toEqual(['hit-0', 'hit-1', 'hit-2']);

    // 첫 단계에 줄은 있지만 등급이 0이고 변환 단계에도 등급이 없으면 공연 줄 질의를 하지 않는다
    const none = modelOf(Array.from({ length: 97 }, (_, i) => ({ productionId: `miss-${i}`, title: `Starry ${i}` })));
    const noneDb = fakeDb(none);
    const noneIndex = new DrizzleSearchIndex(noneDb.db, ORIGIN, { keysOf: keysOfModel(none), ready: () => true });
    const empty = await noneIndex.search(q('a'));
    expect(empty.total).toBe(0);
    expect(nameQueries(noneDb.sent).length).toBeGreaterThanOrEqual(1);
    expect(documentQueries(noneDb.sent)).toHaveLength(0);
  });

  test('SR-T13 ① 이름 줄이 2,000줄보다 많아도 끊어 처리하며 등급이 붙은 줄을 빠뜨리지 않는다', async () => {
    // 2,500 공연 모두 'a' 앞부분이다. 2,000줄마다 I/O를 돌리는 길을 지나고, 전체 수는 1,000에서 멈춘다
    const docs: FakeDoc[] = Array.from({ length: 2_500 }, (_, i) => ({ productionId: `chunk-${pad(i, 4)}`, title: `Aurora 공연 ${pad(i, 4)}` }));
    const model = modelOf(docs);
    const live = fakeDb(model);
    const out = await new DrizzleSearchIndex(live.db, ORIGIN, { keysOf: keysOfModel(model), ready: () => true }).search(q('a'));
    expect([out.total, out.totalCapped, out.items.length]).toEqual([1_000, true, 20]);
    const docsQuery = documentQueries(live.sent);
    expect(docsQuery).toHaveLength(1);
    expect(targetIds(docsQuery[0]!).size).toBe(2_500);
    expect(ids(out).every((x) => x.startsWith('chunk-'))).toBe(true);
  });
});

describe('SR-T13 ① 두 글자 이상 입력은 지금 질의 모양 그대로(T7)', () => {
  test('SR-T13 ① 두 글자 이상은 합친 후보 질의 하나이고 중간 일치(GRADE.MIDDLE)가 빠지지 않는다', async () => {
    const model = modelOf([{ productionId: 'p-mid', title: '별빛나는 공연' }]);
    const live = fakeDb(model);
    const out = await new DrizzleSearchIndex(live.db, ORIGIN, { keysOf: keysOfModel(model), ready: () => true }).search(q('빛나'));
    // 이름 중간에만 있으므로 중간 일치다(빠지면 0건)
    expect(ids(out)).toEqual(['p-mid']);
    expect(out.total).toBe(1);
    expect(candidateQueries(live.sent)).toHaveLength(1);
    expect(nameQueries(live.sent)).toHaveLength(0);
  });
});

describe('SR-T13 ① 변환 차례·query.converted(T4)', () => {
  const model = modelOf([
    { productionId: 'p-cat', title: '캣츠 공연' },
    { productionId: 'p-aurora', title: 'Aurora 쇼' },
    { productionId: 'p-wet', title: '웻 쇼' },
  ]);
  const search = async (s: string) => {
    const live = fakeDb(model);
    return { out: await new DrizzleSearchIndex(live.db, ORIGIN, { keysOf: keysOfModel(model), ready: () => true }).search(q(s)), sent: live.sent };
  };

  test("SR-T13 ① 'z'는 한/영 변환 'ㅋ'으로 찾고 query.converted가 그 값이며, noConvert면 변환 단계를 보지 않는다", async () => {
    const { out } = await search('z');
    expect(ids(out)).toEqual(['p-cat']);
    expect(out.query.converted).toEqual({ from: 'z', to: 'ㅋ' });
    const off = await new DrizzleSearchIndex(fakeDb(model).db, ORIGIN, { keysOf: keysOfModel(model), ready: () => true }).search(q('z', { noConvert: true }));
    expect(off.items).toEqual([]);
    expect(off.query.converted).toBeNull();
  });

  test("SR-T13 ① 'A'는 친 그대로(정규화 'a')가 맞으면 변환하지 않고 query.converted가 null이다", async () => {
    const { out } = await search('A');
    expect(ids(out)).toEqual(['p-aurora']);
    expect(out.query.converted).toBeNull();
  });

  test("SR-T13 ① 두 글자 이상 'DnPt'는 소문자 값의 변환 '웻'으로 찾고 query.converted.to가 실제 값이다", async () => {
    const { out, sent } = await search('DnPt');
    expect(ids(out)).toEqual(['p-wet']);
    expect(out.query.converted).toEqual({ from: 'DnPt', to: '웻' });
    // 새 경로가 아니라 지금 질의 하나다
    expect(candidateQueries(sent)).toHaveLength(1);
  });
});

describe('SR-T13 ① 사전 준비 전·keysOf 없음 fallback(T8)', () => {
  test('SR-T13 ① keysOf가 없거나 사전이 첫 통째로 읽기 전이면 지금 질의 하나로 답하고 응답이 같다', async () => {
    const model = modelOf([
      { productionId: 'p-a', title: 'Aurora 콘서트' },
      { productionId: 'p-musical', title: '뮤지컬 밤' },
      { productionId: 'p-lumen', title: '루멘 콘서트', artists: [{ artistId: 'a1', name: '루멘' }] },
    ]);
    const keysOf = keysOfModel(model);
    const staged = await new DrizzleSearchIndex(fakeDb(model).db, ORIGIN, { keysOf, ready: () => true }).search(q('a'));
    for (const [why, o] of [
      ['keysOf 없음', {}],
      ['준비 전', { keysOf, ready: () => false }],
    ] as const) {
      const live = fakeDb(model);
      const out = await new DrizzleSearchIndex(live.db, ORIGIN, o).search(q('a'));
      expect(JSON.stringify(out), why).toBe(JSON.stringify(staged));
      // 한 글자여도 지금 질의(모든 단계를 합침) 하나다
      expect(candidateQueries(live.sent).length, why).toBe(1);
      expect(nameQueries(live.sent).length, why).toBe(0);
    }
  });
});

describe('SR-T13 ① 같은 어댑터에 함께 온 검색(T10)', () => {
  test('SR-T13 ① 같은 어댑터에 한 글자 검색 둘을 함께 보내도 각자의 결과가 혼자 보낼 때와 같다', async () => {
    const model = modelOf([
      { productionId: 'p-a', title: 'Aurora 콘서트' },
      { productionId: 'p-lumen', title: '루멘 콘서트' },
      { productionId: 'p-mid', title: '별빛나는 공연' },
    ]);
    const keysOf = keysOfModel(model);
    const solo = new DrizzleSearchIndex(fakeDb(model).db, ORIGIN, { keysOf, ready: () => true });
    const wantA = await solo.search(q('a'));
    const wantRu = await solo.search(q('루', { page: 1, sort: 'POPULAR' }));
    expect(ids(wantA)).toEqual(['p-a']);
    expect(ids(wantRu)).toEqual(['p-lumen']);
    // 질의 사이에 다른 검색이 끼어들게 한 번씩 양보한다
    const shared = new DrizzleSearchIndex(fakeDb(model, { before: () => new Promise((r) => setImmediate(r)) }).db, ORIGIN, { keysOf, ready: () => true });
    const [gotA, gotRu] = await Promise.all([shared.search(q('a')), shared.search(q('루', { page: 1, sort: 'POPULAR' }))]);
    expect(JSON.stringify(gotA)).toBe(JSON.stringify(wantA));
    expect(JSON.stringify(gotRu)).toBe(JSON.stringify(wantRu));
    const [gotRu2, gotA2] = await Promise.all([shared.search(q('루', { page: 1, sort: 'POPULAR' })), shared.search(q('a'))]);
    expect(JSON.stringify(gotA2)).toBe(JSON.stringify(wantA));
    expect(JSON.stringify(gotRu2)).toBe(JSON.stringify(wantRu));
  });
});

// 이름 하나의 단계 등급이 matchGrades의 공연 등급과 같은지(두 경로가 같은 규칙을 쓴다는 근거)
test('SR-T13 ① 이름 줄 우선 등급과 matchGrades의 공연 등급이 같은 규칙이다', () => {
  const names = ['Aurora 콘서트', '뮤지컬 밤', 'Starry 밤'];
  const index = names.map((title, i) => ({ item: { id: `p${i}`, name: title, aliases: [] as string[] }, keys: [nameKeys(title)] }));
  for (const [input, stageValue] of [
    ['a', 'a'],
    ['a', 'ㅁ'],
    ['z', 'ㅋ'],
  ] as const) {
    const graded = matchGrades(index, stageValue, true).grades;
    for (const [i, title] of names.entries()) {
      const want = nameGradeOf(queryKeys(stageValue), title);
      const got = graded.get(`p${i}`) ?? GRADE.NONE;
      expect({ input, stageValue, title, grade: got }).toEqual({ input, stageValue, title, grade: want });
    }
  }
});
