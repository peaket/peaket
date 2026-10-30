// SCR-003 검색 화면의 보기 모델(d5 §5.3, docs/features/search.md는 데이터 연결 단계의 정본).
// - 상태를 고르면(?state=) 캔버스 보드의 예시 조합(추천 적용 2026-10-28: 빈 결과 '루맨', 바꿔 찾음 'fnaps' → '루멘' 결과 3개,
//   아티스트로 맞음 '루멘' + 장르 '콘서트' 필터 결과 1개와 'LUMEN의 다른 공연' 2개, 빈 결과(필터) '뮤지컬' + '오픈 예정')을 그대로 그린다.
// - 상태를 고르지 않으면 주소의 검색어·필터로 목업 공연(entities/production)을 거른다(홈·셸 링크가 여는 화면).
// 필터 주소는 d5 §5.3 이름(genre·status·placeId·artistId·includePast·sort·page)을 쓰고, 셸·홈이 이미 쓰는 venue·status=upcoming도 받는다.
import { ARTISTS, getArtist } from '@/entities/artist';
import { PRODUCTIONS, type Production, type ProductionStatus } from '@/entities/production';
import { getVenue, VENUES } from '@/entities/venue';
import { GENRES, GENRE_LABEL, type Genre } from '@/shared/config/genres';
import type { Scr003State } from '@/shared/config/screens.discovery';
import { firstParam, type SearchParams } from '@/shared/lib/page-props';

export type ComboboxMode = 'closed' | 'recent' | 'suggest' | 'loading' | 'none';
export type ResultMode = 'list' | 'empty' | 'empty-filter' | 'error' | 'loading';
export type SortKey = 'relevance' | 'opening' | 'popular';
export type StatusFilter = Exclude<ProductionStatus, 'ended'>;

export const SORT_OPTIONS: readonly { value: SortKey; label: string }[] = [
  { value: 'relevance', label: '정확도' },
  { value: 'opening', label: '오픈 임박' },
  { value: 'popular', label: '인기' },
];

export const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'upcoming', label: '오픈 예정' },
  { value: 'on_sale', label: '판매 중' },
  { value: 'sold_out', label: '매진' },
];

/** 결과 카드(CMP-072 ProductionCard result). 공연 하나가 한 줄, 누르면 대표 회차 상세 */
export interface ResultCard {
  id: string;
  href: string;
  title: string;
  period: string;
  venue: string;
  /** 작은 카드(오픈 예정 인기 공연)의 보조 글 */
  openMeta: string;
  status: ProductionStatus;
  poster: Production['poster'];
}

export interface SearchFilters {
  genres: Genre[];
  statuses: StatusFilter[];
  venueIds: string[];
  artistIds: string[];
  includePast: boolean;
}

export interface SearchView {
  /** 입력 칸의 글 */
  q: string;
  combobox: ComboboxMode;
  result: ResultMode;
  filters: SearchFilters;
  sort: SortKey;
  total: number;
  page: number;
  pages: number;
  cards: ResultCard[];
  /** 한/영 변환으로 찾았을 때 { 바꾼 값, 원래 입력 } */
  converted?: { to: string; from: string };
  /** 비슷한 이름 제안('혹시 …을 찾으셨나요?') */
  didYouMean?: string;
  /** 필터를 풀면 나오는 수 */
  unfilteredCount?: number;
  /** 관련 공연(아티스트·공연장으로 맞았을 때) */
  related?: { title: string; cards: ResultCard[] };
  /** 결과 0건일 때 오픈 예정 인기 공연 */
  popular?: ResultCard[];
}

export const PAGE_SIZE = 20;

/** 다른 이름(별칭): 소문자 입력 → 맞는 이름. 실제로는 검색 색인의 다른 이름 칸(search.md §2) */
const ALIASES: Record<string, string> = { 루멘: 'LUMEN', lumen: 'LUMEN' };
/** 한/영 키를 잘못 둔 입력 → 바꾼 값(search.md §3) */
const CONVERT: Record<string, string> = { fnaps: '루멘' };
/** 비슷한 이름 제안(오타) */
const SIMILAR: Record<string, string> = { 루맨: '루멘' };

export function toCard(p: Production): ResultCard {
  return {
    id: p.id,
    href: `/events/${p.performanceIds[0] ?? ''}`,
    title: p.title,
    period: p.periodText,
    venue: getVenue(p.venueId)?.name ?? '',
    openMeta: `${p.openText} 오픈${p.upcomingBadge ? ` · ${p.upcomingBadge.text}` : ''}`,
    status: p.status,
    poster: p.poster,
  };
}

const byId = (id: string) => PRODUCTIONS.find((p) => p.id === id);
const cards = (ids: readonly string[]) => ids.map(byId).filter((p): p is Production => Boolean(p)).map(toCard);

