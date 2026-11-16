// 검색 도메인: 검색 문서·질의·결과와 순위(ADR-0094, docs/features/search.md §3~§6, BUILD_ORDER HOT-270·HOT-280).
// 정규화·낱자·초성 비교는 packages/search-normalize를 쓴다. DB·프레임워크를 모르는 순수 함수만 둔다.
import {
  compareMatch,
  convertQwertyToHangul,
  GRADE,
  indexNames,
  matchGrade,
  nameKeys,
  normalize,
  queryKeys,
  searchIndexed,
  type Grade,
  type IndexedName,
  type NameItem,
  type NameKeys,
  type NameMatch,
  type QueryKeys,
} from '@peaket/search-normalize';
import { type CardSaleStatus, type EventSaleState, type Genre, cardSaleStatus, representativeEvent, saleEndsAt } from './production.js';

export const SEARCH_PAGE_SIZE = 20;
export const SEARCH_MAX_PAGE = 50;
export const SEARCH_TOTAL_CAP = 1_000;
export const SUGGESTION_MAX = 8;
export const SUGGESTION_QUOTA = { PRODUCTION: 5, ARTIST: 2, PLACE: 1 } as const;
export const RELATED_MAX = 6;

export interface SearchArtist {
  artistId: string;
  name: string;
}

/** 검색 읽기 모델 한 줄. 공개 공연만 들어온다(판매 승인·판매 중지 아님) */
export interface SearchDocument {
  productionId: string;
  eventId?: string;
  title: string;
  aliases: string[];
  genre: Genre;
  placeId?: string;
  placeName?: string;
  artists: SearchArtist[];
  posterUrl?: string;
  posterAlt?: string;
  periodStart?: string;
  periodEnd?: string;
  nextOpenAt?: string | null;
  nextOpenEventId?: string | null;
  saleStatus: CardSaleStatus;
  saleEndsAt?: string;
  minPrice?: number;
  badges?: string[];
  /** 관련 공연·인기 순위에 쓰는 관심도(찜 수 등). 작을수록 뒤 */
  popularity: number;
}

export interface SearchQuery {
  q: string;
  genre?: Genre;
  placeId?: string;
  artistId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: CardSaleStatus;
  includePast: boolean;
  noConvert: boolean;
  sort?: 'RELEVANCE' | 'OPEN_SOON' | 'POPULAR';
  page: number;
  now: Date;
}

export interface SearchCard {
  productionId: string;
  eventId?: string;
  title: string;
  genre: Genre;
  posterUrl?: string;
  posterAlt?: string;
  placeName?: string;
  periodStart?: string;
  periodEnd?: string;
  nextOpenAt?: string | null;
  nextOpenEventId?: string | null;
  saleStatus: CardSaleStatus;
  saleEndsAt?: string;
  minPrice?: number;
  badges?: string[];
}

export interface SearchOutcome {
  items: SearchCard[];
  page: number;
  limit: number;
  total: number;
  totalCapped: boolean;
  totalPages: number;
  query: { normalized: string; converted?: { from: string; to: string } | null };
  didYouMean: string | null;
  relaxedTotal: number | null;
  filterNames?: { placeName: string | null; artistName: string | null };
  related?: { basis: { kind: 'ARTIST' | 'PLACE' | 'UPCOMING_POPULAR'; id?: string | null; name?: string | null }; items: SearchCard[] } | null;
}

export interface SuggestionItem {
  kind: 'PRODUCTION' | 'ARTIST' | 'PLACE';
  label: string;
  matches?: { start: number; length: number }[];
  productionId?: string;
  eventId?: string;
  posterUrl?: string;
  nextOpenAt?: string | null;
  saleStatus?: 'UPCOMING' | 'ON_SALE' | 'SOLD_OUT';
  artistId?: string;
  placeId?: string;
}

export interface SearchSuggestions {
  query: string;
  items: SuggestionItem[];
}

/** 검색 포트. 메모리·DB 어댑터가 같은 순위 규칙(아래 assembleSearch)을 쓴다 */
export interface SearchIndex {
  /** 한 번의 검색. 후보만 읽는다(ADR-0271 결정 4). 연결 묶음이 넘치거나 질의 시간 상한을 넘으면 SearchUnavailable을 던진다 */
  search(q: SearchQuery): Promise<SearchOutcome>;
}

export const SEARCH_INDEX = Symbol('SEARCH_INDEX');

