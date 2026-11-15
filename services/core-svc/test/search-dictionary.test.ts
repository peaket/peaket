// 자동완성 메모리 사전의 증분 갱신 시험(BAT-165 웨이브 7 T-12·T-13, SR-T15 ①, catalog-review 2.4.1).
// 정본: docs/features/search.md §2.3(56줄: 10초 [가정]마다 판 확인, 판 순서대로·같은 판 안에서는 지운 표시 먼저,
// 처음 뜰 때·판이 1,000 [가정] 넘게 뛰었을 때·마지막 갱신이 1시간 [가정]보다 오래됐을 때만 통째로), §4.4(DB를 부르지 않는다), :306 SR-T15 ①.
// 가짜 원천은 DB처럼 '지금 남은 줄'만 돌려준다(지운 줄은 없고 지운 표시만 남는다). 시계는 가짜이고 advance로만 간다.
// 시험이 정한 모양(구현이 다르면 계획의 '시험 이의'에 적는다):
// - refresh()는 마지막 확인에서 10초가 안 지났으면 원천을 부르지 않고 지금 판을 돌려준다(applied·removed 0, full 거짓).
// - refresh()의 applied는 반영한 공연 줄 + 이름 줄 수, removed는 반영한 지운 표시 수다. entries는 사전의 이름 항목 수다.
import { fakeClock } from '@peaket/platform';
import { nameKeys } from '@peaket/search-normalize';
import { describe, expect, test } from 'vitest';
import { SuggestionDictionary, type DictionarySnapshot, type SearchDictionarySource, type SearchDocument, type SearchTermRow } from '../src/modules/catalog/index.js';

const T0 = Date.parse('2026-11-16T00:00:00.000Z');
// 정본 값(docs/features/search.md:56). 코드 상수를 가져오지 않는다
const CHECK_MS = 10_000;
const HOUR_MS = 3_600_000;
const JUMP = 1_000;

type Removal = DictionarySnapshot['removals'][number];

/** DB를 흉내 낸 원천: 지금 남은 공연 줄·이름 줄과 지운 표시. 부른 차례를 남긴다 */
class FakeSource implements SearchDictionarySource {
  v: number;
  readonly docs = new Map<string, { doc: SearchDocument; version: number }>();
  readonly terms = new Map<string, SearchTermRow>();
  readonly removals: Removal[] = [];
  readonly reads: (number | null)[] = [];
  versionCalls = 0;

  constructor(v: number) {
    this.v = v;
  }

  async version(): Promise<number> {
    this.versionCalls += 1;
    return this.v;
  }

  async read(since: number | null): Promise<DictionarySnapshot> {
    this.reads.push(since);
    if (since === null) return { version: this.v, full: true, documents: [...this.docs.values()].map((d) => d.doc), terms: [...this.terms.values()], removals: [] };
    return {
      version: this.v,
      full: false,
      documents: [...this.docs.values()].filter((d) => d.version > since).map((d) => d.doc),
      terms: [...this.terms.values()].filter((t) => t.updatedVersion > since),
      removals: this.removals.filter((r) => r.version > since),
    };
  }

  calls(): number {
    return this.reads.length + this.versionCalls;
  }

  /** 공연 하나와 그 이름 줄들을 판 v로 넣는다 */
  put(v: number, productionId: string, title: string, termIds: { id: string; name: string; aliasOf?: string }[]): void {
    this.docs.set(productionId, { doc: doc(productionId, title), version: v });
    for (const t of termIds) this.terms.set(t.id, term(t.id, 'PRODUCTION', productionId, t.name, v, t.aliasOf ?? null));
  }

  /** 공연을 지운다(DB는 줄을 지우고 같은 트랜잭션에서 지운 표시를 적는다) */
  removeDocument(v: number, productionId: string): void {
    this.docs.delete(productionId);
    this.removals.push({ version: v, kind: 'DOCUMENT', targetId: productionId });
    for (const t of [...this.terms.values()].filter((x) => x.targetId === productionId)) this.removeTerm(v, t.id);
  }

  removeTerm(v: number, termId: string): void {
    this.terms.delete(termId);
    this.removals.push({ version: v, kind: 'TERM', targetId: termId });
  }
}