/** 보드 '결과' 예시 8개(판매 중·오픈 예정·매진이 섞이게) */
const BOARD_RESULT_IDS = [
  'prd-lumen',
  'prd-starlight-gala',
  'prd-classic-garden',
  'prd-musical',
  'prd-jazz-night',
  'prd-comedy',
  'prd-fest',
  'prd-winter-orch',
] as const;

const EMPTY_FILTERS: SearchFilters = { genres: [], statuses: [], venueIds: [], artistIds: [], includePast: false };

function popular(): ResultCard[] {
  return cards(['prd-fanmeet', 'prd-starlight-gala', 'prd-jazz-night']);
}

/** 보드의 상태별 예시(보드 renderVals 그대로) */
function boardView(st: Scr003State, sort: SortKey): SearchView {
  const base: SearchView = {
    q: '콘서트',
    combobox: 'closed',
    result: 'list',
    filters: EMPTY_FILTERS,
    sort,
    total: 128,
    page: 1,
    pages: Math.ceil(128 / PAGE_SIZE),
    cards: cards(BOARD_RESULT_IDS),
  };
  switch (st) {
    case '결과':
      return base;
    case '최근 검색어':
      return { ...base, q: '', combobox: 'recent' };
    case '자동완성':
      return { ...base, q: '루멘', combobox: 'suggest' };
    case '자동완성 불러오는 중':
      return { ...base, q: '루멘', combobox: 'loading' };
    case '자동완성 없음':
      return { ...base, q: '오페라', combobox: 'none' };
    case '빈 결과':
      return { ...base, q: '루맨', result: 'empty', total: 0, pages: 0, cards: [], didYouMean: '루멘', popular: popular() };
    case '빈 결과(필터)':
      return {
        ...base,
        q: '뮤지컬',
        result: 'empty-filter',
        filters: { ...EMPTY_FILTERS, statuses: ['upcoming'] },
        total: 0,
        pages: 0,
        cards: [],
        unfilteredCount: 12,
        popular: popular(),
      };
    case '에러':
      return { ...base, q: 'LUMEN', result: 'error', total: 0, pages: 0, cards: [] };
    case '로딩':
      return { ...base, q: '뮤지컬', result: 'loading', total: 0, pages: 0, cards: [] };
    case '바꿔 찾음':
      return { ...base, q: 'fnaps', total: 3, pages: 1, cards: cards(['prd-lumen', 'prd-fanmeet', 'prd-musical']), converted: { to: '루멘', from: 'fnaps' } };
    case '아티스트로 맞음':
      return {
        ...base,
        q: '루멘',
        filters: { ...EMPTY_FILTERS, genres: ['concert'] },
        total: 1,
        pages: 1,
        cards: cards(['prd-lumen']),
        related: { title: 'LUMEN의 다른 공연', cards: cards(['prd-fanmeet', 'prd-musical']) },
      };
  }
}

function many(sp: SearchParams, key: string): string[] {
  const v = sp[key];
  const list = Array.isArray(v) ? v : v ? [v] : [];
  return list.flatMap((s) => s.split(',')).filter(Boolean);
}

export function readFilters(sp: SearchParams): SearchFilters {
  const genreKeys = new Set(GENRES.map((g) => g.key as string));
  const statusKeys = new Set(STATUS_OPTIONS.map((s) => s.value as string));
  return {
    genres: many(sp, 'genre').filter((g) => genreKeys.has(g)) as Genre[],
    statuses: many(sp, 'status')
      .map((s) => s.toLowerCase())
      .filter((s) => statusKeys.has(s)) as StatusFilter[],
    venueIds: [...many(sp, 'placeId'), ...many(sp, 'venue')].filter((id) => VENUES.some((v) => v.id === id)),
    artistIds: many(sp, 'artistId').filter((id) => ARTISTS.some((a) => a.id === id)),
    includePast: firstParam(sp, 'includePast') === 'true',
  };
}

function matchesQuery(p: Production, q: string): boolean {
  if (!q) return true;
  const needle = (ALIASES[q.toLowerCase()] ?? q).toLowerCase();
  const artist = p.artistId ? getArtist(p.artistId)?.name ?? '' : '';
  const venue = getVenue(p.venueId)?.name ?? '';
  return [p.title, artist, venue, GENRE_LABEL[p.genre]].some((s) => s.toLowerCase().includes(needle));
}

function matchesFilters(p: Production, f: SearchFilters): boolean {
  if (!f.includePast && p.status === 'ended') return false;
  if (f.genres.length && !f.genres.includes(p.genre)) return false;
  if (f.statuses.length && !(f.statuses as ProductionStatus[]).includes(p.status)) return false;
  if (f.venueIds.length && !f.venueIds.includes(p.venueId)) return false;
  if (f.artistIds.length && !(p.artistId && f.artistIds.includes(p.artistId))) return false;
  return true;
}

function sortList(list: Production[], sort: SortKey): Production[] {
  if (sort === 'opening') return [...list].sort((a, b) => a.openAt.localeCompare(b.openAt));
  if (sort === 'popular') return [...list].sort((a, b) => (b.rating?.count ?? 0) - (a.rating?.count ?? 0));
  return list;
}