const SALE_RANK: Record<CardSaleStatus, number> = { ON_SALE: 0, UPCOMING: 1, SOLD_OUT: 2, ENDED: 3 };
const collator = new Intl.Collator('ko');
const byTitle = (a: { title: string; productionId: string }, b: { title: string; productionId: string }) => collator.compare(a.title, b.title) || (a.productionId < b.productionId ? -1 : a.productionId > b.productionId ? 1 : 0);
const card = (d: SearchDocument): SearchCard => ({
  productionId: d.productionId,
  ...(d.eventId !== undefined ? { eventId: d.eventId } : {}),
  title: d.title,
  genre: d.genre,
  ...(d.posterUrl !== undefined ? { posterUrl: d.posterUrl } : {}),
  ...(d.posterAlt !== undefined ? { posterAlt: d.posterAlt } : {}),
  ...(d.placeName !== undefined ? { placeName: d.placeName } : {}),
  ...(d.periodStart !== undefined ? { periodStart: d.periodStart } : {}),
  ...(d.periodEnd !== undefined ? { periodEnd: d.periodEnd } : {}),
  ...(d.nextOpenAt !== undefined ? { nextOpenAt: d.nextOpenAt } : {}),
  ...(d.nextOpenEventId !== undefined ? { nextOpenEventId: d.nextOpenEventId } : {}),
  saleStatus: d.saleStatus,
  ...(d.saleEndsAt !== undefined ? { saleEndsAt: d.saleEndsAt } : {}),
  ...(d.minPrice !== undefined ? { minPrice: d.minPrice } : {}),
  ...(d.badges !== undefined ? { badges: d.badges } : {}),
});

/** 이름과 다른 이름·공연장·아티스트 이름을 함께 맞춘다. 결과 등급은 가장 좋은 하나 */
const searchNamesOf = (d: SearchDocument): string[] => [d.title, ...d.aliases, ...(d.placeName ? [d.placeName] : []), ...d.artists.map((a) => a.name)];

/** 문서의 이름 색인(공연명·다른 이름·공연장·아티스트). 요청마다 만들지 않게 어댑터가 들고 있는다(COV2-07) */
export type DocumentIndex = ReadonlyArray<IndexedName<NameItem>>;

export function indexDocuments(docs: readonly SearchDocument[]): DocumentIndex {
  return indexNames(docs.map((d) => ({ id: d.productionId, name: d.title, aliases: searchNamesOf(d).slice(1) })));
}

/** 색인에서 공연마다 가장 좋은 일치 등급. 로마자만 쳤고 0건이면 한/영 변환으로 다시 찾는다(noConvert면 하지 않는다) */
export function matchGrades(index: DocumentIndex, q: string, noConvert: boolean): Map<string, Grade> {
  const out = new Map<string, Grade>();
  if (noConvert) {
    const qk = queryKeys(q);
    for (const x of index) {
      let best: Grade = GRADE.NONE;
      for (const k of x.keys) {
        const g = matchGrade(qk, k);
        if (g < best) best = g;
      }
      if (best !== GRADE.NONE) out.set(x.item.id, best);
    }
    return out;
  }
  for (const m of searchIndexed(index, q)) out.set(m.item.id, m.grade);
  return out;
}

/** 로마자만인 입력이 한/영 변환으로 찾았는지. 변환하지 않았으면 null */
function convertedQuery(q: string, noConvert: boolean, hit: boolean): { from: string; to: string } | null {
  if (noConvert || !hit) return null;
  const raw = q.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!/^[a-zA-Z ]+$/.test(raw)) return null;
  const to = convertQwertyToHangul(raw);
  return to === normalize(q) ? null : { from: raw, to };
}

const overlapDates = (d: SearchDocument, from?: string, to?: string): boolean => {
  if (from === undefined && to === undefined) return true;
  if (d.periodStart === undefined || d.periodEnd === undefined) return false;
  if (from !== undefined && d.periodEnd < from) return false;
  if (to !== undefined && d.periodStart > to) return false;
  return true;
};

const hasFilters = (q: SearchQuery): boolean => q.genre !== undefined || q.placeId !== undefined || q.artistId !== undefined || q.dateFrom !== undefined || q.dateTo !== undefined || q.status !== undefined;

function filterDocs(docs: readonly SearchDocument[], q: SearchQuery, grades: Map<string, Grade> | null): SearchDocument[] {
  return docs.filter((d) => {
    if (!q.includePast && d.saleStatus === 'ENDED') return false;
    if (q.genre !== undefined && d.genre !== q.genre) return false;
    if (q.placeId !== undefined && d.placeId !== q.placeId) return false;
    if (q.artistId !== undefined && !d.artists.some((a) => a.artistId === q.artistId)) return false;
    if (q.status !== undefined && d.saleStatus !== q.status) return false;
    if (!overlapDates(d, q.dateFrom, q.dateTo)) return false;
    if (grades !== null && !grades.has(d.productionId)) return false;
    return true;
  });
}

function sortDocs(docs: SearchDocument[], q: SearchQuery, grades: Map<string, Grade>): SearchDocument[] {
  const sort = q.sort ?? (q.q.trim() === '' ? 'OPEN_SOON' : 'RELEVANCE');
  return [...docs].sort((a, b) => {
    if (sort === 'RELEVANCE') {
      const g = (grades.get(a.productionId) ?? GRADE.NONE) - (grades.get(b.productionId) ?? GRADE.NONE);
      if (g !== 0) return g;
      const s = SALE_RANK[a.saleStatus] - SALE_RANK[b.saleStatus];
      if (s !== 0) return s;
      if (a.popularity !== b.popularity) return b.popularity - a.popularity;
      return byTitle(a, b);
    }
    if (sort === 'POPULAR') {
      if (a.popularity !== b.popularity) return b.popularity - a.popularity;
      const s = SALE_RANK[a.saleStatus] - SALE_RANK[b.saleStatus];
      return s !== 0 ? s : byTitle(a, b);
    }
    const an = a.nextOpenAt ?? a.periodStart ?? '9999-12-31';
    const bn = b.nextOpenAt ?? b.periodStart ?? '9999-12-31';
    return an < bn ? -1 : an > bn ? 1 : byTitle(a, b);
  });
}