const doc = (productionId: string, title: string): SearchDocument => ({ productionId, eventId: `${productionId}-e`, title, aliases: [], genre: '콘서트', artists: [], saleStatus: 'ON_SALE', popularity: 0 });

function term(id: string, kind: SearchTermRow['kind'], targetId: string, name: string, v: number, aliasOf: string | null): SearchTermRow {
  const k = nameKeys(name);
  return { id, kind, targetId, displayName: name, aliasOf, norm: k.norm, normNospace: k.nospace, jamo: k.jamo, chosung: k.chosung, updatedVersion: v };
}

const ids = (d: SuggestionDictionary, input: string) => d.suggest(input).items.filter((x) => x.kind === 'PRODUCTION').map((x) => x.productionId).sort();

describe('자동완성 사전 증분 갱신', () => {
  test('SR-T15 ① 판이 바뀌면 10초 안에 반영하고, 지운 공연·다른 이름은 증분 한 번에 빠지며, 다시 승인된 공연은 다시 나온다', async () => {
    const src = new FakeSource(9);
    src.put(9, 'p1', '루멘 콘서트', [
      { id: 't1', name: '루멘 콘서트' },
      { id: 't1a', name: 'LUMEN', aliasOf: '루멘 콘서트' },
    ]);
    src.put(9, 'p2', '빛나는 밤', [
      { id: 't2', name: '빛나는 밤' },
      { id: 't2a', name: 'STARRY NIGHT', aliasOf: '빛나는 밤' },
    ]);
    const clock = fakeClock({ now: T0 });
    const dict = new SuggestionDictionary(src, clock);

    // 처음 뜰 때는 통째로 읽는다
    expect(await dict.refresh()).toEqual({ version: 9, full: true, applied: 6, removed: 0 });
    expect(src.reads).toEqual([null]);
    expect(dict.version).toBe(9);
    expect(dict.entries).toBe(4);
    expect(ids(dict, '루멘')).toEqual(['p1']);
    expect(ids(dict, 'starry')).toEqual(['p2']);

    // 판 9 → 10(두 자리. 판을 글로 견주면 '10' < '9'라 놓친다): 새 공연 하나
    src.v = 10;
    src.put(10, 'p3', '루멘 앙코르', [{ id: 't3', name: '루멘 앙코르' }]);

    // 마지막 확인에서 10초 − 1ms: 아직 원천을 부르지 않고 옛 사전 그대로다
    clock.advance(CHECK_MS - 1);
    expect(await dict.refresh()).toEqual({ version: 9, full: false, applied: 0, removed: 0 });
    expect(src.reads).toEqual([null]);
    expect(ids(dict, '루멘')).toEqual(['p1']);

    // 10초: 판 9 뒤의 줄만 읽어 반영한다
    clock.advance(1);
    expect(await dict.refresh()).toEqual({ version: 10, full: false, applied: 2, removed: 0 });
    expect(src.reads).toEqual([null, 9]);
    expect(dict.version).toBe(10);
    expect(dict.entries).toBe(5);
    expect(ids(dict, '루멘')).toEqual(['p1', 'p3']);

    // 판 11: 판매 승인 취소로 p1이 빠지고(공연 줄과 이름 줄 둘), p2의 다른 이름 하나를 지운다
    src.v = 11;
    src.removeDocument(11, 'p1');
    src.removeTerm(11, 't2a');
    clock.advance(CHECK_MS);
    expect(await dict.refresh()).toEqual({ version: 11, full: false, applied: 0, removed: 4 });
    expect(src.reads).toEqual([null, 9, 10]);
    // 지운 키를 모두 본다: 공연 p1(이름·다른 이름 둘 다), p2의 다른 이름. p2의 공연명과 p3은 남는다
    expect(dict.entries).toBe(2);
    expect(ids(dict, '루멘')).toEqual(['p3']);
    expect(ids(dict, 'lumen')).toEqual([]);
    expect(ids(dict, 'starry')).toEqual([]);
    expect(ids(dict, '빛나는')).toEqual(['p2']);

    // 판 12·13을 한 번에: 판 12에 p2 공연명 줄을 지웠다가 같은 판에서 다시 넣고(같은 판 안에서는 지운 표시를 먼저),
    // 판 13에 p1이 다시 승인되어 같은 이름 줄 ID로 돌아온다
    src.v = 12;
    src.removeTerm(12, 't2');
    src.terms.set('t2', term('t2', 'PRODUCTION', 'p2', '빛나는 밤', 12, null));
    src.v = 13;
    src.put(13, 'p1', '루멘 콘서트', [
      { id: 't1', name: '루멘 콘서트' },
      { id: 't1a', name: 'LUMEN', aliasOf: '루멘 콘서트' },
    ]);
    clock.advance(CHECK_MS);
    expect(await dict.refresh()).toEqual({ version: 13, full: false, applied: 4, removed: 1 });
    expect(src.reads).toEqual([null, 9, 10, 11]);
    expect(dict.entries).toBe(4);
    expect(ids(dict, '빛나는')).toEqual(['p2']);
    expect(ids(dict, '루멘')).toEqual(['p1', 'p3']);
    expect(ids(dict, 'lumen')).toEqual(['p1']);

    // 바뀐 것이 없으면 읽은 줄도 없다. 처음 한 번 뒤에는 통째로 읽지 않았다
    clock.advance(CHECK_MS);
    expect(await dict.refresh()).toEqual({ version: 13, full: false, applied: 0, removed: 0 });
    expect(src.reads.slice(1).every((s) => s !== null)).toBe(true);
    expect(src.reads.filter((s) => s === null)).toHaveLength(1);
  });

  test('SR-T15 ① 처음 뜰 때·판이 1,000 넘게 뛸 때·마지막 갱신이 1시간보다 오래될 때만 통째로 읽고, 자동완성은 DB를 부르지 않는다 [ASVS v5.0.0-2.4.1]', async () => {
    // 판이 1,000 뛰면 증분, 1,001 뛰면 통째로
    const src = new FakeSource(20);
    src.put(20, 'p1', '루멘 콘서트', [{ id: 't1', name: '루멘 콘서트' }]);
    const clock = fakeClock({ now: T0 });
    const dict = new SuggestionDictionary(src, clock);
    expect((await dict.refresh()).full).toBe(true);
    expect(src.reads).toEqual([null]);

    src.v = 20 + JUMP;
    src.put(src.v, 'p2', '루멘 앙코르', [{ id: 't2', name: '루멘 앙코르' }]);
    clock.advance(CHECK_MS);
    expect(await dict.refresh()).toEqual({ version: 1_020, full: false, applied: 2, removed: 0 });
    expect(src.reads).toEqual([null, 20]);

    src.v = 1_020 + JUMP + 1;
    src.put(src.v, 'p3', '루멘 투어', [{ id: 't3', name: '루멘 투어' }]);
    clock.advance(CHECK_MS);
    expect(await dict.refresh()).toEqual({ version: 2_021, full: true, applied: 6, removed: 0 });
    expect(src.reads).toEqual([null, 20, null]);
    expect(dict.entries).toBe(3);

    // 마지막 갱신에서 1시간 − 1ms와 1시간은 증분(정본: 1시간'보다 오래'), 1시간 + 1ms는 통째로
    for (const [gap, full] of [
      [HOUR_MS - 1, false],
      [HOUR_MS, false],
      [HOUR_MS + 1, true],
    ] as const) {
      const s = new FakeSource(5);
      s.put(5, 'p1', '루멘 콘서트', [{ id: 't1', name: '루멘 콘서트' }]);
      const c = fakeClock({ now: T0 });
      const d = new SuggestionDictionary(s, c);
      await d.refresh();
      s.v = 6;
      s.put(6, 'p2', '루멘 앙코르', [{ id: 't2', name: '루멘 앙코르' }]);
      c.advance(gap);
      const out = await d.refresh();
      expect({ gap, full: out.full, reads: s.reads }).toEqual({ gap, full, reads: [null, full ? null : 5] });
      expect(ids(d, '루멘')).toEqual(['p1', 'p2']);
    }

    // 자동완성 1,000번 동안 원천(판 읽기 포함)을 한 번도 부르지 않는다
    const before = src.calls();
    for (let i = 0; i < 1_000; i++) dict.suggest(i % 2 === 0 ? '루멘' : 'ㄹㅁ');
    expect(src.calls() - before).toBe(0);
    expect(ids(dict, '루멘')).toEqual(['p1', 'p2', 'p3']);
  });
});
