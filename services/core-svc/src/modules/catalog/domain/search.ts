// 검색 도메인: 검색 문서·질의·결과와 순위(ADR-0094, docs/features/search.md §3~§6, BUILD_ORDER HOT-270·HOT-280).
// 정규화·낱자·초성 비교는 packages/search-normalize를 쓴다. DB·프레임워크를 모르는 순수 함수만 둔다.
import { convertQwertyToHangul, GRADE, indexNames, matchGrade, nameKeys, normalize, queryKeys, searchIndexed, type Grade } from '@peaket/search-normalize';
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

/** 검색 포트. 메모리·DB 어댑터가 같은 문서 모양을 낸다 */
export interface SearchIndex {
  documents(): Promise<SearchDocument[]>;
  /** 사전을 다시 읽을지 판단하는 판(바뀌면 자동완성 사전을 다시 만든다) */
  version(): Promise<number>;
  /** 한 번의 검색. 후보만 읽는다(ADR-0271 결정 4). 연결 묶음이 넘치면 SearchUnavailable을 던진다. BAT-165 웨이브 7 시험 담당이 둔 빈 뼈대 */
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

function matchGrades(docs: readonly SearchDocument[], q: string, noConvert: boolean): Map<string, Grade> {
  const index = indexNames(docs.map((d) => ({ id: d.productionId, name: d.title, aliases: searchNamesOf(d).slice(1) })));
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

export function searchDocuments(docs: readonly SearchDocument[], q: SearchQuery): SearchOutcome {
  if (q.page > SEARCH_MAX_PAGE) throw new Error('page');
  const query = q.q.trim();
  const grades = query === '' ? new Map<string, Grade>() : matchGrades(docs, query, q.noConvert);
  const filtered = filterDocs(docs, q, query === '' ? null : grades);
  const sorted = sortDocs(filtered, q, grades);
  const total = Math.min(sorted.length, SEARCH_TOTAL_CAP);
  const pageItems = sorted.slice((q.page - 1) * SEARCH_PAGE_SIZE, q.page * SEARCH_PAGE_SIZE).map(card);
  const relaxed = filtered.length === 0 && hasFilters(q) ? filterDocs(docs, { ...q, genre: undefined, placeId: undefined, artistId: undefined, dateFrom: undefined, dateTo: undefined, status: undefined }, query === '' ? null : grades).length : null;
  const placeName = q.placeId !== undefined ? (docs.find((d) => d.placeId === q.placeId)?.placeName ?? null) : null;
  const artistName = q.artistId !== undefined ? (docs.flatMap((d) => d.artists).find((a) => a.artistId === q.artistId)?.name ?? null) : null;
  const top = filtered.length > 0 ? sortDocs(filtered, { ...q, sort: 'RELEVANCE' }, grades)[0] : undefined;
  return {
    items: pageItems,
    page: q.page,
    limit: SEARCH_PAGE_SIZE,
    total,
    totalCapped: sorted.length > SEARCH_TOTAL_CAP,
    totalPages: Math.ceil(total / SEARCH_PAGE_SIZE),
    query: { normalized: normalize(query), converted: convertedQuery(query, q.noConvert, filtered.length > 0) },
    didYouMean: filtered.length === 0 && query !== '' ? didYouMean(docs, query) : null,
    relaxedTotal: relaxed,
    ...(q.placeId !== undefined || q.artistId !== undefined ? { filterNames: { placeName, artistName } } : {}),
    related: filtered.length === 0 || (top && (top.artists.length > 0 || top.placeId)) ? relatedOf(docs, top) : null,
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

export function suggestDocuments(docs: readonly SearchDocument[], input: string): SearchSuggestions {
  const q = input.trim();
  const normalized = normalize(q);
  if (normalized === '') return { query: normalized, items: [] };
  if (/^[a-zA-Z0-9 ]+$/.test(q) && normalized.length < 2) return { query: normalized, items: [] };
  const live = docs.filter((d) => d.saleStatus !== 'ENDED');
  const productions = searchIndexed(indexNames(live.map((d) => ({ id: d.productionId, name: d.title, aliases: d.aliases }))), q);
  const artistMap = new Map<string, { artistId: string; name: string }>();
  for (const d of live) for (const a of d.artists) artistMap.set(a.artistId, a);
  const artists = searchIndexed(indexNames([...artistMap.values()].map((a) => ({ id: a.artistId, name: a.name, aliases: [] }))), q);
  const placeMap = new Map<string, { placeId: string; name: string }>();
  for (const d of live) if (d.placeId && d.placeName) placeMap.set(d.placeId, { placeId: d.placeId, name: d.placeName });
  const places = searchIndexed(indexNames([...placeMap.values()].map((p) => ({ id: p.placeId, name: p.name, aliases: [] }))), q);
  const byId = new Map(live.map((d) => [d.productionId, d]));
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

// ---- BAT-165 웨이브 7 공개 인터페이스(계획 docs/review/plans/BAT-165.md '웨이브 7 계획' §5, ADR-0271). 시험 담당이 둔 빈 뼈대이고 구현 담당이 채운다 ----

const notYet = (): never => {
  throw new Error('아직 없음');
};

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

/** 자동완성 메모리 사전(docs/features/search.md §4.4, ADR-0271 결정 6). suggest·correct는 DB를 부르지 않는다 */
/** 사전이 쓰는 시계(플랫폼 Clock과 같은 모양, 도메인은 플랫폼을 가져오지 않는다) */
export interface DictionaryClock {
  now(): number;
}

export class SuggestionDictionary {
  constructor(
    readonly source: SearchDictionarySource,
    readonly clock: DictionaryClock,
  ) {}

  refresh(): Promise<{ version: number; full: boolean; applied: number; removed: number }> {
    return notYet();
  }

  suggest(_input: string): SearchSuggestions {
    return notYet();
  }

  /** didYouMean */
  correct(_input: string): string | null {
    return notYet();
  }

  get version(): number {
    return notYet();
  }

  get entries(): number {
    return notYet();
  }
}

/** 쓰기 쪽 동기화(같은 트랜잭션, ADR-0271 결정 2·3). tx는 어댑터의 DB 트랜잭션(@peaket/platform DbTransaction)이다. 도메인은 그 모양을 모른다 */
export interface SearchReadModelSync {
  sync(tx: unknown, productionIds: readonly string[], at: Date): Promise<{ version: number; removed: string[] }>;
  /** 1분 정리 */
  syncTimed(at: Date, since: Date): Promise<{ version: number | null; productions: number }>;
  /** 1시간 */
  recountInterest(at: Date): Promise<number>;
  /** 하루 지난 지운 표시 */
  purgeRemovals(at: Date): Promise<number>;
}
export const SEARCH_READ_MODEL_SYNC: unique symbol = Symbol('SEARCH_READ_MODEL_SYNC');

/** search_query 줄에 남기기 전 검색어 가리기(docs/features/search.md §11) */
export function maskSearchQuery(_normalized: string): string {
  return notYet();
}

/** 한 주의 0건 검색어 목록(docs/features/search.md §11) */
export function zeroResultQueries(_lines: readonly { query: string; results: number; at: string }[], _o: { weekStart: string }): { query: string; count: number }[] {
  return notYet();
}

/** 오타 제안에 쓰는 이름 키(시험이 직접 부른다) */
export const nameKeysOf = nameKeys;