function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  const dp = Array.from({ length: y.length + 1 }, (_, i) => i);
  for (let i = 1; i <= x.length; i++) {
    let prev = dp[0]!;
    dp[0] = i;
    for (let j = 1; j <= y.length; j++) {
      const cur = dp[j]!;
      dp[j] = Math.min(dp[j]! + 1, dp[j - 1]! + 1, prev + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = cur;
    }
  }
  return dp[y.length]!;
}

function didYouMean(docs: readonly SearchDocument[], q: string): string | null {
  const n = normalize(q);
  if (n === '') return null;
  let best: { title: string; d: number } | null = null;
  for (const d of docs) {
    const v = distance(n, normalize(d.title));
    if (v <= 2 && (best === null || v < best.d)) best = { title: d.title, d: v };
  }
  return best?.title ?? null;
}

function popular(docs: readonly SearchDocument[], exclude?: string): SearchCard[] {
  return [...docs]
    .filter((d) => d.productionId !== exclude && d.saleStatus !== 'ENDED')
    .sort((a, b) => SALE_RANK[a.saleStatus] - SALE_RANK[b.saleStatus] || b.popularity - a.popularity || byTitle(a, b))
    .slice(0, RELATED_MAX)
    .map(card);
}

function relatedOf(docs: readonly SearchDocument[], top: SearchDocument | undefined): SearchOutcome['related'] {
  if (!top) return { basis: { kind: 'UPCOMING_POPULAR' }, items: popular(docs) };
  const artist = top.artists[0];
  if (artist) {
    const items = docs.filter((d) => d.productionId !== top.productionId && d.artists.some((a) => a.artistId === artist.artistId)).sort(byTitle).slice(0, RELATED_MAX).map(card);
    if (items.length > 0) return { basis: { kind: 'ARTIST', id: artist.artistId, name: artist.name }, items };
  }
  if (top.placeId && top.placeName) {
    const items = docs.filter((d) => d.productionId !== top.productionId && d.placeId === top.placeId && d.saleStatus === 'UPCOMING').sort(byTitle).slice(0, RELATED_MAX).map(card);
    if (items.length > 0) return { basis: { kind: 'PLACE', id: top.placeId, name: top.placeName }, items };
  }
  return { basis: { kind: 'UPCOMING_POPULAR' }, items: popular(docs, top.productionId) };
}

/** 모든 문서에서 찾는다(메모리 어댑터·단위 시험). index를 주면 이름 색인을 다시 만들지 않는다 */
export function searchDocuments(docs: readonly SearchDocument[], q: SearchQuery, index?: DocumentIndex): SearchOutcome {
  if (q.page > SEARCH_MAX_PAGE) throw new Error('page');
  const query = q.q.trim();
  const grades = query === '' ? new Map<string, Grade>() : matchGrades(index ?? indexDocuments(docs), query, q.noConvert);
  return assembleSearch(docs, q, grades, docs);
}

/**
 * 순위·필터·쪽·0건 제안·관련 공연을 맞춘다(ADR-0268 결정 3·6). 두 어댑터가 이 함수 하나를 쓴다(ADR-0271 결정 4).
 * matched: 검색어가 있으면 그 후보 공연(등급이 있는 공연을 모두 담은 것), 없으면 모든 공연. grades: 후보의 일치 등급.
 * all: 0건 제안·관련 공연·필터 이름을 고를 모든 공연(DB 어댑터는 판마다 들고 있는 것)
 */
export function assembleSearch(matched: readonly SearchDocument[], q: SearchQuery, grades: Map<string, Grade>, all: readonly SearchDocument[]): SearchOutcome {
  if (q.page > SEARCH_MAX_PAGE) throw new Error('page');
  const query = q.q.trim();
  const docs = matched;
  const filtered = filterDocs(docs, q, query === '' ? null : grades);
  const sorted = sortDocs(filtered, q, grades);
  const total = Math.min(sorted.length, SEARCH_TOTAL_CAP);
  const pageItems = sorted.slice((q.page - 1) * SEARCH_PAGE_SIZE, q.page * SEARCH_PAGE_SIZE).map(card);
  const relaxed = filtered.length === 0 && hasFilters(q) ? filterDocs(docs, { ...q, genre: undefined, placeId: undefined, artistId: undefined, dateFrom: undefined, dateTo: undefined, status: undefined }, query === '' ? null : grades).length : null;
  const placeName = q.placeId !== undefined ? (all.find((d) => d.placeId === q.placeId)?.placeName ?? null) : null;
  const artistName = q.artistId !== undefined ? (all.flatMap((d) => d.artists).find((a) => a.artistId === q.artistId)?.name ?? null) : null;
  const top = filtered.length > 0 ? sortDocs(filtered, { ...q, sort: 'RELEVANCE' }, grades)[0] : undefined;
  return {
    items: pageItems,
    page: q.page,
    limit: SEARCH_PAGE_SIZE,
    total,
    totalCapped: sorted.length > SEARCH_TOTAL_CAP,
    totalPages: Math.ceil(total / SEARCH_PAGE_SIZE),
    query: { normalized: normalize(query), converted: convertedQuery(query, q.noConvert, filtered.length > 0) },
    didYouMean: filtered.length === 0 && query !== '' ? didYouMean(all, query) : null,
    relaxedTotal: relaxed,
    ...(q.placeId !== undefined || q.artistId !== undefined ? { filterNames: { placeName, artistName } } : {}),
    related: filtered.length === 0 || (top && (top.artists.length > 0 || top.placeId)) ? relatedOf(all, top) : null,
  };
}