function hasFilters(f: SearchFilters): boolean {
  return f.genres.length + f.statuses.length + f.venueIds.length + f.artistIds.length > 0 || f.includePast;
}

/** 주소의 검색어·필터로 목업을 거른다 */
function liveView(sp: SearchParams, sort: SortKey): SearchView {
  const q = (firstParam(sp, 'q') ?? '').trim();
  const filters = readFilters(sp);
  const run = (query: string, f: SearchFilters) => PRODUCTIONS.filter((p) => matchesQuery(p, query) && matchesFilters(p, f));
  let found = run(q, filters);
  let converted: SearchView['converted'];
  // '{입력}'(으)로 찾기(exact=1)를 누르면 바꾸지 않고 원래 값으로 찾는다
  if (found.length === 0 && firstParam(sp, 'exact') !== '1' && CONVERT[q.toLowerCase()]) {
    const to = CONVERT[q.toLowerCase()]!;
    found = run(to, filters);
    if (found.length) converted = { to, from: q };
  }
  const total = found.length;
  const pages = Math.ceil(total / PAGE_SIZE);
  const askedPage = Number(firstParam(sp, 'page') ?? '1');
  // 없는 페이지 번호면 마지막 페이지를 보인다(d5 §5.3)
  const page = Math.min(Math.max(Number.isFinite(askedPage) ? Math.floor(askedPage) : 1, 1), Math.max(pages, 1));
  const sorted = sortList(found, sort).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const view: SearchView = { q, combobox: 'closed', result: 'list', filters, sort, total, page, pages, cards: sorted.map(toCard), converted };
  if (total === 0) {
    const unfiltered = hasFilters(filters) ? run(converted?.to ?? q, EMPTY_FILTERS).length : 0;
    return {
      ...view,
      result: unfiltered > 0 ? 'empty-filter' : 'empty',
      unfilteredCount: unfiltered || undefined,
      didYouMean: SIMILAR[q],
      popular: popular(),
    };
  }
  // 아티스트로 맞았고 필터 때문에 빠진 그 아티스트의 공연이 있으면 관련 공연(search.md §6)
  const artist = ARTISTS.find((a) => a.name.toLowerCase() === (ALIASES[q.toLowerCase()] ?? q).toLowerCase());
  if (artist && hasFilters(filters)) {
    const others = PRODUCTIONS.filter((p) => p.artistId === artist.id && !found.includes(p)).slice(0, 6);
    if (others.length) view.related = { title: `${artist.name}의 다른 공연`, cards: others.map(toCard) };
  }
  return view;
}

export function searchView(sp: SearchParams, state: Scr003State | null): SearchView {
  const askedSort = firstParam(sp, 'sort');
  const q = firstParam(sp, 'q');
  // 검색어가 없으면 기본은 오픈 임박(d5 §5.3)
  const sort: SortKey = SORT_OPTIONS.some((o) => o.value === askedSort) ? (askedSort as SortKey) : state || q ? 'relevance' : 'opening';
  return state ? boardView(state, sort) : liveView(sp, sort);
}

/** 같은 검색에서 값 하나만 바꾼 주소 */
export function searchUrl(view: Pick<SearchView, 'q' | 'filters' | 'sort'>, patch: Partial<{ q: string; filters: SearchFilters; sort: SortKey; page: number }> = {}): string {
  const q = patch.q ?? view.q;
  const f = patch.filters ?? view.filters;
  const sort = patch.sort ?? view.sort;
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  for (const g of f.genres) params.append('genre', g);
  for (const s of f.statuses) params.append('status', s);
  for (const v of f.venueIds) params.append('placeId', v);
  for (const a of f.artistIds) params.append('artistId', a);
  if (f.includePast) params.set('includePast', 'true');
  if (patch.sort !== undefined || view.sort !== (q ? 'relevance' : 'opening')) params.set('sort', sort);
  if (patch.page && patch.page > 1) params.set('page', String(patch.page));
  const s = params.toString();
  return s ? `/search?${s}` : '/search';
}

export const NO_FILTERS = EMPTY_FILTERS;

/** 받침 있는 말 뒤 '을'·'으로', 없는 말 뒤 '를'·'로'(ㄹ 받침은 '로'). 한글이 아닌 끝 글자는 받침 없음으로 본다 */
export function josa(word: string, kind: '을' | '으로'): string {
  const last = word.charCodeAt(word.length - 1);
  const isHangul = last >= 0xac00 && last <= 0xd7a3;
  const jong = isHangul ? (last - 0xac00) % 28 : 0;
  if (kind === '을') return jong ? '을' : '를';
  return jong && jong !== 8 ? '으로' : '로';
}

/** 장르 필터 표시 이름 */
export function genreLabel(g: Genre): string {
  return GENRE_LABEL[g];
}