function positions(label: string, q: string): { start: number; length: number }[] | undefined {
  const n = normalize(label);
  const nq = normalize(q);
  if (nq === '') return undefined;
  const at = n.indexOf(nq);
  if (at < 0) return undefined;
  // 정규화가 글자 수를 바꾸지 않는 경우에만 UTF-16 위치를 그대로 쓴다
  if ([...n].length !== [...label].length) return undefined;
  return [{ start: at, length: nq.length }];
}

const suggestionCard = (d: SearchDocument): SuggestionItem => ({
  kind: 'PRODUCTION',
  label: d.title,
  productionId: d.productionId,
  ...(d.eventId !== undefined ? { eventId: d.eventId } : {}),
  ...(d.posterUrl !== undefined ? { posterUrl: d.posterUrl } : {}),
  ...(d.nextOpenAt !== undefined ? { nextOpenAt: d.nextOpenAt } : {}),
  ...(d.saleStatus !== 'ENDED' ? { saleStatus: d.saleStatus } : {}),
});

/** 자동완성에 묻지 않는 입력(빈 값, 로마자·숫자만 한 글자)인가 */
function suggestInput(input: string): { q: string; normalized: string; skip: boolean } {
  const q = input.trim();
  const normalized = normalize(q);
  return { q, normalized, skip: normalized === '' || (/^[a-zA-Z0-9 ]+$/.test(q) && normalized.length < 2) };
}

export function suggestDocuments(docs: readonly SearchDocument[], input: string): SearchSuggestions {
  const { q, normalized, skip } = suggestInput(input);
  if (skip) return { query: normalized, items: [] };
  const live = docs.filter((d) => d.saleStatus !== 'ENDED');
  const productions = searchIndexed(indexNames(live.map((d) => ({ id: d.productionId, name: d.title, aliases: d.aliases }))), q);
  const artistMap = new Map<string, { artistId: string; name: string }>();
  for (const d of live) for (const a of d.artists) artistMap.set(a.artistId, a);
  const artists = searchIndexed(indexNames([...artistMap.values()].map((a) => ({ id: a.artistId, name: a.name, aliases: [] }))), q);
  const placeMap = new Map<string, { placeId: string; name: string }>();
  for (const d of live) if (d.placeId && d.placeName) placeMap.set(d.placeId, { placeId: d.placeId, name: d.placeName });
  const places = searchIndexed(indexNames([...placeMap.values()].map((p) => ({ id: p.placeId, name: p.name, aliases: [] }))), q);
  return assembleSuggestions(q, normalized, productions, artists, places, new Map(live.map((d) => [d.productionId, d])));
}

/** 공연 5·아티스트 2·공연장 1을 먼저 채우고 빈 몫은 다른 종류로 채운다(§4.1). 각 목록은 등급 → 가나다 → ID 차례다 */
function assembleSuggestions(
  q: string,
  normalized: string,
  productions: ReadonlyArray<NameMatch<NameItem>>,
  artists: ReadonlyArray<NameMatch<NameItem>>,
  places: ReadonlyArray<NameMatch<NameItem>>,
  byId: ReadonlyMap<string, SearchDocument>,
): SearchSuggestions {
  const prodItems = productions.slice(0, SUGGESTION_QUOTA.PRODUCTION).map((m) => ({ ...suggestionCard(byId.get(m.item.id)!), matches: positions(m.item.name, q) }));
  const artistItems = artists.slice(0, SUGGESTION_QUOTA.ARTIST).map((m) => ({ kind: 'ARTIST' as const, label: m.item.name, artistId: m.item.id, matches: positions(m.item.name, q) }));
  const placeItems = places.slice(0, SUGGESTION_QUOTA.PLACE).map((m) => ({ kind: 'PLACE' as const, label: m.item.name, placeId: m.item.id, matches: positions(m.item.name, q) }));
  const items = [...prodItems, ...artistItems, ...placeItems];
  const rest = [
    ...productions.slice(SUGGESTION_QUOTA.PRODUCTION).map((m) => ({ ...suggestionCard(byId.get(m.item.id)!), matches: positions(m.item.name, q) })),
    ...artists.slice(SUGGESTION_QUOTA.ARTIST).map((m) => ({ kind: 'ARTIST' as const, label: m.item.name, artistId: m.item.id, matches: positions(m.item.name, q) })),
    ...places.slice(SUGGESTION_QUOTA.PLACE).map((m) => ({ kind: 'PLACE' as const, label: m.item.name, placeId: m.item.id, matches: positions(m.item.name, q) })),
  ];
  return { query: normalized, items: [...items, ...rest].slice(0, SUGGESTION_MAX) };
}

/** 메모리 어댑터가 공연·회차에서 문서를 만든다. DB 어댑터는 같은 모양을 SQL에서 만든다 */
export function documentOf(o: {
  productionId: string;
  eventId?: string;
  title: string;
  aliases?: readonly string[];
  genre: Genre;
  placeId?: string | null;
  placeName?: string | null;
  artists?: readonly SearchArtist[];
  posterUrl?: string;
  posterAlt?: string;
  events: readonly { id: string; openAt: Date; startsAt: Date; endsAt: Date; status: 'SCHEDULED' | 'CANCELLED' | 'POSTPONED'; sale: EventSaleState }[];
  now: Date;
  minPrice?: number;
  popularity?: number;
}): SearchDocument | undefined {
  const rows = o.events.filter((e) => e.status !== 'CANCELLED').map((e) => ({ event: { id: e.id, productionId: o.productionId, venueId: null, openAt: e.openAt, startsAt: e.startsAt, status: e.status }, sale: e.sale }));
  if (rows.length === 0) return undefined;
  const rep = representativeEvent(rows, o.now);
  const next = rows.filter((r) => r.sale === 'UPCOMING').sort((a, b) => a.event.openAt.getTime() - b.event.openAt.getTime() || (a.event.id < b.event.id ? -1 : 1))[0]?.event;
  const kst = (d: Date) => new Date(d.getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const starts = rows.map((r) => r.event.startsAt.getTime());
  const ends = o.events.filter((e) => e.status !== 'CANCELLED').map((e) => e.endsAt.getTime());
  return {
    productionId: o.productionId,
    ...(rep ? { eventId: rep.id } : {}),
    title: o.title,
    aliases: [...(o.aliases ?? [])],
    genre: o.genre,
    ...(o.placeId ? { placeId: o.placeId } : {}),
    ...(o.placeName ? { placeName: o.placeName } : {}),
    artists: [...(o.artists ?? [])],
    ...(o.posterUrl ? { posterUrl: o.posterUrl } : {}),
    ...(o.posterAlt ? { posterAlt: o.posterAlt } : {}),
    periodStart: kst(new Date(Math.min(...starts))),
    periodEnd: kst(new Date(Math.max(...ends))),
    ...(next ? { nextOpenAt: next.openAt.toISOString(), nextOpenEventId: next.id } : {}),
    saleStatus: cardSaleStatus(rows),
    saleEndsAt: new Date(Math.max(...rows.map((r) => saleEndsAt(r.event).getTime()))).toISOString(),
    ...(o.minPrice !== undefined ? { minPrice: o.minPrice } : {}),
    popularity: o.popularity ?? 0,
  };
}

// ---- 검색 읽기 모델·자동완성 사전·검색 로그(ADR-0271, docs/features/search.md §2.3·§4.4·§11, BAT-165 웨이브 7) ----

/** 검색 전용 연결 묶음이 넘쳤거나 질의 시간 상한을 넘었다(503, ADR-0271 결정 5) */
export class SearchUnavailable extends Error {
  constructor(readonly reason: 'pool-timeout' | 'statement-timeout') {
    super(`검색을 쓸 수 없다: ${reason}`);
  }
}

/** search_term 한 줄(docs/data.md search_term) */
export interface SearchTermRow {
  id: string;
  kind: 'PRODUCTION' | 'ARTIST' | 'PLACE';
  targetId: string;
  displayName: string;
  aliasOf: string | null;
  norm: string;
  normNospace: string;
  jamo: string;
  chosung: string;
  updatedVersion: number;
}

/** 자동완성 사전이 한 번에 읽는 것(한 읽기 전용 트랜잭션, docs/features/search.md §2.3) */
export interface DictionarySnapshot {
  version: number;
  /** 통째로 읽었는가 */
  full: boolean;
  /** updated_version > since(통째면 전부) */
  documents: SearchDocument[];
  /** 같은 조건 */
  terms: SearchTermRow[];
  removals: { version: number; kind: 'DOCUMENT' | 'TERM'; targetId: string }[];
}

export interface SearchDictionarySource {
  /** 한 읽기 전용 REPEATABLE READ 트랜잭션에서 판을 먼저 읽는다. since가 null이면 통째로 */
  read(since: number | null): Promise<DictionarySnapshot>;
  version(): Promise<number>;
}

export const SEARCH_DICTIONARY_SOURCE = Symbol('SEARCH_DICTIONARY_SOURCE');

/** 공연 하나의 이름 원천(동기화와 메모리 원천이 이름 줄을 만든다) */
export interface TermSource {
  productionId: string;
  title: string;
  /** 다른 이름과 그 ID(search_alias.id) */
  aliases: readonly { id: string; alias: string }[];
  artists: readonly SearchArtist[];
  placeId?: string | null;
  placeName?: string | null;
}

/**
 * 공연 하나가 내는 이름 줄. 줄 ID는 공연명이면 공연 ID, 다른 이름이면 그 search_alias ID, 아티스트·공연장이면 그 ID다(늘 같은 ID라 다시 승인되면 같은 줄로 돌아온다).
 * 정규화·띄어쓰기 없앤 값·낱자·초성은 브라우저와 같은 @peaket/search-normalize nameKeys 값이다(ADR-0271 결정 1)
 */
export function termRowsOf(src: TermSource, version: number): SearchTermRow[] {
  const row = (id: string, kind: SearchTermRow['kind'], targetId: string, displayName: string, aliasOf: string | null): SearchTermRow => {
    const k = nameKeys(displayName);
    return { id, kind, targetId, displayName, aliasOf, norm: k.norm, normNospace: k.nospace, jamo: k.jamo, chosung: k.chosung, updatedVersion: version };
  };
  return [
    row(src.productionId, 'PRODUCTION', src.productionId, src.title, null),
    ...src.aliases.map((a) => row(a.id, 'PRODUCTION', src.productionId, a.alias, src.title)),
    ...src.artists.filter((a) => a.name !== '').map((a) => row(a.artistId, 'ARTIST', a.artistId, a.name, null)),
    ...(src.placeId && src.placeName ? [row(src.placeId, 'PLACE', src.placeId, src.placeName, null)] : []),
  ];
}

/** 사전이 판을 확인하는 간격(docs/features/search.md:56, 10초 [가정]) */
export const DICTIONARY_CHECK_MS = 10_000;
/** 판이 이만큼보다 많이 뛰면 통째로 읽는다(search.md:56, 1,000 [가정]) */
export const DICTIONARY_FULL_JUMP = 1_000;
/** 마지막 갱신이 이보다 오래되면 통째로 읽는다(search.md:56, 1시간 [가정]) */
export const DICTIONARY_FULL_AGE_MS = 3_600_000;

/** 사전이 쓰는 시계(플랫폼 Clock과 같은 모양, 도메인은 플랫폼을 가져오지 않는다) */
export interface DictionaryClock {
  now(): number;
}

interface DictEntry {
  row: SearchTermRow;
  keys: NameKeys;
}

interface KeyRef {
  key: string;
  id: string;
}

interface DictIndex {
  /** 낱자 키(이름 전체·낱말부터 끝까지) 정렬 배열. 앞부분 일치는 이분 탐색으로 찾는다(§4.4) */
  jamo: KeyRef[];
  chosung: KeyRef[];
  /** 띄어쓰기 없앤 값의 두 글자 조각 → 줄 ID(중간 일치 후보, §4.4) */
  bigram: Map<string, string[]>;
  live: Set<string>;
  liveArtists: Set<string>;
  livePlaces: Set<string>;
}

type Kind = SearchTermRow['kind'];
type KindMatches = Record<Kind, NameMatch<NameItem>[]>;

const byKey = (a: KeyRef, b: KeyRef) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** key로 시작하는 줄 ID(정렬 배열의 이분 탐색) */
function prefixIds(keys: readonly KeyRef[], prefix: string, out: Set<string>): void {
  let lo = 0;
  let hi = keys.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (keys[mid]!.key < prefix) lo = mid + 1;
    else hi = mid;
  }
  for (let i = lo; i < keys.length && keys[i]!.key.startsWith(prefix); i++) out.add(keys[i]!.id);
}

// searchIndexed의 한/영 변환과 같은 입력 다듬기(제로폭·한글 채움 문자를 지운다)
const INVISIBLE = /[​-‍⁠﻿ᅟᅠㅤ]/g;

/**
 * 자동완성 메모리 사전(docs/features/search.md §2.3·§4.4, ADR-0271 결정 6). suggest·correct는 DB를 부르지 않고, 한 요청이 사전 전체를 훑지 않는다.
 * refresh: 마지막 확인에서 10초가 안 지났으면 원천을 부르지 않는다. 판이 바뀌었으면 지난 판 뒤의 줄과 지운 표시만 읽는다.
 * 처음 뜰 때·판이 1,000 넘게 뛰었을 때·마지막 갱신이 1시간보다 오래됐을 때만 통째로 읽는다.
 * 한 스냅숏의 줄은 지금 남은 줄이므로 지운 표시를 먼저 반영하고 줄을 넣는다(같은 판 안에서 지우고 다시 넣은 이름이 남는다).
 */
export class SuggestionDictionary {
  #docs = new Map<string, SearchDocument>();
  #terms = new Map<string, DictEntry>();
  #version = 0;
  #loaded = false;
  #checkedAt = Number.NEGATIVE_INFINITY;
  #readAt = Number.NEGATIVE_INFINITY;
  #index: DictIndex | undefined;
  #running: Promise<{ version: number; full: boolean; applied: number; removed: number }> | undefined;

  constructor(
    readonly source: SearchDictionarySource,
    readonly clock: DictionaryClock,
  ) {}

  get version(): number {
    return this.#version;
  }

  /** 이름 항목 수(search_term 줄 수와 같다) */
  get entries(): number {
    return this.#terms.size;
  }

  /** 마지막으로 원천을 읽은 시각(ms). 읽은 적이 없으면 undefined */
  get readAt(): number | undefined {
    return Number.isFinite(this.#readAt) ? this.#readAt : undefined;
  }

  refresh(): Promise<{ version: number; full: boolean; applied: number; removed: number }> {
    // 같은 때 들어온 요청은 한 번의 갱신을 함께 기다린다
    if (this.#running) return this.#running;
    const run = this.#refresh().finally(() => {
      this.#running = undefined;
    });
    this.#running = run;
    return run;
  }

  async #refresh(): Promise<{ version: number; full: boolean; applied: number; removed: number }> {
    const now = this.clock.now();
    const idle = { version: this.#version, full: false, applied: 0, removed: 0 };
    if (now - this.#checkedAt < DICTIONARY_CHECK_MS) return idle;
    // 원천이 실패해도 10초 동안은 다시 부르지 않는다(DB가 아플 때 요청마다 두드리지 않게)
    this.#checkedAt = now;
    let full = !this.#loaded;
    if (!full) {
      const v = await this.source.version();
      if (v === this.#version) return idle;
      full = v < this.#version || v - this.#version > DICTIONARY_FULL_JUMP || now - this.#readAt > DICTIONARY_FULL_AGE_MS;
    }
    const snap = await this.source.read(full ? null : this.#version);
    this.#readAt = now;
    if (snap.full) {
      this.#docs = new Map(snap.documents.map((d) => [d.productionId, d]));
      this.#terms = new Map(snap.terms.map((t) => [t.id, { row: t, keys: nameKeys(t.displayName) }]));
    } else {
      for (const r of snap.removals) {
        if (r.kind === 'DOCUMENT') this.#docs.delete(r.targetId);
        else this.#terms.delete(r.targetId);
      }
      for (const d of snap.documents) this.#docs.set(d.productionId, d);
      for (const t of snap.terms) {
        const old = this.#terms.get(t.id);
        this.#terms.set(t.id, { row: t, keys: old && old.row.displayName === t.displayName ? old.keys : nameKeys(t.displayName) });
      }
    }
    this.#version = snap.version;
    this.#loaded = true;
    this.#index = undefined;
    return { version: snap.version, full: snap.full, applied: snap.documents.length + snap.terms.length, removed: snap.full ? 0 : snap.removals.length };
  }

  #built(): DictIndex {
    if (this.#index) return this.#index;
    const jamo: KeyRef[] = [];
    const chosung: KeyRef[] = [];
    const bigram = new Map<string, string[]>();
    for (const [id, e] of this.#terms) {
      jamo.push({ key: e.keys.jamo, id });
      chosung.push({ key: e.keys.chosung, id });
      for (const w of e.keys.words.slice(1)) {
        jamo.push({ key: w.jamo, id });
        chosung.push({ key: w.chosung, id });
      }
      const cs = [...e.keys.nospace];
      const seen = new Set<string>();
      for (let i = 0; i + 1 < cs.length; i++) {
        const g = cs[i]! + cs[i + 1]!;
        if (seen.has(g)) continue;
        seen.add(g);
        const list = bigram.get(g);
        if (list) list.push(id);
        else bigram.set(g, [id]);
      }
    }
    jamo.sort(byKey);
    chosung.sort(byKey);
    const live = new Set<string>();
    const liveArtists = new Set<string>();
    const livePlaces = new Set<string>();
    for (const d of this.#docs.values()) {
      if (d.saleStatus === 'ENDED') continue;
      live.add(d.productionId);
      for (const a of d.artists) liveArtists.add(a.artistId);
      if (d.placeId && d.placeName) livePlaces.add(d.placeId);
    }
    this.#index = { jamo, chosung, bigram, live, liveArtists, livePlaces };
    return this.#index;
  }

  /** 입력 하나의 비교 값으로 후보 줄을 찾아 대상마다 가장 좋은 등급을 매긴다(등급 → 가나다 → ID 차례) */
  #run(qk: QueryKeys): KindMatches {
    const out: KindMatches = { PRODUCTION: [], ARTIST: [], PLACE: [] };
    if (qk.nospace === '') return out;
    const ix = this.#built();
    const ids = new Set<string>();
    prefixIds(ix.jamo, qk.jamo, ids);
    if (qk.chosung !== null) prefixIds(ix.chosung, qk.chosung, ids);
    const cs = [...qk.nospace];
    if (cs.length >= 2 && qk.chosung === null) for (const id of ix.bigram.get(cs[0]! + cs[1]!) ?? []) ids.add(id);
    const best = new Map<string, { kind: Kind; id: string; name: string; grade: Grade }>();
    for (const id of ids) {
      const e = this.#terms.get(id);
      if (!e) continue;
      const { kind, targetId } = e.row;
      let name: string;
      if (kind === 'PRODUCTION') {
        if (!ix.live.has(targetId)) continue;
        name = this.#docs.get(targetId)!.title;
      } else if (kind === 'ARTIST') {
        if (!ix.liveArtists.has(targetId)) continue;
        name = e.row.displayName;
      } else {
        if (!ix.livePlaces.has(targetId)) continue;
        name = e.row.displayName;
      }
      const grade = matchGrade(qk, e.keys);
      if (grade === GRADE.NONE) continue;
      const key = `${kind}:${targetId}`;
      const prev = best.get(key);
      if (!prev || grade < prev.grade) best.set(key, { kind, id: targetId, name, grade });
    }
    for (const b of best.values()) out[b.kind].push({ item: { id: b.id, name: b.name, aliases: [] }, grade: b.grade });
    for (const k of ['PRODUCTION', 'ARTIST', 'PLACE'] as const) out[k].sort((a, b) => compareMatch({ grade: a.grade, name: a.item.name, id: a.item.id }, { grade: b.grade, name: b.item.name, id: b.item.id }));
    return out;
  }

  /** 자동완성(§4). DB를 부르지 않는다. 종류마다 searchIndexed와 같은 한/영 변환 대체를 한다 */
  suggest(input: string): SearchSuggestions {
    const { q, normalized, skip } = suggestInput(input);
    if (skip) return { query: normalized, items: [] };
    const qk = queryKeys(q);
    const first = this.#run(qk);
    const raw = q.normalize('NFKC').replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
    const roman = /^[a-zA-Z ]+$/.test(raw);
    let exact: KindMatches | undefined;
    let lower: KindMatches | undefined;
    const pick = (k: Kind): NameMatch<NameItem>[] => {
      if (first[k].length > 0 || !roman) return first[k];
      exact ??= this.#run(queryKeys(convertQwertyToHangul(raw)));
      if (exact[k].length > 0 || raw === qk.norm) return exact[k];
      lower ??= this.#run(queryKeys(convertQwertyToHangul(qk.norm)));
      return lower[k];
    };
    return assembleSuggestions(q, normalized, pick('PRODUCTION'), pick('ARTIST'), pick('PLACE'), this.#docs);
  }

  /** 오타 제안(didYouMean). 검색 결과가 0건일 때만 부른다 */
  correct(input: string): string | null {
    return didYouMean([...this.#docs.values()], input);
  }
}

/** 쓰기 쪽 동기화(같은 트랜잭션, ADR-0271 결정 2·3). tx는 어댑터의 DB 트랜잭션(@peaket/platform DbTransaction)이다. 도메인은 그 모양을 모른다 */
export interface SearchReadModelSync {
  sync(tx: unknown, productionIds: readonly string[], at: Date): Promise<{ version: number; removed: string[] }>;
  /** 1분 정리: since 뒤 at까지 오픈·판매 종료 시각이 지난 회차의 공연을 다시 동기화한다. 고칠 것이 없었으면 version은 null */
  syncTimed(at: Date, since: Date): Promise<{ version: number | null; productions: number }>;
  /** 1시간: 관심도(찜 수)를 다시 센다. 바뀐 공연 수 */
  recountInterest(at: Date): Promise<number>;
  /** 하루 지난 지운 표시를 지운다. 지운 줄 수 */
  purgeRemovals(at: Date): Promise<number>;
}
export const SEARCH_READ_MODEL_SYNC: unique symbol = Symbol('SEARCH_READ_MODEL_SYNC');

// 검색어 가리기(docs/features/search.md §11 286줄). 이메일 꼴 → [이메일], 0으로 시작하는 9~11자리 숫자(사이 하이픈·점·공백 허용) → [전화],
// 그 밖의 이어진 숫자 5자리 이상 → [숫자]. 이메일 → 전화 → 숫자 차례로 바꾼다. 정규식은 겹치는 반복이 없다(ASVS 1.3.12)
const MASK_EMAIL = /[^\s@]+@[^\s@.]+(?:\.[^\s@.]+)+/g;
const MASK_PHONE = /(?<!\d)0\d(?:[-. ]?\d){7,9}(?!\d)/g;
const MASK_NUMBER = /\d{5,}/g;

/** search_query 줄에 남기기 전 검색어 가리기(docs/features/search.md §11). 검색은 가리기 전 값으로 한다 */
export function maskSearchQuery(normalized: string): string {
  return normalized.replace(MASK_EMAIL, '[이메일]').replace(MASK_PHONE, '[전화]').replace(MASK_NUMBER, '[숫자]');
}

/** 0건 목록에 넣는 최소 횟수(search.md:286, 5번 [가정])와 보이는 수(50개) */
export const ZERO_RESULT_MIN = 5;
export const ZERO_RESULT_TOP = 50;
const WEEK_MS = 7 * 86_400_000;

/** 한 주(weekStart부터 7일, KST 월요일 0시)의 0건 검색어 목록: 서로 다른 줄로 5번 이상 나온 것, 많은 차례로 50개(docs/features/search.md §11) */
export function zeroResultQueries(lines: readonly { query: string; results: number; at: string }[], o: { weekStart: string }): { query: string; count: number }[] {
  const start = Date.parse(o.weekStart);
  if (!Number.isFinite(start)) throw new RangeError(`weekStart가 시각이 아니다: ${o.weekStart}`);
  const counts = new Map<string, number>();
  for (const l of lines) {
    if (l.results !== 0) continue;
    const t = Date.parse(l.at);
    if (!(t >= start && t < start + WEEK_MS)) continue;
    counts.set(l.query, (counts.get(l.query) ?? 0) + 1);
  }
  return [...counts]
    .filter(([, n]) => n >= ZERO_RESULT_MIN)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, ZERO_RESULT_TOP)
    .map(([query, count]) => ({ query, count }));
}

/** 오타 제안에 쓰는 이름 키(시험이 직접 부른다) */
export const nameKeysOf = nameKeys;
